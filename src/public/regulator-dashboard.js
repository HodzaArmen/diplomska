/**
 * regulator-dashboard.js — JAZMP read-only audit
 */

let currentSessionId = null;

document.addEventListener('DOMContentLoaded', async () => {
    const ctx = await ensureDashboardSession('regulator');
    if (!ctx) return;

    currentSessionId = ctx.sessionId;
    setupDashboardNav(ctx.user, '🏛️');
    setupDashboardLogout(currentSessionId);
    ProfilePanel?.setupProfileButton?.(currentSessionId);

    await loadRegulatorMedicines();
});

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
