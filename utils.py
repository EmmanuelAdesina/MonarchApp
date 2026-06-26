import random
from datetime import datetime, timedelta

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