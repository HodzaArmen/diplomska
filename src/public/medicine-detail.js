/**
 * medicine-detail.js — pregled zdravila (vir: blockchain + Verifier API + IPFS)
 */

function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function sourceBadge(source, label) {
    const cls = {
        blockchain: 'badge-info',
        'verifier-api': 'badge-success',
        'ipfs-via-blockchain': 'badge-neutral',
        'ipfs-gateway': 'badge-neutral',
        'postgres-inbox-only': 'badge-warning',
        none: 'badge-warning'
    }[source] || 'badge-neutral';
    return `<span class="badge ${cls}" title="Vir podatkov">${escapeHtml(label || source)}</span>`;
}

function detailRow(label, value) {
    if (value == null || value === '') return '';
    return `<div class="detail-kv"><span class="detail-k">${escapeHtml(label)}</span><span class="detail-v">${value}</span></div>`;
}

function renderVcBlock(claims, title, verified, opts = {}) {
    const structural = opts.structuralOnly ? ' (strukturno)' : '';
    const status = verified
        ? `<span class="badge badge-success">Verifier API ✓</span>`
        : `<span class="badge badge-warning">Ni preverjeno</span>`;
    const msg = opts.message ? `<p class="text-muted vc-verify-msg">${escapeHtml(opts.message)}${structural}</p>` : '';
    if (!claims) {
        return `<div class="detail-block"><h5>${escapeHtml(title)} ${status}</h5>${msg}<p class="text-muted">Ni podatkov v credential.</p></div>`;
    }
    return `<div class="detail-block">
        <h5>${escapeHtml(title)} ${status} ${sourceBadge('verifier-api', 'Walt.id Verifier')}</h5>
        ${msg}
        <div class="detail-kv-grid">
            ${detailRow('Dogodek', claims.eventType)}
            ${detailRow('Čas', claims.eventTimestamp ? formatDisplayDateTime(claims.eventTimestamp) : null)}
            ${detailRow('Pošiljatelj', claims.senderName ? `${claims.senderName} (${claims.senderRole})` : claims.creatorName)}
            ${detailRow('Prejemnik', claims.recipientName ? `${claims.recipientName} (${claims.recipientRole})` : null)}
            ${detailRow('Količina', claims.quantity != null ? `${claims.quantity} enot` : null)}
            ${detailRow('Serija', claims.batchNumber)}
            ${detailRow('DID izdajatelja', claims.senderDID || claims.creatorDID || claims.manufacturerDID)}
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

    const ds = medicine.dataSources || {};
    const sourcesHtml = `<p class="detail-sources">
        ${sourceBadge(ds.timeline, 'Pot dobave: ' + (ds.timeline === 'blockchain' ? 'Blockchain' : 'Ni na verigi'))}
        ${sourceBadge(ds.medicineVc, 'VC zdravila')}
        ${sourceBadge(ds.productData, ds.productData === 'ipfs-via-blockchain' ? 'IPFS (hash z verige)' : 'IPFS')}
    </p>
    <p class="text-muted detail-sources-note">${escapeHtml(ds.note || '')}</p>`;

    const deliveriesHtml = (medicine.deliveries || []).length === 0
        ? '<p class="text-muted">Ni pošiljk v indeksu.</p>'
        : `<div class="detail-deliveries">${(medicine.deliveries || []).map((d) => {
            const hl = d.deliveryId === opts.deliveryId ? ' delivery-highlight' : '';
            const vcTag = d.transportVcVerified ? ' · Verifier ✓' : (d.transportVcSigned ? ' · VC' : '');
            const chainTag = d.onChain ? ' · On-chain ✓' : '';
            return `<div class="delivery-chip${hl}">
                <strong>${labelDeliveryStatus(d.status)}</strong>
                ${d.quantity} en · ${escapeHtml(d.sourceRole)} → ${escapeHtml(d.targetRole)}
                ${vcTag}${chainTag}
            </div>`;
        }).join('')}</div>`;

    const historyHtml = (medicine.supplyChainHistory || []).length === 0
        ? '<p class="text-muted">Na blockchainu še ni handoff dogodkov. Ustvarite novo pošiljko po redeploy pogodbe.</p>'
        : `<ol class="timeline">${(medicine.supplyChainHistory || []).map((h) => {
            const qty = h.quantity ? `${h.quantity} en · ` : '';
            const parties = [h.actorLabel, h.counterpartyLabel].filter(Boolean).join(' → ');
            return `<li>
                <span class="timeline-label">${escapeHtml(h.actionLabel || h.action)}</span>
                <span class="timeline-meta">${qty}${escapeHtml(parties)}</span>
                <span class="timeline-time">${formatDisplayDateTime(h.timestamp)}</span>
                ${h.vcRef ? `<span class="timeline-meta">VC ref: <code class="code-break">${escapeHtml(h.vcRef.slice(0, 16))}…</code></span>` : ''}
            </li>`;
        }).join('')}</ol>`;

    const ipfsOk = medicine.ipfsVerification?.accessible;
    const ipfsBlock = medicine.ipfsHash
        ? `${renderIpfsLinksHtml(medicine.ipfsHash)}
           <p>${ipfsOk ? sourceBadge('ipfs-gateway', 'IPFS dostopen') : sourceBadge('none', 'IPFS ni dostopen')}</p>
           ${medicine.ipfsHashOnChain ? '<p class="text-muted">Hash iz blockchain zapisa</p>' : ''}`
        : '<p class="text-muted">Ni IPFS zapisa na verigi.</p>';

    const onChain = medicine.onChain?.medicine;
    const chainBlock = onChain
        ? `${detailRow('Status na verigi', onChain.status)}
           ${detailRow('Lastnik', medicine.onChain.currentHolderLabel || onChain.currentHolder)}
           ${detailRow('DID lastnika', onChain.currentHolderDID)}
           ${renderBlockchainExplorerHtml(medicine)}`
        : '<p class="text-muted">Zdravilo ni na blockchainu ali pogodba ni redeployana.</p>';

    el.innerHTML = `
        <div class="medicine-detail-panel dashboard-card">
            <div class="detail-header">
                <div>
                    <h3>${escapeHtml(medicine.name)}</h3>
                    <p class="text-muted">Serija ${escapeHtml(medicine.batchNumber)} · ${stockText}</p>
                </div>
                <button type="button" class="btn btn-ghost btn-close-detail" aria-label="Zapri">✕</button>
            </div>

            ${sourcesHtml}

            <div class="detail-summary">
                ${detailRow('ID', medicine.medicineId)}
                ${detailRow('Proizvajalec', medicine.manufacturerName)}
                ${detailRow('Rok uporabe', formatDisplayDate(medicine.expiryDate))}
                ${highlightDelivery ? detailRow('Ta pošiljka', `${highlightDelivery.quantity} en · ${labelDeliveryStatus(highlightDelivery.status)}`) : ''}
            </div>

            <details class="detail-accordion" open>
                <summary>Verifiable Credentials (Walt.id Verifier)</summary>
                ${renderVcBlock(medicine.medicineVcClaims, 'Zdravilo (proizvajalec)', medicine.vcSigned, {
                    structuralOnly: medicine.vcStructuralOnly,
                    message: medicine.vcVerificationMessage
                })}
                ${(medicine.deliveries || []).filter((d) => d.transportVcClaims || d.transportVcSigned).map((d) =>
                    renderVcBlock(
                        d.transportVcClaims,
                        `Pošiljka ${labelDeliveryStatus(d.status)}`,
                        d.transportVcVerified,
                        { message: d.transportVcMessage, structuralOnly: d.transportVcStructuralOnly }
                    )
                ).join('')}
            </details>

            <details class="detail-accordion">
                <summary>Pošiljke (${(medicine.deliveries || []).length}) — indeks + verifikacija</summary>
                ${deliveriesHtml}
            </details>

            <details class="detail-accordion" open>
                <summary>Pot dobave (blockchain) ${sourceBadge('blockchain', 'Sepolia')}</summary>
                ${historyHtml}
            </details>

            <details class="detail-accordion">
                <summary>IPFS & Blockchain</summary>
                <div class="detail-split">
                    <div><h5>IPFS</h5>${ipfsBlock}</div>
                    <div><h5>Blockchain</h5>${chainBlock}</div>
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
