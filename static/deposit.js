// ============================================================
// Deposit Page JS
// ============================================================

let currentExchangeRate = null;
let cryptoPollingInterval = null;
let currentPaymentId = null;
let currentDepositAmount = 0;
let currentMethod = 'card';

const STATUS_MAP = {
    waiting:    { label: 'Awaiting Transfer',     sub: 'Send the exact amount to the address above.', color: 'var(--gold)',  dot: 'var(--gold)',  progress: '5%' },
    detecting:  { label: 'Transaction Detected',  sub: 'We found your payment on the network.',       color: '#F59E0B',     dot: '#F59E0B',     progress: '35%' },
    confirming: { label: 'Confirming on Chain',   sub: 'Waiting for enough blockchain confirmations.', color: '#F59E0B',    dot: '#F59E0B',     progress: '65%' },
    confirmed:  { label: '✅ Payment Confirmed',   sub: 'Crediting your account now…',                color: 'var(--green)',dot: 'var(--green)', progress: '90%' },
    finished:   { label: '✅ Deposit Complete',    sub: 'Your funds have been credited to your account.', color: 'var(--green)', dot: 'var(--green)', progress: '100%' },
    failed:     { label: '❌ Payment Failed',      sub: 'Something went wrong. Please contact support.', color: '#EF4444',  dot: '#EF4444',     progress: '0%' },
    expired:    { label: '⏰ Payment Expired',     sub: 'Session expired. Please start a new deposit.', color: '#EF4444',   dot: '#EF4444',     progress: '0%' },
};

function normaliseStatus(status) {
    if (['waiting', 'partially_paid'].includes(status)) return 'waiting';
    if (['sending', 'confirming'].includes(status)) return 'confirming';
    if (status === 'confirmed') return 'confirmed';
    if (status === 'finished') return 'finished';
    if (['failed', 'refunded'].includes(status)) return 'failed';
    if (status === 'expired') return 'expired';
    return 'waiting';
}

function setModalStatus(rawStatus) {
    const key = normaliseStatus(rawStatus);
    const info = STATUS_MAP[key] || STATUS_MAP['waiting'];
    const statusEl = document.getElementById('cryptoStatus');
    const statusSub = document.getElementById('cryptoStatusSub');
    const progress = document.getElementById('statusProgress');
    const dot = document.getElementById('statusDot');
    if (statusEl) statusEl.textContent = info.label;
    if (statusEl) statusEl.style.color = info.color;
    if (statusSub) statusSub.textContent = info.sub;
    if (progress) progress.style.width = info.progress;
    if (dot) {
        dot.style.background = info.dot;
        dot.style.animation = ['failed','expired','finished'].includes(key) ? 'none' : 'pulse 1.5s infinite';
    }
}

function stopCryptoPolling() {
    if (cryptoPollingInterval) {
        clearInterval(cryptoPollingInterval);
        cryptoPollingInterval = null;
    }
}

function closeCryptoModal() {
    stopCryptoPolling();
    document.getElementById('cryptoModal').style.display = 'none';
}

function copyCryptoAddress() {
    const addressText = document.getElementById('cryptoAddress').innerText.trim();
    navigator.clipboard.writeText(addressText).then(() => {
        const btn = document.getElementById('copyBtn');
        if (btn) {
            const orig = btn.innerHTML;
            btn.innerHTML = '✅ Copied!';
            btn.style.background = 'var(--green)';
            setTimeout(() => {
                btn.innerHTML = orig;
                btn.style.background = 'var(--gold)';
            }, 2500);
        }
    }).catch(() => {
        alert('Could not copy. Please copy the address manually.');
    });
}

function selectDepositMethod(method) {
    currentMethod = method;
    document.querySelectorAll('.payment-method-btn').forEach(b => {
        b.style.background = 'rgba(255,255,255,0.02)';
        b.style.borderColor = 'rgba(255,255,255,0.06)';
    });
    const btn = document.getElementById(method === 'card' ? 'methodCard' : 'methodCrypto');
    if (btn) {
        btn.style.background = 'rgba(200,168,94,0.12)';
        btn.style.borderColor = 'var(--gold)';
    }
    updatePaystackPreview();
}

function formatNgnAmount(value) {
    return `₦${Number(value || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function updatePaystackPreview() {
    const insight = document.getElementById('paystackInsights');
    if (!insight) return;

    if (currentMethod !== 'card') {
        insight.style.display = 'none';
        return;
    }

    const amountInput = document.getElementById('depositAmount');
    const amount = parseFloat(amountInput?.value || '500');
    const rate = currentExchangeRate || 1554.2;
    const ngnAmount = amount > 0 ? amount * rate : 0;

    insight.style.display = 'block';
    document.getElementById('paystackUsdDisplay').textContent = `$${amount.toFixed(2)}`;
    document.getElementById('paystackNgnDisplay').textContent = formatNgnAmount(ngnAmount);
    document.getElementById('paystackRateDisplay').textContent = `1 USD = ${formatNgnAmount(rate)}`;
}

async function loadPaystackRate() {
    try {
        const resp = await fetch('/api/paystack/exchange-rate');
        const data = await resp.json();
        if (data.success && data.rate) {
            currentExchangeRate = parseFloat(data.rate);
        }
    } catch (e) {
        console.warn('Exchange rate unavailable:', e);
    }
    updatePaystackPreview();
}

function quickDeposit(amount) {
    document.getElementById('depositAmount').value = amount;
    updatePaystackPreview();
}

async function pollPaymentStatus() {
    if (!currentPaymentId) return;
    try {
        const resp = await fetch(`/api/payment-status/${currentPaymentId}`);
        const data = await resp.json();
        if (!data.success) return;
        setModalStatus(data.status);
        if (data.credited) {
            stopCryptoPolling();
            setTimeout(() => {
                closeCryptoModal();
                alert(`✅ Deposit confirmed!\n$${currentDepositAmount.toFixed(2)} has been credited to your Monarch portfolio.`);
                window.location.href = '/dashboard';
            }, 1500);
        } else if (['failed', 'expired'].includes(normaliseStatus(data.status))) {
            stopCryptoPolling();
        }
    } catch (e) {
        console.error('Poll error:', e);
    }
}

async function submitDeposit() {
    const amountInput = document.getElementById('depositAmount');
    const amount = parseFloat(amountInput?.value || '0');
    const minLimit = typeof USER_MINIMUM_DEPOSIT !== 'undefined' ? USER_MINIMUM_DEPOSIT : 500.0;
    
    if (!amount || amount < minLimit) {
        alert(`❌ Minimum deposit is $${minLimit.toFixed(2)}`);
        return;
    }

    const btn = document.getElementById('depositBtn');
    btn.disabled = true;
    btn.innerHTML = '⏳ Processing...';

    try {
        if (currentMethod === 'card') {
            // Card deposit via Paystack
            const rate = currentExchangeRate || 1554.2;
            const ngnAmount = amount * rate;
            if (!window.confirm(
                `Deposit Amount: $${amount.toFixed(2)}\n` +
                `Exchange Rate: 1 USD = ${formatNgnAmount(rate)}\n` +
                `Amount to be Charged: ${formatNgnAmount(ngnAmount)}\n\nContinue to Paystack?`
            )) {
                btn.disabled = false;
                btn.innerHTML = '<span>💰</span> Deposit Now';
                return;
            }

            const resp = await fetch('/api/deposit-card', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount })
            });
            const data = await resp.json();
            if (data.success) {
                window.location.href = data.authorization_url;
            } else {
                alert('❌ Deposit failed: ' + data.message);
            }
        } else {
            // Crypto deposit
            const resp = await fetch('/api/create-crypto-payment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount, method: currentMethod })
            });
            const data = await resp.json();
            if (!data.success) {
                alert('❌ ' + data.message);
                return;
            }

            const currency = data.pay_currency;
            const payAmount = parseFloat(data.pay_amount).toFixed(currency === 'BTC' ? 6 : 4);
            const networkNote = currentMethod === 'crypto-usdt' ? 'USDT · TRC20 Network'
                : currentMethod === 'crypto-btc' ? 'BTC · Bitcoin Network'
                : 'ETH · ERC20 Network';

            document.getElementById('cryptoCurrencyLabel').textContent = networkNote;
            document.getElementById('cryptoAmountGuide').textContent = payAmount;
            document.getElementById('cryptoCurrencyGuide').textContent = currency;
            document.getElementById('cryptoAddress').textContent = data.pay_address;
            document.getElementById('cryptoAmountDisplay').textContent = `${payAmount} ${currency}`;
            document.getElementById('cryptoUsdEquiv').textContent = `≈ $${amount.toFixed(2)} USD`;

            setModalStatus('waiting');
            currentPaymentId = data.payment_id;
            currentDepositAmount = amount;

            document.getElementById('cryptoModal').style.display = 'flex';

            stopCryptoPolling();
            cryptoPollingInterval = setInterval(pollPaymentStatus, 15000);
        }
    } catch (e) {
        alert('❌ Network error. Please try again.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>💰</span> Deposit Now';
    }
}

// Init
document.addEventListener('DOMContentLoaded', function() {
    loadPaystackRate();
    const amountInput = document.getElementById('depositAmount');
    if (amountInput) {
        amountInput.addEventListener('input', updatePaystackPreview);
    }
});
