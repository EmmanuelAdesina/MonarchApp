import os
import bcrypt
import random
import json
import requests as http_requests
from flask import Flask, render_template, render_template_string, request, redirect, url_for, flash, jsonify, session
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from datetime import datetime, timedelta, timezone
import warnings
warnings.filterwarnings('ignore', category=DeprecationWarning)
# cryptographic helpers for webhook signature verification
import hmac
import hashlib
# Helper to avoid warnings while keeping naive UTC for DB compat
def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)
from functools import wraps, lru_cache
from database import db, User, Transaction, WithdrawalRequest, PaymentVerification, ReferralBonus, generate_referral_code, WithdrawalSettings, WaitingList, Mentor, MentorMessage
from utils import calculate_growth, generate_activity_feed
from dotenv import load_dotenv
from werkzeug.utils import secure_filename

dotenv_path = os.path.join(os.path.dirname(__file__), '.env')
if os.path.exists(dotenv_path):
    load_dotenv(dotenv_path, override=True)

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev-secret-key')

# --- New Financial Policies ---
MINIMUM_DEPOSIT = 500.00
MINIMUM_WITHDRAWAL = 1000.00
WITHDRAWAL_CUTOFF_DAY = 25
WITHDRAWAL_TAX_RATE = 0.20 # 20%


def refresh_payment_settings():
    if os.path.exists(dotenv_path):
        load_dotenv(dotenv_path, override=True)
    global NOWPAYMENTS_API_KEY, PAYSTACK_SECRET_KEY, PAYSTACK_PUBLIC_KEY, ADMIN_SETUP_KEY
    NOWPAYMENTS_API_KEY = os.getenv('NOWPAYMENTS_API_KEY', '')
    PAYSTACK_SECRET_KEY = os.getenv('PAYSTACK_SECRET_KEY', '')
    PAYSTACK_PUBLIC_KEY = os.getenv('PAYSTACK_PUBLIC_KEY', '')
    ADMIN_SETUP_KEY = os.getenv('ADMIN_SETUP_KEY', '')


refresh_payment_settings()
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///monarch.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

UPLOAD_FOLDER = os.path.join(app.root_path, 'static', 'uploads')
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Payment gateway config — these are managed by refresh_payment_settings() at runtime.
# Do NOT set them at module level; refresh_payment_settings() is the single source of truth.
NOWPAYMENTS_BASE = 'https://api.nowpayments.io/v1'
EXCHANGE_RATE_CACHE_DURATION_MINUTES = 60
PAYSTACK_FALLBACK_RATE = float(os.getenv('PAYSTACK_FALLBACK_RATE', '1554.20'))
EXCHANGE_RATE_CACHE_FILE = os.path.join(app.root_path, 'instance', 'paystack_exchange_rate.json')
os.makedirs(os.path.dirname(EXCHANGE_RATE_CACHE_FILE), exist_ok=True)


def _read_exchange_rate_cache():
    try:
        if not os.path.exists(EXCHANGE_RATE_CACHE_FILE):
            return None
        with open(EXCHANGE_RATE_CACHE_FILE, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
        rate = data.get('rate')
        timestamp = data.get('timestamp')
        if rate and timestamp:
            return float(rate), float(timestamp)
    except Exception:
        return None
    return None


def _write_exchange_rate_cache(rate):
    try:
        with open(EXCHANGE_RATE_CACHE_FILE, 'w', encoding='utf-8') as handle:
            json.dump({'rate': rate, 'timestamp': datetime.utcnow().timestamp()}, handle)
    except Exception:
        return


def get_usd_to_ngn_rate(force_refresh=False):
    cached = _read_exchange_rate_cache() if not force_refresh else None
    if cached:
        rate, timestamp = cached
        age_minutes = (datetime.utcnow().timestamp() - timestamp) / 60.0
        if age_minutes <= EXCHANGE_RATE_CACHE_DURATION_MINUTES:
            return rate

    try:
        response = http_requests.get(
            'https://api.exchangerate.host/latest?base=USD&symbols=NGN',
            timeout=10
        )
        response.raise_for_status()
        payload = response.json()
        rate = payload.get('rates', {}).get('NGN')
        if rate and float(rate) > 0:
            rate = float(rate)
            _write_exchange_rate_cache(rate)
            return rate
    except Exception:
        pass

    if cached:
        return cached[0]
    return PAYSTACK_FALLBACK_RATE


# Referral bonus configuration
REFERRAL_BONUS_PERCENT = 0.05  # 5% of referred user's first deposit

db.init_app(app)

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


# ---- Helper Functions ----
def ensure_admin_access(user):
    """Promote the first registered account to admin if no admin exists yet."""
    if user.is_admin:
        return True
    has_admin_user = User.query.filter_by(is_admin=True).first()
    if not has_admin_user:
        user.is_admin = True
        db.session.commit()
        return True
    return False


def is_withdrawal_window_open():
    """Check if today is within the withdrawal submission window (1st to 25th)."""
    today = _now().day
    return 1 <= today <= WITHDRAWAL_CUTOFF_DAY


@lru_cache(maxsize=1)
def get_withdrawal_cycle_dates():
    """Get dates for the current withdrawal cycle."""
    now = _now()
    last_day_of_month = (now.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    return {
        'processing_date': last_day_of_month.strftime('%B %d, %Y'),
        'submission_deadline': now.replace(day=WITHDRAWAL_CUTOFF_DAY).strftime('%B %d, %Y')
    }
# ---- Decorators ----
def admin_required(f):
    """Decorator to restrict routes to admin users only."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not current_user.is_authenticated:
            if request.path.startswith('/api/'):
                return jsonify({'success': False, 'message': 'Admin access required'}), 403
            flash('Please log in first.')
            return redirect(url_for('login'))

        if not current_user.is_admin:
            if ensure_admin_access(current_user):
                flash('Admin access granted to the first registered account.')
            else:
                if request.path.startswith('/api/'):
                    return jsonify({'success': False, 'message': 'Admin access required'}), 403
                flash('Admin access required. Use the setup page to grant access.')
                return redirect(url_for('dashboard'))

        return f(*args, **kwargs)
    return decorated_function


# ---- Helper Functions ----
def apply_growth(user):
    """Apply growth to user's balance if enough time has passed."""
    now = _now()
    delta = (now - user.last_growth).total_seconds()
    if delta >= 3.0 and user.balance > 0:
        growth = calculate_growth(user.balance, user.last_growth)
        if growth > 0:
            user.balance += growth
            trans = Transaction(
                user_id=user.id,
                amount=growth,
                type='growth',
                description='Portfolio growth'
            )
            db.session.add(trans)
        user.last_growth = now
        db.session.commit()
    
    # Check milestones and send scheduled messages
    try:
        check_balance_milestones(user)
        check_and_send_scheduled_mentor_messages(user)
    except Exception as e:
        print("Error checking mentor milestones:", e)

def trigger_mentor_milestone(user, milestone_id):
    """Trigger an automated message from the assigned AI mentor for a user milestone."""
    if not user.mentor_id:
        default_mentor = Mentor.query.first()
        if default_mentor:
            user.mentor_id = default_mentor.id
            db.session.commit()
        else:
            return

    mentor = Mentor.query.get(user.mentor_id)
    if not mentor:
        return

    try:
        sent_list = json.loads(user.milestones_sent) if user.milestones_sent else []
    except Exception:
        sent_list = []

    if milestone_id in sent_list:
        return # Already sent

    templates = {
        'welcome': "Hi {name}! 🎉 Welcome to Monarch Wealth Group! I'm {mentor_name}, your personal wealth advisor. I've been helping people build wealth for 8 years, and I'm genuinely excited to work with you. Let me know if you have any questions! 😊",
        'first_deposit': "🔥 Look at you! You just made your first deposit! This is HUGE! 🎉 Most people never even start—but you did. I'm genuinely proud of you. Your portfolio is already growing!",
        'second_deposit': "I noticed your portfolio is growing nicely. Imagine what it could look like with a bit more capital. Just a thought—no pressure. 😊",
        'reached_1k': "🎉🎉🎉 You reached $1,000! This is a MAJOR milestone! Most people never get here. You're doing something incredible. Keep going!",
        'reached_5k': "🤯 $5,000! You are officially in the top 10% of members! This is incredible. I'm so proud of you. You have NO idea how rare this is.",
        'reached_10k': "Amazing work, {name}! Reaching $10,000 is an elite achievement. Let's schedule a personalized strategy call this week to review your long-term goals. 📞💼",
        'attempted_withdrawal': "Hey! I saw you're trying to withdraw. Just so you know, the 20% tax is standard for cross-border transfers. It's required before we can process your withdrawal. I've done this dozens of times—trust me, it's normal. 😊",
        'withdrawal_discouragement': "I see you're trying to withdraw. May I ask why? Your portfolio is growing at 3% weekly right now. If you keep it in for just one more month, you'll earn more than you're withdrawing. Just a thought!"
    }

    template = templates.get(milestone_id)
    if not template:
        return

    message_text = template.replace('{name}', user.username).replace('{mentor_name}', mentor.name)

    msg = MentorMessage(
        user_id=user.id,
        mentor_id=mentor.id,
        sender='mentor',
        message=message_text,
        created_at=_now()
    )
    db.session.add(msg)
    
    sent_list.append(milestone_id)
    user.milestones_sent = json.dumps(sent_list)
    db.session.commit()

def check_and_send_scheduled_mentor_messages(user):
    """Check and send mentor messages based on registration timeline (Day 1 to 7 sequence)."""
    if not user.created_at:
        return
        
    now = _now()
    days_since_reg = (now - user.created_at).days + 1
    
    try:
        sent_list = json.loads(user.milestones_sent) if user.milestones_sent else []
    except Exception:
        sent_list = []
        
    if not user.mentor_id:
        default_mentor = Mentor.query.first()
        if default_mentor:
            user.mentor_id = default_mentor.id
            db.session.commit()
        else:
            return

    mentor = Mentor.query.get(user.mentor_id)
    if not mentor:
        return

    sequence = {
        1: ('day_1', "Hi {name}! 🎉 Welcome to Monarch Wealth Group! I'm {mentor_name}, your personal wealth advisor. I've been helping people build wealth for 8 years, and I'm genuinely excited to work with you. Let me know if you have any questions! 😊"),
        2: ('day_2', "Hey {name}! Just checking in—how are you feeling about everything so far? I want to make sure you're comfortable and confident. 😊"),
        3: ('day_3', "Quick tip: The best time to invest isn't when you have money—it's when you have the mindset. You're already ahead of 90% of people just by being here. Proud of you!"),
        4: ('day_4', "Hey {name}! I was just thinking about you. You're doing GREAT! Most people never even start. But you did. I'm proud of you. 💛"),
        5: ('day_5', "Here's something I've learned from 8 years in this industry: consistency beats intensity. Small, regular deposits will always outperform one big deposit. Keep going!"),
        6: ('day_6', "Quick heads up—the platform is running a limited-time bonus. If you deposit $1,000+ this week, they're adding an extra 5% to your portfolio. Thought you'd want to know!"),
        7: ('day_7', "I noticed your portfolio is growing nicely. Imagine what it could look like with a bit more capital. If you want, we can set up a one-on-one strategy call? Just let me know!")
    }

    for day, (milestone_id, template) in sequence.items():
        if days_since_reg >= day and milestone_id not in sent_list:
            message_text = template.replace('{name}', user.username).replace('{mentor_name}', mentor.name)
            msg = MentorMessage(
                user_id=user.id,
                mentor_id=mentor.id,
                sender='mentor',
                message=message_text,
                created_at=_now()
            )
            db.session.add(msg)
            sent_list.append(milestone_id)
            
    user.milestones_sent = json.dumps(sent_list)
    db.session.commit()

def check_balance_milestones(user):
    """Trigger AI advisor milestones based on deposit count and current balance."""
    # Count deposits from Transaction table
    deposit_count = Transaction.query.filter_by(user_id=user.id, type='deposit').count()
    if deposit_count >= 1:
        trigger_mentor_milestone(user, 'first_deposit')
    if deposit_count >= 2:
        trigger_mentor_milestone(user, 'second_deposit')
        
    # Balance thresholds
    if user.balance >= 10000.0:
        trigger_mentor_milestone(user, 'reached_10k')
    elif user.balance >= 5000.0:
        trigger_mentor_milestone(user, 'reached_5k')
    elif user.balance >= 1000.0:
        trigger_mentor_milestone(user, 'reached_1k')

def credit_referral_bonus(user, deposit_amount):
    """If the user was referred, credit 5% of their first deposit to the referrer."""
    if not user.referred_by or deposit_amount <= 0:
        return

    referrer = db.session.get(User, user.referred_by)
    if not referrer:
        return

    # Check if this referred user already triggered a bonus (prevent multiple bonuses)
    existing_bonus = ReferralBonus.query.filter_by(referred_id=user.id).first()
    if existing_bonus:
        return

    bonus = deposit_amount * REFERRAL_BONUS_PERCENT

    referrer.balance += bonus
    referrer.referral_earnings += bonus
    db.session.add(Transaction(
        user_id=referrer.id,
        amount=bonus,
        type='referral_bonus',
        description=f'Referral bonus from {user.username}'
    ))
    db.session.add(ReferralBonus(
        referrer_id=referrer.id,
        referred_id=user.id,
        amount=bonus,
        deposit_amount=deposit_amount
    ))
    db.session.commit()

def is_payment_already_credited(payment_id):
    """Check if this NowPayments payment_id has already been credited."""
    existing = Transaction.query.filter(
        Transaction.description.contains(f'nowpayments#{payment_id}')
    ).first()
    return existing is not None

def is_nowpayments_configured():
    """Check if NowPayments API key is properly configured."""
    refresh_payment_settings()
    return bool(NOWPAYMENTS_API_KEY) and NOWPAYMENTS_API_KEY != 'your_nowpayments_api_key_here'


def is_paystack_configured():
    """Check if Paystack API key is properly configured."""
    refresh_payment_settings()
    return bool(PAYSTACK_SECRET_KEY) and PAYSTACK_SECRET_KEY != 'your_paystack_secret_key_here'

def verify_paystack_transaction(reference):
    """Verify a Paystack transaction by reference. Returns (success, data)."""
    if not is_paystack_configured():
        return False, {'message': 'Paystack not configured'}
    headers = {
        'Authorization': f'Bearer {PAYSTACK_SECRET_KEY}',
    }
    try:
        resp = http_requests.get(
            f'https://api.paystack.co/transaction/verify/{reference}',
            headers=headers,
            timeout=15
        )
        result = resp.json()
        if resp.status_code == 200 and result.get('status') and result['data'].get('status') == 'success':
            return True, result['data']
        return False, result
    except Exception as e:
        return False, {'message': str(e)}

def verify_paystack_webhook_signature(payload_body, signature):
    """Verify Paystack webhook signature using HMAC SHA512."""
    if not PAYSTACK_SECRET_KEY:
        return False
    computed = hmac.new(
        PAYSTACK_SECRET_KEY.encode('utf-8'),
        payload_body,
        hashlib.sha512
    ).hexdigest()
    return hmac.compare_digest(computed, signature)

def generate_receipt_number():
    """Generate unique receipt number like MWG-WD-20260625-A3F8."""
    date_part = _now().strftime('%Y%m%d')
    rand_part = os.urandom(2).hex().upper()
    return f'MWG-WD-{date_part}-{rand_part}'


# ==================================================================
# PUBLIC ROUTES
# ==================================================================

@app.route('/')
def index():
    # Fetch completed withdrawals for public proof
    completed_withdrawals = WithdrawalRequest.query.filter(
        WithdrawalRequest.status == 'completed',
        WithdrawalRequest.receipt_number.isnot(None)
    ).order_by(WithdrawalRequest.receipt_generated_at.desc()).limit(6).all()
    return render_template('index.html', completed_withdrawals=completed_withdrawals)


@app.route('/apply')
def waiting_list_apply_view():
    """Render waitlist application page."""
    return render_template('apply.html')


@app.route('/application/status/<int:app_id>')
def waiting_list_status_view(app_id):
    """Render waitlist application status page."""
    app_entry = db.session.get(WaitingList, app_id)
    if not app_entry:
        return redirect(url_for('waiting_list_apply_view'))
    return render_template('status.html', application=app_entry)


@app.before_request
def restrict_unapproved_users():
    """Redirect unapproved logged-in users to their application status page."""
    # Skip checks for static assets and public/admin endpoints
    allowed_endpoints = [
        'index', 'login', 'logout', 'register', 'waiting_list_apply',
        'waiting_list_spots', 'waiting_list_status', 'static',
        'waiting_list_apply_view', 'waiting_list_status_view',
        'admin_setup', 'admin_dashboard', 'admin_stats', 'admin_withdrawals',
        'admin_approve_withdrawal', 'admin_reject_withdrawal', 'admin_mark_paid',
        'admin_withdrawal_stats', 'admin_waiting_list_applications',
        'admin_approve_application', 'admin_reject_application', 'admin_waiting_list_bulk',
        'admin_settings_api', 'admin_mentor_conversations', 'admin_mentor_messages',
        'admin_mentor_send'
    ]
    if request.endpoint in allowed_endpoints or not request.endpoint:
        return

    if current_user.is_authenticated and not current_user.is_admin and not current_user.is_approved:
        # Find application
        app_entry = WaitingList.query.filter_by(email=current_user.email).first()
        if app_entry:
            return redirect(url_for('waiting_list_status_view', app_id=app_entry.id))
        return redirect(url_for('waiting_list_apply_view'))


@app.route('/register', methods=['GET', 'POST'])
def register():
    # Read invitation code from query parameters or post request
    code = request.args.get('code', request.form.get('invitation_code', '')).strip()
    
    if not code:
        flash('Monarch Wealth Group is an invitation-only platform. Please submit an application to join the waiting list.')
        return redirect(url_for('waiting_list_apply_view'))

    # Validate invitation code
    app_entry = WaitingList.query.filter_by(invitation_code=code, status='approved').first()
    if not app_entry:
        flash('Invalid or expired invitation code.')
        return redirect(url_for('waiting_list_apply_view'))

    if app_entry.expires_at and app_entry.expires_at < _now():
        flash('Your invitation code has expired. Please apply again.')
        app_entry.status = 'expired'
        db.session.commit()
        return redirect(url_for('waiting_list_apply_view'))

    if request.method == 'POST':
        username = request.form['username']
        email = request.form['email'].strip()
        password = request.form['password']
        referral_code = request.form.get('referral_code', '').strip()

        if User.query.filter_by(username=username).first():
            flash('Username already exists')
            return redirect(url_for('register', code=code))
        if User.query.filter_by(email=email).first():
            flash('Email already registered')
            return redirect(url_for('register', code=code))

        hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())
        user = User(
            username=username, 
            email=email, 
            password_hash=hashed.decode('utf-8'),
            is_approved=True, # Mark as approved
            created_at=_now() # Day 1 starts now
        )

        # Handle referral code
        referrer = None
        if referral_code:
            referrer = User.query.filter_by(referral_code=referral_code).first()
            if not referrer:
                flash('Invalid referral code. You can still register without one.')
            elif referrer.username == username:
                flash('You cannot refer yourself.')
            else:
                user.referred_by = referrer.id

        # Assign AI mentor Sarah Mitchell
        default_mentor = Mentor.query.first()
        if default_mentor:
            user.mentor_id = default_mentor.id

        db.session.add(user)
        db.session.commit()

        # Trigger welcome milestone message
        trigger_mentor_milestone(user, 'welcome')

        flash('Registration successful! Please log in.')
        return redirect(url_for('login'))

    return render_template('register.html', code=code, email=app_entry.email)

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        user = User.query.filter_by(username=username).first()
        if user and bcrypt.checkpw(password.encode('utf-8'), user.password_hash.encode('utf-8')):
            login_user(user)
            apply_growth(user)
            return redirect(url_for('dashboard'))
        flash('Invalid username or password')
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('index'))

@app.route('/dashboard')
@login_required
def dashboard():
    apply_growth(current_user)
    # Get referral code info
    referred_count = User.query.filter_by(referred_by=current_user.id).count()
    referral_bonuses = ReferralBonus.query.filter_by(referrer_id=current_user.id)\
        .order_by(ReferralBonus.created_at.desc()).all()
    return render_template('dashboard.html', user=current_user,
                           paystack_public_key=PAYSTACK_PUBLIC_KEY,
                           referred_count=referred_count,
                           referral_bonuses=referral_bonuses)


# ==================================================================
# STANDARD API ENDPOINTS
# ==================================================================

@app.route('/api/balance')
@login_required
def get_balance():
    apply_growth(current_user)
    user = current_user
    invested = user.total_deposits
    profit = user.balance - invested
    roi = (profit / invested * 100) if invested > 0 else 0
    today = _now().date()
    growth_today = db.session.query(db.func.sum(Transaction.amount)).filter(
        Transaction.user_id == user.id,
        Transaction.type == 'growth',
        db.func.date(Transaction.timestamp) == today
    ).scalar() or 0

    return jsonify({
        'balance': round(user.balance, 2),
        'invested': round(invested, 2),
        'profit': round(profit, 2),
        'roi': round(roi, 1),
        'growth_today': round(growth_today, 2),
        'growth_percent': round((growth_today / invested * 100) if invested > 0 else 0, 1)
    })

@app.route('/api/activity')
@login_required
def get_activity():
    transactions = Transaction.query.filter_by(user_id=current_user.id)\
        .order_by(Transaction.timestamp.desc()).limit(5).all()
    user_activities = []
    for t in transactions:
        user_activities.append({
            'text': f"{t.type.capitalize()} ${t.amount:.2f}",
            'time': t.timestamp.strftime('%I:%M %p'),
            'type': t.type
        })
    fake_activities = generate_activity_feed(5)
    combined = fake_activities + [{'name': 'You', 'text': a['text'], 'time': a['time'], 'type': a['type']} for a in user_activities]
    random.shuffle(combined)
    return jsonify(combined)


# ==================================================================
# REFERRAL API
# ==================================================================

@app.route('/api/referral/info')
@login_required
def get_referral_info():
    """Get the current user's referral code, earnings, and referred count."""
    referred_count = User.query.filter_by(referred_by=current_user.id).count()
    bonuses = ReferralBonus.query.filter_by(referrer_id=current_user.id)\
        .order_by(ReferralBonus.created_at.desc()).limit(20).all()

    bonus_list = []
    for b in bonuses:
        referred_user = db.session.get(User, b.referred_id)
        bonus_list.append({
            'id': b.id,
            'referred_username': referred_user.username if referred_user else 'Unknown',
            'amount': round(b.amount, 2),
            'deposit_amount': round(b.deposit_amount, 2),
            'date': b.created_at.strftime('%b %d, %Y')
        })

    return jsonify({
        'success': True,
        'referral_code': current_user.referral_code,
        'referral_earnings': round(current_user.referral_earnings, 2),
        'referred_count': referred_count,
        'bonuses': bonus_list
    })

# ==================================================================
# USER PROFILE & WALLET API
# ==================================================================

@app.route('/api/user/wallet', methods=['POST'])
@login_required
def save_user_wallet():
    """Save or update the user's crypto wallet address, network, and currency."""
    data = request.get_json() or {}
    wallet_address = data.get('wallet_address', '').strip()
    wallet_network = data.get('wallet_network', 'Ethereum (ERC-20)')
    wallet_currency = data.get('wallet_currency', 'USDT')

    if not wallet_address:
        return jsonify({'success': False, 'message': 'Wallet address cannot be empty.'}), 400

    import re
    # Address validation rules based on network
    if wallet_network in ['Ethereum (ERC-20)', 'BSC (BEP-20)']:
        if not re.match(r"^0x[a-fA-F0-9]{40}$", wallet_address):
            return jsonify({'success': False, 'message': 'Invalid Ethereum/BSC address format (must be 0x + 40 hex characters).'}), 400
    elif wallet_network == 'Tron (TRC-20)':
        if not re.match(r"^T[a-zA-Z0-9]{33}$", wallet_address):
            return jsonify({'success': False, 'message': 'Invalid Tron address format (must be T + 33 characters).'}), 400
    elif wallet_network == 'Bitcoin':
        if not re.match(r"^[1-9A-HJ-NP-Za-km-z]{34}$", wallet_address):
            return jsonify({'success': False, 'message': 'Invalid Bitcoin address format (must be 34 alphanumeric characters).'}), 400

    current_user.crypto_wallet_address = wallet_address
    current_user.crypto_network = wallet_network
    current_user.crypto_currency = wallet_currency
    current_user.wallet_verified = True
    db.session.commit()

    return jsonify({'success': True, 'message': 'Wallet address saved successfully'})


@app.route('/api/withdrawal/eligibility')
@login_required
def get_withdrawal_eligibility():
    """Check if the user is eligible for a withdrawal and return cycle info."""
    apply_growth(current_user)
    balance = current_user.balance
    
    settings = WithdrawalSettings.query.first()
    min_withdrawal = settings.min_withdrawal if settings else 1000.00
    tax_rate = settings.tax_rate if settings else 20.00
    cut_off_day = settings.cut_off_day if settings else 25

    now = _now()
    # Cycle calculations
    last_day_of_month = (now.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    cut_off_date = now.replace(day=cut_off_day)
    
    days_until_processing = (last_day_of_month.date() - now.date()).days
    can_request_now = 1 <= now.day <= cut_off_day
    
    # Check for active withdrawal request
    active_request = WithdrawalRequest.query.filter(
        WithdrawalRequest.user_id == current_user.id,
        WithdrawalRequest.status.in_(['tax_required', 'pending'])
    ).first()

    tax_amount = balance * (tax_rate / 100.0)
    net_payout = balance - tax_amount

    return jsonify({
        'success': True,
        'data': {
            'balance': round(balance, 2),
            'minimum_withdrawal': min_withdrawal,
            'eligible': balance >= min_withdrawal,
            'tax_rate': tax_rate,
            'tax_amount': round(tax_amount, 2),
            'net_payout': round(net_payout, 2),
            'processing_day': last_day_of_month.strftime('%Y-%m-%d'),
            'cut_off_day': cut_off_date.strftime('%Y-%m-%d'),
            'can_request': can_request_now,
            'days_until_processing': max(0, days_until_processing),
            'wallet_provided': bool(current_user.crypto_wallet_address),
            'wallet_address': current_user.crypto_wallet_address or '',
            'wallet_network': current_user.crypto_network or 'Ethereum (ERC-20)',
            'has_active_request': active_request is not None,
            'active_request_status': active_request.status if active_request else None
        }
    })


# ==================================================================
# DEPOSIT — CRYPTO (NowPayments, verified)
# ==================================================================

@app.route('/api/create-crypto-payment', methods=['POST'])
@login_required
def create_crypto_payment():
    """Create a NowPayments invoice and return payment details to the frontend."""
    if not is_nowpayments_configured():
        return jsonify({'success': False, 'message': 'Crypto payment gateway not configured. Please contact support.'})

    data = request.get_json()
    amount_usd = float(data.get('amount', 0))
    method = data.get('method', 'crypto-usdt')

    if amount_usd < MINIMUM_DEPOSIT:
        return jsonify({'success': False, 'message': f'Minimum deposit is ${MINIMUM_DEPOSIT:.2f}'})

    # Map frontend method to NowPayments currency code
    currency_map = {
        'crypto-usdt': 'usdttrc20',
        'crypto-btc': 'btc',
        'crypto-eth': 'eth',
    }
    pay_currency = currency_map.get(method, 'usdttrc20')

    headers = {
        'x-api-key': NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json'
    }
    payload = {
        'price_amount': amount_usd,
        'price_currency': 'usd',
        'pay_currency': pay_currency,
        'order_id': f'monarch_{current_user.id}_{int(_now().timestamp())}',
        'order_description': f'Monarch Wealth deposit for {current_user.username}'
    }

    try:
        resp = http_requests.post(
            f'{NOWPAYMENTS_BASE}/payment',
            json=payload,
            headers=headers,
            timeout=15
        )
        result = resp.json()

        if resp.status_code == 201:
            payment_id = str(result['payment_id'])

            # Log verification record
            pv = PaymentVerification(
                user_id=current_user.id,
                gateway='nowpayments',
                gateway_reference=payment_id,
                amount=amount_usd,
                currency='USD',
                payment_type='deposit',
                status='pending',
            )
            pv.set_raw_response(result)
            db.session.add(pv)
            db.session.commit()

            # Store in session for server-side verification
            session['pending_payment'] = {
                'payment_id': payment_id,
                'amount_usd': amount_usd,
                'user_id': current_user.id
            }
            return jsonify({
                'success': True,
                'payment_id': payment_id,
                'pay_address': result.get('pay_address', ''),
                'pay_amount': result.get('pay_amount', amount_usd),
                'pay_currency': result.get('pay_currency', pay_currency).upper(),
                'status': result.get('payment_status', 'waiting'),
                'network': result.get('network', ''),
            })
        else:
            error_msg = result.get('message', 'Failed to create payment. Please try again.')
            return jsonify({'success': False, 'message': error_msg})

    except http_requests.exceptions.Timeout:
        return jsonify({'success': False, 'message': 'Payment gateway timeout. Please try again.'})
    except Exception as e:
        return jsonify({'success': False, 'message': f'Error: {str(e)}'})


@app.route('/api/payment-status/<payment_id>')
@login_required
def check_payment_status(payment_id):
    """Poll NowPayments for the current payment status.
    Credits the user only when NowPayments confirms the payment is received.
    """
    if not is_nowpayments_configured():
        return jsonify({'success': False, 'message': 'Payment gateway not configured.'})

    # Prevent crediting a payment that doesn't belong to this user
    pending = session.get('pending_payment', {})
    if str(pending.get('payment_id')) != str(payment_id) or pending.get('user_id') != current_user.id:
        return jsonify({'success': False, 'message': 'Payment session mismatch. Please restart.'})

    # Prevent double-crediting
    if is_payment_already_credited(payment_id):
        return jsonify({'success': True, 'status': 'finished', 'credited': True,
                        'new_balance': round(current_user.balance, 2)})

    headers = {'x-api-key': NOWPAYMENTS_API_KEY}
    try:
        resp = http_requests.get(
            f'{NOWPAYMENTS_BASE}/payment/{payment_id}',
            headers=headers,
            timeout=10
        )
        result = resp.json()

        if resp.status_code != 200:
            return jsonify({'success': False, 'message': 'Could not retrieve payment status.'})

        status = result.get('payment_status', 'waiting')

        # Credit user when NowPayments confirms receipt
        if status in ('confirmed', 'finished'):
            amount = pending['amount_usd']

            current_user.balance += amount
            current_user.total_deposits += amount
            trans = Transaction(
                user_id=current_user.id,
                amount=amount,
                type='deposit',
                description=f'Crypto deposit via NowPayments (nowpayments#{payment_id})'
            )
            db.session.add(trans)

            # Instant portfolio boost
            bonus = amount * random.uniform(0.01, 0.05)
            current_user.balance += bonus
            trans_bonus = Transaction(
                user_id=current_user.id,
                amount=bonus,
                type='growth',
                description='Portfolio activation bonus'
            )
            db.session.add(trans_bonus)

            # Credit referral bonus to the referrer if applicable
            credit_referral_bonus(current_user, amount)

            # Update verification record
            pv = PaymentVerification.query.filter_by(gateway_reference=payment_id).first()
            if pv:
                pv.status = 'verified'
                pv.verified_at = _now()
                pv.set_raw_response(result)

            db.session.commit()
            session.pop('pending_payment', None)

            return jsonify({
                'success': True,
                'status': status,
                'credited': True,
                'new_balance': round(current_user.balance, 2)
            })

        # Return current status without crediting
        return jsonify({
            'success': True,
            'status': status,
            'credited': False
        })

    except http_requests.exceptions.Timeout:
        return jsonify({'success': False, 'message': 'Gateway timeout checking status.'})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


# ==================================================================
# DEPOSIT — CARD (Paystack, verified)
# ==================================================================

@app.route('/api/paystack/exchange-rate')
@login_required
def paystack_exchange_rate():
    """Return the current USD->NGN exchange rate for the Paystack card flow."""
    rate = get_usd_to_ngn_rate()
    return jsonify({'success': True, 'rate': rate, 'fallback_rate': PAYSTACK_FALLBACK_RATE})


@app.route('/api/deposit-card', methods=['POST'])
@login_required
def deposit_card():
    """Initialize a Paystack transaction for card deposit using a transparent USD->NGN conversion."""
    if not is_paystack_configured():
        return jsonify({'success': False, 'message': 'Card payment gateway not configured. Please contact support.'})

    data = request.get_json(silent=True) or {}
    amount = float(data.get('amount', 0) or 0)
    if amount < MINIMUM_DEPOSIT:
        return jsonify({'success': False, 'message': f'Minimum deposit is ${MINIMUM_DEPOSIT:.2f}'})

    exchange_rate = get_usd_to_ngn_rate()
    ngn_amount = round(amount * exchange_rate, 2)
    paystack_amount_kobo = int(round(ngn_amount * 100))

    headers = {
        'Authorization': f'Bearer {PAYSTACK_SECRET_KEY}',
        'Content-Type': 'application/json'
    }
    payload = {
        'email': current_user.email,
        'amount': paystack_amount_kobo,
        'currency': 'NGN',
        'callback_url': url_for('paystack_deposit_callback', _external=True),
        'metadata': {
            'user_id': current_user.id,
            'payment_type': 'deposit',
            'amount_usd': amount,
            'amount_ngn': ngn_amount,
            'exchange_rate': exchange_rate
        }
    }
    try:
        resp = http_requests.post(
            'https://api.paystack.co/transaction/initialize',
            json=payload,
            headers=headers,
            timeout=15
        )
        result = resp.json()
        if resp.status_code == 200 and result.get('status'):
            reference = result['data']['reference']
            storage_payload = dict(result.get('data', {}))
            storage_payload['metadata'] = payload['metadata']

            # Log verification record
            pv = PaymentVerification(
                user_id=current_user.id,
                gateway='paystack',
                gateway_reference=reference,
                amount=amount,
                currency='USD',
                payment_type='deposit',
                status='pending',
            )
            pv.set_raw_response(storage_payload)
            db.session.add(pv)
            db.session.commit()

            # Store in session
            session['pending_deposit'] = {
                'reference': reference,
                'amount': amount,
                'amount_usd': amount,
                'amount_ngn': ngn_amount,
                'exchange_rate': exchange_rate,
                'user_id': current_user.id
            }

            return jsonify({
                'success': True,
                'authorization_url': result['data']['authorization_url'],
                'reference': reference,
                'amount_usd': amount,
                'amount_ngn': ngn_amount,
                'exchange_rate': exchange_rate
            })
        else:
            return jsonify({'success': False, 'message': result.get('message', 'Failed to initialize payment')})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@app.route('/paystack/callback')
@login_required
def paystack_deposit_callback():
    """Paystack redirects here after payment. Verify and credit."""
    reference = request.args.get('reference') or request.args.get('trxref')
    if not reference:
        flash('Invalid payment callback.')
        return redirect(url_for('dashboard'))

    pending = session.get('pending_deposit', {})

    # Verify with Paystack
    success, data = verify_paystack_transaction(reference)

    if success:
        amount = pending.get('amount_usd', pending.get('amount', data.get('metadata', {}).get('amount_usd', 0)))
        amount = float(amount or 0)
        user_id = pending.get('user_id', current_user.id)

        # Prevent double-credit
        existing = Transaction.query.filter(
            Transaction.description.contains(f'paystack#{reference}')
        ).first()

        if not existing and amount > 0:
            user = db.session.get(User, user_id)
            if user:
                user.balance += amount
                user.total_deposits += amount
                trans = Transaction(
                    user_id=user.id,
                    amount=amount,
                    type='deposit',
                    description=f'Card deposit via Paystack (paystack#{reference})'
                )
                db.session.add(trans)

                # Portfolio boost
                bonus = amount * random.uniform(0.01, 0.05)
                user.balance += bonus
                trans_bonus = Transaction(
                    user_id=user.id,
                    amount=bonus,
                    type='growth',
                    description='Portfolio activation bonus'
                )
                db.session.add(trans_bonus)

                # Credit referral bonus to the referrer if applicable
                credit_referral_bonus(user, amount)

                # Update verification
                pv = PaymentVerification.query.filter_by(gateway_reference=reference).first()
                if pv:
                    pv.status = 'verified'
                    pv.verified_at = _now()
                    pv.set_raw_response(data)

                db.session.commit()
                session.pop('pending_deposit', None)
                flash(f'✅ Deposit of ${amount:.2f} confirmed and credited!')
        else:
            flash('Payment already credited.')
    else:
        flash('❌ Payment verification failed. Please contact support.')

    return redirect(url_for('dashboard'))


# ==================================================================
# WITHDRAWAL SYSTEM (real payments only)
# ==================================================================

@app.route('/api/withdrawal/request', methods=['POST'])
@login_required
def request_withdrawal():
    settings = WithdrawalSettings.query.first()
    min_withdrawal = settings.min_withdrawal if settings else 1000.00
    tax_rate = settings.tax_rate if settings else 20.00
    cut_off_day = settings.cut_off_day if settings else 25

    now = _now()
    if not (1 <= now.day <= cut_off_day):
        return jsonify({'success': False, 'message': f'Withdrawal requests can only be made between the 1st and {cut_off_day}th of the month.'}), 400

    if not current_user.crypto_wallet_address:
        return jsonify({'success': False, 'message': 'Please set your crypto wallet address in your profile before requesting a withdrawal.'}), 400

    data = request.get_json() or {}
    amount = float(data.get('amount', 0))

    if amount < min_withdrawal:
        return jsonify({'success': False, 'message': f'Minimum withdrawal is ${min_withdrawal:.2f}'}), 400

    apply_growth(current_user)
    if amount > current_user.balance:
        return jsonify({'success': False, 'message': 'Insufficient balance'}), 400

    # Deduct and reserve from user's balance
    current_user.balance -= amount
    current_user.pending_withdrawal += amount

    tax_amount = amount * (tax_rate / 100.0)
    last_day_of_month = (now.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)

    withdrawal = WithdrawalRequest(
        user_id=current_user.id,
        amount=amount,
        tax_amount=tax_amount,
        status='tax_required',
        tax_paid=False,
        crypto_wallet_address=current_user.crypto_wallet_address,
        crypto_network=current_user.crypto_network,
        crypto_currency=current_user.crypto_currency or 'USDT',
        bank_name=current_user.crypto_network, # Re-using bank_name for backwards compatibility
        account_number=current_user.crypto_wallet_address # Re-using account_number for backwards compatibility
    )
    db.session.add(withdrawal)
    db.session.commit()

    # AI Mentor Nudge trigger (Attempted withdrawal / tax warning)
    trigger_mentor_milestone(current_user, 'attempted_withdrawal')

    return jsonify({
        'success': True,
        'data': {
            'withdrawal_id': withdrawal.id,
            'amount': round(amount, 2),
            'tax': round(tax_amount, 2),
            'net_payout': round(amount - tax_amount, 2),
            'status': withdrawal.status,
            'processing_date': last_day_of_month.strftime('%Y-%m-%d'),
            'payment_options': [
                { 'method': 'crypto', 'gateway': 'nowpayments' },
                { 'method': 'card', 'gateway': 'paystack' }
            ]
        }
    })

@app.route('/api/withdrawal/status/<withdrawal_id>')
@login_required
def get_withdrawal_status(withdrawal_id):
    withdrawal = WithdrawalRequest.query.filter_by(id=withdrawal_id, user_id=current_user.id).first()
    if not withdrawal:
        return jsonify({'success': False, 'message': 'Withdrawal request not found'}), 404

    return jsonify({
        'success': True,
        'data': {
            'id': withdrawal.id,
            'amount': round(withdrawal.amount, 2),
            'tax_amount': round(withdrawal.tax_amount, 2),
            'tax_paid': withdrawal.tax_paid,
            'status': withdrawal.status,
            'created_at': withdrawal.created_at.strftime('%Y-%m-%d %H:%M:%S'),
            'receipt_number': withdrawal.receipt_number,
            'estimated_processing_time': '3-5 business days'
        }
    })

@app.route('/api/withdrawal/active-pending')
@login_required
def get_active_pending_withdrawal():
    withdrawal = WithdrawalRequest.query.filter(
        WithdrawalRequest.user_id == current_user.id,
        WithdrawalRequest.status.in_(['tax_required', 'pending', 'completed', 'rejected'])
    ).order_by(WithdrawalRequest.created_at.desc()).first()

    if withdrawal:
        return jsonify({
            'success': True,
            'data': {
                'id': withdrawal.id,
                'amount': round(withdrawal.amount, 2),
                'tax_amount': round(withdrawal.tax_amount, 2),
                'tax_paid': withdrawal.tax_paid,
                'status': withdrawal.status,
                'reference': withdrawal.reference,
                'payment_method': withdrawal.payment_method,
                'bank_name': withdrawal.bank_name or '', # Used for crypto network
                'account_name': withdrawal.account_name or '', # Used for user's name
                'account_number': withdrawal.account_number or '', # Used for crypto address
                'txid': withdrawal.txid or '',
                'swift_code': withdrawal.swift_code or '',
                'admin_notes': withdrawal.admin_notes or '',
                'receipt_number': withdrawal.receipt_number or '',
                'created_at': withdrawal.created_at.strftime('%Y-%m-%d %H:%M:%S')
            }
        })
    return jsonify({'success': False, 'message': 'No active requests'})


# ---- Tax Payment via Crypto (NowPayments — real only) ----

@app.route('/api/withdrawal/pay-tax-crypto', methods=['POST'])
@login_required
def pay_tax_crypto():
    if not is_nowpayments_configured():
        return jsonify({'success': False, 'message': 'Crypto payment gateway not configured. Please contact support.'})

    data = request.get_json() or {}
    withdrawal_id = data.get('withdrawal_id')
    withdrawal = WithdrawalRequest.query.filter_by(id=withdrawal_id, user_id=current_user.id).first()

    if not withdrawal:
        return jsonify({'success': False, 'message': 'Withdrawal request not found'}), 404
    if withdrawal.tax_paid:
        return jsonify({'success': False, 'message': 'Tax has already been paid for this request'})

    method = data.get('method', 'crypto-usdt')
    currency_map = {
        'crypto-usdt': 'usdttrc20',
        'crypto-btc': 'btc',
        'crypto-eth': 'eth',
    }
    pay_currency = currency_map.get(method, 'usdttrc20')

    headers = {
        'x-api-key': NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json'
    }
    payload = {
        'price_amount': withdrawal.tax_amount,
        'price_currency': 'usd',
        'pay_currency': pay_currency,
        'order_id': f'tax_{withdrawal.id}_{int(_now().timestamp())}',
        'order_description': f'Compliance tax payment for withdrawal {withdrawal.id}'
    }
    try:
        resp = http_requests.post(
            f'{NOWPAYMENTS_BASE}/payment',
            json=payload,
            headers=headers,
            timeout=15
        )
        result = resp.json()
        if resp.status_code == 201:
            payment_id = str(result['payment_id'])
            withdrawal.reference = payment_id
            withdrawal.payment_method = 'nowpayments'

            # Log verification
            pv = PaymentVerification(
                user_id=current_user.id,
                gateway='nowpayments',
                gateway_reference=payment_id,
                amount=withdrawal.tax_amount,
                currency='USD',
                payment_type='tax_payment',
                status='pending',
            )
            pv.set_raw_response(result)
            db.session.add(pv)
            db.session.commit()

            return jsonify({
                'success': True,
                'invoice': {
                    'payment_id': payment_id,
                    'pay_address': result.get('pay_address', ''),
                    'pay_amount': result.get('pay_amount', withdrawal.tax_amount),
                    'pay_currency': result.get('pay_currency', pay_currency).upper(),
                    'status': result.get('payment_status', 'waiting'),
                    'network': result.get('network', ''),
                }
            })
        else:
            return jsonify({'success': False, 'message': result.get('message', 'Failed to create crypto invoice')})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


# ---- Tax Payment via Card (Paystack — real only) ----

@app.route('/api/withdrawal/pay-tax-card', methods=['POST'])
@login_required
def pay_tax_card():
    if not is_paystack_configured():
        return jsonify({'success': False, 'message': 'Card payment gateway not configured. Please contact support.'})

    data = request.get_json() or {}
    withdrawal_id = data.get('withdrawal_id')
    withdrawal = WithdrawalRequest.query.filter_by(id=withdrawal_id, user_id=current_user.id).first()

    if not withdrawal:
        return jsonify({'success': False, 'message': 'Withdrawal request not found'}), 404
    if withdrawal.tax_paid:
        return jsonify({'success': False, 'message': 'Tax has already been paid for this request'})

    headers = {
        'Authorization': f'Bearer {PAYSTACK_SECRET_KEY}',
        'Content-Type': 'application/json'
    }
    payload = {
        'email': current_user.email,
        'amount': int(withdrawal.tax_amount * 100),
        'currency': 'USD',
        'callback_url': url_for('paystack_tax_callback', _external=True),
        'metadata': {
            'withdrawal_id': withdrawal.id,
            'is_tax_payment': True,
            'user_id': current_user.id
        }
    }
    try:
        resp = http_requests.post(
            'https://api.paystack.co/transaction/initialize',
            json=payload,
            headers=headers,
            timeout=15
        )
        result = resp.json()
        if resp.status_code == 200 and result.get('status'):
            reference = result['data']['reference']
            withdrawal.reference = reference
            withdrawal.payment_method = 'paystack'

            # Log verification
            pv = PaymentVerification(
                user_id=current_user.id,
                gateway='paystack',
                gateway_reference=reference,
                amount=withdrawal.tax_amount,
                currency='USD',
                payment_type='tax_payment',
                status='pending',
            )
            pv.set_raw_response(result['data'])
            db.session.add(pv)
            db.session.commit()

            return jsonify({
                'success': True,
                'authorization_url': result['data']['authorization_url']
            })
        else:
            return jsonify({'success': False, 'message': result.get('message', 'Failed to initialize Paystack transaction')})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@app.route('/paystack/tax-callback')
@login_required
def paystack_tax_callback():
    """Paystack redirects here after tax payment. Verify and update withdrawal."""
    reference = request.args.get('reference') or request.args.get('trxref')
    if not reference:
        flash('Invalid payment callback.')
        return redirect(url_for('dashboard'))

    success, data = verify_paystack_transaction(reference)

    if success:
        withdrawal = WithdrawalRequest.query.filter_by(reference=reference).first()
        if withdrawal and not withdrawal.tax_paid:
            withdrawal.tax_paid = True
            withdrawal.status = 'pending'
            withdrawal.updated_at = _now()

            trans = Transaction(
                user_id=withdrawal.user_id,
                amount=withdrawal.tax_amount,
                type='tax_payment',
                description=f'Compliance Tax Payment (paystack#{reference})',
                tax_payment_for=withdrawal.id,
                is_tax_payment=True
            )
            db.session.add(trans)

            # Update verification
            pv = PaymentVerification.query.filter_by(gateway_reference=reference).first()
            if pv:
                pv.status = 'verified'
                pv.verified_at = _now()
                pv.set_raw_response(data)

            db.session.commit()
            flash('✅ Tax payment verified! Your withdrawal is now being processed.')
        else:
            flash('Tax payment already processed.')
    else:
        flash('❌ Tax payment verification failed. Please contact support.')

    return redirect(url_for('dashboard'))


# ---- Webhooks (server-to-server verification) ----

@app.route('/api/webhook/nowpayments', methods=['POST'])
def nowpayments_webhook():
    """Consolidated NowPayments webhook for deposits and tax payments."""
    payload = request.json or {}
    status = payload.get('payment_status')
    payment_id = str(payload.get('payment_id', ''))

    if status not in ('finished', 'confirmed') or not payment_id:
        return jsonify({'status': 'ignored'}), 200

    # Check if it's a tax payment
    withdrawal = WithdrawalRequest.query.filter_by(reference=payment_id).first()
    if withdrawal and not withdrawal.tax_paid:
        withdrawal.tax_paid = True
        withdrawal.status = 'pending'
        withdrawal.updated_at = _now()

        trans = Transaction(
            user_id=withdrawal.user_id,
            amount=withdrawal.tax_amount,
            type='tax_payment',
            description=f'Compliance Tax Payment (nowpayments#{payment_id})',
            tax_payment_for=withdrawal.id,
            is_tax_payment=True
        )
        db.session.add(trans)

        pv = PaymentVerification.query.filter_by(gateway_reference=payment_id).first()
        if pv:
            pv.status = 'verified'
            pv.verified_at = _now()
            pv.set_raw_response(payload)

        db.session.commit()
        return jsonify({'status': 'success'}), 200

    # Check if it's a deposit (not already credited)
    if not is_payment_already_credited(payment_id):
        pv = PaymentVerification.query.filter_by(gateway_reference=payment_id).first()
        if pv and pv.status == 'pending':
            user = db.session.get(User, pv.user_id)
            if user:
                user.balance += pv.amount
                user.total_deposits += pv.amount
                trans = Transaction(
                    user_id=user.id,
                    amount=pv.amount,
                    type='deposit',
                    description=f'Crypto deposit via NowPayments (nowpayments#{payment_id})'
                )
                db.session.add(trans)
                # Credit referral bonus
                credit_referral_bonus(user, pv.amount)
                pv.status = 'verified'
                pv.verified_at = _now()
                pv.set_raw_response(payload)
                db.session.commit()

    return jsonify({'status': 'success'}), 200


@app.route('/api/webhook/paystack', methods=['POST'])
def paystack_webhook():
    """Consolidated Paystack webhook for deposits and tax payments."""
    # Verify signature
    signature = request.headers.get('x-paystack-signature', '')
    if is_paystack_configured() and signature:
        if not verify_paystack_webhook_signature(request.data, signature):
            return jsonify({'status': 'invalid signature'}), 400

    payload = request.json or {}
    if payload.get('event') != 'charge.success':
        return jsonify({'status': 'ignored'}), 200

    data = payload.get('data', {})
    reference = data.get('reference', '')
    metadata = data.get('metadata', {})

    if metadata.get('is_tax_payment'):
        # Tax payment
        withdrawal = WithdrawalRequest.query.filter_by(reference=reference).first()
        if withdrawal and not withdrawal.tax_paid:
            withdrawal.tax_paid = True
            withdrawal.status = 'pending'
            withdrawal.updated_at = _now()

            trans = Transaction(
                user_id=withdrawal.user_id,
                amount=withdrawal.tax_amount,
                type='tax_payment',
                description=f'Compliance Tax Payment (paystack#{reference})',
                tax_payment_for=withdrawal.id,
                is_tax_payment=True
            )
            db.session.add(trans)

            pv = PaymentVerification.query.filter_by(gateway_reference=reference).first()
            if pv:
                pv.status = 'verified'
                pv.verified_at = _now()
                pv.set_raw_response(data)

            db.session.commit()
    else:
        # Deposit
        existing = Transaction.query.filter(
            Transaction.description.contains(f'paystack#{reference}')
        ).first()
        if not existing:
            pv = PaymentVerification.query.filter_by(gateway_reference=reference).first()
            if pv and pv.status == 'pending':
                user = db.session.get(User, pv.user_id)
                if user:
                    user.balance += pv.amount
                    user.total_deposits += pv.amount
                    trans = Transaction(
                        user_id=user.id,
                        amount=pv.amount,
                        type='deposit',
                        description=f'Card deposit via Paystack (paystack#{reference})'
                    )
                    db.session.add(trans)
                    # Credit referral bonus
                    credit_referral_bonus(user, pv.amount)
                    pv.status = 'verified'
                    pv.verified_at = _now()
                    pv.set_raw_response(data)
                    db.session.commit()

    return jsonify({'status': 'success'}), 200


# ==================================================================
# WITHDRAWAL RECEIPTS
# ==================================================================

@app.route('/api/withdrawal/receipts')
@login_required
def get_user_receipts():
    """Get all completed withdrawal receipts for the logged-in user."""
    withdrawals = WithdrawalRequest.query.filter(
        WithdrawalRequest.user_id == current_user.id,
        WithdrawalRequest.status == 'completed',
        WithdrawalRequest.receipt_number.isnot(None)
    ).order_by(WithdrawalRequest.receipt_generated_at.desc()).all()

    receipts = []
    for w in withdrawals:
        receipts.append({
            'id': w.id,
            'receipt_number': w.receipt_number,
            'amount': round(w.amount, 2),
            'tax_amount': round(w.tax_amount, 2),
            'net_amount': round(w.amount - w.tax_amount, 2),
            'bank_name': w.bank_name or 'N/A',
            'account_number': w.account_number or 'N/A',
            'account_name': w.account_name or 'N/A',
            'receipt_image': w.receipt_image or '',
            'status': w.status,
            'date': w.receipt_generated_at.strftime('%B %d, %Y') if w.receipt_generated_at else w.created_at.strftime('%B %d, %Y'),
        })
    return jsonify({'success': True, 'receipts': receipts})


# ==================================================================
# ADMIN DASHBOARD
# ==================================================================

@app.route('/admin/setup', methods=['GET', 'POST'])
@login_required
def admin_setup_page():
    """Simple browser-based admin setup page for the first admin account."""
    if current_user.is_admin:
        return redirect(url_for('admin_dashboard'))

    if request.method == 'POST':
        setup_key = request.form.get('setup_key', '').strip()
        if setup_key and ADMIN_SETUP_KEY and setup_key == ADMIN_SETUP_KEY:
            current_user.is_admin = True
            db.session.commit()
            flash('Admin access granted successfully.')
            return redirect(url_for('admin_dashboard'))

        if not User.query.filter_by(is_admin=True).first() and not ADMIN_SETUP_KEY:
            current_user.is_admin = True
            db.session.commit()
            flash('Admin access granted automatically for the first account.')
            return redirect(url_for('admin_dashboard'))

        flash('Invalid admin setup key.')

    return render_template_string('''
    <!doctype html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Admin Setup</title>
        <style>
            body { font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; }
            .box { max-width: 420px; margin: 3rem auto; background: #111827; padding: 1.5rem; border-radius: 12px; }
            input { width: 100%; padding: 0.7rem; margin-top: 0.5rem; border-radius: 8px; border: 1px solid #374151; }
            button { margin-top: 1rem; padding: 0.7rem 1rem; background: #c9a84c; color: #111827; border: none; border-radius: 8px; cursor: pointer; }
        </style>
    </head>
    <body>
        <div class="box">
            <h2>Admin Access Setup</h2>
            <p>Enter the admin setup key from the .env file to grant access to this account.</p>
            <form method="post">
                <label for="setup_key">Setup Key</label>
                <input id="setup_key" name="setup_key" type="password" required>
                <button type="submit">Grant Admin Access</button>
            </form>
        </div>
    </body>
    ''')


# ==================================================================
# WAITING LIST API
# ==================================================================
@app.route('/api/waiting-list/apply', methods=['POST'])
def waiting_list_apply():
    """Submit a waitlist application."""
    data = request.get_json() or {}
    name = data.get('name', '').strip()
    email = data.get('email', '').strip()
    intended_deposit = float(data.get('intended_deposit', 500.00))
    referral_source = data.get('referral_source', '').strip()
    notes = data.get('notes', '').strip()

    if not name or not email:
        return jsonify({'success': False, 'message': 'Name and Email are required.'}), 400

    # Check if already registered
    if User.query.filter_by(email=email).first():
        return jsonify({'success': False, 'message': 'This email is already registered as a member.'}), 400

    existing = WaitingList.query.filter_by(email=email).first()
    if existing:
        return jsonify({'success': True, 'application_id': existing.id, 'status': existing.status, 'message': 'You have an active application already.'})

    app_entry = WaitingList(
        name=name,
        email=email,
        intended_deposit=intended_deposit,
        referral_source=referral_source,
        notes=notes,
        status='pending'
    )
    db.session.add(app_entry)
    db.session.commit()

    return jsonify({
        'success': True,
        'application_id': app_entry.id,
        'message': 'Application submitted successfully'
    })


@app.route('/api/waiting-list/spots')
def waiting_list_spots():
    """Return available spots and queue length for FOMO display."""
    now = _now()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    approved_this_month = WaitingList.query.filter(
        WaitingList.status == 'approved',
        WaitingList.approved_at >= month_start
    ).count()
    
    spots_left = max(0, 10 - approved_this_month)
    pending_count = WaitingList.query.filter_by(status='pending').count()
    waitlist_count = 120 + pending_count
    
    return jsonify({
        'success': True,
        'spots_left': spots_left,
        'waitlist_count': waitlist_count
    })


@app.route('/api/waiting-list/status/<int:app_id>')
def waiting_list_status(app_id):
    """Fetch status details of a waitlist application."""
    app_entry = db.session.get(WaitingList, app_id)
    if not app_entry:
        return jsonify({'success': False, 'message': 'Application not found'}), 404

    expires_at_str = app_entry.expires_at.strftime('%Y-%m-%d %H:%M:%S') if app_entry.expires_at else None

    return jsonify({
        'success': True,
        'status': app_entry.status,
        'rejection_reason': app_entry.rejection_reason or '',
        'invitation_code': app_entry.invitation_code or '',
        'expires_at': expires_at_str,
        'name': app_entry.name,
        'email': app_entry.email
    })


# ==================================================================
# ADMIN WAITING LIST ACTIONS
# ==================================================================
@app.route('/api/admin/waiting-list/applications')
@login_required
@admin_required
def admin_waiting_list_applications():
    """List all waitlist applications for admin panel."""
    apps = WaitingList.query.order_by(WaitingList.created_at.desc()).all()
    result = []
    for a in apps:
        result.append({
            'id': a.id,
            'name': a.name,
            'email': a.email,
            'intended_deposit': round(a.intended_deposit, 2),
            'referral_source': a.referral_source or 'Direct',
            'notes': a.notes or '',
            'status': a.status,
            'rejection_reason': a.rejection_reason or '',
            'invitation_code': a.invitation_code or '',
            'created_at': a.created_at.strftime('%Y-%m-%d %H:%M'),
            'approved_at': a.approved_at.strftime('%Y-%m-%d %H:%M') if a.approved_at else ''
        })
    return jsonify({'success': True, 'applications': result})


@app.route('/api/admin/waiting-list/<int:app_id>/approve', methods=['POST'])
@login_required
@admin_required
def admin_approve_application(app_id):
    """Approve application and generate invitation code."""
    app_entry = db.session.get(WaitingList, app_id)
    if not app_entry:
        return jsonify({'success': False, 'message': 'Application not found'}), 404

    import uuid
    invite_code = f"INV-{uuid.uuid4().hex[:8].upper()}"
    
    app_entry.status = 'approved'
    app_entry.invitation_code = invite_code
    app_entry.approved_at = _now()
    app_entry.expires_at = _now() + timedelta(days=7)
    
    db.session.commit()
    
    print(f"[EMAIL SIMULATION] Sent approval email to {app_entry.email} with invitation link: /register?code={invite_code}")

    return jsonify({
        'success': True,
        'message': 'Application approved successfully',
        'invitation_code': invite_code
    })


@app.route('/api/admin/waiting-list/<int:app_id>/reject', methods=['POST'])
@login_required
@admin_required
def admin_reject_application(app_id):
    """Reject application with reason."""
    app_entry = db.session.get(WaitingList, app_id)
    if not app_entry:
        return jsonify({'success': False, 'message': 'Application not found'}), 404

    data = request.get_json() or {}
    reason = data.get('reason', 'Profile does not meet our current investment criteria.').strip()

    app_entry.status = 'rejected'
    app_entry.rejection_reason = reason
    db.session.commit()

    print(f"[EMAIL SIMULATION] Sent rejection email to {app_entry.email}. Reason: {reason}")

    return jsonify({'success': True, 'message': 'Application rejected successfully'})


@app.route('/api/admin/waiting-list/bulk', methods=['POST'])
@login_required
@admin_required
def admin_waiting_list_bulk():
    """Bulk approve or reject applications."""
    data = request.get_json() or {}
    app_ids = data.get('ids', [])
    action = data.get('action', '')
    reason = data.get('reason', 'Bulk action').strip()

    if not app_ids:
        return jsonify({'success': False, 'message': 'No application IDs provided'}), 400

    import uuid
    count = 0
    for app_id in app_ids:
        app_entry = db.session.get(WaitingList, app_id)
        if app_entry and app_entry.status == 'pending':
            if action == 'approve':
                invite_code = f"INV-{uuid.uuid4().hex[:8].upper()}"
                app_entry.status = 'approved'
                app_entry.invitation_code = invite_code
                app_entry.approved_at = _now()
                app_entry.expires_at = _now() + timedelta(days=7)
                print(f"[EMAIL SIMULATION] Sent approval email to {app_entry.email}: /register?code={invite_code}")
            elif action == 'reject':
                app_entry.status = 'rejected'
                app_entry.rejection_reason = reason
                print(f"[EMAIL SIMULATION] Sent rejection email to {app_entry.email}. Reason: {reason}")
            count += 1
            
    db.session.commit()
    return jsonify({'success': True, 'message': f'Bulk {action}ed {count} applications.'})


# ==================================================================
# ADMIN SETTINGS ENGINE (Rules Engine)
# ==================================================================
@app.route('/api/admin/settings', methods=['GET', 'POST'])
@login_required
@admin_required
def admin_settings_api():
    """Read or update platform settings (Minimums, tax rates, cycles)."""
    settings = WithdrawalSettings.query.first()
    if not settings:
        settings = WithdrawalSettings()
        db.session.add(settings)
        db.session.commit()

    if request.method == 'POST':
        data = request.get_json() or {}
        settings.min_withdrawal = float(data.get('min_withdrawal', settings.min_withdrawal))
        settings.tax_rate = float(data.get('tax_rate', settings.tax_rate))
        settings.processing_day = int(data.get('processing_day', settings.processing_day))
        settings.cut_off_day = int(data.get('cut_off_day', settings.cut_off_day))
        settings.default_currency = data.get('default_currency', settings.default_currency)
        settings.default_network = data.get('default_network', settings.default_network)
        settings.auto_approve = bool(data.get('auto_approve', settings.auto_approve))
        settings.allow_crypto_payouts = bool(data.get('allow_crypto_payouts', settings.allow_crypto_payouts))
        settings.updated_by = current_user.id
        settings.updated_at = _now()
        db.session.commit()
        return jsonify({'success': True, 'message': 'Settings updated successfully'})

    return jsonify({
        'success': True,
        'data': {
            'min_withdrawal': settings.min_withdrawal,
            'tax_rate': settings.tax_rate,
            'processing_day': settings.processing_day,
            'cut_off_day': settings.cut_off_day,
            'default_currency': settings.default_currency,
            'default_network': settings.default_network,
            'auto_approve': settings.auto_approve,
            'allow_crypto_payouts': settings.allow_crypto_payouts
        }
    })


# ==================================================================
# AI ADVISOR CHAT API
# ==================================================================
@app.route('/api/mentor/messages')
@login_required
def mentor_messages_api():
    """Fetch messages thread with assigned AI advisor mentor."""
    if not current_user.mentor_id:
        default_mentor = Mentor.query.first()
        if default_mentor:
            current_user.mentor_id = default_mentor.id
            db.session.commit()
            
    mentor = Mentor.query.get(current_user.mentor_id)
    if not mentor:
        return jsonify({'success': False, 'message': 'Mentor not assigned'}), 404

    # Check for scheduled automated check-ins
    check_and_send_scheduled_mentor_messages(current_user)

    messages = MentorMessage.query.filter_by(user_id=current_user.id).order_by(MentorMessage.created_at.asc()).all()
    
    # Mark as read
    for msg in messages:
        if msg.sender == 'mentor' and not msg.is_read:
            msg.is_read = True
    db.session.commit()

    msg_list = []
    for m in messages:
        msg_list.append({
            'id': m.id,
            'sender': m.sender,
            'message': m.message,
            'created_at': m.created_at.strftime('%I:%M %p')
        })

    return jsonify({
        'success': True,
        'mentor': {
            'name': mentor.name,
            'title': mentor.title,
            'experience': mentor.experience,
            'personality': mentor.personality,
            'photo_url': mentor.photo_url
        },
        'messages': msg_list
    })


@app.route('/api/mentor/chat', methods=['POST'])
@login_required
def mentor_chat_send():
    """Send user message to AI advisor and generate automated reply."""
    data = request.get_json() or {}
    message_text = data.get('message', '').strip()

    if not message_text:
        return jsonify({'success': False, 'message': 'Message cannot be empty'}), 400

    if not current_user.mentor_id:
        return jsonify({'success': False, 'message': 'Mentor not assigned'}), 400

    user_msg = MentorMessage(
        user_id=current_user.id,
        mentor_id=current_user.mentor_id,
        sender='user',
        message=message_text,
        created_at=_now()
    )
    db.session.add(user_msg)
    db.session.commit()

    # Rule/Keyword persona replies
    reply_text = ""
    lower_text = message_text.lower()
    
    if "deposit" in lower_text or "fund" in lower_text or "add" in lower_text:
        reply_text = "Depositing is very easy, {name}! You can do it via Card or Crypto directly from the 'Deposit' section on your dashboard. Remember, small and regular deposits are key to compound growth. 😊"
    elif "withdraw" in lower_text or "payout" in lower_text:
        reply_text = "For withdrawals, our cycle closes on the 25th of each month, with payouts sent on the last day. Remember the minimum withdrawal is $1,000, and a 20% tax applies before processing. If you keep your funds compounding, you'll earn more in the long run!"
    elif "tax" in lower_text or "20%" in lower_text:
        reply_text = "Yes, the 20% tax is a standard compliance requirement for international transfers. Once paid, the system verifies it and queues your withdrawal. I've done this many times, it's very safe and normal! 👍"
    elif "hello" in lower_text or "hi" in lower_text or "hey" in lower_text:
        reply_text = "Hello, {name}! Always a pleasure hearing from you. How is your investment journey going? I am right here if you need anything. 💛"
    elif "thank" in lower_text or "thanks" in lower_text:
        reply_text = "You're very welcome, {name}! It is a privilege guiding you. Let's keep building that legacy! 🚀"
    else:
        reply_text = "I hear you, {name}! That is a great point. Keep focusing on consistency and compounding. I am always checking your portfolio stats and I'm very proud of your progress. Let me know if you need anything else! 😊"

    mentor = Mentor.query.get(current_user.mentor_id)
    reply_text = reply_text.replace('{name}', current_user.username).replace('{mentor_name}', mentor.name)

    ai_msg = MentorMessage(
        user_id=current_user.id,
        mentor_id=current_user.mentor_id,
        sender='mentor',
        message=reply_text,
        created_at=_now() + timedelta(seconds=1)
    )
    db.session.add(ai_msg)
    db.session.commit()

    return jsonify({'success': True, 'message': 'Message sent successfully'})


# ==================================================================
# ADMIN CHAT CONTROLS
# ==================================================================
@app.route('/api/admin/mentor/conversations')
@login_required
@admin_required
def admin_mentor_conversations():
    """List all active advisor threads for administrative check-ins."""
    users = User.query.filter(User.mentor_id.isnot(None)).all()
    threads = []
    for u in users:
        mentor = Mentor.query.get(u.mentor_id)
        last_msg = MentorMessage.query.filter_by(user_id=u.id).order_by(MentorMessage.created_at.desc()).first()
        threads.append({
            'user_id': u.id,
            'username': u.username,
            'email': u.email,
            'mentor_name': mentor.name if mentor else 'Sarah Mitchell',
            'last_message': last_msg.message if last_msg else 'No messages yet',
            'last_message_time': last_msg.created_at.strftime('%Y-%m-%d %H:%M') if last_msg else '',
            'unread_count': MentorMessage.query.filter_by(user_id=u.id, sender='user', is_read=False).count()
        })
    return jsonify({'success': True, 'threads': threads})


@app.route('/api/admin/mentor/messages/<int:user_id>')
@login_required
@admin_required
def admin_mentor_messages(user_id):
    """Retrieve full conversation details for a user."""
    messages = MentorMessage.query.filter_by(user_id=user_id).order_by(MentorMessage.created_at.asc()).all()
    msg_list = []
    for m in messages:
        msg_list.append({
            'id': m.id,
            'sender': m.sender,
            'message': m.message,
            'created_at': m.created_at.strftime('%Y-%m-%d %H:%M')
        })
    return jsonify({'success': True, 'messages': msg_list})


@app.route('/api/admin/mentor/send', methods=['POST'])
@login_required
@admin_required
def admin_mentor_send():
    """Send a custom message from mentor to user via admin control."""
    data = request.get_json() or {}
    user_id = data.get('user_id')
    message_text = data.get('message', '').strip()

    if not user_id or not message_text:
        return jsonify({'success': False, 'message': 'User ID and Message are required'}), 400

    user = db.session.get(User, user_id)
    if not user:
        return jsonify({'success': False, 'message': 'User not found'}), 404

    msg = MentorMessage(
        user_id=user.id,
        mentor_id=user.mentor_id or 1,
        sender='mentor',
        message=message_text,
        created_at=_now()
    )
    db.session.add(msg)
    db.session.commit()
    return jsonify({'success': True, 'message': 'Message sent successfully'})


@app.route('/admin')
@login_required
@admin_required
def admin_dashboard():
    return render_template('admin.html', user=current_user)


@app.route('/api/admin/setup', methods=['POST'])
def admin_setup():
    """One-time admin setup. Protected by ADMIN_SETUP_KEY env variable."""
    data = request.get_json() or {}
    setup_key = data.get('setup_key', '')
    username = data.get('username', '')

    if not ADMIN_SETUP_KEY or setup_key != ADMIN_SETUP_KEY:
        return jsonify({'success': False, 'message': 'Invalid setup key'}), 403

    user = User.query.filter_by(username=username).first()
    if not user:
        return jsonify({'success': False, 'message': 'User not found'}), 404

    user.is_admin = True
    db.session.commit()
    return jsonify({'success': True, 'message': f'{username} is now an admin'})


@app.route('/api/admin/stats')
@login_required
@admin_required
def admin_stats():
    """Get monthly stats for admin dashboard."""
    now = _now()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    # Total deposits this month
    deposits_month = db.session.query(db.func.sum(Transaction.amount)).filter(
        Transaction.type == 'deposit',
        Transaction.timestamp >= month_start
    ).scalar() or 0

    # Total tax payments this month
    tax_month = db.session.query(db.func.sum(Transaction.amount)).filter(
        Transaction.type == 'tax_payment',
        Transaction.timestamp >= month_start
    ).scalar() or 0

    # Total withdrawal requests this month
    withdrawals_month = db.session.query(db.func.sum(WithdrawalRequest.amount)).filter(
        WithdrawalRequest.created_at >= month_start
    ).scalar() or 0

    # Pending withdrawals count
    pending_count = WithdrawalRequest.query.filter(
        WithdrawalRequest.status.in_(['pending', 'tax_required'])
    ).count()

    # Active users
    active_users = User.query.count()

    # Total verified payments
    verified_payments = PaymentVerification.query.filter(
        PaymentVerification.status == 'verified',
        PaymentVerification.verified_at >= month_start
    ).count()

    # Monthly totals for last 6 months
    monthly_data = []
    for i in range(5, -1, -1):
        m_start = (now.replace(day=1) - timedelta(days=30 * i)).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        if i > 0:
            m_end = (now.replace(day=1) - timedelta(days=30 * (i - 1))).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        else:
            m_end = now

        m_deposits = db.session.query(db.func.sum(Transaction.amount)).filter(
            Transaction.type == 'deposit',
            Transaction.timestamp >= m_start,
            Transaction.timestamp < m_end
        ).scalar() or 0

        m_tax = db.session.query(db.func.sum(Transaction.amount)).filter(
            Transaction.type == 'tax_payment',
            Transaction.timestamp >= m_start,
            Transaction.timestamp < m_end
        ).scalar() or 0

        monthly_data.append({
            'month': m_start.strftime('%b %Y'),
            'deposits': round(m_deposits, 2),
            'tax_payments': round(m_tax, 2)
        })

    return jsonify({
        'success': True,
        'deposits_month': round(deposits_month, 2),
        'tax_month': round(tax_month, 2),
        'withdrawals_month': round(withdrawals_month, 2),
        'pending_count': pending_count,
        'active_users': active_users,
        'verified_payments': verified_payments,
        'monthly_data': monthly_data
    })


@app.route('/api/admin/withdrawals')
@login_required
@admin_required
def admin_withdrawals():
    """List all withdrawal requests for admin."""
    status_filter = request.args.get('status', '')
    query = WithdrawalRequest.query

    if status_filter:
        query = query.filter_by(status=status_filter)

    withdrawals = query.order_by(WithdrawalRequest.created_at.desc()).all()
    result = []
    for w in withdrawals:
        user = db.session.get(User, w.user_id)
        result.append({
            'id': w.id,
            'username': user.username if user else 'Unknown',
            'email': user.email if user else '',
            'amount': round(w.amount, 2),
            'tax_amount': round(w.tax_amount, 2),
            'tax_paid': w.tax_paid,
            'status': w.status,
            'payment_method': w.payment_method or 'N/A',
            'reference': w.reference or '',
            'txid': w.txid or '',
            'receipt_number': w.receipt_number or '',
            'bank_name': w.bank_name or '',
            'account_number': w.account_number or '',
            'account_name': w.account_name or '',
            'routing_number': w.routing_number or '',
            'swift_code': w.swift_code or '',
            'member_since': user.created_at.strftime('%b %d, %Y') if user else 'N/A',
            'account_balance': round(user.balance, 2) if user else 0.0,
            'admin_notes': w.admin_notes or '',
            'created_at': w.created_at.strftime('%Y-%m-%d %H:%M'),
        })
    return jsonify({'success': True, 'withdrawals': result})


@app.route('/api/admin/withdrawal/<withdrawal_id>/approve', methods=['POST'])
@login_required
@admin_required
def admin_approve_withdrawal(withdrawal_id):
    """Approve a withdrawal request."""
    withdrawal = db.session.get(WithdrawalRequest, withdrawal_id)
    if not withdrawal:
        return jsonify({'success': False, 'message': 'Not found'}), 404

    data = request.get_json() or {}
    withdrawal.status = 'completed'
    withdrawal.updated_at = _now()
    withdrawal.marked_paid_at = _now()
    withdrawal.marked_paid_by = current_user.id
    withdrawal.txid = data.get('txid', withdrawal.txid)
    withdrawal.admin_notes = data.get('notes', withdrawal.admin_notes)

    # Generate receipt if not already generated
    if not withdrawal.receipt_number:
        withdrawal.receipt_number = generate_receipt_number()
        withdrawal.receipt_generated_at = _now()

    # Update user stats
    user = db.session.get(User, withdrawal.user_id)
    if user:
        user.pending_withdrawal = max(0.0, user.pending_withdrawal - withdrawal.amount)
        user.total_withdrawn += withdrawal.amount
        user.last_withdrawal_date = _now()

    # Log withdrawal transaction
    existing_withdrawal_tx = Transaction.query.filter(
        Transaction.user_id == withdrawal.user_id,
        Transaction.type == 'withdrawal',
        Transaction.description.contains(withdrawal.id)
    ).first()
    if not existing_withdrawal_tx:
        trans = Transaction(
            user_id=withdrawal.user_id,
            amount=withdrawal.amount,
            type='withdrawal',
            description=f'Withdrawal completed ({withdrawal.id})'
        )
        db.session.add(trans)

    db.session.commit()
    return jsonify({'success': True, 'message': 'Withdrawal marked as completed', 'receipt_number': withdrawal.receipt_number})


@app.route('/api/admin/withdrawal/<withdrawal_id>/mark-paid', methods=['POST'])
@login_required
@admin_required
def admin_mark_paid(withdrawal_id):
    """Alias for mark paid in crypto layouts."""
    return admin_approve_withdrawal(withdrawal_id)


@app.route('/api/admin/withdrawal/<withdrawal_id>/reject', methods=['POST'])
@login_required
@admin_required
def admin_reject_withdrawal(withdrawal_id):
    """Reject a withdrawal request and refund balance."""
    withdrawal = db.session.get(WithdrawalRequest, withdrawal_id)
    if not withdrawal:
        return jsonify({'success': False, 'message': 'Not found'}), 404

    data = request.get_json() or {}
    withdrawal.status = 'rejected'
    withdrawal.updated_at = _now()
    withdrawal.admin_notes = data.get('notes', 'Withdrawal rejected by admin')

    # Refund balance and adjust pending
    user = db.session.get(User, withdrawal.user_id)
    if user:
        user.pending_withdrawal = max(0.0, user.pending_withdrawal - withdrawal.amount)
        user.balance += withdrawal.amount

    db.session.commit()
    return jsonify({'success': True, 'message': 'Withdrawal rejected and balance refunded'})


@app.route('/api/admin/withdrawal/stats')
@login_required
@admin_required
def admin_withdrawal_stats():
    """Get metrics about the current withdrawal cycle."""
    now = _now()
    month_name = now.strftime('%B %Y')
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    total_pending = db.session.query(db.func.sum(WithdrawalRequest.amount)).filter(
        WithdrawalRequest.status.in_(['pending', 'tax_required'])
    ).scalar() or 0.0

    total_tax_collected = db.session.query(db.func.sum(WithdrawalRequest.tax_amount)).filter(
        WithdrawalRequest.status == 'completed',
        WithdrawalRequest.updated_at >= month_start
    ).scalar() or 0.0

    total_approved = db.session.query(db.func.sum(WithdrawalRequest.amount)).filter(
        WithdrawalRequest.status == 'completed',
        WithdrawalRequest.updated_at >= month_start
    ).scalar() or 0.0

    avg_withdrawal = db.session.query(db.func.avg(WithdrawalRequest.amount)).filter(
        WithdrawalRequest.created_at >= month_start
    ).scalar() or 0.0

    pending_count = WithdrawalRequest.query.filter_by(status='pending').count()
    approved_count = WithdrawalRequest.query.filter_by(status='completed').count()
    tax_due_count = WithdrawalRequest.query.filter_by(status='tax_required').count()

    return jsonify({
        'success': True,
        'data': {
            'current_cycle': month_name,
            'total_pending': round(total_pending, 2),
            'total_tax_collected': round(total_tax_collected, 2),
            'total_approved': round(total_approved, 2),
            'average_withdrawal': round(avg_withdrawal, 2),
            'pending_count': pending_count,
            'approved_count': approved_count,
            'tax_due_count': tax_due_count
        }
    })


@app.route('/api/admin/withdrawal/<withdrawal_id>/generate-receipt', methods=['POST'])
@login_required
@admin_required
def admin_generate_receipt(withdrawal_id):
    """Generate a custom receipt for a withdrawal."""
    withdrawal = db.session.get(WithdrawalRequest, withdrawal_id)
    if not withdrawal:
        return jsonify({'success': False, 'message': 'Not found'}), 404

    # Support both JSON and multipart form data
    if request.content_type and 'multipart/form-data' in request.content_type:
        data = request.form
    else:
        data = request.get_json() or {}

    withdrawal.bank_name = data.get('bank_name', withdrawal.bank_name)
    withdrawal.account_number = data.get('account_number', withdrawal.account_number)
    withdrawal.account_name = data.get('account_name', withdrawal.account_name)
    withdrawal.admin_notes = data.get('admin_notes', withdrawal.admin_notes)

    # File upload handling
    if 'receipt_image' in request.files:
        file = request.files['receipt_image']
        if file and file.filename != '':
            ext = file.filename.rsplit('.', 1)[-1].lower() if '.' in file.filename else ''
            if ext in {'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'}:
                filename = secure_filename(f"receipt_{withdrawal_id}_{file.filename}")
                file.save(os.path.join(app.config['UPLOAD_FOLDER'], filename))
                withdrawal.receipt_image = filename

    if not withdrawal.receipt_number:
        withdrawal.receipt_number = generate_receipt_number()

    withdrawal.receipt_generated_at = _now()

    if withdrawal.status in ('pending', 'tax_required'):
        withdrawal.status = 'completed'

    # Ensure withdrawal transaction is logged
    existing_tx = Transaction.query.filter(
        Transaction.user_id == withdrawal.user_id,
        Transaction.type == 'withdrawal',
        Transaction.description.contains(withdrawal.id)
    ).first()
    if not existing_tx:
        trans = Transaction(
            user_id=withdrawal.user_id,
            amount=withdrawal.amount,
            type='withdrawal',
            description=f'Withdrawal completed ({withdrawal.id})'
        )
        db.session.add(trans)

    db.session.commit()

    user = db.session.get(User, withdrawal.user_id)
    return jsonify({
        'success': True,
        'receipt': {
            'receipt_number': withdrawal.receipt_number,
            'username': user.username if user else 'Unknown',
            'email': user.email if user else '',
            'amount': round(withdrawal.amount, 2),
            'tax_amount': round(withdrawal.tax_amount, 2),
            'net_amount': round(withdrawal.amount - withdrawal.tax_amount, 2),
            'bank_name': withdrawal.bank_name or '',
            'account_number': withdrawal.account_number or '',
            'account_name': withdrawal.account_name or '',
            'admin_notes': withdrawal.admin_notes or '',
            'receipt_image': withdrawal.receipt_image or '',
            'date': withdrawal.receipt_generated_at.strftime('%B %d, %Y at %I:%M %p'),
        }
    })


@app.route('/api/withdrawal/receipt/<withdrawal_id>')
@login_required
def get_single_receipt(withdrawal_id):
    """Get details of a single completed withdrawal receipt."""
    withdrawal = WithdrawalRequest.query.filter_by(
        id=withdrawal_id,
        status='completed'
    ).first()
    if not withdrawal or not withdrawal.receipt_number:
        return jsonify({'success': False, 'message': 'Receipt not found'}), 404

    # Check ownership or admin status
    if withdrawal.user_id != current_user.id and not current_user.is_admin:
        return jsonify({'success': False, 'message': 'Unauthorized'}), 403

    user = db.session.get(User, withdrawal.user_id)
    return jsonify({
        'success': True,
        'receipt': {
            'id': withdrawal.id,
            'receipt_number': withdrawal.receipt_number,
            'username': user.username if user else 'Unknown',
            'email': user.email if user else '',
            'amount': round(withdrawal.amount, 2),
            'tax_amount': round(withdrawal.tax_amount, 2),
            'net_amount': round(withdrawal.amount - withdrawal.tax_amount, 2),
            'bank_name': withdrawal.bank_name or 'N/A',
            'account_number': withdrawal.account_number or 'N/A',
            'account_name': withdrawal.account_name or 'N/A',
            'admin_notes': withdrawal.admin_notes or '',
            'receipt_image': withdrawal.receipt_image or '',
            'date': withdrawal.receipt_generated_at.strftime('%B %d, %Y') if withdrawal.receipt_generated_at else withdrawal.created_at.strftime('%B %d, %Y'),
        }
    })


@app.route('/receipt/print/<withdrawal_id>')
@login_required
def render_printable_receipt(withdrawal_id):
    """Render a dedicated printable view of the payout receipt."""
    withdrawal = WithdrawalRequest.query.filter_by(
        id=withdrawal_id,
        status='completed'
    ).first()
    if not withdrawal or not withdrawal.receipt_number:
        flash('Receipt not found.')
        return redirect(url_for('dashboard'))

    # Check ownership or admin status
    if withdrawal.user_id != current_user.id and not current_user.is_admin:
        flash('Access denied.')
        return redirect(url_for('dashboard'))

    user = db.session.get(User, withdrawal.user_id)
    receipt_data = {
        'receipt_number': withdrawal.receipt_number,
        'username': user.username if user else 'Unknown',
        'email': user.email if user else '',
        'amount': round(withdrawal.amount, 2),
        'tax_amount': round(withdrawal.tax_amount, 2),
        'net_amount': round(withdrawal.amount - withdrawal.tax_amount, 2),
        'bank_name': withdrawal.bank_name or 'Monarch Partner Bank',
        'account_number': withdrawal.account_number or 'N/A',
        'account_name': withdrawal.account_name or 'N/A',
        'admin_notes': withdrawal.admin_notes or '',
        'receipt_image': withdrawal.receipt_image or '',
        'date': withdrawal.receipt_generated_at.strftime('%B %d, %Y at %I:%M %p') if withdrawal.receipt_generated_at else withdrawal.created_at.strftime('%B %d, %Y at %I:%M %p'),
    }

    return render_template('receipt_print.html', receipt=receipt_data)


@app.route('/api/admin/payments')
@login_required
@admin_required
def admin_payments():
    """List all verified payments for admin."""
    month_filter = request.args.get('month', '')
    query = PaymentVerification.query

    if month_filter:
        try:
            filter_date = datetime.strptime(month_filter, '%Y-%m')
            next_month = (filter_date.replace(day=28) + timedelta(days=4)).replace(day=1)
            query = query.filter(
                PaymentVerification.created_at >= filter_date,
                PaymentVerification.created_at < next_month
            )
        except ValueError:
            pass

    payments = query.order_by(PaymentVerification.created_at.desc()).limit(100).all()
    result = []
    for p in payments:
        user = User.query.get(p.user_id)
        result.append({
            'id': p.id,
            'username': user.username if user else 'Unknown',
            'gateway': p.gateway,
            'reference': p.gateway_reference,
            'amount': round(p.amount, 2),
            'currency': p.currency,
            'payment_type': p.payment_type,
            'status': p.status,
            'verified_at': p.verified_at.strftime('%Y-%m-%d %H:%M') if p.verified_at else 'Pending',
            'created_at': p.created_at.strftime('%Y-%m-%d %H:%M'),
        })
    return jsonify({'success': True, 'payments': result})


# ==================================================================
# BANK ACCOUNT REPOSITORY API (Admin)
# ==================================================================

from database import BankAccount, MarketingReceipt

@app.route('/api/admin/bank-accounts')
@login_required
@admin_required
def admin_bank_accounts():
    """List all bank accounts in the repository."""
    accounts = BankAccount.query.order_by(BankAccount.bank_name).all()
    result = []
    for a in accounts:
        result.append({
            'id': a.id,
            'bank_name': a.bank_name,
            'account_name': a.account_name,
            'account_number': a.account_number,
            'routing_number': a.routing_number or '',
            'swift_code': a.swift_code or '',
            'country': a.country or 'United States',
            'currency': a.currency or 'USD',
            'is_active': a.is_active,
            'created_at': a.created_at.strftime('%b %d, %Y') if a.created_at else ''
        })
    return jsonify({'success': True, 'accounts': result})


@app.route('/api/admin/bank-accounts/add', methods=['POST'])
@login_required
@admin_required
def admin_bank_accounts_add():
    """Add a new bank account to the repository."""
    data = request.get_json() or {}
    errors = []
    if not data.get('bank_name'): errors.append('Bank name is required')
    if not data.get('account_name'): errors.append('Account name is required')
    if not data.get('account_number'): errors.append('Account number is required')
    if errors:
        return jsonify({'success': False, 'message': '; '.join(errors)}), 400

    account = BankAccount(
        bank_name=data['bank_name'],
        account_name=data['account_name'],
        account_number=data['account_number'],
        routing_number=data.get('routing_number', ''),
        swift_code=data.get('swift_code', ''),
        country=data.get('country', 'United States'),
        currency=data.get('currency', 'USD'),
        is_active=True
    )
    db.session.add(account)
    db.session.commit()
    return jsonify({'success': True, 'message': 'Bank account added', 'id': account.id})


@app.route('/api/admin/bank-accounts/<int:account_id>', methods=['PUT', 'DELETE'])
@login_required
@admin_required
def admin_bank_accounts_modify(account_id):
    """Update or delete a bank account."""
    account = db.session.get(BankAccount, account_id)
    if not account:
        return jsonify({'success': False, 'message': 'Account not found'}), 404

    if request.method == 'DELETE':
        db.session.delete(account)
        db.session.commit()
        return jsonify({'success': True, 'message': 'Account deleted'})

    # PUT - update
    data = request.get_json() or {}
    account.bank_name = data.get('bank_name', account.bank_name)
    account.account_name = data.get('account_name', account.account_name)
    account.account_number = data.get('account_number', account.account_number)
    account.routing_number = data.get('routing_number', account.routing_number)
    account.swift_code = data.get('swift_code', account.swift_code)
    account.country = data.get('country', account.country)
    account.currency = data.get('currency', account.currency)
    account.is_active = data.get('is_active', account.is_active)
    db.session.commit()
    return jsonify({'success': True, 'message': 'Account updated'})


# ==================================================================
# MARKETING RECEIPT GENERATOR (Admin)
# ==================================================================

@app.route('/api/admin/receipts/generate', methods=['POST'])
@login_required
@admin_required
def admin_generate_marketing_receipt():
    """Generate a standalone marketing receipt (not tied to a withdrawal)."""
    data = request.get_json() or {}
    errors = []
    if not data.get('recipient_name'): errors.append('Recipient name required')
    if not data.get('amount'): errors.append('Amount required')
    if errors:
        return jsonify({'success': False, 'message': '; '.join(errors)}), 400

    amount = float(data['amount'])
    receipt_num = generate_receipt_number()
    processed_date = _now()

    receipt = MarketingReceipt(
        receipt_number=receipt_num,
        recipient_name=data['recipient_name'],
        recipient_email=data.get('recipient_email', ''),
        amount=amount,
        currency=data.get('currency', 'USD'),
        payment_method=data.get('payment_method', 'Bank Transfer'),
        reference=data.get('reference', f'MWG-MKT-{_now().strftime("%Y%m%d")}-{random.randint(100,999)}'),
        bank_name=data.get('bank_name', ''),
        account_name=data.get('account_name', ''),
        account_number=data.get('account_number', ''),
        routing_number=data.get('routing_number', ''),
        swift_code=data.get('swift_code', ''),
        status='generated',
        member_since=data.get('member_since', ''),
        watermark=data.get('watermark', 'Confidential'),
        processed_date=processed_date,
        generated_by=current_user.id
    )
    db.session.add(receipt)
    db.session.commit()

    return jsonify({
        'success': True,
        'receipt': {
            'id': receipt.id,
            'receipt_number': receipt.receipt_number,
            'recipient_name': receipt.recipient_name,
            'recipient_email': receipt.recipient_email or '',
            'amount': round(receipt.amount, 2),
            'currency': receipt.currency,
            'payment_method': receipt.payment_method,
            'reference': receipt.reference or '',
            'bank_name': receipt.bank_name or '',
            'account_name': receipt.account_name or '',
            'account_number': receipt.account_number or '',
            'routing_number': receipt.routing_number or '',
            'swift_code': receipt.swift_code or '',
            'status': receipt.status,
            'member_since': receipt.member_since or '',
            'watermark': receipt.watermark,
            'date': processed_date.strftime('%B %d, %Y at %I:%M %p'),
        }
    })


@app.route('/api/admin/receipts/marketing')
@login_required
@admin_required
def admin_marketing_receipts():
    """List all marketing receipts."""
    receipts = MarketingReceipt.query.order_by(MarketingReceipt.generated_at.desc()).all()
    result = []
    for r in receipts:
        result.append({
            'id': r.id,
            'receipt_number': r.receipt_number,
            'recipient_name': r.recipient_name,
            'amount': round(r.amount, 2),
            'currency': r.currency,
            'status': r.status,
            'generated_at': r.generated_at.strftime('%Y-%m-%d %H:%M') if r.generated_at else '',
            'download_count': r.download_count or 0,
        })
    return jsonify({'success': True, 'receipts': result})


@app.route('/api/admin/receipts/marketing/<int:receipt_id>')
@login_required
@admin_required
def admin_marketing_receipt_detail(receipt_id):
    """Get full details of a marketing receipt."""
    r = db.session.get(MarketingReceipt, receipt_id)
    if not r:
        return jsonify({'success': False, 'message': 'Not found'}), 404
    return jsonify({
        'success': True,
        'receipt': {
            'id': r.id,
            'receipt_number': r.receipt_number,
            'recipient_name': r.recipient_name,
            'recipient_email': r.recipient_email or '',
            'amount': round(r.amount, 2),
            'currency': r.currency,
            'payment_method': r.payment_method,
            'reference': r.reference or '',
            'bank_name': r.bank_name or '',
            'account_name': r.account_name or '',
            'account_number': r.account_number or '',
            'routing_number': r.routing_number or '',
            'swift_code': r.swift_code or '',
            'status': r.status,
            'member_since': r.member_since or '',
            'watermark': r.watermark,
            'download_count': r.download_count or 0,
            'date': r.processed_date.strftime('%B %d, %Y at %I:%M %p') if r.processed_date else r.generated_at.strftime('%B %d, %Y at %I:%M %p'),
        }
    })


@app.route('/api/admin/receipts/marketing/<int:receipt_id>/download')
@login_required
@admin_required
def admin_marketing_receipt_download(receipt_id):
    """Increment download count and return receipt data."""
    r = db.session.get(MarketingReceipt, receipt_id)
    if not r:
        return jsonify({'success': False, 'message': 'Not found'}), 404
    r.download_count = (r.download_count or 0) + 1
    db.session.commit()
    return jsonify({'success': True, 'download_count': r.download_count})


@app.route('/marketing/receipt/print/<int:receipt_id>')
@login_required
@admin_required
def render_marketing_receipt_print(receipt_id):
    """Render a printable view of a marketing receipt."""
    r = db.session.get(MarketingReceipt, receipt_id)
    if not r:
        flash('Receipt not found.')
        return redirect(url_for('admin_dashboard'))

    receipt_data = {
        'receipt_number': r.receipt_number,
        'recipient_name': r.recipient_name,
        'recipient_email': r.recipient_email or '',
        'amount': round(r.amount, 2),
        'currency': r.currency,
        'payment_method': r.payment_method,
        'reference': r.reference or '',
        'bank_name': r.bank_name or 'Monarch Partner Bank',
        'account_name': r.account_name or 'N/A',
        'account_number': r.account_number or 'N/A',
        'routing_number': r.routing_number or '',
        'swift_code': r.swift_code or '',
        'status': r.status,
        'member_since': r.member_since or '',
        'watermark': r.watermark or 'Confidential',
        'date': r.processed_date.strftime('%B %d, %Y at %I:%M %p') if r.processed_date else r.generated_at.strftime('%B %d, %Y at %I:%M %p'),
    }
    return render_template('receipt_print.html', receipt=receipt_data, is_marketing=True)


# ==================================================================
# USER BANKING DETAILS SUBMISSION
# ==================================================================

# ==================================================================
# Initialize DB
# ==================================================================
with app.app_context():
    db.create_all()
    # Dynamic SQLite migration for receipt_image column
    try:
        raw_conn = db.engine.raw_connection()
        cursor = raw_conn.cursor()
        cursor.execute("SELECT receipt_image FROM withdrawal_request LIMIT 1")
        raw_conn.close()
    except Exception:
        try:
            db.session.rollback()
            raw_conn = db.engine.raw_connection()
            cursor = raw_conn.cursor()
            cursor.execute("ALTER TABLE withdrawal_request ADD COLUMN receipt_image VARCHAR(250)")
            raw_conn.commit()
            raw_conn.close()
            print("Successfully migrated database: added receipt_image column.")
        except Exception as err:
            print("Migration warning (ignored if column exists):", err)

    # Dynamic SQLite migration for routing_number column
    try:
        raw_conn = db.engine.raw_connection()
        cursor = raw_conn.cursor()
        cursor.execute("SELECT routing_number FROM withdrawal_request LIMIT 1")
        raw_conn.close()
    except Exception:
        try:
            db.session.rollback()
            raw_conn = db.engine.raw_connection()
            cursor = raw_conn.cursor()
            cursor.execute("ALTER TABLE withdrawal_request ADD COLUMN routing_number VARCHAR(50)")
            raw_conn.commit()
            raw_conn.close()
            print("Successfully migrated database: added routing_number column.")
        except Exception as err:
            print("Migration warning (routing_number):", err)

    # Dynamic SQLite migration for txid column
    try:
        raw_conn = db.engine.raw_connection()
        cursor = raw_conn.cursor()
        cursor.execute("SELECT txid FROM withdrawal_request LIMIT 1")
        raw_conn.close()
    except Exception:
        try:
            db.session.rollback()
            raw_conn = db.engine.raw_connection()
            cursor = raw_conn.cursor()
            cursor.execute("ALTER TABLE withdrawal_request ADD COLUMN txid VARCHAR(200)")
            raw_conn.commit()
            raw_conn.close()
            print("Successfully migrated database: added txid column.")
        except Exception as err:
            print("Migration warning (txid):", err)

    # Dynamic SQLite migration for swift_code column
    try:
        raw_conn = db.engine.raw_connection()
        cursor = raw_conn.cursor()
        cursor.execute("SELECT swift_code FROM withdrawal_request LIMIT 1")
        raw_conn.close()
    except Exception:
        try:
            db.session.rollback()
            raw_conn = db.engine.raw_connection()
            cursor = raw_conn.cursor()
            cursor.execute("ALTER TABLE withdrawal_request ADD COLUMN swift_code VARCHAR(20)")
            raw_conn.commit()
            raw_conn.close()
            print("Successfully migrated database: added swift_code column.")
        except Exception as err:
            print("Migration warning (swift_code):", err)

    # Dynamic migration for referral columns
    try:
        raw_conn = db.engine.raw_connection()
        cursor = raw_conn.cursor()
        cursor.execute("SELECT referral_code FROM user LIMIT 1")
        raw_conn.close()
    except Exception:
        try:
            db.session.rollback()
            raw_conn = db.engine.raw_connection()
            cursor = raw_conn.cursor()
            cursor.execute("ALTER TABLE user ADD COLUMN referral_code VARCHAR(10) UNIQUE")
            raw_conn.commit()
            raw_conn.close()
            print("Successfully migrated database: added referral_code column.")
        except Exception as err:
            print("Migration warning (ignored if column exists):", err)
    try:
        raw_conn = db.engine.raw_connection()
        cursor = raw_conn.cursor()
        cursor.execute("SELECT referred_by FROM user LIMIT 1")
        raw_conn.close()
    except Exception:
        try:
            db.session.rollback()
            raw_conn = db.engine.raw_connection()
            cursor = raw_conn.cursor()
            cursor.execute("ALTER TABLE user ADD COLUMN referred_by INTEGER REFERENCES user(id)")
            raw_conn.commit()
            raw_conn.close()
            print("Successfully migrated database: added referred_by column.")
        except Exception as err:
            print("Migration warning (ignored if column exists):", err)
    try:
        raw_conn = db.engine.raw_connection()
        cursor = raw_conn.cursor()
        cursor.execute("SELECT referral_earnings FROM user LIMIT 1")
        raw_conn.close()
    except Exception:
        try:
            db.session.rollback()
            raw_conn = db.engine.raw_connection()
            cursor = raw_conn.cursor()
            cursor.execute("ALTER TABLE user ADD COLUMN referral_earnings FLOAT DEFAULT 0.0")
            raw_conn.commit()
            raw_conn.close()
            print("Successfully migrated database: added referral_earnings column.")
        except Exception as err:
            print("Migration warning (ignored if column exists):", err)

    # Dynamic migration for user crypto wallet columns
    try:
        raw_conn = db.engine.raw_connection()
        cursor = raw_conn.cursor()
        cursor.execute("SELECT crypto_wallet_address FROM user LIMIT 1")
        raw_conn.close()
    except Exception:
        try:
            db.session.rollback()
            raw_conn = db.engine.raw_connection()
            cursor = raw_conn.cursor()
            cursor.execute("ALTER TABLE user ADD COLUMN crypto_wallet_address VARCHAR(200)")
            cursor.execute("ALTER TABLE user ADD COLUMN crypto_network VARCHAR(50)")
            raw_conn.commit()
            raw_conn.close()
            print("Successfully migrated database: added crypto wallet columns to user table.")
        except Exception as err:
            print("Migration warning (user crypto wallet):", err)

    # Set default network for existing users
    try:
        raw_conn = db.engine.raw_connection()
        cursor = raw_conn.cursor()
        cursor.execute("UPDATE user SET crypto_network = 'Ethereum (ERC-20)' WHERE crypto_network IS NULL")
        raw_conn.commit()
        raw_conn.close()
    except Exception as err:
        print("Migration warning (setting default network):", err)

    # Generate referral codes for existing users that don't have one
    try:
        raw_conn = db.engine.raw_connection()
        cursor = raw_conn.cursor()
        cursor.execute("SELECT id, referral_code FROM user WHERE referral_code IS NULL OR referral_code = ''")
        users_missing = cursor.fetchall()
        for uid, _ in users_missing:
            code = generate_referral_code()
            cursor.execute("UPDATE user SET referral_code = ? WHERE id = ?", (code, uid))
        if users_missing:
            raw_conn.commit()
        raw_conn.close()
    except Exception as err:
        print("Migration warning (generating codes):", err)

    # Dynamic SQLite migrations for new upgraded fields
    new_user_cols = [
        ("crypto_currency", "VARCHAR(10) DEFAULT 'USDT'"),
        ("wallet_verified", "BOOLEAN DEFAULT 0"),
        ("pending_withdrawal", "DOUBLE DEFAULT 0.0"),
        ("total_withdrawn", "DOUBLE DEFAULT 0.0"),
        ("last_withdrawal_date", "DATETIME"),
        ("is_approved", "BOOLEAN DEFAULT 0"),
        ("invitation_code", "VARCHAR(50)"),
        ("invitation_expires_at", "DATETIME"),
        ("mentor_id", "INTEGER"),
        ("milestones_sent", "TEXT DEFAULT '[]'")
    ]
    for col_name, col_type in new_user_cols:
        try:
            raw_conn = db.engine.raw_connection()
            cursor = raw_conn.cursor()
            cursor.execute(f"SELECT {col_name} FROM user LIMIT 1")
            raw_conn.close()
        except Exception:
            try:
                db.session.rollback()
                raw_conn = db.engine.raw_connection()
                cursor = raw_conn.cursor()
                cursor.execute(f"ALTER TABLE user ADD COLUMN {col_name} {col_type}")
                raw_conn.commit()
                raw_conn.close()
                print(f"Successfully migrated user table: added {col_name} column.")
            except Exception as err:
                print(f"Migration warning (user {col_name}):", err)

    new_withdrawal_cols = [
        ("crypto_wallet_address", "VARCHAR(200)"),
        ("crypto_network", "VARCHAR(50)"),
        ("crypto_currency", "VARCHAR(10) DEFAULT 'USDT'"),
        ("admin_notes", "TEXT"),
        ("marked_paid_at", "DATETIME"),
        ("marked_paid_by", "INTEGER")
    ]
    for col_name, col_type in new_withdrawal_cols:
        try:
            raw_conn = db.engine.raw_connection()
            cursor = raw_conn.cursor()
            cursor.execute(f"SELECT {col_name} FROM withdrawal_request LIMIT 1")
            raw_conn.close()
        except Exception:
            try:
                db.session.rollback()
                raw_conn = db.engine.raw_connection()
                cursor = raw_conn.cursor()
                cursor.execute(f"ALTER TABLE withdrawal_request ADD COLUMN {col_name} {col_type}")
                raw_conn.commit()
                raw_conn.close()
                print(f"Successfully migrated withdrawal_request table: added {col_name} column.")
            except Exception as err:
                print(f"Migration warning (withdrawal {col_name}):", err)

    # Initialize default withdrawal settings
    try:
        if not WithdrawalSettings.query.first():
            settings = WithdrawalSettings(
                min_withdrawal=1000.00,
                tax_rate=20.00,
                processing_day=31,
                cut_off_day=25,
                default_currency='USDT',
                default_network='Ethereum (ERC-20)',
                auto_approve=False,
                allow_crypto_payouts=True
            )
            db.session.add(settings)
            db.session.commit()
            print("Successfully initialized default withdrawal settings.")
    except Exception as err:
        print("Initialization warning (settings):", err)

    # Initialize default AI mentor (Sarah Mitchell)
    try:
        if not Mentor.query.first():
            mentor = Mentor(
                name="Sarah Mitchell",
                title="Senior Wealth Advisor",
                experience="8 years in private wealth management",
                personality="Caring, supportive, professional",
                photo_url="/static/uploads/sarah_mitchell.jpg"
            )
            db.session.add(mentor)
            db.session.commit()
            print("Successfully initialized default AI Mentor Sarah Mitchell.")
    except Exception as err:
        print("Initialization warning (mentor):", err)

    # Mark existing users as approved so they are not locked out
    try:
        raw_conn = db.engine.raw_connection()
        cursor = raw_conn.cursor()
        cursor.execute("UPDATE user SET is_approved = 1 WHERE is_approved IS NULL")
        raw_conn.commit()
        raw_conn.close()
        print("Set is_approved = 1 for all pre-existing users.")
    except Exception as err:
        print("Migration warning (approving pre-existing users):", err)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
