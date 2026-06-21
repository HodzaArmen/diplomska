/**
 * regulator-dashboard.js — JAZMP audit in potrditev akterjev
 */

let currentSessionId = null;

const REGULATOR_ROLE_LABELS = {
    manufacturer: 'Proizvajalec',
    distributor: 'Distributer',
    pharmacy: 'Lekarna'
};

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const ctx = await ensureDashboardSession('regulator');
        if (!ctx) return;

        currentSessionId = ctx.sessionId;
        setupDashboardNav(ctx.user, '🏛️');
        setupDashboardLogout(currentSessionId);
        ProfilePanel?.setupProfileButton?.(currentSessionId);

        await Promise.all([loadRegulatorUsers(), loadRegulatorMedicines()]);
    } catch (error) {
        console.error('Regulator dashboard init:', error);
        const usersBox = document.getElementById('regulator-users-list');
        const medsBox = document.getElementById('regulator-medicines-list');
        const msg = `<p class="error-message">${escapeHtml(error.message || 'Napaka pri nalaganju dashboarda')}</p>`;
        if (usersBox) usersBox.innerHTML = msg;
        if (medsBox) medsBox.innerHTML = msg;
    }
});

async function loadRegulatorUsers() {
    const container = document.getElementById('regulator-users-list');
    if (!container) return;

    try {
        const res = await fetch(`/api/regulator/pending-users?sessionId=${encodeURIComponent(currentSessionId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Napaka pri nalaganju uporabnikov');

        const users = data.users || [];
        if (!users.length) {
            container.innerHTML = '<p class="text-muted">Ni registriranih proizvajalcev, distributerjev ali lekarn.</p>';
            return;
        }

        const pendingCount = users.filter((u) => !u.jazmpApproved).length;
        const intro = pendingCount
            ? `<p class="text-muted">Čaka na potrditev: <strong>${pendingCount}</strong> ${pendingCount === 1 ? 'račun' : 'računov'}.</p>`
            : '<p class="text-muted">Vsi registrirani akterji so potrjeni.</p>';

        const rows = users.map((u) => {
            const shortWallet = `${u.walletAddress.slice(0, 8)}…${u.walletAddress.slice(-6)}`;
            const status = u.jazmpApproved
                ? '<span class="badge badge-success">Potrjen</span>'
                : '<span class="badge badge-warning">Čaka</span>';
            const action = u.jazmpApproved
                ? '—'
                : `<button type="button" class="btn btn-primary btn-sm btn-jazmp-approve"
                        data-wallet="${escapeHtml(u.walletAddress)}">Potrdi</button>`;

            return `
                <tr>
                    <td>${escapeHtml(REGULATOR_ROLE_LABELS[u.role] || u.role)}</td>
                    <td>${escapeHtml(u.companyName || '—')}</td>
                    <td>${escapeHtml(u.email || '—')}</td>
                    <td><code title="${escapeHtml(u.walletAddress)}">${escapeHtml(shortWallet)}</code></td>
                    <td>${status}</td>
                    <td>${action}</td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            ${intro}
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Vloga</th><th>Podjetje</th><th>Email</th><th>Denarnica</th><th>Status</th><th></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;

        container.querySelectorAll('.btn-jazmp-approve').forEach((btn) => {
            btn.addEventListener('click', () => approveUser(btn.dataset.wallet, btn));
        });
    } catch (error) {
        container.innerHTML = `<p class="error-message">${escapeHtml(error.message)}</p>`;
    }
}

async function approveUser(walletAddress, btn) {
    if (!walletAddress) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Potrjujem…';

    try {
        const res = await fetch('/api/regulator/approve-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId, targetWallet: walletAddress })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Potrditev ni uspela');
        await loadRegulatorUsers();
    } catch (error) {
        alert(error.message);
        btn.disabled = false;
        btn.textContent = original;
    }
}

async function loadRegulatorMedicines() {
    const container = document.getElementById('regulator-medicines-list');
    try {
        const res = await fetch(`/api/regulator/medicines?sessionId=${encodeURIComponent(currentSessionId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Napaka pri nalaganju');

        const medicines = data.medicines || [];
        if (!medicines.length) {
            container.innerHTML = '<p class="text-muted">V sistemu še ni registriranih zdravil.</p>';
            return;
        }

        const rows = medicines.map((m) => `
            <tr>
                <td><code>${escapeHtml(m.medicine_id)}</code></td>
                <td>${escapeHtml(m.name)}</td>
                <td>${escapeHtml(m.batch_number || '—')}</td>
                <td>${escapeHtml(m.manufacturer_name || '—')}</td>
                <td>${escapeHtml(m.blockchain_status || '—')}</td>
                <td>${formatDisplayDate(m.expiry_date)}</td>
                <td>
                    <button type="button" class="btn btn-secondary btn-sm btn-regulator-preview"
                        data-medicine-id="${escapeHtml(m.medicine_id)}">Pregled</button>
                </td>
            </tr>
        `).join('');

        container.innerHTML = `
            <table class="data-table">
                <thead>
                    <tr>
                        <th>ID</th><th>Ime</th><th>Serija</th><th>Proizvajalec</th>
                        <th>Veriga</th><th>Rok</th><th></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;

        container.querySelectorAll('.btn-regulator-preview').forEach((btn) => {
            btn.addEventListener('click', () => {
                openMedicinePreview(btn.dataset.medicineId, currentSessionId, { readOnly: true });
            });
        });
    } catch (error) {
        container.innerHTML = `<p class="error-message">${escapeHtml(error.message)}</p>`;
    }
}

function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}
