import uuid
import json
import random
import string
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from datetime import datetime

db = SQLAlchemy()

def generate_referral_code():
    """Generate a unique 8-character referral code."""
    while True:
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=8))
        if not User.query.filter_by(referral_code=code).first():
            return code

class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    balance = db.Column(db.Float, default=0.0)
    total_deposits = db.Column(db.Float, default=0.0)
    is_admin = db.Column(db.Boolean, default=False)
    referral_code = db.Column(db.String(10), unique=True, nullable=False, default=generate_referral_code)
    referred_by = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)
    referral_earnings = db.Column(db.Float, default=0.0)
    
    # Crypto wallet details for payouts
    crypto_wallet_address = db.Column(db.String(200), nullable=True)
    crypto_network = db.Column(db.String(50), nullable=True, default='Ethereum (ERC-20)')
    crypto_currency = db.Column(db.String(10), default='USDT')
    wallet_verified = db.Column(db.Boolean, default=False)
    
    # Withdrawal tracking
    pending_withdrawal = db.Column(db.Float, default=0.0)
    total_withdrawn = db.Column(db.Float, default=0.0)
    last_withdrawal_date = db.Column(db.DateTime, nullable=True)
    
    # Waiting List approval fields
    is_approved = db.Column(db.Boolean, default=False)
    invitation_code = db.Column(db.String(50), nullable=True, unique=True)
    invitation_expires_at = db.Column(db.DateTime, nullable=True)

    # Risk and admin controls
    risk_stress_active = db.Column(db.Boolean, default=False)
    decline_rate = db.Column(db.Numeric(5, 2), default=0.00)
    decline_interval = db.Column(db.Integer, default=10)
    custom_minimum_deposit = db.Column(db.Numeric(12, 2), nullable=True)
    chat_mode = db.Column(db.String(20), default='auto')
    
    # AI Mentor relationship
    mentor_id = db.Column(db.Integer, db.ForeignKey('mentor.id'), nullable=True)
    milestones_sent = db.Column(db.Text, default='[]') # JSON string listing completed milestones
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_growth = db.Column(db.DateTime, default=datetime.utcnow)

    referrer = db.relationship('User', remote_side=[id], backref=db.backref('referrals', lazy='dynamic'))
    mentor = db.relationship('Mentor', backref=db.backref('assigned_users', lazy=True))

    def get_id(self):
        return str(self.id)

class Transaction(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    type = db.Column(db.String(20), nullable=False)  # 'deposit', 'growth', 'withdrawal', 'tax_payment', 'referral_bonus'
    description = db.Column(db.String(200))
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    tax_payment_for = db.Column(db.String(36), db.ForeignKey('withdrawal_request.id'), nullable=True)
    is_tax_payment = db.Column(db.Boolean, default=False)

    user = db.relationship('User', backref=db.backref('transactions', lazy=True))

class ReferralBonus(db.Model):
    """Tracks referral bonuses credited to users."""
    id = db.Column(db.Integer, primary_key=True)
    referrer_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    referred_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    deposit_amount = db.Column(db.Float, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    referrer = db.relationship('User', foreign_keys=[referrer_id], backref=db.backref('referral_bonuses_given', lazy='dynamic'))
    referred = db.relationship('User', foreign_keys=[referred_id], backref=db.backref('referral_bonuses_received', lazy='dynamic'))

class WithdrawalRequest(db.Model):
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    tax_amount = db.Column(db.Float, nullable=False)
    tax_paid = db.Column(db.Boolean, default=False)
    status = db.Column(db.String(20), default='tax_required')  # 'tax_required', 'pending', 'completed', 'rejected'
    reference = db.Column(db.String(100), unique=True, nullable=True)
    payment_method = db.Column(db.String(20), nullable=True)  # 'nowpayments', 'paystack'
    txid = db.Column(db.String(200), nullable=True) # Crypto transaction ID for the payout
    
    # Crypto details for payouts
    crypto_wallet_address = db.Column(db.String(200), nullable=True)
    crypto_network = db.Column(db.String(50), nullable=True)
    crypto_currency = db.Column(db.String(10), default='USDT')
    
    # Receipt fields
    receipt_number = db.Column(db.String(30), unique=True, nullable=True)
    bank_name = db.Column(db.String(100), nullable=True)
    account_number = db.Column(db.String(30), nullable=True)
    account_name = db.Column(db.String(100), nullable=True)
    routing_number = db.Column(db.String(50), nullable=True)
    swift_code = db.Column(db.String(20), nullable=True)
    receipt_image = db.Column(db.String(250), nullable=True)
    receipt_generated_at = db.Column(db.DateTime, nullable=True)
    
    # Payout tracking
    admin_notes = db.Column(db.Text, nullable=True)
    marked_paid_at = db.Column(db.DateTime, nullable=True)
    marked_paid_by = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = db.relationship('User', foreign_keys=[user_id], backref=db.backref('withdrawals', lazy=True))
    payer = db.relationship('User', foreign_keys=[marked_paid_by], backref=db.backref('paid_withdrawals', lazy=True))

class PaymentVerification(db.Model):
    """Tracks every payment verified through NowPayments or Paystack."""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    gateway = db.Column(db.String(20), nullable=False)  # 'nowpayments', 'paystack'
    gateway_reference = db.Column(db.String(200), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    currency = db.Column(db.String(10), default='USD')
    payment_type = db.Column(db.String(20), nullable=False)  # 'deposit', 'tax_payment'
    status = db.Column(db.String(20), default='pending')  # 'pending', 'verified', 'failed'
    raw_response = db.Column(db.Text, nullable=True)  # JSON string of gateway response
    verified_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship('User', backref=db.backref('payment_verifications', lazy=True))

    def set_raw_response(self, data):
        self.raw_response = json.dumps(data)

    def get_raw_response(self):
        if self.raw_response:
            return json.loads(self.raw_response)
        return {}


class BankAccount(db.Model):
    """Repository of bank accounts used for generating realistic receipts."""
    __tablename__ = 'bank_account'
    id = db.Column(db.Integer, primary_key=True)
    bank_name = db.Column(db.String(100), nullable=False)
    account_name = db.Column(db.String(100), nullable=False)
    account_number = db.Column(db.String(50), nullable=False)
    routing_number = db.Column(db.String(50), nullable=True)
    swift_code = db.Column(db.String(20), nullable=True)
    country = db.Column(db.String(50), default='United States')
    currency = db.Column(db.String(10), default='USD')
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class MarketingReceipt(db.Model):
    """Standalone marketing receipts not linked to any real withdrawal."""
    id = db.Column(db.Integer, primary_key=True)
    receipt_number = db.Column(db.String(30), unique=True, nullable=False)
    recipient_name = db.Column(db.String(100), nullable=False)
    recipient_email = db.Column(db.String(120), nullable=True)
    amount = db.Column(db.Float, nullable=False)
    currency = db.Column(db.String(10), default='USD')
    payment_method = db.Column(db.String(50), default='Bank Transfer')
    reference = db.Column(db.String(100), nullable=True)
    bank_name = db.Column(db.String(100), nullable=True)
    account_name = db.Column(db.String(100), nullable=True)
    account_number = db.Column(db.String(50), nullable=True)
    routing_number = db.Column(db.String(50), nullable=True)
    swift_code = db.Column(db.String(20), nullable=True)
    status = db.Column(db.String(20), default='draft')  # 'draft', 'generated', 'shared'
    member_since = db.Column(db.String(50), nullable=True)
    watermark = db.Column(db.String(50), default='Confidential')
    processed_date = db.Column(db.DateTime, nullable=True)
    generated_by = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)
    generated_at = db.Column(db.DateTime, default=datetime.utcnow)
    download_count = db.Column(db.Integer, default=0)

    generator = db.relationship('User', foreign_keys=[generated_by], backref=db.backref('generated_marketing_receipts', lazy=True))

class WithdrawalSettings(db.Model):
    """Store withdrawal cycle settings and policies."""
    id = db.Column(db.Integer, primary_key=True)
    min_withdrawal = db.Column(db.Float, default=1000.00)
    tax_rate = db.Column(db.Float, default=20.00)
    processing_day = db.Column(db.Integer, default=31) # Last day of month
    cut_off_day = db.Column(db.Integer, default=25)
    default_currency = db.Column(db.String(10), default='USDT')
    default_network = db.Column(db.String(50), default='Ethereum (ERC-20)')
    auto_approve = db.Column(db.Boolean, default=False)
    allow_crypto_payouts = db.Column(db.Boolean, default=True)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)

class WaitingList(db.Model):
    """Tracks waiting list registrations and approval status."""
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    intended_deposit = db.Column(db.Float, default=100.00)
    referral_source = db.Column(db.String(100), nullable=True)
    notes = db.Column(db.Text, nullable=True)
    status = db.Column(db.String(20), default='pending') # 'pending', 'approved', 'rejected'
    rejection_reason = db.Column(db.Text, nullable=True)
    invitation_code = db.Column(db.String(50), unique=True, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    approved_at = db.Column(db.DateTime, nullable=True)
    expires_at = db.Column(db.DateTime, nullable=True)

class Mentor(db.Model):
    """Stores information about the AI Wealth Advisor mentors."""
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    title = db.Column(db.String(100), nullable=False)
    experience = db.Column(db.String(100), nullable=False)
    personality = db.Column(db.String(100), nullable=False)
    photo_url = db.Column(db.String(250), nullable=False)

class MentorMessage(db.Model):
    """Logs conversation histories between users and their assigned AI Mentors."""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    mentor_id = db.Column(db.Integer, db.ForeignKey('mentor.id'), nullable=False)
    sender = db.Column(db.String(20), nullable=False)  # 'user' or 'mentor'
    message = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    is_read = db.Column(db.Boolean, default=False)
