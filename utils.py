import random
from datetime import datetime, timedelta
import re

# Growth parameters
MIN_GROWTH_PCT = 0.3   # 0.3%
MAX_GROWTH_PCT = 1.5   # 1.5%
GROWTH_INTERVAL = 3    # seconds

def calculate_growth(current_balance, last_update_time):
    """Calculate growth since last update."""
    if current_balance <= 0:
        return 0.0
    # Random percentage
    pct = random.uniform(MIN_GROWTH_PCT, MAX_GROWTH_PCT) / 100.0
    # Apply growth (compounding)
    return current_balance * pct

def generate_activity_feed(count=10):
    """Generate fake activity for social proof."""
    names = [
        'Sarah K.', 'Michael R.', 'Emma W.', 'David L.',
        'Jessica M.', 'James P.', 'Amanda T.', 'Robert C.',
        'Lisa N.', 'Daniel S.', 'Olivia Y.', 'William H.',
        'Sophia M.', 'Alexander W.', 'Isabella R.'
    ]
    actions = [
        ('deposited', '${amount}', 'deposit'),
        ('earned', '${amount} on ${asset}', 'growth'),
        ('withdrew', '${amount}', 'withdrawal'),
        ('portfolio grew by', '${percent}%', 'growth')
    ]
    assets = ['Tesla (TSLA)', 'NVIDIA (NVDA)', 'Bitcoin (BTC)', 'Amazon (AMZN)',
              'Microsoft (MSFT)', 'Apple (AAPL)', 'Ethereum (ETH)', 'Meta (META)']
    feed = []
    for _ in range(count):
        name = random.choice(names)
        action, template, typ = random.choice(actions)
        amount = round(random.uniform(50, 2000), 2)
        if '${amount}' in template:
            text = f"{action} ${amount}"
        elif '${percent}' in template:
            pct = round(random.uniform(1.0, 8.0), 1)
            text = f"{action} {pct}%"
        else:
            text = action
        # Add asset if applicable
        if 'on ${asset}' in template:
            asset = random.choice(assets)
            text = text.replace('${asset}', asset)
        # Time
        minutes_ago = random.randint(1, 180)
        time_str = f"{minutes_ago}m ago" if minutes_ago < 60 else f"{minutes_ago//60}h ago"
        feed.append({
            'name': name,
            'text': text,
            'time': time_str,
            'type': typ
        })
    return feed


# ========== WITHDRAWAL VALIDATION & RULES ==========

def validate_ethereum_address(address):
    """Validate Ethereum (ERC-20) address format."""
    if not address:
        return False
    return bool(re.match(r'^0x[a-fA-F0-9]{40}$', address))

def validate_bsc_address(address):
    """Validate BNB Smart Chain (BEP-20) address format."""
    if not address:
        return False
    return bool(re.match(r'^0x[a-fA-F0-9]{40}$', address))

def validate_tron_address(address):
    """Validate Tron (TRC-20) address format."""
    if not address:
        return False
    return bool(re.match(r'^T[1-9A-HJ-NP-Z]{33}$', address))

def validate_bitcoin_address(address):
    """Validate Bitcoin address format (P2PKH, P2SH, Bech32)."""
    if not address:
        return False
    # P2PKH (starts with 1), P2SH (starts with 3), or Bech32 (starts with bc1)
    return bool(re.match(r'^(1[1-9A-HJ-NP-Z]{25,34}|3[1-9A-HJ-NP-Z]{25,34}|bc1[a-z0-9]{39,59})$', address))

def validate_crypto_address(address, network):
    """Validate cryptocurrency address based on network."""
    network = network.lower() if network else ''
    
    validators = {
        'ethereum': validate_ethereum_address,
        'bsc': validate_bsc_address,
        'tron': validate_tron_address,
        'bitcoin': validate_bitcoin_address,
    }
    
    validator = validators.get(network)
    if not validator:
        return False
    return validator(address)

def get_withdrawal_cutoff_day():
    """Get the cutoff day for withdrawal submissions (default: 25th)."""
    return 25

def get_next_processing_date():
    """Get the next month's last day (processing date)."""
    today = datetime.utcnow().date()
    current_month_last = _get_last_day_of_month(today)
    
    if today <= current_month_last:
        return current_month_last
    else:
        # Already past the cutoff, next processing is next month
        next_month = today.replace(day=1) + timedelta(days=32)
        return _get_last_day_of_month(next_month.date())

def _get_last_day_of_month(date):
    """Get the last day of the month for a given date."""
    if date.month == 12:
        return date.replace(month=1, year=date.year + 1, day=1) - timedelta(days=1)
    else:
        return date.replace(month=date.month + 1, day=1) - timedelta(days=1)

def get_days_until_cutoff():
    """Get the number of days until the withdrawal submission cutoff."""
    today = datetime.utcnow().date()
    cutoff_day = get_withdrawal_cutoff_day()
    
    # Current month's cutoff
    cutoff_date = today.replace(day=cutoff_day)
    
    if today <= cutoff_date:
        return (cutoff_date - today).days
    else:
        # Next month's cutoff
        if today.month == 12:
            next_cutoff = today.replace(year=today.year + 1, month=1, day=cutoff_day)
        else:
            next_cutoff = today.replace(month=today.month + 1, day=cutoff_day)
        return (next_cutoff - today).days

def is_within_withdrawal_window():
    """Check if current date is within withdrawal submission window (1st-25th)."""
    today = datetime.utcnow().date()
    cutoff_day = get_withdrawal_cutoff_day()
    return 1 <= today.day <= cutoff_day

def get_withdrawal_window_status():
    """Get detailed status of the withdrawal window."""
    today = datetime.utcnow().date()
    cutoff_day = get_withdrawal_cutoff_day()
    
    if not is_within_withdrawal_window():
        return {
            'is_open': False,
            'days_until_open': 30 - today.day + 1,  # Days until next month 1st
            'status': 'Closed',
            'message': f'Withdrawals only allowed 1st–{cutoff_day}th of each month.'
        }
    
    days_left = cutoff_day - today.day
    return {
        'is_open': True,
        'days_left': days_left,
        'status': 'Open',
        'message': f'Withdrawal window closes in {days_left} days.',
        'cutoff_day': cutoff_day,
        'next_processing_date': str(get_next_processing_date())
    }

def calculate_withdrawal_tax(amount, tax_rate=0.20):
    """Calculate tax for a withdrawal amount."""
    return round(amount * tax_rate, 2)

def calculate_net_withdrawal(amount, tax_rate=0.20):
    """Calculate net amount after tax."""
    tax = calculate_withdrawal_tax(amount, tax_rate)
    return round(amount - tax, 2)
