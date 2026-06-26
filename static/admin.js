// ============================================================
// Admin Dashboard JS
// ============================================================

let currentWithdrawalFilter = '';

async function loadStats() {
    try {
        const resp = await fetch('/api/admin/stats');
        const data = await resp.json();
        
        if (data.success) {
            document.getElementById('statDeposits').textContent = `$${data.deposits_month.toFixed(2)}`;
            document.getElementById('statVerifiedCount').textContent = `${data.verified_payments} verified transactions`;
            document.getElementById('statTax').textContent = `$${data.tax_month.toFixed(2)}`;
            document.getElementById('statPending').textContent = data.pending_count;
            document.getElementById('statUsers').textContent = data.active_users;
        }
    } catch (e) {
        console.error('Error loading stats:', e);
    }
}

async function loadWithdrawals() {
    const tbody = document.getElementById('withdrawalsTableBody');
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="7" class="loading">Fetching withdrawal records...</td></tr>`;

    try {
        const url = `/api/admin/withdrawals${currentWithdrawalFilter ? '?status=' + currentWithdrawalFilter : ''}`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.success && data.withdrawals && data.withdrawals.length > 0) {
            tbody.innerHTML = data.withdrawals.map(w => {
                const netAmount = w.amount - w.tax_amount;
                let actionsHtml = '';

                if (w.status === 'pending' || w.status === 'tax_required') {
                    actionsHtml = `
                        <button onclick="openReceiptModal('${w.id}', ${w.amount}, ${w.tax_amount})" class="btn-sm btn-approve">Approve / Receipt</button>
                        <button onclick="rejectWithdrawal('${w.id}')" class="btn-sm btn-reject">Reject</button>
                    `;
                } else if (w.status === 'completed' && w.receipt_number) {
                    actionsHtml = `
                        <button onclick="window.open('/receipt/print/${w.id}', '_blank')" class="btn-sm btn-view">📄 View Receipt</button>
                    `;
                } else {
                    actionsHtml = `<span style="color: var(--text-faint);">None</span>`;
                }

                return `
                    <tr>
                        <td>
                            <strong>${escapeHtml(w.username)}</strong>
                            <div style="font-size: 0.68rem; color: var(--text-faint);">${escapeHtml(w.email)}</div>
                        </td>
                        <td><strong>$${w.amount.toFixed(2)}</strong></td>
                        <td style="color: var(--gold-dim);">$${w.tax_amount.toFixed(2)}</td>
                        <td style="color: var(--green);"><strong>$${netAmount.toFixed(2)}</strong></td>
                        <td>
                            <span class="badge-status ${w.status}">${w.status.replace('_', ' ')}</span>
                        </td>
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

async function loadPayments() {
    const tbody = document.getElementById('paymentsTableBody');
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="6" class="loading">Loading payments ledger...</td></tr>`;

    try {
        const month = document.getElementById('paymentsMonthFilter').value;
        const url = `/api/admin/payments${month ? '?month=' + month : ''}`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.success && data.payments && data.payments.length > 0) {
            tbody.innerHTML = data.payments.map(p => `
                <tr>
                    <td><strong>${escapeHtml(p.username)}</strong></td>
                    <td style="text-transform: uppercase;">${escapeHtml(p.gateway)}</td>
                    <td style="font-family: monospace; font-size: 0.75rem;">${escapeHtml(p.reference)}</td>
                    <td><strong>$${p.amount.toFixed(2)}</strong> <span style="font-size: 0.65rem; color: var(--text-faint);">${escapeHtml(p.currency)}</span></td>
                    <td>
                        <span style="font-size: 0.72rem; padding: 0.1rem 0.4rem; border-radius: 4px; background: rgba(255,255,255,0.03); border: 1px solid var(--border); text-transform: uppercase;">
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

function filterWithdrawals(status) {
    currentWithdrawalFilter = status;
    
    // Update active tab styles
    const tabs = document.querySelectorAll('#withdrawalTabs .tab');
    tabs.forEach(tab => {
        const text = tab.innerText.toLowerCase();
        if (status === '' && text === 'all') {
            tab.classList.add('active');
        } else if (text === status.replace('_', ' ')) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    loadWithdrawals();
}

async function rejectWithdrawal(id) {
    const notes = prompt("Enter reason/notes for rejection (to be displayed to the user):", "Failed compliance review / KYC validation mismatch.");
    if (notes === null) return; // User cancelled prompt

    const btn = document.querySelector(`button[onclick="rejectWithdrawal('${id}')"]`);
    if (btn) { btn.disabled = true; btn.innerText = "Rejecting..."; }

    try {
        const resp = await fetch(`/api/admin/withdrawal/${id}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes })
        });
        const data = await resp.json();
        if (data.success) {
            alert("✅ Withdrawal request has been rejected and funds returned to user's balance.");
            loadStats();
            loadWithdrawals();
        } else {
            alert("❌ Reject failed: " + data.message);
        }
    } catch (e) {
        alert("❌ Error communication error.");
    }
}

function openReceiptModal(id, amount, taxAmount) {
    document.getElementById('modalWithdrawalId').value = id;
    document.getElementById('recAmount').value = `$${amount.toFixed(2)}`;
    document.getElementById('recNet').value = `$${(amount - taxAmount).toFixed(2)}`;
    
    // Reset form fields
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
    btn.textContent = 'Clearing & Uploading...';

    // Build Form Data for multipart file upload
    const formData = new FormData();
    formData.append('bank_name', document.getElementById('recBankName').value);
    formData.append('account_number', document.getElementById('recAccNum').value);
    formData.append('account_name', document.getElementById('recAccName').value);
    formData.append('admin_notes', document.getElementById('recNotes').value);

    const imageFile = document.getElementById('recImage').files[0];
    if (imageFile) {
        formData.append('receipt_image', imageFile);
    }

    try {
        const resp = await fetch(`/api/admin/withdrawal/${id}/generate-receipt`, {
            method: 'POST',
            body: formData // Fetch handles proper headers/boundary automatically
        });
        const data = await resp.json();

        if (data.success) {
            closeReceiptModal();
            alert("✅ Withdrawal cleared and settlement receipt successfully generated!");
            loadStats();
            loadWithdrawals();
            
            // Open print window immediately
            window.open(`/receipt/print/${id}`, '_blank');
        } else {
            alert("❌ Approve failed: " + data.message);
            btn.disabled = false;
            btn.textContent = 'Approve & Generate Receipt';
        }
    } catch (e) {
        alert("❌ Network error saving settlement receipt.");
        btn.disabled = false;
        btn.textContent = 'Approve & Generate Receipt';
    }
}

// ---- Help Helpers ----
function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Set current month filter as default
document.addEventListener('DOMContentLoaded', () => {
    const filter = document.getElementById('paymentsMonthFilter');
    if (filter) {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        filter.value = `${yyyy}-${mm}`;
    }

    loadStats();
    loadWithdrawals();
    loadPayments();
});
