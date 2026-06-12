/**
 * medicine-detail.js — pregled zdravila (vir: blockchain + Verifier API + IPFS)
 */

const ROLE_LABELS = {
    manufacturer: 'proizvajalec',
    distributor: 'distributer',
    pharmacy: 'lekarna'
};

function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function labelRole(role) {
    return ROLE_LABELS[role] || role || '—';
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

function journeyStepIcon(eventType) {
    const icons = {
        MANUFACTURED: '🏭',
        manufactured: '🏭',
        SENT_TO_DISTRIBUTOR: '📤',
        RECEIVED_BY_DISTRIBUTOR: '📥',
        FORWARDED_TO_PHARMACY: '🚚',
        RECEIVED_AT_PHARMACY: '✅'
    };
    return icons[eventType] || '🔗';
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
            ${detailRow('Pošiljatelj', claims.senderName ? `${claims.senderName} (${labelRole(claims.senderRole)})` : claims.creatorName)}
            ${detailRow('Prejemnik', claims.recipientName ? `${claims.recipientName} (${labelRole(claims.recipientRole)})` : null)}
            ${detailRow('Količina', claims.quantity != null ? `${claims.quantity} enot` : null)}
            ${detailRow('Serija', claims.batchNumber)}
            ${detailRow('DID izdajatelja', claims.senderDID || claims.creatorDID || claims.manufacturerDID)}
        </div>
    </div>`;
}

function renderAssistantMarkdown(text) {
    if (!text) return '';
    return escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code class="code-break">$1</code>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>')
        .replace(/^/, '<p>')
        .replace(/$/, '</p>');
}

function renderVcAssistantSections(sections) {
    if (!sections?.length) return '<p class="text-muted">Ni razlage.</p>';
    return sections.map((s) => {
        const statusCls = {
            veljavno: 'vc-assistant-section--ok',
            opozorilo: 'vc-assistant-section--warn',
            manjka: 'vc-assistant-section--err',
            info: 'vc-assistant-section--info'
        }[s.status] || 'vc-assistant-section--info';
        return `<article class="vc-assistant-section ${statusCls}">
            <h5>${escapeHtml(s.title)}</h5>
            <div class="vc-assistant-body">${renderAssistantMarkdown(s.text)}</div>
        </article>`;
    }).join('');
}

async function loadVcAssistant(medicineId, sessionId, containerEl, opts = {}) {
    if (!containerEl) return;
    containerEl.style.display = 'block';
    containerEl.innerHTML = '<p class="text-muted">Analiziram VC…</p>';

    let url = `/api/medicines/${encodeURIComponent(medicineId)}/vc-assistant?sessionId=${encodeURIComponent(sessionId)}`;
    if (opts.deliveryId) url += `&deliveryId=${encodeURIComponent(opts.deliveryId)}`;
    if (opts.enhanceAi) url += '&enhance=true';

    try {
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Napaka');

        const exp = data.explanation;
        let html = `<div class="vc-assistant-header">
            <span class="badge badge-info">${escapeHtml(exp.mode)}</span>
            ${data.openAiConfigured ? '<span class="badge badge-neutral">OpenAI na voljo</span>' : ''}
        </div>`;
        html += renderVcAssistantSections(exp.sections);

        if (data.ai?.enhanced && data.ai.aiSummary) {
            html += `<article class="vc-assistant-section vc-assistant-section--ai">
                <h5>🤖 AI povzetek (${escapeHtml(data.ai.model || 'OpenAI')})</h5>
                <div class="vc-assistant-body">${renderAssistantMarkdown(data.ai.aiSummary)}</div>
            </article>`;
        } else if (opts.enhanceAi && data.ai && !data.ai.enhanced) {
            html += `<p class="text-muted vc-assistant-ai-hint">${escapeHtml(data.ai.reason || 'AI ni na voljo')}</p>`;
        }

        containerEl.innerHTML = html;
    } catch (e) {
        containerEl.innerHTML = `<p class="error-message">${escapeHtml(e.message)}</p>`;
    }
}

function renderJourneyStepper(timeline, chainNetwork) {
    if (!timeline.length) {
        return `<div class="detail-chain-card detail-chain-empty">
            <p class="text-muted">Na blockchainu še ni handoff dogodkov za to zdravilo.</p>
            <p class="text-muted">Po registraciji in pošiljanju bodo koraki prikazani tukaj.</p>
        </div>`;
    }

    const steps = timeline.map((h, idx) => {
        const qty = h.quantity ? `<span class="journey-qty">${h.quantity} en</span>` : '';
        const parties = [h.actorLabel, h.counterpartyLabel].filter(Boolean).join(' → ');
        const isLast = idx === timeline.length - 1;
        return `<li class="journey-step${isLast ? ' journey-step--last' : ''}">
            <div class="journey-marker" aria-hidden="true">${journeyStepIcon(h.action)}</div>
            <div class="journey-body">
                <div class="journey-title-row">
                    <strong class="journey-title">${escapeHtml(h.actionLabel || h.action)}</strong>
                    ${sourceBadge('blockchain', chainNetwork)}
                </div>
                <p class="journey-parties">${qty}${qty && parties ? ' · ' : ''}${escapeHtml(parties)}</p>
                <p class="journey-time">${formatDisplayDateTime(h.timestamp)}</p>
                ${h.vcRef ? `<p class="journey-vcref">VC ref (SHA-256): <code class="code-break">${escapeHtml(h.vcRef.slice(0, 16))}…</code></p>` : ''}
                ${h.deliveryId ? `<p class="journey-delivery-id text-muted">Pošiljka: <code>${escapeHtml(h.deliveryId.slice(-12))}</code></p>` : ''}
            </div>
        </li>`;
    }).join('');

    return `<div class="detail-chain-card">
        <p class="detail-chain-lead">Koraki dobavne verige — <strong>vir: blockchain</strong> (ne baza podatkov)</p>
        <ol class="journey-stepper">${steps}</ol>
    </div>`;
}

function displayMedicineDetailPanel(containerId, medicine, opts = {}) {
    const el = document.getElementById(containerId);
    if (!el || !medicine) return;
    el.style.display = 'block';

    const total = medicine.totalManufacturedQuantity ?? medicine.quantity;
    const recv = medicine.receivedQuantity ?? medicine.quantity;
    const stockText = medicine.stockStatusLabel || (recv !== total ? `${recv} / ${total} enot` : `${recv} enot`);

    let deliveries = medicine.deliveries || [];
    let timeline = medicine.supplyChainHistory || [];
    if (opts.deliveryId) {
        deliveries = deliveries.filter((d) => d.deliveryId === opts.deliveryId);
        timeline = timeline.filter((h) =>
            !h.deliveryId || h.deliveryId === opts.deliveryId || h.action === 'MANUFACTURED' || h.action === 'manufactured'
        );
    }

    const highlightDelivery = opts.deliveryId
        ? deliveries[0] || (medicine.deliveries || []).find((d) => d.deliveryId === opts.deliveryId)
        : null;

    const chainNetwork = medicine.dataSources?.chainNetwork || 'Blockchain';
    const ds = medicine.dataSources || {};
    const onChain = medicine.onChain?.medicine;
    const hasChain = Boolean(onChain?.medicineId || timeline.length > 0);
    const chainStatus = onChain?.status || medicine.blockchainStatus || '—';
    const vcOk = medicine.vcSigned;
    const ipfsOkBanner = Boolean(medicine.ipfsHash);

    let trustBanner;
    if (hasChain) {
        trustBanner = `<div class="detail-trust-banner detail-trust-banner--chain">
            <span class="detail-trust-icon">⛓</span>
            <div>
                <strong>Podatki s blockchaina (${escapeHtml(chainNetwork)})</strong>
                <p>Pot dobave, lastništvo in IPFS hash iz smart contract zapisa. PostgreSQL je le operativni indeks.</p>
            </div>
        </div>`;
    } else if (vcOk && ipfsOkBanner) {
        trustBanner = `<div class="detail-trust-banner detail-trust-banner--warn">
            <span class="detail-trust-icon">⚠</span>
            <div>
                <strong>VC in IPFS OK — blockchain še ni potrjen</strong>
                <p>Backend še ni zapisal <code>registerMedicine</code> na verigo (preverite deploy pogodbe ali ponovno ustvarite zdravilo). Dokler zapisa ni, distributer ne more sprejeti pošiljke.</p>
            </div>
        </div>`;
    } else {
        trustBanner = `<div class="detail-trust-banner detail-trust-banner--warn">
            <span class="detail-trust-icon">⚠</span>
            <div>
                <strong>Zdravilo še ni na verigi</strong>
                <p>Registracija na blockchainu poteka avtomatsko ob ustvarjanju zdravila. Preverite, ali je smart contract deployan.</p>
            </div>
        </div>`;
    }

    const deliveryFocus = highlightDelivery
        ? `<div class="detail-focus-box">
            <span class="detail-focus-label">Pregledujete pošiljko</span>
            <strong>${highlightDelivery.quantity} en</strong>
            <span>${labelDeliveryStatus(highlightDelivery.status)}</span>
            <span class="text-muted">${labelRole(highlightDelivery.sourceRole)} → ${labelRole(highlightDelivery.targetRole)}</span>
        </div>`
        : '';

    const deliveriesHtml = deliveries.length === 0
        ? '<p class="text-muted">Ni pošiljk v operativnem indeksu.</p>'
        : `<div class="detail-deliveries">${deliveries.map((d) => {
            const hl = d.deliveryId === opts.deliveryId ? ' delivery-highlight' : '';
            const vcTag = d.transportVcVerified ? ' · Verifier ✓' : (d.transportVcSigned ? ' · VC' : '');
            const chainTag = d.onChain ? ' · On-chain ✓' : '';
            return `<div class="delivery-chip${hl}">
                <strong>${labelDeliveryStatus(d.status)}</strong>
                ${d.quantity} en · ${escapeHtml(labelRole(d.sourceRole))} → ${escapeHtml(labelRole(d.targetRole))}
                ${vcTag}${chainTag}
                <span class="text-muted delivery-chip-note">Indeks (DB) — pot dobave je zgoraj na verigi</span>
            </div>`;
        }).join('')}</div>`;

    const ipfsOk = medicine.ipfsVerification?.accessible;
    const ipfsBlock = medicine.ipfsHash
        ? `${renderIpfsLinksHtml(medicine.ipfsHash)}
           <p>${ipfsOk ? sourceBadge('ipfs-gateway', 'IPFS dostopen') : sourceBadge('none', 'IPFS ni dostopen')}</p>
           ${medicine.ipfsHashOnChain ? `<p class="text-muted">${sourceBadge('ipfs-via-blockchain', 'Hash potrjen na verigi')}</p>` : ''}`
        : '<p class="text-muted">Ni IPFS zapisa na verigi.</p>';

    const chainBlock = onChain
        ? `<div class="detail-chain-state">
            ${detailRow('Status na verigi', `<span class="chain-status-pill">${escapeHtml(chainStatus)}</span>`)}
            ${detailRow('Trenutni lastnik', medicine.onChain.currentHolderLabel || onChain.currentHolder)}
            ${detailRow('DID lastnika', onChain.currentHolderDID)}
            ${renderBlockchainExplorerHtml(medicine)}
           </div>`
        : '<p class="text-muted">Zdravilo ni na blockchainu.</p>';

    el.innerHTML = `
        <div class="medicine-detail-panel dashboard-card">
            <div class="detail-header">
                <div>
                    <h3>${escapeHtml(medicine.name)}</h3>
                    <p class="text-muted">Serija ${escapeHtml(medicine.batchNumber)} · ${stockText}</p>
                    ${hasChain ? `<p class="detail-chain-status">${sourceBadge('blockchain', chainNetwork)} ${escapeHtml(chainStatus)}</p>` : ''}
                </div>
                <button type="button" class="btn btn-ghost btn-close-detail" aria-label="Zapri">✕</button>
            </div>

            ${trustBanner}
            ${deliveryFocus}

            <section class="detail-section vc-assistant-wrap">
                <div class="vc-assistant-toolbar">
                    <h4 class="detail-section-title">AI asistent — razlaga VC</h4>
                    <div class="vc-assistant-actions">
                        <button type="button" class="btn btn-secondary btn-sm btn-vc-assistant">Razloži VC</button>
                        <button type="button" class="btn btn-ghost btn-sm btn-vc-assistant-ai" title="Zahteva OPENAI_API_KEY">+ AI povzetek</button>
                    </div>
                </div>
                <p class="text-muted vc-assistant-lead">Pregled Verifiable Credentials v kontekstu tega zdravila, verige in vaše vloge.</p>
                <div class="vc-assistant-output" style="display:none;" aria-live="polite"></div>
            </section>

            <section class="detail-section detail-section--primary">
                <h4 class="detail-section-title">Pot dobave</h4>
                ${renderJourneyStepper(timeline, chainNetwork)}
            </section>

            <div class="detail-cards-row">
                <section class="detail-section detail-section--chain">
                    <h4 class="detail-section-title">Stanje na verigi ${sourceBadge('blockchain', chainNetwork)}</h4>
                    ${chainBlock}
                </section>
                <section class="detail-section">
                    <h4 class="detail-section-title">IPFS ${medicine.ipfsHashOnChain ? sourceBadge('ipfs-via-blockchain', 'z verige') : ''}</h4>
                    ${ipfsBlock}
                </section>
            </div>

            <div class="detail-summary detail-summary--compact">
                ${detailRow('ID zdravila', `<code class="code-break">${escapeHtml(medicine.medicineId)}</code>`)}
                ${detailRow('Proizvajalec', medicine.manufacturerName)}
                ${detailRow('Rok uporabe', formatDisplayDate(medicine.expiryDate))}
            </div>

            <details class="detail-accordion">
                <summary>Verifiable Credentials — Walt.id Verifier</summary>
                <p class="text-muted detail-accordion-hint">Kriptografsko preverjanje podpisov (OID4VP). Dopolnjuje blockchain zapis.</p>
                ${renderVcBlock(medicine.medicineVcClaims, 'VC zdravila (proizvajalec)', medicine.vcSigned, {
                    structuralOnly: medicine.vcStructuralOnly,
                    message: medicine.vcVerificationMessage
                })}
                ${deliveries.filter((d) => d.transportVcClaims || d.transportVcSigned).map((d) =>
                    renderVcBlock(
                        d.transportVcClaims,
                        `VC pošiljke — ${labelDeliveryStatus(d.status)}`,
                        d.transportVcVerified,
                        { message: d.transportVcMessage, structuralOnly: d.transportVcStructuralOnly }
                    )
                ).join('')}
            </details>

            <details class="detail-accordion">
                <summary>Operativni indeks pošiljk (${deliveries.length}) ${sourceBadge('postgres-inbox-only', 'PostgreSQL')}</summary>
                <p class="text-muted detail-accordion-hint">Samo za inbox / status v aplikaciji. Za dokazilo o poreklu uporabite pot dobave zgoraj.</p>
                ${deliveriesHtml}
            </details>

            ${opts.onVerify ? '<button type="button" class="btn btn-secondary btn-verify-detail">Preveri VC + blockchain</button>' : ''}
        </div>
    `;

    el.querySelector('.btn-close-detail')?.addEventListener('click', closeMedicineDetailPanel);
    el.querySelector('.btn-verify-detail')?.addEventListener('click', () => opts.onVerify(medicine.medicineId));

    const assistantOut = el.querySelector('.vc-assistant-output');
    const assistantOpts = { deliveryId: opts.deliveryId, sessionId: opts.sessionId };
    el.querySelector('.btn-vc-assistant')?.addEventListener('click', () => {
        loadVcAssistant(medicine.medicineId, opts.sessionId, assistantOut, assistantOpts);
    });
    el.querySelector('.btn-vc-assistant-ai')?.addEventListener('click', () => {
        loadVcAssistant(medicine.medicineId, opts.sessionId, assistantOut, { ...assistantOpts, enhanceAi: true });
    });
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
    displayMedicineDetailPanel(containerId, data.medicine, { ...opts, sessionId });
    return data.medicine;
}
