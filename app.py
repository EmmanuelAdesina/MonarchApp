import os
import bcrypt
import random
import hashlib
import hmac
import json
import requests as http_requests
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify, session
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from datetime import datetime, timedelta
from functools import wraps
from database import db, User, Transaction, WithdrawalRequest, PaymentVerification
from utils import calculate_growth, generate_activity_feed
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev-secret-key')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///monarch.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

UPLOAD_FOLDER = os.path.join(app.root_path, 'static', 'uploads')
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Payment gateway config
NOWPAYMENTS_API_KEY = os.getenv('NOWPAYMENTS_API_KEY', '')
NOWPAYMENTS_BASE = 'https://api.nowpayments.io/v1'
PAYSTACK_SECRET_KEY = os.getenv('PAYSTACK_SECRET_KEY', '')
PAYSTACK_PUBLIC_KEY = os.getenv('PAYSTACK_PUBLIC_KEY', '')
ADMIN_SETUP_KEY = os.getenv('ADMIN_SETUP_KEY', '')

db.init_app(app)

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))


# ---- Decorators ----
def admin_required(f):
    """Decorator to restrict routes to admin users only."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not current_user.is_authenticated or not current_user.is_admin:
            return jsonify({'success': False, 'message': 'Admin access required'}), 403
        return f(*args, **kwargs)
    return decorated_function


# ---- Helper Functions ----
def apply_growth(user):
    """Apply growth to user's balance if enough time has passed."""
    now = datetime.utcnow()
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

def is_payment_already_credited(payment_id):
    """Check if this NowPayments payment_id has already been credited."""
    existing = Transaction.query.filter(
        Transaction.description.contains(f'nowpayments#{payment_id}')
    ).first()
    return existing is not None

def is_nowpayments_configured():
    """Check if NowPayments API key is properly configured."""
    return bool(NOWPAYMENTS_API_KEY) and NOWPAYMENTS_API_KEY != 'your_nowpayments_api_key_here'

def is_paystack_configured():
    """Check if Paystack API key is properly configured."""
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

def generate_receipt_number():
    """Generate unique receipt number like MWG-WD-20260625-A3F8."""
    date_part = datetime.utcnow().strftime('%Y%m%d')
    rand_part = os.urandom(2).hex().upper()
    return f'MWG-WD-{date_part}-{rand_part}'

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

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form['username']
        email = request.form['email']
        password = request.form['password']
        if User.query.filter_by(username=username).first():
            flash('Username already exists')
            return redirect(url_for('register'))
        if User.query.filter_by(email=email).first():
            flash('Email already registered')
            return redirect(url_for('register'))
        hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())
        user = User(username=username, email=email, password_hash=hashed.decode('utf-8'))
        db.session.add(user)
        db.session.commit()
        flash('Registration successful! Please log in.')
        return redirect(url_for('login'))
    return render_template('register.html')

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
    return render_template('dashboard.html', user=current_user,
                           paystack_public_key=PAYSTACK_PUBLIC_KEY)


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
    today = datetime.utcnow().date()
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

    if amount_usd <= 0:
        return jsonify({'success': False, 'message': 'Invalid amount'})

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
        'order_id': f'monarch_{current_user.id}_{int(datetime.utcnow().timestamp())}',
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

            # Update verification record
            pv = PaymentVerification.query.filter_by(gateway_reference=payment_id).first()
            if pv:
                pv.status = 'verified'
                pv.verified_at = datetime.utcnow()
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

@app.route('/api/deposit-card', methods=['POST'])
@login_required
def deposit_card():
    """Initialize a Paystack transaction for card deposit."""
    if not is_paystack_configured():
        return jsonify({'success': False, 'message': 'Card payment gateway not configured. Please contact support.'})

    data = request.get_json()
    amount = float(data.get('amount', 0))
    if amount <= 0:
        return jsonify({'success': False, 'message': 'Amount must be positive'})

    headers = {
        'Authorization': f'Bearer {PAYSTACK_SECRET_KEY}',
        'Content-Type': 'application/json'
    }
    payload = {
        'email': current_user.email,
        'amount': int(amount * 100),  # Paystack uses kobo/cents
        'currency': 'USD',
        'callback_url': url_for('paystack_deposit_callback', _external=True),
        'metadata': {
            'user_id': current_user.id,
            'payment_type': 'deposit',
            'amount_usd': amount
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
            pv.set_raw_response(result['data'])
            db.session.add(pv)
            db.session.commit()

            # Store in session
            session['pending_deposit'] = {
                'reference': reference,
                'amount': amount,
                'user_id': current_user.id
            }

            return jsonify({
                'success': True,
                'authorization_url': result['data']['authorization_url'],
                'reference': reference
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
        amount = pending.get('amount', data.get('metadata', {}).get('amount_usd', 0))
        user_id = pending.get('user_id', current_user.id)

        # Prevent double-credit
        existing = Transaction.query.filter(
            Transaction.description.contains(f'paystack#{reference}')
        ).first()

        if not existing and amount > 0:
            user = User.query.get(user_id)
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

                # Update verification
                pv = PaymentVerification.query.filter_by(gateway_reference=reference).first()
                if pv:
                    pv.status = 'verified'
                    pv.verified_at = datetime.utcnow()
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
    data = request.get_json() or {}
    amount = float(data.get('amount', 0))
    if amount < 10:
        return jsonify({'success': False, 'message': 'Minimum withdrawal is $10.00'})

    apply_growth(current_user)
    if amount > current_user.balance:
        return jsonify({'success': False, 'message': 'Insufficient balance'})

    # Deduct and reserve from user's balance
    current_user.balance -= amount

    tax_amount = amount * 0.20
    withdrawal = WithdrawalRequest(
        user_id=current_user.id,
        amount=amount,
        tax_amount=tax_amount,
        status='tax_required',
        tax_paid=False
    )
    db.session.add(withdrawal)
    db.session.commit()

    return jsonify({
        'success': True,
        'data': {
            'id': withdrawal.id,
            'withdrawal_id': withdrawal.id,
            'amount': round(amount, 2),
            'tax_amount': round(tax_amount, 2),
            'status': withdrawal.status,
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
        WithdrawalRequest.status.in_(['tax_required', 'pending'])
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
        'order_id': f'tax_{withdrawal.id}_{int(datetime.utcnow().timestamp())}',
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
            withdrawal.updated_at = datetime.utcnow()

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
                pv.verified_at = datetime.utcnow()
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
        withdrawal.updated_at = datetime.utcnow()

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
            pv.verified_at = datetime.utcnow()
            pv.set_raw_response(payload)

        db.session.commit()
        return jsonify({'status': 'success'}), 200

    # Check if it's a deposit (not already credited)
    if not is_payment_already_credited(payment_id):
        pv = PaymentVerification.query.filter_by(gateway_reference=payment_id).first()
        if pv and pv.status == 'pending':
            user = User.query.get(pv.user_id)
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
                pv.status = 'verified'
                pv.verified_at = datetime.utcnow()
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
            withdrawal.updated_at = datetime.utcnow()

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
                pv.verified_at = datetime.utcnow()
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
                user = User.query.get(pv.user_id)
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
                    pv.status = 'verified'
                    pv.verified_at = datetime.utcnow()
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
            'status': w.status,
            'date': w.receipt_generated_at.strftime('%B %d, %Y') if w.receipt_generated_at else w.created_at.strftime('%B %d, %Y'),
        })
    return jsonify({'success': True, 'receipts': receipts})


# ==================================================================
# ADMIN DASHBOARD
# ==================================================================

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
    now = datetime.utcnow()
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
        user = User.query.get(w.user_id)
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
            'receipt_number': w.receipt_number or '',
            'bank_name': w.bank_name or '',
            'account_number': w.account_number or '',
            'account_name': w.account_name or '',
            'admin_notes': w.admin_notes or '',
            'created_at': w.created_at.strftime('%Y-%m-%d %H:%M'),
        })
    return jsonify({'success': True, 'withdrawals': result})


@app.route('/api/admin/withdrawal/<withdrawal_id>/approve', methods=['POST'])
@login_required
@admin_required
def admin_approve_withdrawal(withdrawal_id):
    """Approve a withdrawal request."""
    withdrawal = WithdrawalRequest.query.get(withdrawal_id)
    if not withdrawal:
        return jsonify({'success': False, 'message': 'Not found'}), 404

    data = request.get_json() or {}
    withdrawal.status = 'completed'
    withdrawal.updated_at = datetime.utcnow()
    withdrawal.admin_notes = data.get('notes', withdrawal.admin_notes)

    # Generate receipt if not already generated
    if not withdrawal.receipt_number:
        withdrawal.receipt_number = generate_receipt_number()
        withdrawal.receipt_generated_at = datetime.utcnow()

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
    return jsonify({'success': True, 'message': 'Withdrawal approved', 'receipt_number': withdrawal.receipt_number})


@app.route('/api/admin/withdrawal/<withdrawal_id>/reject', methods=['POST'])
@login_required
@admin_required
def admin_reject_withdrawal(withdrawal_id):
    """Reject a withdrawal request and refund balance."""
    withdrawal = WithdrawalRequest.query.get(withdrawal_id)
    if not withdrawal:
        return jsonify({'success': False, 'message': 'Not found'}), 404

    data = request.get_json() or {}
    withdrawal.status = 'rejected'
    withdrawal.updated_at = datetime.utcnow()
    withdrawal.admin_notes = data.get('notes', 'Withdrawal rejected by admin')

    # Refund balance
    user = User.query.get(withdrawal.user_id)
    if user:
        user.balance += withdrawal.amount

    db.session.commit()
    return jsonify({'success': True, 'message': 'Withdrawal rejected and balance refunded'})


@app.route('/api/admin/withdrawal/<withdrawal_id>/generate-receipt', methods=['POST'])
@login_required
@admin_required
def admin_generate_receipt(withdrawal_id):
    """Generate a custom receipt for a withdrawal."""
    withdrawal = WithdrawalRequest.query.get(withdrawal_id)
    if not withdrawal:
        return jsonify({'success': False, 'message': 'Not found'}), 404

    data = request.get_json() or {}

    withdrawal.bank_name = data.get('bank_name', withdrawal.bank_name)
    withdrawal.account_number = data.get('account_number', withdrawal.account_number)
    withdrawal.account_name = data.get('account_name', withdrawal.account_name)
    withdrawal.admin_notes = data.get('admin_notes', withdrawal.admin_notes)

    if not withdrawal.receipt_number:
        withdrawal.receipt_number = generate_receipt_number()

    withdrawal.receipt_generated_at = datetime.utcnow()

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

    user = User.query.get(withdrawal.user_id)
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
            'date': withdrawal.receipt_generated_at.strftime('%B %d, %Y at %I:%M %p'),
        }
    })


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
# Initialize DB
# ==================================================================
with app.app_context():
    db.create_all()
    # Dynamic SQLite migration for receipt_image column
    try:
        conn = db.engine.connect()
        # Query column to test existence
        conn.execute("SELECT receipt_image FROM withdrawal_request LIMIT 1")
    except Exception:
        # Table exists but column does not, alter table to add it
        try:
            db.session.rollback()
            conn = db.engine.connect()
            conn.execute("ALTER TABLE withdrawal_request ADD COLUMN receipt_image VARCHAR(250)")
            print("Successfully migrated database: added receipt_image column.")
        except Exception as err:
            print("Migration warning (ignored if column exists):", err)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)