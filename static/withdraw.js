// ============================================================
// Withdraw Page JS
// ============================================================

let withdrawalData = null;
let currentWithdrawalId = null;
let withdrawalTaxPollingInterval = null;
const MINIMUM_WITHDRAWAL = 1000;

// ---- Wallet Form ----
function showWalletForm() {
    document.getElementById('walletFormCard').style.display = 'block';
    document.getElementById('walletFormCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function hideWalletForm() {
    document.getElementById('walletFormCard').style.display = 'none';
}

function updateWalletPreview() {
    // no-op for now
}

async function submitWalletForm(event) {
    event.preventDefault();
    const address = document.getElementById('walletAddress').value.trim();
    const confirm = document.getElementById('walletAddressConfirm').value.trim();
    const network = document.getElementById('walletNetwork').value;
    const currency = document.getElementById('walletCurrency').value;

    if (address !== confirm) {
        alert('❌ Wallet addresses do not match. Please re-enter carefully.');
        return;
    }

    // Basic validation
    if (network.includes('ERC-20') || network.includes('BEP-20')) {
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
            alert('❌ Invalid Ethereum/BSC address. Must be 0x + 40 hex characters.');
            return;
        }
    } else if (network.includes('TRC-20')) {
        if (!/^T[a-zA-Z0-9]{33}$/.test(address)) {
            alert('❌ Invalid Tron address. Must start with T and be 34 characters.');
            return;
        }
    } else if (network === 'Bitcoin') {
        if (!/^[1-9A-HJ-NP-Za-km-z]{26,35}$/.test(address)) {
            alert('❌ Invalid Bitcoin address.');
            return;
        }
    }

    const btn = document.getElementById('walletSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        const resp = await fetch('/api/user/wallet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet_address: address, wallet_network: network, wallet_currency: currency })
        });
        const data = await resp.json();
        if (data.success) {
            alert('✅ Wallet saved successfully!');
            hideWalletForm();
            await loadWithdrawalEligibility();
        } else {
            alert('❌ ' + (data.message || 'Failed to save wallet.'));
        }
    } catch (e) {
        alert('❌ Network error. Please try again.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save Wallet →';
    }
}

// ---- Eligibility ----
async function loadWithdrawalEligibility() {
    try {
        const resp = await fetch('/api/withdrawal/eligibility');
        const result = await resp.json();
        if (!result.success) return;

        const d = result.data;
        const form = document.getElementById('withdrawalRequestForm');
        const closed = document.getElementById('windowClosedMessage');
        const withdrawBtn = document.getElementById('withdrawBtn');
        const countdownSection = document.getElementById('countdownSection');
        const countdownDisplay = document.getElementById('countdownDisplay');

        // Update form display
        document.getElementById('walletMissingBanner').style.display = d.wallet_address ? 'none' : 'block';
        document.getElementById('walletInfoBanner').style.display = d.wallet_address ? 'flex' : 'none';
        if (d.wallet_address) {
            const addr = d.wallet_address;
            document.getElementById('walletAddressPreview').textContent =
                addr.length > 20 ? addr.slice(0, 10) + '...' + addr.slice(-8) : addr;
        }

        // Update cycle info
        if (d.processing_day) {
            document.getElementById('cycleProcessingDate').innerHTML = d.processing_day;
        }

        // Eligibility status
        const statusLabel = document.getElementById('eligibilityStatusLabel');
        let isEligible = true;
        let reasons = [];

        if (!d.can_request_now) {
            isEligible = false;
            reasons.push('Withdrawal window is closed (1st–25th only)');
        }
        if (!d.wallet_provided) {
            isEligible = false;
            reasons.push('No crypto wallet set');
        }
        if (!d.eligible) {
            isEligible = false;
            reasons.push(`Balance below $${d.minimum_withdrawal.toFixed(2)} minimum`);
        }
        if (d.has_active_request) {
            isEligible = false;
            reasons.push(`You have an active ${d.active_request_status} request`);
        }

        if (isEligible) {
            statusLabel.textContent = '✅ Eligible for Withdrawal';
            statusLabel.style.color = 'var(--green)';
            form.style.display = 'block';
            closed.style.display = 'none';
            if (withdrawBtn) withdrawBtn.disabled = false;
        } else {
            statusLabel.textContent = '❌ ' + reasons[0];
            statusLabel.style.color = '#F87171';
            form.style.display = 'none';
            closed.style.display = d.can_request_now ? 'none' : 'block';
            if (withdrawBtn) withdrawBtn.disabled = true;
        }

        // Countdown timer
        countdownSection.style.display = 'block';
        startCountdown(d.processing_day);

    } catch (e) {
        console.error('Eligibility load error:', e);
    }
}

// ---- Countdown Timer ----
function startCountdown(targetDateStr) {
    const display = document.getElementById('countdownDisplay');
    if (!display || !targetDateStr) return;

    const target = new Date(targetDateStr + 'T23:59:59');
    if (isNaN(target.getTime())) {
        // Calculate last day of current month
        const now = new Date();
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        target.setTime(lastDay.getTime());
        target.setHours(23, 59, 59, 0);
    }

    function tick() {
        const now = new Date();
        const diff = target.getTime() - now.getTime();
        if (diff <= 0) {
            display.textContent = 'Processing Now';
            return;
        }
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const secs = Math.floor((diff % (1000 * 60)) / 1000);
        display.textContent = `${days}d ${hours}h ${mins}m ${secs}s`;
    }

    tick();
    setInterval(tick, 1000);
}

// ---- Withdrawal Form ----
function setMaxAmount() {
    const balanceEl = document.getElementById('withdrawAvailableBalance');
    const balance = parseFloat(balanceEl.textContent.replace(/[^0-9.-]/g, '')) || 0;
    document.getElementById('withdrawAmount').value = Math.floor(balance);
    calculateBreakdown();
}

function calculateBreakdown() {
    const amount = parseFloat(document.getElementById('withdrawAmount')?.value) || 0;
    const tax = amount * 0.20;
    const net = amount - tax;

    document.getElementById('displayAmount').textContent = '$' + amount.toFixed(2);
    document.getElementById('displayTax').textContent = '$' + tax.toFixed(2);
    document.getElementById('displayNet').textContent = '$' + net.toFixed(2);

    const withdrawBtn = document.getElementById('withdrawBtn');
    if (withdrawBtn) {
        withdrawBtn.disabled = amount < MINIMUM_WITHDRAWAL || amount > parseFloat(document.getElementById('withdrawAvailableBalance').textContent.replace(/[^0-9.-]/g, ''));
    }

    // Eligibility bar
    const eligBar = document.getElementById('eligibilityBar');
    if (eligBar && amount > 0) {
        eligBar.style.display = 'block';
        const pct = Math.min(100, (amount / MINIMUM_WITHDRAWAL) * 100);
        document.getElementById('eligibilityFill').style.width = pct + '%';
        document.getElementById('eligibilityPercent').textContent = Math.round(pct) + '%';
        if (amount < MINIMUM_WITHDRAWAL) {
            document.getElementById('eligibilityNote').textContent = `Need $${(MINIMUM_WITHDRAWAL - amount).toFixed(2)} more to meet the minimum.`;
        } else {
            document.getElementById('eligibilityNote').textContent = '✓ Eligible for withdrawal.';
        }
    } else if (eligBar) {
        eligBar.style.display = 'none';
    }
}

async function requestWithdrawal() {
    const amountInput = document.getElementById('withdrawAmount');
    const amount = parseFloat(amountInput?.value);
    const balanceEl = document.getElementById('withdrawAvailableBalance');
    const balance = parseFloat(balanceEl.textContent.replace(/[^0-9.-]/g, '')) || 0;

    if (!amount || amount < MINIMUM_WITHDRAWAL) {
        alert(`❌ Minimum withdrawal is $${MINIMUM_WITHDRAWAL.toFixed(2)}`);
        return;
    }
    if (amount > balance) {
        alert('❌ Insufficient balance');
        return;
    }

    const btn = document.getElementById('withdrawBtn');
    btn.disabled = true;
    btn.textContent = 'Processing...';

    try {
        const resp = await fetch('/api/withdrawal/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount })
        });
        const data = await resp.json();

        if (data.success) {
            withdrawalData = data.data;
            currentWithdrawalId = data.data.withdrawal_id;

            document.getElementById('modalAmount').textContent = '$' + data.data.amount.toFixed(2);
            document.getElementById('modalTax').textContent = '$' + data.data.tax.toFixed(2);
            document.getElementById('taxModal').style.display = 'flex';
        } else {
            alert('❌ ' + data.message);
        }
    } catch (e) {
        alert('❌ Withdrawal request failed');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Request Withdrawal →';
    }
}

// ---- Tax Payment ----
function closeTaxModal() {
    document.getElementById('taxModal').style.display = 'none';
}

async function payTaxCrypto() {
    try {
        const resp = await fetch('/api/withdrawal/pay-tax-crypto', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ withdrawal_id: currentWithdrawalId })
        });
        const data = await resp.json();
        if (data.success) {
            closeTaxModal();
            const invoice = data.invoice;
            const currency = invoice.pay_currency;
            const payAmount = parseFloat(invoice.pay_amount).toFixed(currency === 'BTC' ? 6 : 4);
            const networkNote = currency === 'USDT' ? 'USDT · TRC20 Network'
                : currency === 'BTC' ? 'BTC · Bitcoin Network'
                : 'ETH · ERC20 Network';

            // Update crypto modal elements if they exist (reuse from deposit page)
            const cryptoModal = document.getElementById('cryptoModal');
            if (cryptoModal) {
                document.getElementById('cryptoCurrencyLabel').textContent = networkNote;
                document.getElementById('cryptoAmountGuide').textContent = payAmount;
                document.getElementById('cryptoCurrencyGuide').textContent = currency;
                document.getElementById('cryptoAddress').textContent = invoice.pay_address;
                document.getElementById('cryptoAmountDisplay').textContent = `${payAmount} ${currency}`;
                document.getElementById('cryptoUsdEquiv').textContent = `≈ $${(withdrawalData ? withdrawalData.tax_amount : 0).toFixed(2)} USD`;
                setModalStatus('waiting');
                cryptoModal.style.display = 'flex';
            } else {
                alert(`💎 Send exactly ${payAmount} ${currency} to:\n\n${invoice.pay_address}\n\nNetwork: ${networkNote}`);
            }

            // Start polling
            if (withdrawalTaxPollingInterval) clearInterval(withdrawalTaxPollingInterval);
            withdrawalTaxPollingInterval = setInterval(pollWithdrawalTaxStatus, 5000);
        } else {
            alert('❌ ' + data.message);
        }
    } catch (e) {
        alert('❌ Tax payment initiation failed');
    }
}

async function payTaxCard() {
    try {
        const resp = await fetch('/api/withdrawal/pay-tax-card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ withdrawal_id: currentWithdrawalId })
        });
        const data = await resp.json();
        if (data.success) {
            window.location.href = data.authorization_url;
        } else {
            alert('❌ ' + data.message);
        }
    } catch (e) {
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
            const cryptoModal = document.getElementById('cryptoModal');
            if (cryptoModal) {
                setModalStatus('finished');
                setTimeout(() => {
                    cryptoModal.style.display = 'none';
                    alert(`✅ Tax paid! Withdrawal $${data.amount.toFixed(2)} is now processing.`);
                    window.location.reload();
                }, 2000);
            } else {
                alert(`✅ Tax paid! Withdrawal $${data.amount.toFixed(2)} is now processing.`);
                window.location.reload();
            }
        }
    } catch (e) {
        console.error('Tax status poll error:', e);
    }
}

function resumeTaxPayment() {
    if (withdrawalData) {
        document.getElementById('modalAmount').textContent = '$' + withdrawalData.amount.toFixed(2);
        document.getElementById('modalTax').textContent = '$' + withdrawalData.tax_amount.toFixed(2);
        document.getElementById('taxModal').style.display = 'flex';
    }
}

// ---- Status Cards ----
async function checkActiveWithdrawal() {
    // Hide all status cards
    ['taxRequiredStatusCard', 'pendingStatusCard', 'completedStatusCard', 'rejectedStatusCard'].forEach(id => {
        document.getElementById(id).style.display = 'none';
    });

    try {
        const resp = await fetch('/api/withdrawal/active-pending');
        const data = await resp.json();

        if (data.success && data.data) {
            const w = data.data;
            withdrawalData = w;
            currentWithdrawalId = w.id;

            const isDismissed = localStorage.getItem('dismissed_withdrawal_' + w.id) === 'true';

            if (w.status === 'tax_required') {
                document.getElementById('taxRequiredStatusCard').style.display = 'flex';
                document.getElementById('unpaidAmountDisplay').textContent = '$' + w.amount.toFixed(2);
                document.getElementById('unpaidTaxDisplay').textContent = '$' + w.tax_amount.toFixed(2);
            } else if (w.status === 'pending') {
                document.getElementById('pendingStatusCard').style.display = 'flex';
                document.getElementById('pendingAmountDisplay').textContent = '$' + w.amount.toFixed(2);
            } else if (w.status === 'completed' && !isDismissed) {
                document.getElementById('completedStatusCard').style.display = 'flex';
                document.getElementById('completedAmountDisplay').textContent = '$' + w.amount.toFixed(2);
                const receiptBtn = document.getElementById('completedReceiptBtn');
                if (receiptBtn) {
                    receiptBtn.onclick = () => window.open('/receipt/print/' + w.id, '_blank');
                }
            } else if (w.status === 'rejected' && !isDismissed) {
                document.getElementById('rejectedStatusCard').style.display = 'flex';
                document.getElementById('rejectedAmountDisplay').textContent = '$' + w.amount.toFixed(2);
                document.getElementById('rejectedReasonDisplay').textContent = w.admin_notes || 'Failed compliance audit.';
            }
        }
    } catch (e) {
        console.error('Error fetching active withdrawal:', e);
    }
}

function dismissBanner(type) {
    if (currentWithdrawalId) {
        localStorage.setItem('dismissed_withdrawal_' + currentWithdrawalId, 'true');
        document.getElementById(type + 'StatusCard').style.display = 'none';
        loadWithdrawalEligibility();
    }
}

// ---- Crypto Modal Helpers (shared with deposit) ----
function setModalStatus(rawStatus) {
    const STATUS_MAP = {
        waiting:    { label: 'Awaiting Transfer',     sub: 'Send the exact amount to the address above.', color: 'var(--gold)',  dot: 'var(--gold)',  progress: '5%' },
        detecting:  { label: 'Transaction Detected',  sub: 'We found your payment on the network.',       color: '#F59E0B',     dot: '#F59E0B',     progress: '35%' },
        confirming: { label: 'Confirming on Chain',   sub: 'Waiting for enough blockchain confirmations.', color: '#F59E0B',    dot: '#F59E0B',     progress: '65%' },
        confirmed:  { label: '✅ Payment Confirmed',   sub: 'Crediting your account now…',                color: 'var(--green)',dot: 'var(--green)', progress: '90%' },
        finished:   { label: '✅ Deposit Complete',    sub: 'Your funds have been credited.',             color: 'var(--green)', dot: 'var(--green)', progress: '100%' },
        failed:     { label: '❌ Payment Failed',      sub: 'Something went wrong. Contact support.',     color: '#EF4444',  dot: '#EF4444',     progress: '0%' },
        expired:    { label: '⏰ Payment Expired',     sub: 'Session expired. Start a new deposit.',      color: '#EF4444',   dot: '#EF4444',     progress: '0%' },
    };
    const normaliseStatus = (s) => {
        if (['waiting', 'partially_paid'].includes(s)) return 'waiting';
        if (['sending', 'confirming'].includes(s)) return 'confirming';
        if (s === 'confirmed') return 'confirmed';
        if (s === 'finished') return 'finished';
        if (['failed', 'refunded'].includes(s)) return 'failed';
        if (s === 'expired') return 'expired';
        return 'waiting';
    };
    const key = normaliseStatus(rawStatus);
    const info = STATUS_MAP[key] || STATUS_MAP['waiting'];
    const statusEl = document.getElementById('cryptoStatus');
    const statusSub = document.getElementById('cryptoStatusSub');
    const progress = document.getElementById('statusProgress');
    const dot = document.getElementById('statusDot');
    if (statusEl) { statusEl.textContent = info.label; statusEl.style.color = info.color; }
    if (statusSub) statusSub.textContent = info.sub;
    if (progress) progress.style.width = info.progress;
    if (dot) {
        dot.style.background = info.dot;
        dot.style.animation = ['failed','expired','finished'].includes(key) ? 'none' : 'pulse 1.5s infinite';
    }
}

function closeCryptoModal() {
    const modal = document.getElementById('cryptoModal');
    if (modal) modal.style.display = 'none';
}

// ---- Receipts ----
async function loadReceipts() {
    const container = document.getElementById('receiptsList');
    if (!container) return;

    try {
        const resp = await fetch('/api/withdrawal/receipts');
        const data = await resp.json();

        if (data.success && data.receipts && data.receipts.length > 0) {
            container.innerHTML = data.receipts.map(r => `
                <div style="padding:1rem; border:1px solid var(--border); border-radius:8px; margin-bottom:0.8rem; background:rgba(255,255,255,0.01);">
                    <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
                        <strong style="color:var(--gold); font-size:0.85rem;">${r.bank_name} Payout</strong>
                        <span style="color:var(--green); font-size:0.65rem; font-weight:bold; background:rgba(74,222,128,0.1); padding:0.15rem 0.5rem; border-radius:4px; text-transform:uppercase;">✅ Settled</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; font-size:0.72rem; color:var(--text-dim); margin-top:0.3rem;">
                        <span>Ref: ${r.receipt_number}</span>
                        <span>${r.date}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px dashed rgba(201,168,76,0.1); padding-top:0.5rem; margin-top:0.5rem;">
                        <div>
                            <span style="font-size:0.65rem; color:var(--text-faint); display:block;">Net Settled</span>
                            <strong style="font-size:1rem; color:var(--text);">$${r.net_amount.toFixed(2)}</strong>
                        </div>
                        <button onclick="window.open('/receipt/print/${r.id}', '_blank')" style="padding:0.25rem 0.6rem; font-size:0.65rem; border:1px solid rgba(200,168,94,0.2); color:var(--gold); border-radius:4px; background:transparent; cursor:pointer; text-transform:uppercase; font-weight:bold;">📄 View Receipt</button>
                    </div>
                </div>
            `).join('');
        } else {
            container.innerHTML = '<p style="text-align:center; color:var(--text-faint); font-size:0.8rem; padding:1.5rem 0;">No completed payouts yet.</p>';
        }
    } catch (e) {
        container.innerHTML = '<p style="text-align:center; color:#EF4444; font-size:0.8rem; padding:1.5rem 0;">Failed to load receipts.</p>';
    }
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', function() {
    loadWithdrawalEligibility();
    checkActiveWithdrawal();
    loadReceipts();
});
