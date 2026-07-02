// ============================================================
// Dashboard JS — Auto‑update, Chart, Feed, Deposit
// ============================================================

const portfolioValueEl = document.getElementById('portfolioValue');
const investedEl = document.getElementById('invested');

let balance = portfolioValueEl ? parseFloat(portfolioValueEl.textContent.replace('$', '')) : 0.0;
let invested = investedEl ? parseFloat(investedEl.textContent.replace('$', '')) : 0.0;
let currentExchangeRate = null;
const updateInterval = 3000; // ms

// ---- Chart Generation ----
function generateChart(periodDays = 30, initialBalance = balance) {
    const svg = document.getElementById('performanceChart');
    if (!svg) return;

    const points = [];
    const base = Math.max(0, initialBalance * 0.7);
    const volatility = initialBalance * 0.035;
    for (let i = 0; i < 12; i++) {
        const progress = i / 11;
        const value = base + (initialBalance - base) * progress + (Math.sin(i * 1.5) * volatility * 0.4) + ((Math.random() - 0.5) * volatility);
        points.push(Math.max(0, value));
    }

    const minValue = Math.min(...points);
    const maxValue = Math.max(...points);
    const width = 320;
    const height = 160;
    const padding = 18;
    const pathPoints = points.map((value, index) => {
        const x = padding + (index / (points.length - 1)) * (width - padding * 2);
        const y = height - padding - ((value - minValue) / Math.max(1, maxValue - minValue)) * (height - padding * 2);
        return `${x},${y}`;
    }).join(' ');

    const areaPath = `M${padding},${height - padding} L${pathPoints} L${width - padding},${height - padding} Z`;
    svg.innerHTML = `
        <defs>
            <linearGradient id="chartGradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stop-color="rgba(200,168,94,0.35)" />
                <stop offset="100%" stop-color="rgba(10,13,26,0.04)" />
            </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#chartGradient)" opacity="0.85"></path>
        <polyline points="${pathPoints}" fill="none" stroke="#C8A85E" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx="${pathPoints.split(' ').slice(-1)[0].split(',')[0]}" cy="${pathPoints.split(' ').slice(-1)[0].split(',')[1]}" r="4" fill="#4ADE80" stroke="#FFFFFF" stroke-width="2" />
    `;

    window._chartData = points;
    window._chartPeriod = periodDays;
    updateChartSummary(points, periodDays);
}

function updateChartSummary(points, periodDays) {
    const first = points[0] || 0;
    const last = points[points.length - 1] || 0;
    const percent = first > 0 ? ((last - first) / first) * 100 : 0;
    document.getElementById('chartReturn').textContent = `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
    document.getElementById('volatilityLabel').textContent = ['Low', 'Low', 'Medium', 'High'][Math.min(3, Math.floor(periodDays / 120))] || 'Low';
}

function formatNgnAmount(value) {
    return `₦${Number(value || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function updatePaystackPreview() {
    const method = document.getElementById('depositMethod')?.value;
    const insight = document.getElementById('paystackInsights');
    if (!insight) return;

    if (method !== 'card') {
        insight.style.display = 'none';
        return;
    }

    const amountInput = document.getElementById('depositAmount');
    const amount = parseFloat(amountInput?.value || '0');
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

// ---- Update Dashboard from API ----
async function updateDashboard() {
    try {
        const resp = await fetch('/api/balance');
        const data = await resp.json();

        animateValue('portfolioValue', data.balance);
        animateValue('invested', data.invested, '$');
        animateValue('profit', data.profit, '$');
        const profitChangeEl = document.getElementById('profitChange');
        if (profitChangeEl) profitChangeEl.textContent = `+${data.roi.toFixed(1)}%`;
        document.getElementById('roiDisplay').textContent = `+${data.roi.toFixed(1)}%`;
        document.getElementById('todayGain').textContent = `+$${data.growth_today.toFixed(2)}`;
        document.getElementById('todayPercent').textContent = `+${data.growth_percent.toFixed(1)}%`;
        document.getElementById('yieldDisplay').textContent = `${Math.max(8.5, Math.min(24.0, data.roi * 0.14)).toFixed(1)}%`;

        if (window._chartData) {
            const lastValue = window._chartData[window._chartData.length - 1] || data.balance;
            generateChart(window._chartPeriod || 30, data.balance);
        }

        await updateFeed();
        renderHoldings(data.balance, data.invested);

    } catch (e) {
        console.error('Update error:', e);
    }
}

function animateValue(id, value, prefix = '') {
    const el = document.getElementById(id);
    if (!el) return;
    const start = parseFloat(el.textContent.replace(/[^0-9.-]/g, '')) || 0;
    const end = value;
    const duration = 900;
    const stepTime = 24;
    const steps = Math.max(1, Math.floor(duration / stepTime));
    let currentStep = 0;
    const delta = (end - start) / steps;
    const timer = setInterval(() => {
        currentStep += 1;
        const currentValue = start + delta * currentStep;
        el.textContent = prefix + currentValue.toFixed(2);
        if (currentStep >= steps) {
            el.textContent = prefix + end.toFixed(2);
            clearInterval(timer);
        }
    }, stepTime);
}

// ---- Activity Feed ----
async function updateFeed() {
    try {
        const resp = await fetch('/api/activity');
        const items = await resp.json();
        const container = document.getElementById('dashFeed');
        container.innerHTML = items.map((item, index) => {
            const icon = item.type === 'deposit' ? '⚡' : item.type === 'withdrawal' ? '💰' : item.type === 'growth' ? '📈' : '📊';
            const tone = item.type === 'withdrawal' ? 'red' : item.type === 'deposit' ? 'green' : 'gold';
            return `
                <div class="feed-card" style="animation-delay:${index * 80}ms;">
                    <div class="feed-icon ${tone}">${icon}</div>
                    <div class="feed-copy">
                        <div class="feed-line">${item.name ? `<strong>${item.name}</strong> ` : ''}${item.text}</div>
                        <div class="feed-time">${item.time} ago</div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Feed error:', e);
    }
}

const feedState = { paused: false, sound: true };

function toggleFeedPause() {
    feedState.paused = !feedState.paused;
    const button = document.getElementById('pauseToggle');
    if (button) button.textContent = feedState.paused ? '▶ Resume Updates' : '⏸ Pause Updates';
}

function toggleFeedSound() {
    feedState.sound = !feedState.sound;
    const button = document.getElementById('soundToggle');
    if (button) button.textContent = feedState.sound ? '🔊 Enable Sound' : '🔇 Sound Off';
}

function renderHoldings(currentBalance, investedAmount) {
    const container = document.getElementById('holdingsList');
    if (!container) return;

    const holdings = [
        { name: 'Tesla (TSLA)', value: currentBalance * 0.26, allocation: 30, range: '$180 - $320', delta: '+18.4%' },
        { name: 'NVIDIA (NVDA)', value: currentBalance * 0.18, allocation: 20, range: '$380 - $620', delta: '+12.1%' },
        { name: 'iShares TIPS (TIP)', value: currentBalance * 0.13, allocation: 15, range: '$105 - $118', delta: '+4.2%' },
        { name: 'SPDR Gold (GLD)', value: currentBalance * 0.10, allocation: 10, range: '$150 - $185', delta: '+22.7%' },
        { name: 'Vanguard REIT (VNQ)', value: currentBalance * 0.08, allocation: 8, range: '$88 - $102', delta: '-2.1%' }
    ];

    container.innerHTML = holdings.map(item => `
        <div class="holding-card">
            <div class="holding-head">
                <div class="holding-icon">${item.delta.startsWith('-') ? '🔴' : '🟢'}</div>
                <div>
                    <div class="holding-name">${item.name}</div>
                    <div class="holding-value">${formatCurrency(item.value)}</div>
                </div>
                <div class="holding-delta ${item.delta.startsWith('-') ? 'negative' : ''}">${item.delta}</div>
            </div>
            <div class="holding-meta">${item.allocation.toFixed(0)}% Allocation • ${item.range}</div>
            <div class="holding-bar"><div style="width:${Math.min(100, item.allocation)}%;"></div></div>
        </div>
    `).join('');
}

function formatCurrency(value) {
    return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function setBottomNav(tab) {
    document.querySelectorAll('.bottom-nav .nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-nav') === tab);
    });
    if (tab === 'withdraw') {
        showWithdrawView();
    } else {
        showHomeView();
    }
}
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
        const rate = currentExchangeRate || 1554.2;
        const ngnAmount = amount > 0 ? amount * rate : 0;
        const summary = `Deposit Amount: $${amount.toFixed(2)}\nExchange Rate: 1 USD = ${formatNgnAmount(rate)}\nAmount to be Charged: ${formatNgnAmount(ngnAmount)}\n\nContinue to Paystack?`;
        if (!window.confirm(summary)) {
            return;
        }

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

async function loadWithdrawalEligibility() {
    try {
        const resp = await fetch('/api/withdrawal/eligibility');
        const data = await resp.json();
        if (data.success && data.data) {
            const e = data.data;
            
            // Show countdown
            const countdownEl = document.getElementById('withdrawalCountdown');
            if (countdownEl) {
                countdownEl.style.display = 'block';
                document.getElementById('countdownDisplay').textContent = `Processing on ${e.processing_date}`;
                document.getElementById('cutOffDateDisplay').textContent = e.cut_off_date;
                if (e.days_until_processing > 0) {
                    document.getElementById('countdownSub').innerHTML = `Submit your request by <strong>${e.cut_off_date}</strong> &middot; <strong>${e.days_until_processing} days</strong> until processing`;
                }
            }
            
            // Show eligibility banner
            const banner = document.getElementById('eligibilityBanner');
            if (banner) {
                banner.style.display = 'block';
                if (!e.eligible) {
                    banner.style.background = 'rgba(245,158,11,0.06)';
                    banner.style.border = '1px solid rgba(245,158,11,0.15)';
                    const needed = e.minimum_withdrawal - e.balance;
                    banner.innerHTML = `
                        <div style="display:flex; align-items:center; gap:0.5rem;">
                            <span>❌</span>
                            <div>
                                <div style="font-size:0.75rem; color:var(--text);">Not eligible for withdrawal</div>
                                <div style="font-size:0.68rem; color:var(--text-dim);">You need to deposit <strong style="color:var(--gold);">$${needed.toFixed(2)}</strong> more to reach the $${e.minimum_withdrawal.toFixed(2)} minimum.</div>
                            </div>
                        </div>
                    `;
                } else if (!e.wallet_provided) {
                    banner.style.background = 'rgba(245,158,11,0.06)';
                    banner.style.border = '1px solid rgba(245,158,11,0.15)';
                    banner.innerHTML = `
                        <div style="display:flex; align-items:center; gap:0.5rem;">
                            <span>⚠️</span>
                            <div>
                                <div style="font-size:0.75rem; color:var(--text);">Wallet required</div>
                                <div style="font-size:0.68rem; color:var(--text-dim);">Please save your crypto wallet address below before requesting a withdrawal.</div>
                            </div>
                        </div>
                    `;
                } else if (!e.within_submission_window) {
                    banner.style.background = 'rgba(239,68,68,0.06)';
                    banner.style.border = '1px solid rgba(239,68,68,0.15)';
                    banner.innerHTML = `
                        <div style="display:flex; align-items:center; gap:0.5rem;">
                            <span>🔒</span>
                            <div>
                                <div style="font-size:0.75rem; color:var(--text);">Submissions closed</div>
                                <div style="font-size:0.68rem; color:var(--text-dim);">Withdrawal submissions are closed until the 1st of next month. Cut-off is the 25th of each month.</div>
                            </div>
                        </div>
                    `;
                } else if (e.has_pending) {
                    banner.style.background = 'rgba(59,130,246,0.06)';
                    banner.style.border = '1px solid rgba(59,130,246,0.15)';
                    banner.innerHTML = `
                        <div style="display:flex; align-items:center; gap:0.5rem;">
                            <span>⏳</span>
                            <div>
                                <div style="font-size:0.75rem; color:var(--text);">Pending withdrawal</div>
                                <div style="font-size:0.68rem; color:var(--text-dim);">You already have a pending withdrawal request. Status: <strong>${e.pending_status}</strong></div>
                            </div>
                        </div>
                    `;
                } else {
                    banner.style.background = 'rgba(74,222,128,0.06)';
                    banner.style.border = '1px solid rgba(74,222,128,0.15)';
                    banner.innerHTML = `
                        <div style="display:flex; align-items:center; gap:0.5rem;">
                            <span>✅</span>
                            <div>
                                <div style="font-size:0.75rem; color:var(--text);">You are eligible!</div>
                                <div style="font-size:0.68rem; color:var(--text-dim);">You can request up to <strong style="color:var(--gold);">$${e.balance.toFixed(2)}</strong>. Net payout after ${e.tax_rate}% tax: <strong style="color:var(--green);">$${e.net_payout.toFixed(2)}</strong></div>
                            </div>
                        </div>
                    `;
                }
            }

            // Load saved wallet
            if (e.wallet_provided) {
                const addrInput = document.getElementById('cryptoWalletAddress');
                const netSelect = document.getElementById('cryptoWalletNetwork');
                if (addrInput && e.wallet_address) addrInput.value = e.wallet_address;
                if (netSelect && e.wallet_network) {
                    for (let i = 0; i < netSelect.options.length; i++) {
                        if (netSelect.options[i].value === e.wallet_network) {
                            netSelect.selectedIndex = i;
                            break;
                        }
                    }
                }
                const ws = document.getElementById('walletStatus');
                if (ws) {
                    ws.innerHTML = `<span style="color:var(--green);">✅ Wallet saved: ${e.wallet_address} (${e.wallet_network})</span>`;
                }
            }
        }
    } catch (e) {
        console.error('Error loading eligibility:', e);
    }
}

async function saveCryptoWallet() {
    const address = document.getElementById('cryptoWalletAddress').value.trim();
    const network = document.getElementById('cryptoWalletNetwork').value;
    
    if (!address) {
        document.getElementById('walletStatus').innerHTML = '<span style="color:#EF4444;">❌ Please enter a wallet address.</span>';
        return;
    }
    
    // Basic validation
    const networkValidators = {
        'Ethereum (ERC-20)': a => a.length === 42 && a.startsWith('0x'),
        'BSC (BEP-20)': a => a.length === 42 && a.startsWith('0x'),
        'Tron (TRC-20)': a => a.length === 34 && a.startsWith('T'),
        'Bitcoin': a => a.length === 34 && '13bc'.includes(a[0]),
        'Solana': a => a.length >= 32 && a.length <= 44,
        'Polygon': a => a.length === 42 && a.startsWith('0x'),
    };
    
    const validator = networkValidators[network];
    if (validator && !validator(address)) {
        document.getElementById('walletStatus').innerHTML = `<span style="color:#EF4444;">❌ Invalid address format for ${network}. Please check and try again.</span>`;
        return;
    }
    
    const btn = document.getElementById('btnSaveWallet');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    
    try {
        const resp = await fetch('/api/user/wallet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                wallet_address: address,
                wallet_network: network,
                wallet_currency: 'USDT'
            })
        });
        const data = await resp.json();
        if (data.success) {
            const walletStatus = document.getElementById('walletStatus');
            if (walletStatus) {
                walletStatus.innerHTML = `<span style="color:var(--green);">✅ ${data.message}</span>`;
            }
            // Refresh eligibility
            await loadWithdrawalEligibility();
        } else {
            document.getElementById('walletStatus').innerHTML = `<span style="color:#EF4444;">❌ ${data.message}</span>`;
        }
    } catch (e) {
        document.getElementById('walletStatus').innerHTML = '<span style="color:#EF4444;">❌ Network error saving wallet.</span>';
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '💾 Save'; }
    }
}

async function requestWithdrawal() {
    const amount = parseFloat(document.getElementById('withdrawAmount').value);
    if (amount > balance) {
        alert('❌ Insufficient balance');
        return;
    }
    if (amount < 1000) {
        alert('❌ Minimum withdrawal is $1,000.00');
        return;
    }
    
    // Check eligibility via API
    try {
        const eligResp = await fetch('/api/withdrawal/eligibility');
        const eligData = await eligResp.json();
        if (eligData.success && eligData.data) {
            const e = eligData.data;
            if (!e.can_request) {
                if (!e.eligible) alert('❌ You must have at least $1,000 to withdraw.');
                else if (!e.wallet_provided) alert('❌ Please save your crypto wallet address first.');
                else if (!e.within_submission_window) alert('❌ Withdrawal submissions are closed until the 1st of next month.');
                else if (e.has_pending) alert('❌ You already have a pending withdrawal request.');
                return;
            }
        }
    } catch (e) {
        // Fall through to server-side validation
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
    // Hide all first
    document.getElementById('taxRequiredStatusCard').style.display = 'none';
    document.getElementById('withdrawalStatusCard').style.display = 'none';
    document.getElementById('bankDetailsFormCard').style.display = 'none';
    document.getElementById('completedStatusCard').style.display = 'none';
    document.getElementById('rejectedStatusCard').style.display = 'none';

    // Show withdrawal form by default
    const formView = document.querySelector('#withdrawalContainer .withdrawal-form');
    if (formView) formView.style.display = 'block';

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
                if (formView) formView.style.display = 'none';
            } else if (w.status === 'pending') {
                if (!w.bank_name) {
                    // Show banking details form
                    document.getElementById('bankDetailsFormCard').style.display = 'flex';
                    document.getElementById('bankDetailsWithdrawAmount').textContent = '$' + w.amount.toFixed(2);
                } else {
                    // Show normal processing status
                    document.getElementById('withdrawalStatusCard').style.display = 'flex';
                    document.getElementById('pendingAmountDisplay').textContent = '$' + w.amount.toFixed(2);
                }
                if (formView) formView.style.display = 'none';
            } else if (w.status === 'completed') {
                if (!isDismissed) {
                    document.getElementById('completedStatusCard').style.display = 'flex';
                    document.getElementById('completedAmountDisplay').textContent = '$' + w.amount.toFixed(2);
                    
                    const receiptBtn = document.getElementById('completedReceiptBtn');
                    if (receiptBtn) {
                        receiptBtn.onclick = () => {
                            window.open('/receipt/print/' + w.id, '_blank');
                        };
                    }
                    if (formView) formView.style.display = 'none';
                }
            } else if (w.status === 'rejected') {
                if (!isDismissed) {
                    document.getElementById('rejectedStatusCard').style.display = 'flex';
                    document.getElementById('rejectedAmountDisplay').textContent = '$' + w.amount.toFixed(2);
                    document.getElementById('rejectedReasonDisplay').textContent = w.admin_notes || 'Failed compliance audit.';
                    if (formView) formView.style.display = 'none';
                }
            }
        }
    } catch (e) {
        console.error('Error fetching active withdrawal:', e);
    }
}

async function submitBankDetailsForm(event) {
    event.preventDefault();
    const bankName = document.getElementById('userBankName').value.trim();
    const accountName = document.getElementById('userAccountName').value.trim();
    const accountNumber = document.getElementById('userAccountNumber').value.trim();
    const confirmAccountNumber = document.getElementById('userConfirmAccountNumber').value.trim();
    const routingNumber = document.getElementById('userRoutingNumber').value.trim();
    const swiftCode = document.getElementById('userSwiftCode').value.trim();
    const country = document.getElementById('userCountry').value;
    const currency = document.getElementById('userCurrency').value;

    if (accountNumber !== confirmAccountNumber) {
        alert('❌ Account numbers do not match.');
        return;
    }

    const btn = document.getElementById('btnSubmitBankDetails');
    btn.disabled = true;
    btn.textContent = 'Submitting Details...';

    try {
        const resp = await fetch(`/api/withdrawal/${currentWithdrawalId}/bank-details`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bank_name: bankName,
                account_name: accountName,
                account_number: accountNumber,
                routing_number: routingNumber,
                swift_code: swiftCode,
                country: country,
                currency: currency
            })
        });
        const result = await resp.json();
        if (result.success) {
            alert('✅ Banking details submitted successfully! Your withdrawal is now processing.');
            await checkActiveWithdrawal();
        } else {
            alert('❌ Submission failed: ' + result.message);
        }
    } catch (e) {
        alert('❌ Network error submitting details.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Submit & Process Withdrawal →';
    }
}

function cancelBankDetailsForm() {
    if (confirm('Are you sure? You must submit bank details to receive your funds.')) {
        document.getElementById('bankDetailsFormCard').style.display = 'none';
        alert('You can resume entering banking details later from the dashboard banner.');
        window.location.reload();
    }
}

function dismissCompletedBanner() {
    if (currentWithdrawalId) {
        localStorage.setItem('dismissed_withdrawal_' + currentWithdrawalId, 'true');
        checkActiveWithdrawal();
    }
}

function dismissRejectedBanner() {
    if (currentWithdrawalId) {
        localStorage.setItem('dismissed_withdrawal_' + currentWithdrawalId, 'true');
        checkActiveWithdrawal();
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

// ============================================================
// REFERRAL SYSTEM
// ============================================================

async function loadReferralInfo() {
    const codeEl = document.getElementById('referralCodeDisplay');
    if (!codeEl) return;

    try {
        const resp = await fetch('/api/referral/info');
        const data = await resp.json();
        
        if (data.success) {
            codeEl.textContent = data.referral_code;
            
            const earningsBadge = document.getElementById('referralEarningsBadge');
            if (earningsBadge) {
                earningsBadge.textContent = `$${data.referral_earnings.toFixed(2)} earned`;
            }
            
            const earningsEl = document.getElementById('referralEarnings');
            if (earningsEl) {
                earningsEl.textContent = `$${data.referral_earnings.toFixed(2)}`;
            }
            
            const countEl = document.getElementById('referredCount');
            if (countEl) {
                countEl.textContent = data.referred_count;
            }
        }
    } catch (e) {
        console.error('Error loading referral info:', e);
    }
}

async function copyReferralLink() {
    const code = document.getElementById('referralCodeDisplay').textContent;
    if (!code || code === '------') {
        alert('Loading referral code...');
        return;
    }
    
    const referralLink = `${window.location.origin}/register?ref=${code}`;
    
    try {
        await navigator.clipboard.writeText(referralLink);
        const btn = document.getElementById('copyRefBtn');
        if (btn) {
            const orig = btn.innerHTML;
            btn.innerHTML = '✅ Copied!';
            btn.style.background = 'var(--green)';
            setTimeout(() => {
                btn.innerHTML = orig;
                btn.style.background = 'var(--gold)';
            }, 2500);
        }
    } catch (e) {
        // Fallback: prompt the user to copy manually
        prompt('Copy this referral link:', referralLink);
    }
}

// ---- Initialization ----
document.addEventListener('DOMContentLoaded', async function () {
    const portfolioVal = document.getElementById('portfolioValue');
    if (portfolioVal) {
        const depositAmountInput = document.getElementById('depositAmount');
        const depositMethodSelect = document.getElementById('depositMethod');
        if (depositAmountInput) depositAmountInput.addEventListener('input', updatePaystackPreview);
        if (depositMethodSelect) depositMethodSelect.addEventListener('change', updatePaystackPreview);

        generateChart(30, balance);
        await loadPaystackRate();
        updateDashboard();
        await checkActiveWithdrawal();
        await loadWithdrawalEligibility();
        await loadReceipts();
        await loadReferralInfo();

        const pauseToggle = document.getElementById('pauseToggle');
        const soundToggle = document.getElementById('soundToggle');
        if (pauseToggle) pauseToggle.addEventListener('click', toggleFeedPause);
        if (soundToggle) soundToggle.addEventListener('click', toggleFeedSound);

        document.querySelectorAll('#periodToggle button').forEach(button => {
            button.addEventListener('click', () => {
                document.querySelectorAll('#periodToggle button').forEach(b => b.classList.remove('active'));
                button.classList.add('active');
                generateChart(parseInt(button.getAttribute('data-period'), 10), balance);
            });
        });

        setInterval(() => {
            if (!feedState.paused) updateFeed();
            updateDashboard();
        }, updateInterval);
    }
});
