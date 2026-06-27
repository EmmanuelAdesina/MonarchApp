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
                    actionsHtml = `
                        <button onclick="openDetailModal('${w.id}')" class="btn-sm btn-view">📋 View</button>
                        <button onclick="openReceiptModal('${w.id}', ${w.amount || 0}, ${w.tax_amount || 0})" class="btn-sm btn-approve">Approve</button>
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
                        <td><strong>$${Number(w.amount || 0).toFixed(2)}</strong></td>
                        <td style="color: var(--gold-dim);">$${Number(w.tax_amount || 0).toFixed(2)}</td>
                        <td style="color: var(--green);"><strong>$${netAmount.toFixed(2)}</strong></td>
                        <td><span class="badge-status ${w.status}">${w.status.replace('_', ' ')}</span></td>
                        <td style="font-size: 0.72rem; color: var(--text-dim);">${w.created_at}</td>
                        <td>${actionsHtml}</td>
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
                <div class="detail-row"><span class="lbl">Bank</span><span class="val">${user.bank_name || 'Not provided'}</span></div>
                <div class="detail-row"><span class="lbl">Account Name</span><span class="val">${user.account_name || 'Not provided'}</span></div>
                <div class="detail-row"><span class="lbl">Account Number</span><span class="val">${user.account_number || 'Not provided'}</span></div>
                <div class="detail-row"><span class="lbl">Routing Number</span><span class="val">${user.routing_number || 'Not provided'}</span></div>
                <div class="detail-row"><span class="lbl">Swift Code</span><span class="val">${user.swift_code || 'Not provided'}</span></div>
            </div>
            ${user.admin_notes ? `<div style="margin-top: 0.8rem; padding: 0.5rem; background: rgba(245, 158, 11, 0.05); border-radius: 6px; font-size: 0.75rem; color: var(--text-dim);"><strong>Notes:</strong> ${user.admin_notes}</div>` : ''}
            <div style="margin-top: 1rem; display: flex; gap: 0.6rem; flex-wrap: wrap; border-top: 1px solid var(--border); padding-top: 1rem;">
                ${user.status === 'pending' || user.status === 'tax_required' ? `
                    <button onclick="quickApproveWithdrawal('${user.id}')" class="btn-sm btn-approve" style="padding: 0.5rem 1rem;">✅ Approve (Quick)</button>
                    <button onclick="closeDetailModal(); openReceiptModal('${user.id}', ${user.amount}, ${user.tax_amount})" class="btn-sm btn-view" style="padding: 0.5rem 1rem; border-color:var(--green); color:var(--green);">📄 Generate Receipt</button>
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

async function quickApproveWithdrawal(id) {
    if (!confirm('Are you sure you want to approve this withdrawal? This will set status to Completed and log the transaction. No actual funds will be disbursed.')) return;
    try {
        const resp = await fetch(`/api/admin/withdrawal/${id}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await resp.json();
        if (data.success) {
            _allWithdrawalsCache = {}; // Invalidate cache
            closeDetailModal();
            loadStats();
            loadWithdrawals();
            alert('Withdrawal approved successfully!');
        } else {
            alert('Error: ' + data.message);
        }
    } catch (e) {
        alert('Network error.');
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
