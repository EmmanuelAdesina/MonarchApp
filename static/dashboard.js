// ============================================================
// Dashboard JS — Auto‑update, Chart, Feed, Deposit
// ============================================================

const portfolioValueEl = document.getElementById('portfolioValue');
const investedEl = document.getElementById('invested');

let balance = portfolioValueEl ? parseFloat(portfolioValueEl.textContent.replace('$', '')) : 0.0;
let invested = investedEl ? parseFloat(investedEl.textContent.replace('$', '')) : 0.0;
const updateInterval = 3000; // ms

// ---- Chart Generation ----
function generateChart() {
    const container = document.getElementById('chartBars');
    const count = 24;
    let heights = [];
    let current = 20;
    for (let i = 0; i < count; i++) {
        const trend = (i / count) * 70;
        const noise = (Math.random() - 0.5) * 12;
        let h = Math.max(8, Math.min(100, trend + noise + 15));
        if (i > 0 && h < heights[i - 1] - 5) h = heights[i - 1] - 5;
        heights.push(h);
    }
    window._chartHeights = heights;
    container.innerHTML = heights.map(h => `<div class="chart-bar" style="height:${h}%"></div>`).join('');
}

// ---- Update Dashboard from API ----
async function updateDashboard() {
    try {
        const resp = await fetch('/api/balance');
        const data = await resp.json();
        // Update DOM
        document.getElementById('portfolioValue').textContent = `$${data.balance.toFixed(2)}`;
        document.getElementById('invested').textContent = `$${data.invested.toFixed(2)}`;
        document.getElementById('profit').textContent = `$${data.profit.toFixed(2)}`;
        document.getElementById('profitChange').textContent = `+${data.roi.toFixed(1)}%`;
        document.getElementById('roiDisplay').textContent = `+${data.roi.toFixed(1)}%`;
        document.getElementById('todayGain').textContent = `+$${data.growth_today.toFixed(2)}`;
        document.getElementById('todayPercent').textContent = `+${data.growth_percent.toFixed(1)}%`;
        document.getElementById('chartReturn').textContent = `+${data.roi.toFixed(1)}%`;

        // Update chart bars (shift slightly)
        if (window._chartHeights) {
            const bars = document.querySelectorAll('#chartBars .chart-bar');
            const newHeights = window._chartHeights.map((h, i) => {
                const shift = (Math.random() - 0.5) * 6;
                let nh = Math.max(8, Math.min(100, h + shift));
                if (i > 0 && nh < newHeights[i - 1] - 2) nh = newHeights[i - 1] - 2;
                return nh;
            });
            window._chartHeights = newHeights;
            bars.forEach((bar, i) => {
                bar.style.height = newHeights[i] + '%';
            });
        }

        // Update activity feed
        await updateFeed();

    } catch (e) {
        console.error('Update error:', e);
    }
}

// ---- Activity Feed ----
async function updateFeed() {
    try {
        const resp = await fetch('/api/activity');
        const items = await resp.json();
        const container = document.getElementById('dashFeed');
        container.innerHTML = items.map(item => `
            <div class="feed-item">
                <span class="left">
                    <span class="${item.type === 'deposit' ? 'gold' : 'green'}">${item.type === 'deposit' ? '📊' : '📈'}</span>
                    ${item.name ? `<strong>${item.name}</strong> ` : ''}${item.text}
                </span>
                <span class="time">${item.time}</span>
            </div>
        `).join('');
    } catch (e) {
        console.error('Feed error:', e);
    }
}

// ---- Deposit ----
let cryptoPollingInterval = null;
let currentPaymentId = null;
let currentDepositAmount = 0;

const STATUS_MAP = {
    waiting:    { label: 'Awaiting Transfer',     sub: 'Send the exact amount to the address above.', color: 'var(--gold)',  dot: 'var(--gold)',  progress: '5%' },
    detecting:  { label: 'Transaction Detected',  sub: 'We found your payment on the network.',       color: '#F59E0B',     dot: '#F59E0B',     progress: '35%' },
    confirming: { label: 'Confirming on Chain',   sub: 'Waiting for enough blockchain confirmations.', color: '#F59E0B',    dot: '#F59E0B',     progress: '65%' },
    confirmed:  { label: '✅ Payment Confirmed',   sub: 'Crediting your account now…',                color: 'var(--green)',dot: 'var(--green)', progress: '90%' },
    finished:   { label: '✅ Deposit Complete',    sub: 'Your funds have been credited to your account.', color: 'var(--green)', dot: 'var(--green)', progress: '100%' },
    failed:     { label: '❌ Payment Failed',      sub: 'Something went wrong. Please contact support.', color: '#EF4444',  dot: '#EF4444',     progress: '0%' },
    expired:    { label: '⏰ Payment Expired',     sub: 'Session expired. Please start a new deposit.', color: '#EF4444',   dot: '#EF4444',     progress: '0%' },
};

// Map NowPayments statuses to our simplified ones
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
    document.getElementById('cryptoStatus').textContent    = info.label;
    document.getElementById('cryptoStatus').style.color   = info.color;
    document.getElementById('cryptoStatusSub').textContent = info.sub;
    document.getElementById('statusProgress').style.width  = info.progress;
    document.getElementById('statusDot').style.background  = info.dot;
    document.getElementById('statusDot').style.animation  =
        ['failed','expired','finished'].includes(key) ? 'none' : 'pulse 1.5s infinite';
}

function stopCryptoPolling() {
    if (cryptoPollingInterval) {
        clearInterval(cryptoPollingInterval);
        cryptoPollingInterval = null;
    }
}

function openDepositModal() {
    document.getElementById('depositModal').style.display = 'flex';
}

function closeDepositModal() {
    document.getElementById('depositModal').style.display = 'none';
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

async function pollPaymentStatus() {
    if (!currentPaymentId) return;
    try {
        const resp = await fetch(`/api/payment-status/${currentPaymentId}`);
        const data = await resp.json();

        if (!data.success) {
            console.warn('Status check error:', data.message);
            return;
        }

        setModalStatus(data.status);

        if (data.credited) {
            stopCryptoPolling();
            balance = data.new_balance;
            setTimeout(async () => {
                closeCryptoModal();
                document.getElementById('portfolioValue').textContent = `$${balance.toFixed(2)}`;
                await updateDashboard();
                alert(`✅ Deposit confirmed!\n$${currentDepositAmount.toFixed(2)} has been credited to your Monarch portfolio.`);
            }, 1500);
        } else if (['failed', 'expired'].includes(normaliseStatus(data.status))) {
            stopCryptoPolling();
        }
    } catch (e) {
        console.error('Poll error:', e);
    }
}

async function submitDeposit() {
    const amount = parseFloat(document.getElementById('depositAmount').value);
    if (!amount || amount <= 0) {
        alert('Please enter a valid amount.');
        return;
    }

    const method = document.getElementById('depositMethod').value;

    if (method === 'card') {
        const submitBtn = document.querySelector('#depositModal button[onclick="submitDeposit()"]');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Redirecting...'; }
        try {
            const resp = await fetch('/api/deposit-card', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount })
            });
            const data = await resp.json();
            if (data.success) {
                // Redirect to Paystack checkout page
                window.location.href = data.authorization_url;
            } else {
                alert('Deposit failed: ' + data.message);
            }
        } catch (e) {
            alert('Error processing deposit.');
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Deposit'; }
        }
        return;
    }

    // ---- Crypto: call NowPayments ----
    const submitBtn = document.querySelector('#depositModal button[onclick="submitDeposit()"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creating invoice…'; }

    try {
        const resp = await fetch('/api/create-crypto-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, method })
        });
        const data = await resp.json();

        if (!data.success) {
            alert('Could not create payment: ' + data.message);
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Deposit'; }
            return;
        }

        // Populate the modal fields
        const currency    = data.pay_currency;
        const payAmount   = parseFloat(data.pay_amount).toFixed(data.pay_currency === 'BTC' ? 6 : 4);
        const networkNote = method === 'crypto-usdt' ? 'USDT · TRC20 Network'
                          : method === 'crypto-btc'  ? 'BTC · Bitcoin Network'
                          :                            'ETH · ERC20 Network';

        document.getElementById('cryptoCurrencyLabel').textContent  = networkNote;
        document.getElementById('cryptoAmountGuide').textContent    = payAmount;
        document.getElementById('cryptoCurrencyGuide').textContent  = currency;
        document.getElementById('cryptoAddress').textContent        = data.pay_address;
        document.getElementById('cryptoAmountDisplay').textContent  = `${payAmount} ${currency}`;
        document.getElementById('cryptoUsdEquiv').textContent       = `≈ $${amount.toFixed(2)} USD`;

        // Reset status UI
        setModalStatus('waiting');

        // Store for polling
        currentPaymentId   = data.payment_id;
        currentDepositAmount = amount;

        // Show modal
        closeDepositModal();
        document.getElementById('cryptoModal').style.display = 'flex';

        // Start polling every 15 seconds (NowPayments rate limit safe)
        stopCryptoPolling();
        cryptoPollingInterval = setInterval(pollPaymentStatus, 15000);

    } catch (e) {
        alert('Network error. Please try again.');
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Deposit'; }
    }
}

// ============================================================
// WITHDRAWAL SYSTEM
// ============================================================

let withdrawalData = null;
let withdrawalTaxPollingInterval = null;
let currentWithdrawalId = null;

function showHomeView() {
    document.getElementById('homeView').style.display = 'block';
    document.getElementById('withdrawalContainer').style.display = 'none';
    
    document.getElementById('navHome').classList.add('active');
    document.getElementById('navWithdraw').classList.remove('active');
}

function showWithdrawView() {
    document.getElementById('homeView').style.display = 'none';
    document.getElementById('withdrawalContainer').style.display = 'block';
    
    document.getElementById('navHome').classList.remove('active');
    document.getElementById('navWithdraw').classList.add('active');
    
    // Update available balance on withdraw screen
    document.getElementById('withdrawAvailableBalance').textContent = '$' + balance.toFixed(2);
    calculateBreakdown();
}

function setMaxAmount() {
    document.getElementById('withdrawAmount').value = Math.floor(balance);
    calculateBreakdown();
}

function calculateBreakdown() {
    const amount = parseFloat(document.getElementById('withdrawAmount').value) || 0;
    const tax = amount * 0.20;
    const net = amount - tax;

    document.getElementById('displayAmount').textContent = '$' + amount.toFixed(2);
    document.getElementById('displayTax').textContent = '$' + tax.toFixed(2);
    document.getElementById('displayNet').textContent = '$' + net.toFixed(2);

    const withdrawBtn = document.getElementById('withdrawBtn');
    if (withdrawBtn) {
        withdrawBtn.disabled = amount < 10 || amount > balance;
    }
}

async function requestWithdrawal() {
    const amount = parseFloat(document.getElementById('withdrawAmount').value);
    if (amount > balance) {
        alert('❌ Insufficient balance');
        return;
    }
    if (amount < 10) {
        alert('❌ Minimum withdrawal is $10.00');
        return;
    }

    const withdrawBtn = document.getElementById('withdrawBtn');
    if (withdrawBtn) { withdrawBtn.disabled = true; withdrawBtn.textContent = 'Processing...'; }

    try {
        const response = await fetch('/api/withdrawal/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount })
        });
        const data = await response.json();

        if (data.success) {
            withdrawalData = data.data;
            currentWithdrawalId = data.data.id;
            
            // Show tax modal
            document.getElementById('modalAmount').textContent = '$' + data.data.amount.toFixed(2);
            document.getElementById('modalTax').textContent = '$' + data.data.tax_amount.toFixed(2);
            document.getElementById('taxModal').style.display = 'flex';
        } else {
            alert('❌ ' + data.message);
        }
    } catch (error) {
        alert('❌ Withdrawal request failed');
    } finally {
        if (withdrawBtn) { withdrawBtn.disabled = false; withdrawBtn.textContent = 'Request Withdrawal →'; }
    }
}

function closeTaxModal() {
    document.getElementById('taxModal').style.display = 'none';
}

async function payTaxCrypto() {
    try {
        const response = await fetch('/api/withdrawal/pay-tax-crypto', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ withdrawal_id: currentWithdrawalId })
        });
        const data = await response.json();
        if (data.success) {
            closeTaxModal();
            
            // Populate the crypto payment modal
            const invoice = data.invoice;
            const currency = invoice.pay_currency;
            const payAmount = parseFloat(invoice.pay_amount).toFixed(currency === 'BTC' ? 6 : 4);
            const networkNote = currency === 'USDT' ? 'USDT · TRC20 Network'
                              : currency === 'BTC'  ? 'BTC · Bitcoin Network'
                              :                       'ETH · ERC20 Network';

            document.getElementById('cryptoCurrencyLabel').textContent  = networkNote;
            document.getElementById('cryptoAmountGuide').textContent    = payAmount;
            document.getElementById('cryptoCurrencyGuide').textContent  = currency;
            document.getElementById('cryptoAddress').textContent        = invoice.pay_address;
            document.getElementById('cryptoAmountDisplay').textContent  = `${payAmount} ${currency}`;
            document.getElementById('cryptoUsdEquiv').textContent       = `≈ $${(withdrawalData ? withdrawalData.tax_amount : invoice.pay_amount).toFixed(2)} USD`;

            // Store ID for status checking
            currentPaymentId = invoice.payment_id;
            
            // Set modal status to waiting
            setModalStatus('waiting');
            
            // If mock, show simulation button
            const simContainer = document.getElementById('sandboxSimulateBtnContainer');
            if (simContainer) {
                if (currentPaymentId.startsWith('mock_')) {
                    simContainer.style.display = 'block';
                } else {
                    simContainer.style.display = 'none';
                }
            }

            // Show crypto modal
            document.getElementById('cryptoModal').style.display = 'flex';
            
            // Start withdrawal status polling instead of deposit polling
            stopCryptoPolling(); // stop deposit polling if any
            if (withdrawalTaxPollingInterval) clearInterval(withdrawalTaxPollingInterval);
            withdrawalTaxPollingInterval = setInterval(pollWithdrawalTaxStatus, 5000);
        } else {
            alert('❌ ' + data.message);
        }
    } catch (error) {
        alert('❌ Tax payment initiation failed');
    }
}

async function payTaxCard() {
    try {
        const response = await fetch('/api/withdrawal/pay-tax-card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ withdrawal_id: currentWithdrawalId })
        });
        const data = await response.json();
        if (data.success) {
            // Redirect to Paystack or simulated page
            window.location.href = data.authorization_url;
        } else {
            alert('❌ ' + data.message);
        }
    } catch (error) {
        alert('❌ Tax payment initiation failed');
    }
}

async function pollWithdrawalTaxStatus() {
    if (!currentWithdrawalId) return;
    try {
        const resp = await fetch(`/api/withdrawal/status/${currentWithdrawalId}`);
        const result = await resp.json();
        if (!result.success) return;
        
        const data = result.data;
        if (data.tax_paid || ['pending', 'completed'].includes(data.status)) {
            if (withdrawalTaxPollingInterval) {
                clearInterval(withdrawalTaxPollingInterval);
                withdrawalTaxPollingInterval = null;
            }
            
            // Update UI status to completed
            setModalStatus('finished');
            
            setTimeout(() => {
                closeCryptoModal();
                alert(`✅ Tax payment verified!\nYour withdrawal request for $${data.amount.toFixed(2)} has been successfully submitted for processing.`);
                window.location.reload();
            }, 2000);
        }
    } catch (e) {
        console.error('Error checking withdrawal tax status:', e);
    }
}

async function checkActiveWithdrawal() {
    try {
        const resp = await fetch('/api/withdrawal/active-pending');
        const data = await resp.json();
        
        if (data.success && data.data) {
            const w = data.data;
            withdrawalData = w;
            currentWithdrawalId = w.id;
            
            // If user has an active withdrawal, display the status at the top
            if (w.status === 'tax_required') {
                document.getElementById('taxRequiredStatusCard').style.display = 'flex';
                document.getElementById('unpaidAmountDisplay').textContent = '$' + w.amount.toFixed(2);
                document.getElementById('unpaidTaxDisplay').textContent = '$' + w.tax_amount.toFixed(2);
                
                // Hide input form so they don't submit another one
                const formView = document.querySelector('#withdrawalContainer .withdrawal-form');
                if (formView) formView.style.display = 'none';
            } else if (w.status === 'pending') {
                document.getElementById('withdrawalStatusCard').style.display = 'flex';
                document.getElementById('pendingAmountDisplay').textContent = '$' + w.amount.toFixed(2);
                
                // Hide input form
                const formView = document.querySelector('#withdrawalContainer .withdrawal-form');
                if (formView) formView.style.display = 'none';
            }
        }
    } catch (e) {
        console.error('Error fetching active withdrawal:', e);
    }
}

function resumeTaxPayment() {
    if (withdrawalData) {
        document.getElementById('modalAmount').textContent = '$' + withdrawalData.amount.toFixed(2);
        document.getElementById('modalTax').textContent = '$' + withdrawalData.tax_amount.toFixed(2);
        document.getElementById('taxModal').style.display = 'flex';
    }
}

async function loadReceipts() {
    const container = document.getElementById('receiptsList');
    if (!container) return;

    try {
        const resp = await fetch('/api/withdrawal/receipts');
        const data = await resp.json();

        if (data.success && data.receipts && data.receipts.length > 0) {
            container.innerHTML = data.receipts.map(r => `
                <div class="feed-item" style="padding: 1rem; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 0.8rem; display: flex; flex-direction: column; gap: 0.5rem; background: rgba(255,255,255,0.01);">
                    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <strong style="color: var(--gold); font-size: 0.85rem;">${r.bank_name} Payout</strong>
                        <span style="color: var(--green); font-size: 0.65rem; font-weight: bold; background: rgba(74,222,128,0.1); padding: 0.15rem 0.5rem; border-radius: 4px; text-transform: uppercase;">✅ Settled</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; font-size: 0.72rem; color: var(--text-dim);">
                        <span>Ref: ${r.receipt_number}</span>
                        <span>Date: ${r.date}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; border-top: 1px dashed rgba(201,168,76,0.1); padding-top: 0.5rem; margin-top: 0.2rem;">
                        <div>
                            <span style="font-size: 0.65rem; color: var(--text-faint); display: block;">Net Settled</span>
                            <strong style="font-size: 1rem; color: var(--text);">$${r.net_amount.toFixed(2)}</strong>
                        </div>
                        <button onclick="downloadReceipt('${r.id}')" class="btn-outline" style="padding: 0.25rem 0.6rem; font-size: 0.65rem; border: 1px solid var(--gold-dim); color: var(--gold); border-radius: 4px; background: transparent; cursor: pointer; transition: all 0.2s; text-transform: uppercase; font-weight: bold;">
                            📄 View Payout Receipt
                        </button>
                    </div>
                </div>
            `).join('');
        } else {
            container.innerHTML = `<p style="text-align: center; color: var(--text-faint); font-size: 0.8rem; padding: 1.5rem 0;">No completed payouts yet.</p>`;
        }
    } catch (e) {
        console.error('Error loading receipts:', e);
        container.innerHTML = `<p style="text-align: center; color: #EF4444; font-size: 0.8rem; padding: 1.5rem 0;">Failed to load receipts.</p>`;
    }
}

function downloadReceipt(receiptId) {
    window.open(`/receipt/print/${receiptId}`, '_blank');
}

// ---- Initialization ----
document.addEventListener('DOMContentLoaded', async function () {
    const portfolioVal = document.getElementById('portfolioValue');
    if (portfolioVal) {
        generateChart();
        updateDashboard();
        await checkActiveWithdrawal();
        await loadReceipts();
        setInterval(updateDashboard, updateInterval);
    }
});