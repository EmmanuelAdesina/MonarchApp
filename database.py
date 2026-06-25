import uuid
import json
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from datetime import datetime

db = SQLAlchemy()

class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    balance = db.Column(db.Float, default=0.0)
    total_deposits = db.Column(db.Float, default=0.0)
    is_admin = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_growth = db.Column(db.DateTime, default=datetime.utcnow)

    def get_id(self):
        return str(self.id)

class Transaction(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    type = db.Column(db.String(20), nullable=False)  # 'deposit', 'growth', 'withdrawal', 'tax_payment'
    description = db.Column(db.String(200))
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    tax_payment_for = db.Column(db.String(36), db.ForeignKey('withdrawal_request.id'), nullable=True)
    is_tax_payment = db.Column(db.Boolean, default=False)

    user = db.relationship('User', backref=db.backref('transactions', lazy=True))

class WithdrawalRequest(db.Model):
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    tax_amount = db.Column(db.Float, nullable=False)
    tax_paid = db.Column(db.Boolean, default=False)
    status = db.Column(db.String(20), default='tax_required')  # 'tax_required', 'pending', 'completed', 'rejected'
    reference = db.Column(db.String(100), unique=True, nullable=True)
    payment_method = db.Column(db.String(20), nullable=True)  # 'nowpayments', 'paystack'
    # Receipt fields
    receipt_number = db.Column(db.String(30), unique=True, nullable=True)
    bank_name = db.Column(db.String(100), nullable=True)
    account_number = db.Column(db.String(30), nullable=True)
    account_name = db.Column(db.String(100), nullable=True)
    receipt_image = db.Column(db.String(250), nullable=True)
    receipt_generated_at = db.Column(db.DateTime, nullable=True)
    admin_notes = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = db.relationship('User', backref=db.backref('withdrawals', lazy=True))

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