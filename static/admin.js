// ============================================================
// Admin Dashboard JS — Full SPA with Tabs
// ============================================================

let currentWithdrawalFilter = '';
let currentAdminTab = 'withdrawals';
let _bankAccountsCache = []; // Shared cache for bank accounts

// ---- Tab Switching ----
function switchAdminTab(tabName) {
    currentAdminTab = tabName;

    // Update tab buttons
    document.querySelectorAll('.admin-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tabName);
    });

    // Update content panels
    document.querySelectorAll('.admin-tab-content').forEach(c => {
        c.classList.toggle('active', c.id === 'tab-' + tabName);
    });

    // Load data for the tab
    switch (tabName) {
        case 'withdrawals':
            loadStats();
            loadWithdrawals();
            loadCycleInfo();
            break;
        case 'waiting-list':
            loadWaitingList('');
            break;
        case 'members':
            loadMembers();
            break;
        case 'receipt-library':
            loadReceiptLibrary();
            break;
        case 'marketing':
            // Bank accounts already loaded globally
            break;
        case 'bank-accounts':
            loadBankAccounts();
            break;
        case 'payments':
            loadPayments();
            break;
    }
}

// ============================================================
// STATS
// ============================================================

async function loadStats() {
    try {
        const resp = await fetch('/api/admin/stats');
        const data = await resp.json();
        if (data.success) {
            document.getElementById('statDeposits').textContent = `$${Number(data.deposits_month || 0).toFixed(2)}`;
            document.getElementById('statVerifiedCount').textContent = `${data.verified_payments || 0} verified transactions`;
            document.getElementById('statTax').textContent = `$${Number(data.tax_month || 0).toFixed(2)}`;
            document.getElementById('statPending').textContent = data.pending_count || 0;
            document.getElementById('statUsers').textContent = data.active_users || 0;
        }
    } catch (e) {
        console.error('Error loading stats:', e);
    }
}

// ============================================================
// WITHDRAWALS
// ============================================================

async function loadWithdrawals() {
    const tbody = document.getElementById('withdrawalsTableBody');
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="7" class="loading">Fetching withdrawal records...</td></tr>`;

    try {
        const url = `/api/admin/withdrawals${currentWithdrawalFilter ? '?status=' + currentWithdrawalFilter : ''}`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.success && data.withdrawals && data.withdrawals.length > 0) {
            // Populate cache with all fetched withdrawals (no filter = full data)
            if (!currentWithdrawalFilter) {
                _allWithdrawalsCache = {};
                data.withdrawals.forEach(w => { _allWithdrawalsCache[w.id] = w; });
            } else {
                // Partial update — only cache what we fetched
                data.withdrawals.forEach(w => { _allWithdrawalsCache[w.id] = w; });
            }

            tbody.innerHTML = data.withdrawals.map(w => {
                const netAmount = (w.amount || 0) - (w.tax_amount || 0);
                let actionsHtml = '';

                if (w.status === 'pending' || w.status === 'tax_required') {
                    actionsHtml = w.tax_paid ? `
                        <button onclick="openDetailModal('${w.id}')" class="btn-sm btn-view">📋 View</button>
                        <button onclick="openReceiptModal('${w.id}', ${w.amount || 0}, ${w.tax_amount || 0})" class="btn-sm btn-approve">Approve</button>
                        <button onclick="openRejectModal('${w.id}')" class="btn-sm btn-reject">Reject</button>
                    ` : `
                        <button onclick="openDetailModal('${w.id}')" class="btn-sm btn-view">📋 View</button>
                        <button onclick="openRejectModal('${w.id}')" class="btn-sm btn-reject">Reject</button>
                    `;
                } else if (w.status === 'completed' && w.receipt_number) {
                    actionsHtml = `
                        <button onclick="openDetailModal('${w.id}')" class="btn-sm btn-view">📋 View</button>
                        <button onclick="window.open('/receipt/print/${w.id}', '_blank')" class="btn-sm btn-view">📄 Receipt</button>
                    `;
                } else if (w.status === 'completed') {
                    actionsHtml = `
                        <button onclick="openDetailModal('${w.id}')" class="btn-sm btn-view">📋 View</button>
                        <button onclick="openReceiptModal('${w.id}', ${w.amount || 0}, ${w.tax_amount || 0})" class="btn-sm btn-approve" style="font-size:0.65rem;">📄 Gen Receipt</button>
                    `;
                } else if (w.status === 'rejected') {
                    actionsHtml = `
                        <button onclick="openDetailModal('${w.id}')" class="btn-sm btn-view" style="font-size:0.65rem;">📋 View</button>
                    `;
                } else {
                    actionsHtml = `<span style="color: var(--text-faint); font-size: 0.7rem;">—</span>`;
                }

                return `
                    <tr>
                        <td>
                            <strong>${w.username}</strong>
                            <div style="font-size: 0.68rem; color: var(--text-faint);">${w.email}</div>
                        </td>
                        <td>
                            <strong>$${Number(w.amount || 0).toFixed(2)}</strong>
                            <div style="font-size: 0.68rem; color: var(--text-faint);">${w.account_number ? w.account_number.substring(0, 6) + '...' + w.account_number.substring(w.account_number.length - 4) : 'No Wallet'}</div>
                            <div style="font-size: 0.6rem; color: var(--text-faint); text-transform: uppercase;">${w.bank_name || ''}</div>
                        </td>
                        <td style="color: var(--gold-dim);">${w.tax_paid ? '✅ Yes' : '❌ No'}</td>
                        <td><span class="badge-status ${w.status}">${w.status.replace('_', ' ')}</span></td>
                        <td style="font-size: 0.72rem; color: var(--text-dim);">${w.created_at}</td>
                        <td style="font-size: 0.7rem; color: var(--text-faint);">${w.txid || 'N/A'}</td>
                        <td class="actions-cell">${actionsHtml}</td>
                    </tr>
                `;
            }).join('');
        } else {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-faint); padding: 3rem 0;">No withdrawal requests found.</td></tr>`;
        }
    } catch (e) {
        console.error('Error loading withdrawals:', e);
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #EF4444; padding: 3rem 0;">Failed to fetch withdrawal records.</td></tr>`;
    }
}

function filterWithdrawals(status) {
    currentWithdrawalFilter = status;
    const tabs = document.querySelectorAll('#withdrawalTabs .tab');
    tabs.forEach(tab => {
        const text = tab.innerText.toLowerCase().trim();
        if (status === '' && text === 'all') tab.classList.add('active');
        else if (text === status.replace('_', ' ')) tab.classList.add('active');
        else tab.classList.remove('active');
    });
    loadWithdrawals();
}

// ---- Withdrawal Detail Modal ----
let _allWithdrawalsCache = {};
async function openDetailModal(id) {
    try {
        // Try cache first; if not there, fetch all
        let withdrawal = _allWithdrawalsCache[id];
        if (!withdrawal) {
            const resp = await fetch(`/api/admin/withdrawals`);
            const data = await resp.json();
            if (data.success && data.withdrawals) {
                data.withdrawals.forEach(w => { _allWithdrawalsCache[w.id] = w; });
                withdrawal = _allWithdrawalsCache[id];
            }
        }
        if (!withdrawal) { alert('Withdrawal not found'); return; }

        document.getElementById('detailRef').textContent = `#WD-${id.substring(0, 8)}`;

        const user = withdrawal;
        const netAmount = (user.amount || 0) - (user.tax_amount || 0);
        const statusClass = user.status;

        document.getElementById('detailContent').innerHTML = `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.2rem;">
                <div>
                    <h4 style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-faint); letter-spacing: 1px; margin-bottom: 0.5rem;">User Information</h4>
                    <div class="detail-row"><span class="lbl">Name</span><span class="val">${user.username}</span></div>
                    <div class="detail-row"><span class="lbl">Email</span><span class="val">${user.email}</span></div>
                    <div class="detail-row"><span class="lbl">Member Since</span><span class="val">${user.member_since || 'N/A'}</span></div>
                    <div class="detail-row"><span class="lbl">Account Balance</span><span class="val" style="color: var(--green); font-weight: bold;">$${Number(user.account_balance || 0).toFixed(2)}</span></div>
                </div>
                <div>
                    <h4 style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-faint); letter-spacing: 1px; margin-bottom: 0.5rem;">Withdrawal Details</h4>
                    <div class="detail-row"><span class="lbl">Amount</span><span class="val">$${Number(user.amount).toFixed(2)}</span></div>
                    <div class="detail-row"><span class="lbl">Tax (20%)</span><span class="val" style="color: #F59E0B;">$${Number(user.tax_amount).toFixed(2)}</span></div>
                    <div class="detail-row"><span class="lbl">Net Payout</span><span class="val" style="color: var(--green); font-weight: 700;">$${netAmount.toFixed(2)}</span></div>
                    <div class="detail-row"><span class="lbl">Status</span><span class="val"><span class="badge-status ${statusClass}">${user.status.replace('_', ' ')}</span></span></div>
                    <div class="detail-row"><span class="lbl">Payment Method</span><span class="val" style="text-transform: uppercase; font-size: 0.7rem; font-weight: bold;">${user.payment_method || 'N/A'}</span></div>
                    <div class="detail-row"><span class="lbl">Date</span><span class="val">${user.created_at}</span></div>
                </div>
            </div>
            <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border);">
                <h4 style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-faint); letter-spacing: 1px; margin-bottom: 0.5rem;">Bank Account Details</h4>
                <div class="detail-row"><span class="lbl">Wallet Address</span><span class="val">${user.account_number || 'Not provided'}</span></div>
                <div class="detail-row"><span class="lbl">Network</span><span class="val">${user.bank_name || 'Not provided'}</span></div>
                <div class="detail-row"><span class="lbl">Payout TXID</span><span class="val">${user.txid || 'Not Paid'}</span></div>
            </div>
            ${user.admin_notes ? `<div style="margin-top: 0.8rem; padding: 0.5rem; background: rgba(245, 158, 11, 0.05); border-radius: 6px; font-size: 0.75rem; color: var(--text-dim);"><strong>Notes:</strong> ${user.admin_notes}</div>` : ''}
            <div style="margin-top: 1rem; display: flex; gap: 0.6rem; flex-wrap: wrap; border-top: 1px solid var(--border); padding-top: 1rem;">
                ${user.status === 'pending' || user.status === 'tax_required' ? `
                    ${user.tax_paid ? `
                        <button onclick="openMarkAsPaidModal('${user.id}')" class="btn-sm btn-approve" style="padding: 0.5rem 1rem;">✅ Mark as Paid</button>
                        <button onclick="closeDetailModal(); openReceiptModal('${user.id}', ${user.amount}, ${user.tax_amount})" class="btn-sm btn-view" style="padding: 0.5rem 1rem; border-color:var(--green); color:var(--green);">📄 Generate Receipt</button>
                    ` : '<span style="font-size:0.7rem; color: var(--text-faint); padding: 0.5rem 1rem;">Awaiting tax payment...</span>'}
                    <button onclick="closeDetailModal(); openRejectModal('${user.id}')" class="btn-sm btn-reject" style="padding: 0.5rem 1rem;">⛔ Decline</button>
                ` : ''}
                ${user.receipt_number ? `<button onclick="window.open('/receipt/print/${user.id}', '_blank')" class="btn-sm btn-view" style="padding: 0.5rem 1rem;">📄 View Receipt</button>` : ''}
                <button onclick="closeDetailModal()" class="btn-sm" style="background: rgba(255,255,255,0.05); color: var(--text-dim); padding: 0.5rem 1rem;">Close</button>
            </div>
        `;

        document.getElementById('detailModal').style.display = 'flex';
    } catch (e) {
        console.error('Error loading detail:', e);
        alert('Failed to load withdrawal detail.');
    }
}


function closeDetailModal() {
    document.getElementById('detailModal').style.display = 'none';
}

// ---- Reject Withdrawal ----
function openRejectModal(id) {
    document.getElementById('rejectWithdrawalId').value = id;
    document.getElementById('rejectReason').value = '';
    document.getElementById('rejectModal').style.display = 'flex';
}

function closeRejectModal() {
    document.getElementById('rejectModal').style.display = 'none';
}

async function confirmRejectWithdrawal() {
    const id = document.getElementById('rejectWithdrawalId').value;
    const notes = document.getElementById('rejectReason').value.trim() || 'Withdrawal rejected by admin.';

    const btn = document.querySelector('#rejectModal .btn-gold');
    if (btn) { btn.disabled = true; btn.textContent = 'Rejecting...'; }

    try {
        const resp = await fetch(`/api/admin/withdrawal/${id}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes })
        });
        const data = await resp.json();
        if (data.success) {
            _allWithdrawalsCache = {}; // Invalidate cache
            closeRejectModal();
            loadStats();
            loadWithdrawals();
        } else {
            alert('❌ Reject failed: ' + data.message);
        }
    } catch (e) {
        alert('❌ Network error.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Confirm Decline'; }
    }
}

// ---- Mark as Paid Modal ----
function openMarkAsPaidModal(id) {
    const withdrawal = _allWithdrawalsCache[id];
    if (!withdrawal) { alert('Withdrawal not found'); return; }

    document.getElementById('markPaidWithdrawalId').value = id;
    document.getElementById('markPaidTxid').value = '';
    document.getElementById('markPaidInfo').innerHTML = `
        User: <strong>${withdrawal.username}</strong><br>
        Net Payout: <strong>$${((withdrawal.amount || 0) - (withdrawal.tax_amount || 0)).toFixed(2)}</strong><br>
        Wallet: <strong>${withdrawal.account_number}</strong><br>
        Network: <strong>${withdrawal.bank_name}</strong>
    `;
    document.getElementById('markAsPaidModal').style.display = 'flex';
}

function closeMarkAsPaidModal() {
    document.getElementById('markAsPaidModal').style.display = 'none';
}

async function confirmMarkAsPaid() {
    const id = document.getElementById('markPaidWithdrawalId').value;
    const txid = document.getElementById('markPaidTxid').value.trim();

    const btn = document.querySelector('#markAsPaidModal .btn-gold');
    if (btn) { btn.disabled = true; btn.textContent = 'Processing...'; }

    try {
        const resp = await fetch(`/api/admin/withdrawal/${id}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txid: txid, notes: 'Payout processed via crypto.' })
        });
        const data = await resp.json();
        if (data.success) {
            _allWithdrawalsCache = {}; // Invalidate cache
            closeMarkAsPaidModal();
            loadStats();
            loadWithdrawals();
            alert('Withdrawal marked as completed!');
        } else {
            alert('❌ Error: ' + data.message);
        }
    } catch (e) {
        alert('❌ Network error.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Confirm & Mark Completed'; }
    }
}

// ---- Receipt Generator Modal (for withdrawal approvals) ----
function openReceiptModal(id, amount, taxAmount) {
    document.getElementById('modalWithdrawalId').value = id;
    document.getElementById('recAmount').value = `$${Number(amount).toFixed(2)}`;
    document.getElementById('recNet').value = `$${Number(amount - taxAmount).toFixed(2)}`;
    document.getElementById('recBankName').value = '';
    document.getElementById('recAccNum').value = '';
    document.getElementById('recAccName').value = '';
    document.getElementById('recImage').value = '';
    document.getElementById('recNotes').value = '';
    document.getElementById('receiptModal').style.display = 'flex';
}

function closeReceiptModal() {
    document.getElementById('receiptModal').style.display = 'none';
}

async function submitReceiptForm(event) {
    event.preventDefault();
    const id = document.getElementById('modalWithdrawalId').value;
    const btn = document.getElementById('btnSubmitReceipt');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    const formData = new FormData();
    formData.append('bank_name', document.getElementById('recBankName').value);
    formData.append('account_number', document.getElementById('recAccNum').value);
    formData.append('account_name', document.getElementById('recAccName').value);
    formData.append('admin_notes', document.getElementById('recNotes').value);
    const imageFile = document.getElementById('recImage').files[0];
    if (imageFile) formData.append('receipt_image', imageFile);

    try {
        const resp = await fetch(`/api/admin/withdrawal/${id}/generate-receipt`, {
            method: 'POST',
            body: formData
        });
        const data = await resp.json();
        if (data.success) {
            _allWithdrawalsCache = {}; // Invalidate cache
            closeReceiptModal();
            loadStats();
            loadWithdrawals();
            window.open(`/receipt/print/${id}`, '_blank');
        } else {
            alert('❌ Failed: ' + data.message);
        }
    } catch (e) {
        alert('❌ Network error.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Approve & Generate Receipt';
    }
}

// ============================================================
// RECEIPT LIBRARY
// ============================================================

async function loadReceiptLibrary() {
    const tbody = document.getElementById('receiptLibraryBody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="7" class="loading">Loading receipts...</td></tr>`;

    const filter = document.getElementById('receiptLibraryFilter')?.value || '';

    try {
        // Load withdrawal receipts
        const respW = await fetch('/api/admin/withdrawals?status=completed');
        const dataW = await respW.json();
        let withdrawalReceipts = [];
        if (dataW.success && dataW.withdrawals) {
            withdrawalReceipts = dataW.withdrawals
                .filter(w => w.receipt_number)
                .map(w => ({
                    id: w.id,
                    receipt_number: w.receipt_number,
                    recipient: w.username,
                    amount: w.amount,
                    type: 'Withdrawal',
                    date: w.created_at,
                    downloads: 0,
                    print_url: `/receipt/print/${w.id}`
                }));
        }

        // Load marketing receipts
        let marketingReceipts = [];
        try {
            const respM = await fetch('/api/admin/receipts/marketing');
            const dataM = await respM.json();
            if (dataM.success && dataM.receipts) {
                marketingReceipts = dataM.receipts.map(r => ({
                    id: r.id,
                    receipt_number: r.receipt_number,
                    recipient: r.recipient_name,
                    amount: r.amount,
                    type: 'Marketing',
                    date: r.generated_at,
                    downloads: r.download_count || 0,
                    print_url: `/marketing/receipt/print/${r.id}`
                }));
            }
        } catch (e) { /* no marketing receipts yet */ }

        let allReceipts = [...withdrawalReceipts, ...marketingReceipts];

        // Apply filter
        if (filter === 'completed') allReceipts = withdrawalReceipts;
        else if (filter === 'marketing') allReceipts = marketingReceipts;

        // Sort by date descending
        allReceipts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        if (allReceipts.length > 0) {
            tbody.innerHTML = allReceipts.map(r => `
                <tr>
                    <td style="font-family: monospace; font-size: 0.75rem;">${r.receipt_number}</td>
                    <td><strong>${r.recipient}</strong></td>
                    <td><strong>$${Number(r.amount || 0).toFixed(2)}</strong></td>
                    <td><span style="font-size: 0.7rem; padding: 0.15rem 0.4rem; border-radius: 4px; background: ${r.type === 'Marketing' ? 'rgba(201,168,76,0.1)' : 'rgba(74,222,128,0.1)'}; color: ${r.type === 'Marketing' ? 'var(--gold)' : 'var(--green)'};">${r.type}</span></td>
                    <td style="font-size: 0.72rem; color: var(--text-dim);">${r.date}</td>
                    <td style="font-size: 0.72rem; color: var(--text-faint);">${r.downloads}</td>
                    <td>
                        <button onclick="window.open('${r.print_url}', '_blank')" class="btn-sm btn-view">📄 View</button>
                    </td>
                </tr>
            `).join('');
        } else {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-faint); padding: 3rem 0;">No receipts found.</td></tr>`;
        }
    } catch (e) {
        console.error('Error loading receipt library:', e);
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #EF4444; padding: 3rem 0;">Failed to load receipts.</td></tr>`;
    }
}

// ============================================================
// MARKETING RECEIPT GENERATOR
// ============================================================

// ============================================================
// BANK ACCOUNT LOADER (shared by marketing form + receipt modal)
// ============================================================

async function loadBankNamesForMarketing() {
    if (_bankAccountsCache.length === 0) {
        try {
            const resp = await fetch('/api/admin/bank-accounts');
            const data = await resp.json();
            if (data.success && data.accounts) {
                _bankAccountsCache = data.accounts.filter(a => a.is_active);
            }
        } catch (e) {
            console.error('Error loading bank accounts:', e);
            return;
        }
    }

    // Populate datalist
    const datalist = document.getElementById('bankNameList');
    if (datalist) {
        datalist.innerHTML = _bankAccountsCache
            .map(a => `<option value="${a.bank_name}">`)
            .join('');
    }
}

function autoFillBankFields(bankName, nameFieldId, numFieldId, routingFieldId, swiftFieldId) {
    const opt = _bankAccountsCache.find(a => a.bank_name === bankName);
    if (!opt) return;
    if (nameFieldId) {
        const el = document.getElementById(nameFieldId);
        if (el) el.value = opt.account_name;
    }
    if (numFieldId) {
        const el = document.getElementById(numFieldId);
        if (el) el.value = opt.account_number;
    }
    if (routingFieldId) {
        const el = document.getElementById(routingFieldId);
        if (el) el.value = opt.routing_number || '';
    }
    if (swiftFieldId) {
        const el = document.getElementById(swiftFieldId);
        if (el) el.value = opt.swift_code || '';
    }
}

function getMarketingFormData() {
    return {
        recipient_name: document.getElementById('mktRecipientName').value.trim(),
        recipient_email: document.getElementById('mktRecipientEmail').value.trim(),
        member_since: document.getElementById('mktMemberSince').value.trim(),
        amount: parseFloat(document.getElementById('mktAmount').value) || 0,
        currency: document.getElementById('mktCurrency').value,
        payment_method: document.getElementById('mktPaymentMethod').value,
        reference: document.getElementById('mktReference').value.trim(),
        watermark: document.getElementById('mktWatermark').value,
        bank_name: document.getElementById('mktBankName').value.trim(),
        account_name: document.getElementById('mktAccountName').value.trim(),
        account_number: document.getElementById('mktAccountNumber').value.trim(),
        routing_number: document.getElementById('mktRoutingNumber').value.trim(),
        swift_code: document.getElementById('mktSwiftCode').value.trim(),
    };
}

window._lastMktReceiptId = null;
window._lastMktData = null;

async function generateMarketingReceipt() {
    const data = getMarketingFormData();
    if (!data.recipient_name) { alert('Recipient name is required.'); return; }
    if (!data.amount || data.amount <= 0) { alert('Invalid amount.'); return; }

    const btn = document.getElementById('btnGenerateMkt');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    try {
        const resp = await fetch('/api/admin/receipts/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await resp.json();
        if (result.success) {
            window._lastMktReceiptId = result.receipt.id;
            window._lastMktData = result.receipt;

            const statusEl = document.getElementById('mktResult');
            statusEl.style.display = 'inline';
            statusEl.textContent = `✅ Generated: ${result.receipt.receipt_number}`;
            statusEl.style.color = 'var(--green)';

            // Enable preview
            document.getElementById('btnPreviewMkt').style.display = 'inline-block';
            document.getElementById('btnOpenMktPrint').style.display = 'inline-block';

            // Populate preview
            renderMktPreview(result.receipt);

            setTimeout(() => {
                document.getElementById('mktResult').style.display = 'none';
            }, 6000);
        } else {
            alert('❌ ' + (result.message || 'Failed to generate'));
        }
    } catch (e) {
        alert('❌ Network error.');
    } finally {
        btn.disabled = false;
        btn.textContent = '🎯 Generate & Save Receipt';
    }
}

function renderMktPreview(receipt) {
    const container = document.getElementById('mktPreviewContent');
    container.innerHTML = `
        <div style="background: white; color: #1F2937; padding: 2rem; border-radius: 8px; max-width: 500px; margin: 0 auto;">
            <div style="text-align: center; border-bottom: 2px solid #E5E7EB; padding-bottom: 1rem; margin-bottom: 1rem;">
                <div style="font-size: 1.1rem; font-weight: 700; color: #111827; font-family: Georgia, serif;">Monarch<span style="color: #A88B3A;">Securities</span></div>
                <div style="font-size: 0.8rem; color: #6B7280;">Payment Confirmation</div>
                <div style="font-size: 0.65rem; color: #9CA3AF;">Ref: ${receipt.receipt_number}</div>
            </div>
            <div style="text-align: center; background: #F0FDF4; border: 1px solid #DCFCE7; border-radius: 8px; padding: 0.8rem; margin-bottom: 1rem;">
                <div style="font-size: 0.65rem; color: #4B5563; text-transform: uppercase;">Net Transfer</div>
                <div style="font-size: 1.6rem; font-weight: 700; color: #15803D; font-family: Georgia, serif;">$${Number(receipt.amount).toFixed(2)} ${receipt.currency}</div>
            </div>
            <div style="font-size: 0.75rem;">
                <div style="display: flex; justify-content: space-between; padding: 0.35rem 0; border-bottom: 1px dashed #E5E7EB;">
                    <span style="color: #4B5563;">Recipient</span>
                    <span style="font-weight: 600;">${receipt.recipient_name}</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 0.35rem 0; border-bottom: 1px dashed #E5E7EB;">
                    <span style="color: #4B5563;">Bank</span>
                    <span style="font-weight: 600;">${receipt.bank_name || 'N/A'}</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 0.35rem 0; border-bottom: 1px dashed #E5E7EB;">
                    <span style="color: #4B5563;">Account</span>
                    <span style="font-weight: 600;">${receipt.account_number || 'N/A'}</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 0.35rem 0;">
                    <span style="color: #4B5563;">Date</span>
                    <span style="font-weight: 600;">${receipt.date}</span>
                </div>
            </div>
            <div style="text-align: center; margin-top: 1rem; font-size: 0.6rem; color: #9CA3AF;">
                ${receipt.watermark !== 'None' ? `<span style="border: 1px solid #9A8B3A; color: #9A8B3A; padding: 0.2rem 0.6rem; border-radius: 3px; transform: rotate(-12deg); display: inline-block; font-weight: 700;">${receipt.watermark}</span>` : ''}
            </div>
        </div>
    `;
    document.getElementById('mktPreviewModal').style.display = 'flex';
}

function previewMarketingReceipt() {
    if (window._lastMktData) {
        renderMktPreview(window._lastMktData);
    } else {
        alert('Generate a receipt first.');
    }
}

function closeMktPreview() {
    document.getElementById('mktPreviewModal').style.display = 'none';
}

// ============================================================
// BANK ACCOUNT REPOSITORY
// ============================================================

async function loadBankAccounts() {
    const tbody = document.getElementById('bankAccountsBody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="7" class="loading">Loading bank accounts...</td></tr>`;

    try {
        const resp = await fetch('/api/admin/bank-accounts');
        const data = await resp.json();
        if (data.success && data.accounts && data.accounts.length > 0) {
            tbody.innerHTML = data.accounts.map(a => `
                <tr>
                    <td><strong>${a.bank_name}</strong></td>
                    <td>${a.account_name}</td>
                    <td style="font-family: monospace;">${a.account_number}</td>
                    <td style="font-family: monospace; font-size: 0.75rem;">${a.routing_number || '—'}</td>
                    <td style="font-family: monospace; font-size: 0.75rem;">${a.swift_code || '—'}</td>
                    <td><span class="badge-status ${a.is_active ? 'completed' : 'rejected'}">${a.is_active ? 'Active' : 'Inactive'}</span></td>
                    <td>
                        <button onclick="deleteBankAccount(${a.id})" class="btn-sm btn-reject" style="font-size: 0.6rem;">Delete</button>
                    </td>
                </tr>
            `).join('');
        } else {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-faint); padding: 3rem 0;">No bank accounts found. Add one to get started.</td></tr>`;
        }
    } catch (e) {
        console.error('Error loading bank accounts:', e);
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #EF4444; padding: 3rem 0;">Failed to load bank accounts.</td></tr>`;
    }
}

function openAddBankAccountModal() {
    document.getElementById('addBankName').value = '';
    document.getElementById('addAccountName').value = '';
    document.getElementById('addAccountNumber').value = '';
    document.getElementById('addRoutingNumber').value = '';
    document.getElementById('addSwiftCode').value = '';
    document.getElementById('addCountry').value = 'United States';
    document.getElementById('addBankModal').style.display = 'flex';
}

function closeAddBankModal() {
    document.getElementById('addBankModal').style.display = 'none';
}

async function submitAddBankAccount(event) {
    event.preventDefault();
    const data = {
        bank_name: document.getElementById('addBankName').value.trim(),
        account_name: document.getElementById('addAccountName').value.trim(),
        account_number: document.getElementById('addAccountNumber').value.trim(),
        routing_number: document.getElementById('addRoutingNumber').value.trim(),
        swift_code: document.getElementById('addSwiftCode').value.trim(),
        country: document.getElementById('addCountry').value.trim(),
    };

    if (!data.bank_name || !data.account_name || !data.account_number) {
        alert('Bank name, account name, and account number are required.');
        return;
    }

    const btn = document.querySelector('#addBankForm .btn-gold');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    try {
        const resp = await fetch('/api/admin/bank-accounts/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await resp.json();
        if (result.success) {
            closeAddBankModal();
            _bankAccountsCache = []; // Invalidate cache
            await loadBankNamesForMarketing(); // Refresh datalist
            loadBankAccounts();
        } else {
            alert('❌ ' + (result.message || 'Failed to add account'));
        }
    } catch (e) {
        alert('❌ Network error.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Add Account'; }
    }
}

async function deleteBankAccount(id) {
    if (!confirm('Delete this bank account?')) return;
    try {
        const resp = await fetch(`/api/admin/bank-accounts/${id}`, { method: 'DELETE' });
        const result = await resp.json();
        if (result.success) {
            _bankAccountsCache = []; // Invalidate cache
            await loadBankNamesForMarketing(); // Refresh datalist
            loadBankAccounts();
        } else {
            alert('❌ ' + (result.message || 'Failed to delete'));
        }
    } catch (e) {
        alert('❌ Network error.');
    }
}

// ============================================================
// PAYMENTS LEDGER
// ============================================================

async function loadPayments() {
    const tbody = document.getElementById('paymentsTableBody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="6" class="loading">Loading payments ledger...</td></tr>`;

    try {
        const month = document.getElementById('paymentsMonthFilter')?.value || '';
        const url = `/api/admin/payments${month ? '?month=' + month : ''}`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.success && data.payments && data.payments.length > 0) {
            tbody.innerHTML = data.payments.map(p => `
                <tr>
                    <td><strong>${p.username}</strong></td>
                    <td style="text-transform: uppercase; font-size: 0.75rem;">${p.gateway}</td>
                    <td style="font-family: monospace; font-size: 0.7rem;">${p.reference}</td>
                    <td><strong>$${Number(p.amount).toFixed(2)}</strong> <span style="font-size: 0.6rem; color: var(--text-faint);">${p.currency}</span></td>
                    <td>
                        <span style="font-size: 0.65rem; padding: 0.1rem 0.4rem; border-radius: 4px; background: rgba(255,255,255,0.03); border: 1px solid var(--border); text-transform: uppercase;">
                            ${p.payment_type.replace('_', ' ')}
                        </span>
                    </td>
                    <td style="font-size: 0.72rem; color: var(--text-dim);">${p.created_at}</td>
                </tr>
            `).join('');
        } else {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-faint); padding: 3rem 0;">No verified payment transactions found.</td></tr>`;
        }
    } catch (e) {
        console.error('Error loading payments:', e);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #EF4444; padding: 3rem 0;">Failed to load payments ledger.</td></tr>`;
    }
}

// ============================================================
// INIT
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
    // Set current month for payments filter
    const filter = document.getElementById('paymentsMonthFilter');
    if (filter) {
        const now = new Date();
        filter.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    // Pre-load bank accounts globally so they work in all tabs immediately
    await loadBankNamesForMarketing();

    // Wire up marketing form bank auto-fill (once at init)
    const mktBankInput = document.getElementById('mktBankName');
    if (mktBankInput) {
        mktBankInput.oninput = function() {
            autoFillBankFields(
                this.value,
                'mktAccountName',
                'mktAccountNumber',
                'mktRoutingNumber',
                'mktSwiftCode'
            );
        };
    }

    // Wire up receipt modal bank auto-fill (once at init)
    const recBankInput = document.getElementById('recBankName');
    if (recBankInput) {
        recBankInput.oninput = function() {
            const opt = _bankAccountsCache.find(a => a.bank_name === this.value);
            if (opt) {
                document.getElementById('recAccName').value = opt.account_name;
                document.getElementById('recAccNum').value = opt.account_number;
                document.getElementById('recNotes').value =
                    `Administrative check passed. Bank: ${opt.bank_name}. Routing: ${opt.routing_number || 'N/A'}.`;
            }
        };
    }

    // Load initial tab
    switchAdminTab('withdrawals');
});

// ============================================================
// CYCLE INFO BAR
// ============================================================

async function loadCycleInfo() {
    const bar = document.getElementById('cycleInfoBar');
    if (!bar) return;
    try {
        const resp = await fetch('/api/withdrawal/settings');
        const data = await resp.json();
        if (data.success) {
            const d = data.data;
            bar.innerHTML = `
                <span>📅 <strong>Cycle:</strong> ${d.current_cycle}</span>
                <span>✂️ <strong>Submission Deadline:</strong> ${d.cut_off_day}th of every month</span>
                <span>📤 <strong>Processing Date:</strong> ${d.processing_day}</span>
                <span>💵 <strong>Min Withdrawal:</strong> $${Number(d.min_withdrawal).toLocaleString()}</span>
                <span>🧾 <strong>Tax Rate:</strong> ${d.tax_rate}%</span>
                <span style="color:${d.can_request ? 'var(--green)' : '#EF4444'};font-weight:600;">${d.can_request ? '🟢 Window Open' : '🔴 Window Closed'}</span>
            `;
        }
    } catch (e) {
        if (bar) bar.innerHTML = 'Could not load cycle info.';
    }
}

// ============================================================
// WAITING LIST MANAGEMENT
// ============================================================

let _allWaitingListData = [];
let _currentWLFilter = '';

async function loadWaitingList(statusFilter) {
    _currentWLFilter = statusFilter;

    // Update filter tab UI
    ['wlTabAll','wlTabPending','wlTabApproved','wlTabRejected'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    const tabMap = { '': 'wlTabAll', 'pending': 'wlTabPending', 'approved': 'wlTabApproved', 'rejected': 'wlTabRejected' };
    const activeTab = document.getElementById(tabMap[statusFilter]);
    if (activeTab) activeTab.classList.add('active');

    const tbody = document.getElementById('waitingListBody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="8" class="loading">Loading applications…</td></tr>`;

    try {
        const resp = await fetch('/api/admin/waiting-list/applications');
        const data = await resp.json();

        if (!data.success) throw new Error(data.message || 'Failed to load');

        _allWaitingListData = data.applications || [];

        // Dynamically compute stats from the full list
        const stats = {
            total: _allWaitingListData.length,
            pending: _allWaitingListData.filter(a => a.status === 'pending').length,
            approved: _allWaitingListData.filter(a => a.status === 'approved').length,
            rejected: _allWaitingListData.filter(a => a.status === 'rejected').length
        };
        updateWLStats(stats);

        // Filter the applications before rendering if status filter is active
        const filteredApps = statusFilter 
            ? _allWaitingListData.filter(a => a.status === statusFilter)
            : _allWaitingListData;

        renderWaitingListTable(filteredApps);

        // Badge on tab button
        const badge = document.getElementById('waitingListBadge');
        if (badge) {
            if (stats.pending > 0) {
                badge.textContent = stats.pending;
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        }

    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#EF4444;padding:1.5rem;">
            Error loading applications: ${e.message}</td></tr>`;
        console.error('Waiting list error:', e);
    }
}

function updateWLStats(stats) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('wlStatTotal', stats.total || 0);
    set('wlStatPending', stats.pending || 0);
    set('wlStatApproved', stats.approved || 0);
    set('wlStatRejected', stats.rejected || 0);
}

function renderWaitingListTable(applications) {
    const tbody = document.getElementById('waitingListBody');
    if (!tbody) return;

    if (!applications.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-faint);">No applications found.</td></tr>`;
        return;
    }

    const statusBadge = (s) => {
        const map = {
            pending:  `<span style="color:#F59E0B;font-size:0.7rem;font-weight:600;background:rgba(245,158,11,0.1);padding:0.15rem 0.5rem;border-radius:20px;">Pending</span>`,
            approved: `<span style="color:var(--green);font-size:0.7rem;font-weight:600;background:rgba(74,222,128,0.1);padding:0.15rem 0.5rem;border-radius:20px;">Approved</span>`,
            rejected: `<span style="color:#EF4444;font-size:0.7rem;font-weight:600;background:rgba(239,68,68,0.1);padding:0.15rem 0.5rem;border-radius:20px;">Rejected</span>`,
        };
        return map[s] || s;
    };

    tbody.innerHTML = applications.map(app => {
        const pendingActions = app.status === 'pending' ? `
            <button onclick="openApproveAppModal(${app.id}, '${(app.name||'').replace(/'/g,"'")}', '${app.email||''}')" class="btn-sm btn-approve">✓ Approve</button>
            <button onclick="openRejectAppModal(${app.id}, '${(app.name||'').replace(/'/g,"'")}')" class="btn-sm btn-reject">✗ Reject</button>
        ` : '';

        return `<tr>
            <td><input type="checkbox" class="wl-checkbox" data-id="${app.id}" onchange="updateBulkActionBtns()"></td>
            <td style="font-weight:600;">${app.name || '—'}</td>
            <td style="font-family:monospace;font-size:0.78rem;">${app.email || '—'}</td>
            <td>$${Number(app.intended_deposit || 0).toLocaleString()}</td>
            <td>${app.referral_source || '—'}</td>
            <td style="font-size:0.75rem;color:var(--text-dim);">${app.created_at ? new Date(app.created_at).toLocaleDateString() : '—'}</td>
            <td>${statusBadge(app.status)}</td>
            <td class="actions-cell" style="display:flex;gap:0.4rem;flex-wrap:wrap;">
                <button onclick="openAppDetail(${app.id})" class="btn-sm btn-view">📋 View</button>
                ${pendingActions}
            </td>
        </tr>`;
    }).join('');
}

function filterWaitingListTable() {
    const q = (document.getElementById('wlSearch')?.value || '').toLowerCase();
    if (!q) {
        renderWaitingListTable(_allWaitingListData);
        return;
    }
    const filtered = _allWaitingListData.filter(a =>
        (a.name || '').toLowerCase().includes(q) ||
        (a.email || '').toLowerCase().includes(q)
    );
    renderWaitingListTable(filtered);
}

function updateBulkActionBtns() {
    const checked = document.querySelectorAll('.wl-checkbox:checked').length;
    const btnA = document.getElementById('btnBulkApprove');
    const btnR = document.getElementById('btnBulkReject');
    if (btnA) btnA.style.display = checked > 0 ? 'inline-flex' : 'none';
    if (btnR) btnR.style.display = checked > 0 ? 'inline-flex' : 'none';
}

function toggleSelectAllApplications(masterCb) {
    document.querySelectorAll('.wl-checkbox').forEach(cb => { cb.checked = masterCb.checked; });
    updateBulkActionBtns();
}

// ---- Approve Modal ----
function openApproveAppModal(id, name, email) {
    document.getElementById('approveAppId').value = id;
    document.getElementById('approveAppInfo').textContent = `Approving application for ${name} (${email}). An invitation code will be generated and emailed.`;
    document.getElementById('approveReason').value = '';
    document.getElementById('approveAppModal').style.display = 'flex';
}
function closeApproveAppModal() {
    document.getElementById('approveAppModal').style.display = 'none';
}

async function confirmApproveApplication() {
    const id = document.getElementById('approveAppId').value;
    const reason = document.getElementById('approveReason').value;
    if (!id) return;
    try {
        const resp = await fetch(`/api/admin/waiting-list/${id}/approve`, {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ reason })
        });
        const data = await resp.json();
        if (data.success) {
            closeApproveAppModal();
            showAdminToast(`✅ Application approved! Invite code: ${data.invitation_code || '—'}`, 'success');
            loadWaitingList(_currentWLFilter);
        } else {
            showAdminToast('Error: ' + (data.message || 'Failed'), 'error');
        }
    } catch (e) {
        showAdminToast('Network error: ' + e.message, 'error');
    }
}

// ---- Reject Modal ----
function openRejectAppModal(id, name) {
    document.getElementById('rejectAppId').value = id;
    document.getElementById('rejectAppInfo').textContent = `Rejecting application for ${name}. Please provide a reason.`;
    document.getElementById('rejectAppReason').value = '';
    document.getElementById('rejectAppModal').style.display = 'flex';
}
function closeRejectAppModal() {
    document.getElementById('rejectAppModal').style.display = 'none';
}

async function confirmRejectApplication() {
    const id = document.getElementById('rejectAppId').value;
    const reason = document.getElementById('rejectAppReason').value;
    if (!id) return;
    try {
        const resp = await fetch(`/api/admin/waiting-list/${id}/reject`, {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ reason })
        });
        const data = await resp.json();
        if (data.success) {
            closeRejectAppModal();
            showAdminToast('⛔ Application rejected.', 'info');
            loadWaitingList(_currentWLFilter);
        } else {
            showAdminToast('Error: ' + (data.message || 'Failed'), 'error');
        }
    } catch (e) {
        showAdminToast('Network error: ' + e.message, 'error');
    }
}

// ---- Bulk Actions ----
async function bulkApproveApplications() {
    const ids = [...document.querySelectorAll('.wl-checkbox:checked')].map(cb => parseInt(cb.dataset.id));
    if (!ids.length) return;
    if (!confirm(`Approve ${ids.length} selected application(s)?`)) return;
    try {
        const resp = await fetch('/api/admin/waiting-list/bulk', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ action: 'approve', ids })
        });
        const data = await resp.json();
        showAdminToast(`✅ ${data.processed || ids.length} applications approved.`, 'success');
        loadWaitingList(_currentWLFilter);
    } catch (e) {
        showAdminToast('Network error: ' + e.message, 'error');
    }
}

async function bulkRejectApplications() {
    const ids = [...document.querySelectorAll('.wl-checkbox:checked')].map(cb => parseInt(cb.dataset.id));
    if (!ids.length) return;
    const reason = prompt('Rejection reason for all selected (optional):') || '';
    try {
        const resp = await fetch('/api/admin/waiting-list/bulk', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ action: 'reject', ids, reason })
        });
        const data = await resp.json();
        showAdminToast(`⛔ ${data.processed || ids.length} applications rejected.`, 'info');
        loadWaitingList(_currentWLFilter);
    } catch (e) {
        showAdminToast('Network error: ' + e.message, 'error');
    }
}

// ---- Application Detail Modal ----
async function openAppDetail(id) {
    const modal = document.getElementById('appDetailModal');
    const content = document.getElementById('appDetailContent');
    if (!modal || !content) return;
    modal.style.display = 'flex';
    content.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-dim);">Loading…</div>';
    const app = _allWaitingListData.find(a => a.id === id);
    if (!app) {
        content.innerHTML = '<p style="color:#EF4444;">Application not found in current data.</p>';
        return;
    }
    const row = (label, val) => `<div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border);font-size:0.82rem;">
        <span style="color:var(--text-faint);">${label}</span>
        <span style="color:var(--text);font-weight:600;">${val || '—'}</span></div>`;
    content.innerHTML = `
        ${row('Name', app.name)}
        ${row('Email', app.email)}
        ${row('Intended Investment', '$' + Number(app.intended_deposit || 0).toLocaleString())}
        ${row('Referral Source', app.referral_source)}
        ${row('Notes', app.notes)}
        ${row('Status', app.status?.toUpperCase())}
        ${row('Rejection Reason', app.rejection_reason)}
        ${row('Invitation Code', app.invitation_code)}
        ${row('Submitted', app.created_at ? new Date(app.created_at).toLocaleString() : '—')}
        ${row('Approved At', app.approved_at ? new Date(app.approved_at).toLocaleString() : '—')}
    `;
}
function closeAppDetailModal() {
    document.getElementById('appDetailModal').style.display = 'none';
}

// ============================================================
// MEMBERS MANAGEMENT
// ============================================================

let _allMembersData = [];

async function loadMembers() {
    const tbody = document.getElementById('membersTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="loading">Loading members…</td></tr>';
    try {
        const resp = await fetch('/api/admin/users');
        const data = await resp.json();
        if (!data.success) throw new Error(data.message);
        _allMembersData = data.users || [];
        renderMembersTable(_allMembersData);
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#EF4444;padding:1.5rem;">Error loading members: ${e.message}</td></tr>`;
    }
}

function renderMembersTable(users) {
    const tbody = document.getElementById('membersTableBody');
    if (!tbody) return;
    if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-faint);">No members found.</td></tr>';
        return;
    }
    tbody.innerHTML = users.map(u => `<tr>
        <td style="font-weight:600;">${u.username || '—'}</td>
        <td style="font-family:monospace;font-size:0.78rem;">${u.email || '—'}</td>
        <td style="color:var(--gold);font-weight:700;">$${Number(u.balance || 0).toFixed(2)}</td>
        <td>$${Number(u.total_deposits || 0).toFixed(2)}</td>
        <td style="font-size:0.75rem;color:var(--text-dim);">${u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
        <td>${u.is_admin
            ? '<span style="color:var(--gold);font-size:0.7rem;font-weight:600;background:var(--gold-dim);padding:0.15rem 0.5rem;border-radius:20px;">Admin</span>'
            : '<span style="color:var(--green);font-size:0.7rem;font-weight:600;background:rgba(74,222,128,0.1);padding:0.15rem 0.5rem;border-radius:20px;">Active</span>'}
        </td>
    </tr>`).join('');
}

function filterMembersTable() {
    const q = (document.getElementById('membersSearch')?.value || '').toLowerCase();
    if (!q) { renderMembersTable(_allMembersData); return; }
    renderMembersTable(_allMembersData.filter(u =>
        (u.username || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q)
    ));
}

// ---- Admin Toast (reusable) ----
function showAdminToast(msg, type = 'info') {
    let toast = document.getElementById('adminToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'adminToast';
        toast.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;padding:0.8rem 1.2rem;border-radius:8px;font-size:0.82rem;font-weight:600;max-width:340px;box-shadow:0 8px 32px rgba(0,0,0,0.4);transition:all 0.3s ease;';
        document.body.appendChild(toast);
    }
    const colors = { success: '#4ADE80', error: '#EF4444', info: '#C8A85E' };
    toast.style.background = '#141926';
    toast.style.border = `1px solid ${colors[type] || colors.info}`;
    toast.style.color = colors[type] || colors.info;
    toast.textContent = msg;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(10px)'; }, 4000);
}
