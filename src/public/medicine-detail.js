/**
 * medicine-detail.js — pregled zdravila (accordion, brez horizontal scrolla)
 */

function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function detailRow(label, value) {
    if (value == null || value === '') return '';
    return `<div class="detail-kv"><span class="detail-k">${escapeHtml(label)}</span><span class="detail-v">${escapeHtml(value)}</span></div>`;
}

function renderVcBlock(claims, title, signed) {
    const status = signed ? '<span class="badge badge-success">Podpisano</span>' : '<span class="badge badge-warning">Ni podpisano</span>';
    if (!claims) {
        return `<div class="detail-block"><h5>${escapeHtml(title)} ${status}</h5><p class="text-muted">Ni podatkov v credential.</p></div>`;
    }
    return `<div class="detail-block">
        <h5>${escapeHtml(title)} ${status}</h5>
        <div class="detail-kv-grid">
            ${detailRow('Dogodek', claims.eventType)}
            ${detailRow('Čas', claims.eventTimestamp ? formatDisplayDateTime(claims.eventTimestamp) : null)}
            ${detailRow('Pošiljatelj', claims.senderName ? `${claims.senderName} (${claims.senderRole})` : claims.creatorName)}
            ${detailRow('Prejemnik', claims.recipientName ? `${claims.recipientName} (${claims.recipientRole})` : null)}
            ${detailRow('Količina', claims.quantity != null ? `${claims.quantity} enot` : null)}
            ${detailRow('Serija', claims.batchNumber)}
        </div>
    </div>`;
}

function displayMedicineDetailPanel(containerId, medicine, opts = {}) {
    const el = document.getElementById(containerId);
    if (!el || !medicine) return;
    el.style.display = 'block';

    const total = medicine.totalManufacturedQuantity ?? medicine.quantity;
    const recv = medicine.receivedQuantity ?? medicine.quantity;
    const stockText = medicine.stockStatusLabel || (recv !== total ? `${recv} / ${total} enot` : `${recv} enot`);

    const highlightDelivery = opts.deliveryId
        ? (medicine.deliveries || []).find((d) => d.deliveryId === opts.deliveryId)
        : null;

    const deliveriesHtml = (medicine.deliveries || []).length === 0
        ? '<p class="text-muted">Ni pošiljk.</p>'
        : `<div class="detail-deliveries">${(medicine.deliveries || []).map((d) => {
            const hl = d.deliveryId === opts.deliveryId ? ' delivery-highlight' : '';
            return `<div class="delivery-chip${hl}">
                <strong>${labelDeliveryStatus(d.status)}</strong>
                ${d.quantity} en · ${escapeHtml(d.sourceRole)} → ${escapeHtml(d.targetRole)}
                ${d.transportVcSigned ? ' · VC ✓' : ''}
            </div>`;
        }).join('')}</div>`;

    const historyHtml = (medicine.supplyChainHistory || []).length === 0
        ? '<p class="text-muted">Ni zgodovine.</p>'
        : `<ol class="timeline">${(medicine.supplyChainHistory || []).map((h) => {
            const d = h.details || {};
            const extra = [d.quantity != null ? `${d.quantity} en` : null, d.targetDistributorName, d.targetPharmacyName].filter(Boolean).join(' · ');
            return `<li><span class="timeline-label">${escapeHtml(h.actionLabel || h.action)}</span>
                <span class="timeline-meta">${escapeHtml(h.actorRole || '')}${extra ? ' · ' + escapeHtml(extra) : ''}</span>
                <span class="timeline-time">${formatDisplayDateTime(h.timestamp)}</span></li>`;
        }).join('')}</ol>`;

    const ipfsBlock = medicine.ipfsHash
        ? `${renderIpfsLinksHtml(medicine.ipfsHash)}`
        : '<p class="text-muted">Ni IPFS zapisa.</p>';

    el.innerHTML = `
        <div class="medicine-detail-panel dashboard-card">
            <div class="detail-header">
                <div>
                    <h3>${escapeHtml(medicine.name)}</h3>
                    <p class="text-muted">Serija ${escapeHtml(medicine.batchNumber)} · ${stockText}</p>
                </div>
                <button type="button" class="btn btn-ghost btn-close-detail" aria-label="Zapri">✕</button>
            </div>

            <div class="detail-summary">
                ${detailRow('ID', medicine.medicineId)}
                ${detailRow('Proizvajalec', medicine.manufacturerName)}
                ${detailRow('Rok uporabe', formatDisplayDate(medicine.expiryDate))}
                ${highlightDelivery ? detailRow('Ta pošiljka', `${highlightDelivery.quantity} en · ${labelDeliveryStatus(highlightDelivery.status)}`) : ''}
            </div>

            <details class="detail-accordion" open>
                <summary>Verifiable Credentials</summary>
                ${renderVcBlock(medicine.medicineVcClaims, 'Zdravilo (proizvajalec)', medicine.vcSigned)}
                ${(medicine.deliveries || []).filter((d) => d.transportVcClaims || d.transportVcSigned).map((d) =>
                    renderVcBlock(d.transportVcClaims, `Pošiljka ${labelDeliveryStatus(d.status)}`, d.transportVcSigned)
                ).join('')}
            </details>

            <details class="detail-accordion">
                <summary>Pošiljke (${(medicine.deliveries || []).length})</summary>
                ${deliveriesHtml}
            </details>

            <details class="detail-accordion">
                <summary>Pot dobave</summary>
                ${historyHtml}
            </details>

            <details class="detail-accordion">
                <summary>IPFS & Blockchain</summary>
                <div class="detail-split">
                    <div><h5>IPFS</h5>${ipfsBlock}</div>
                    <div><h5>Blockchain</h5>${renderBlockchainExplorerHtml(medicine)}</div>
                </div>
            </details>

            ${opts.onVerify ? '<button type="button" class="btn btn-secondary btn-verify-detail">Preveri VC + blockchain</button>' : ''}
        </div>
    `;

    el.querySelector('.btn-close-detail')?.addEventListener('click', closeMedicineDetailPanel);
    el.querySelector('.btn-verify-detail')?.addEventListener('click', () => opts.onVerify(medicine.medicineId));
}

async function loadMedicineDetails(medicineId, sessionId, containerId, opts = {}) {
    let url = `/api/medicines/${encodeURIComponent(medicineId)}/details?sessionId=${encodeURIComponent(sessionId)}`;
    if (opts.deliveryId) url += `&deliveryId=${encodeURIComponent(opts.deliveryId)}`;
    const response = await fetch(url);
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Napaka pri nalaganju podatkov');
    }
    const data = await response.json();
    displayMedicineDetailPanel(containerId, data.medicine, opts);
    return data.medicine;
}
