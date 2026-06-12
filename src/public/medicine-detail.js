/**
 * medicine-detail.js — pregled zdravila (zavihki: Pregled | Pot | Potrdila | Razlaga)
 */

const ROLE_LABELS = {
    manufacturer: 'proizvajalec',
    distributor: 'distributer',
    pharmacy: 'lekarna'
};

const TRUST_LAYER_HELP = {
    vc: 'Podpisano digitalno potrdilo o izvoru zdravila (Walt.id issuer).',
    ipfs: 'Nespremenljivi metapodatki na decentralizirani shrambi (CID).',
    chain: 'Zapis na pametni pogodbi — kdo je kdaj imel zdravilo.',
    hash: 'IPFS identifikator se ujema s tistim na blockchainu.'
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

function truncateDid(did) {
    if (!did || did.length < 48) return did || '—';
    return `${did.slice(0, 18)}…${did.slice(-10)}`;
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

function dedupeTimeline(timeline) {
    const seen = new Set();
    return timeline.filter((h) => {
        const key = `${h.action}|${h.deliveryId || ''}|${h.quantity || ''}|${h.timestamp || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function buildTrustChecks(medicine) {
    return [
        { id: 'vc', ok: medicine.vcSigned, label: 'VC podpis', help: TRUST_LAYER_HELP.vc },
        { id: 'ipfs', ok: Boolean(medicine.ipfsHash && medicine.ipfsVerification?.accessible), label: 'IPFS', help: TRUST_LAYER_HELP.ipfs },
        { id: 'chain', ok: Boolean(medicine.onChain?.medicine?.medicineId), label: 'Veriga', help: TRUST_LAYER_HELP.chain },
        { id: 'hash', ok: medicine.ipfsHashOnChain, label: 'Hash ✓', help: TRUST_LAYER_HELP.hash }
    ];
}

function renderTrustStrip(medicine) {
    const checks = buildTrustChecks(medicine);
    const passed = checks.filter((c) => c.ok).length;
    const level = passed === 4 ? 'high' : passed >= 2 ? 'mid' : 'low';
    const levelLabel = passed === 4 ? 'Zanesljivo' : passed >= 2 ? 'Delno preverjeno' : 'Nezanesljivo';

    return `<div class="detail-trust-strip detail-trust-strip--${level}">
        <div class="detail-trust-strip-head">
            <strong>${levelLabel}</strong>
            <span class="text-muted">${passed}/4 plasti</span>
        </div>
        <div class="detail-trust-layers">
            ${checks.map((c) => `
                <div class="detail-trust-layer${c.ok ? ' detail-trust-layer--ok' : ''}" title="${escapeHtml(c.help)}">
                    <span class="detail-trust-layer-icon">${c.ok ? '✓' : '✗'}</span>
                    <span class="detail-trust-layer-label">${escapeHtml(c.label)}</span>
                </div>
            `).join('')}
        </div>
    </div>`;
}

function renderHumanOverview(medicine, highlightDelivery, chainNetwork) {
    const onChain = medicine.onChain?.medicine;
    const owner = medicine.onChain?.currentHolderLabel || onChain?.currentHolder || '—';
    const status = onChain?.status || medicine.blockchainStatus || '—';

    let lead = `Zdravilo <strong>${escapeHtml(medicine.name)}</strong> (serija ${escapeHtml(medicine.batchNumber)}) je proizvedlo <strong>${escapeHtml(medicine.manufacturerName || '—')}</strong>.`;

    if (highlightDelivery) {
        lead += ` Pregledujete pošiljko <strong>${highlightDelivery.quantity} en</strong> (${labelDeliveryStatus(highlightDelivery.status)}): ${labelRole(highlightDelivery.sourceRole)} → ${labelRole(highlightDelivery.targetRole)}.`;
    } else if (onChain?.medicineId) {
        lead += ` Trenutni lastnik na verigi (${escapeHtml(chainNetwork)}): <strong>${escapeHtml(owner)}</strong>, status <strong>${escapeHtml(status)}</strong>.`;
    }

    return `<p class="detail-overview-lead">${lead}</p>
        <p class="detail-overview-note text-muted">Spodnji zavihki razdelijo podatke: <em>Pregled</em> (kaj vidite), <em>Pot dobave</em> (kronologija na verigi), <em>Potrdila</em> (VC podpisi), <em>Razlaga</em> (AI pomoč).</p>`;
}

function renderVcBlock(claims, title, verified, opts = {}) {
    const status = verified
        ? '<span class="vc-card-status vc-card-status--ok">Preverjeno</span>'
        : '<span class="vc-card-status vc-card-status--warn">Ni preverjeno</span>';

    if (!claims) {
        return `<article class="vc-card vc-card--empty">
            <header class="vc-card-head"><h5>${escapeHtml(title)}</h5>${status}</header>
            <p class="text-muted">Potrdilo ni na voljo.</p>
        </article>`;
    }

    const did = claims.senderDID || claims.creatorDID || claims.manufacturerDID;

    return `<article class="vc-card">
        <header class="vc-card-head">
            <div>
                <h5>${escapeHtml(title)}</h5>
                <p class="vc-card-desc text-muted">Kdo je podpisal premik / izvor in kdaj.</p>
            </div>
            ${status}
        </header>
        <dl class="vc-card-dl">
            <div><dt>Dogodek</dt><dd>${escapeHtml(claims.eventType || '—')}</dd></div>
            <div><dt>Čas</dt><dd>${claims.eventTimestamp ? formatDisplayDateTime(claims.eventTimestamp) : '—'}</dd></div>
            <div><dt>Pošiljatelj</dt><dd>${escapeHtml(claims.senderName || claims.creatorName || '—')}${claims.senderRole || claims.creatorRole ? ` (${labelRole(claims.senderRole || claims.creatorRole)})` : ''}</dd></div>
            ${claims.recipientName ? `<div><dt>Prejemnik</dt><dd>${escapeHtml(claims.recipientName)} (${labelRole(claims.recipientRole)})</dd></div>` : ''}
            ${claims.quantity != null ? `<div><dt>Količina</dt><dd>${claims.quantity} enot</dd></div>` : ''}
            ${claims.batchNumber ? `<div><dt>Serija</dt><dd>${escapeHtml(claims.batchNumber)}</dd></div>` : ''}
            ${did ? `<div><dt>DID</dt><dd><code class="code-break" title="${escapeHtml(did)}">${escapeHtml(truncateDid(did))}</code></dd></div>` : ''}
        </dl>
        ${verified ? '<p class="vc-card-foot text-muted">Walt.id Verifier je potrdil kriptografski podpis (OID4VP).</p>' : ''}
    </article>`;
}

function renderAssistantMarkdown(text) {
    if (!text) return '';
    return escapeHtml(text)
        .replace(/^## (.+)$/gm, '</p><h6 class="ai-md-h">$1</h6><p>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code class="code-break">$1</code>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>')
        .replace(/^/, '<p>')
        .replace(/$/, '</p>');
}

function renderVcAssistantSections(sections, compact = false) {
    if (!sections?.length) return '<p class="text-muted">Ni razlage.</p>';
    const filtered = compact
        ? sections.filter((s) =>
            s.title === 'Povzetek'
            || s.title === 'Skupna ocena zaupanja'
            || s.title.startsWith('Priporočilo za'))
        : sections;
    return filtered.map((s) => {
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
    containerEl.hidden = false;
    containerEl.innerHTML = `<p class="detail-loading">${opts.enhanceAi ? 'AI pripravlja razlago…' : 'Pripravljam povzetek…'}</p>`;

    let url = `/api/medicines/${encodeURIComponent(medicineId)}/vc-assistant?sessionId=${encodeURIComponent(sessionId)}`;
    if (opts.deliveryId) url += `&deliveryId=${encodeURIComponent(opts.deliveryId)}`;
    if (opts.enhanceAi) url += '&enhance=true';

    try {
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Napaka');

        const exp = data.explanation;
        let html = '';

        if (data.ai?.enhanced && data.ai.aiSummary) {
            html += `<div class="explain-ai-block">
                <p class="explain-ai-label">🤖 ${escapeHtml(data.ai.providerLabel || 'AI')} · ${escapeHtml(data.ai.model || '')}</p>
                <div class="vc-assistant-body explain-ai-text">${renderAssistantMarkdown(data.ai.aiSummary)}</div>
            </div>`;
        } else if (opts.enhanceAi) {
            const hint = data.ai?.reason || data.aiStatus?.hint || 'AI ni na voljo.';
            html += `<div class="vc-assistant-setup-hint"><p><strong>AI ni aktiven.</strong> ${escapeHtml(hint)}</p></div>`;
        }

        if (!opts.enhanceAi || !data.ai?.enhanced) {
            html += renderVcAssistantSections(exp.sections, true);
        }

        containerEl.innerHTML = html || '<p class="text-muted">Ni vsebine.</p>';
    } catch (e) {
        containerEl.innerHTML = `<p class="error-message">${escapeHtml(e.message)}</p>`;
    }
}

function renderJourneyStepper(timeline, chainNetwork, compact = false) {
    if (!timeline.length) {
        return `<div class="detail-chain-card detail-chain-empty">
            <p class="text-muted">Na verigi še ni zabeleženih premikov.</p>
        </div>`;
    }

    const steps = timeline.map((h, idx) => {
        const parties = [h.actorLabel, h.counterpartyLabel].filter(Boolean).join(' → ');
        const isLast = idx === timeline.length - 1;
        const tech = compact ? '' : `
            ${h.vcRef ? `<p class="journey-vcref">VC ref: <code>${escapeHtml(h.vcRef.slice(0, 12))}…</code></p>` : ''}
            ${h.deliveryId ? `<p class="journey-delivery-id text-muted">Pošiljka: …${escapeHtml(h.deliveryId.slice(-8))}</p>` : ''}`;

        return `<li class="journey-step${isLast ? ' journey-step--last' : ''}">
            <div class="journey-marker">${journeyStepIcon(h.action)}</div>
            <div class="journey-body">
                <strong class="journey-title">${escapeHtml(h.actionLabel || h.action)}</strong>
                <p class="journey-parties">${h.quantity ? `${h.quantity} en · ` : ''}${escapeHtml(parties)}</p>
                <p class="journey-time">${formatDisplayDateTime(h.timestamp)}</p>
                ${tech}
            </div>
        </li>`;
    }).join('');

    return `<p class="detail-tab-intro text-muted">Kronološki zapisi iz pametne pogodbe <strong>${escapeHtml(chainNetwork)}</strong> — uradna pot lastništva (ne PostgreSQL).</p>
        <ol class="journey-stepper">${steps}</ol>`;
}

function setupDetailTabs(panelEl) {
    const tabs = panelEl.querySelectorAll('.detail-tab');
    const panels = panelEl.querySelectorAll('.detail-tab-panel');

    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const id = tab.dataset.tab;
            tabs.forEach((t) => {
                t.classList.toggle('detail-tab--active', t.dataset.tab === id);
                t.setAttribute('aria-selected', t.dataset.tab === id ? 'true' : 'false');
            });
            panels.forEach((p) => {
                const active = p.dataset.panel === id;
                p.hidden = !active;
                p.classList.toggle('detail-tab-panel--active', active);
            });
        });
    });
}

function displayMedicineDetailPanel(containerId, medicine, opts = {}) {
    const el = document.getElementById(containerId);
    if (!el || !medicine) return;
    el.style.display = 'block';

    const total = medicine.totalManufacturedQuantity ?? medicine.quantity;
    const recv = medicine.receivedQuantity ?? medicine.quantity;
    const stockText = medicine.stockStatusLabel || (recv !== total ? `${recv} / ${total} enot` : `${recv} enot`);

    let deliveries = medicine.deliveries || [];
    let timeline = dedupeTimeline(medicine.supplyChainHistory || []);

    if (opts.deliveryId) {
        deliveries = deliveries.filter((d) => d.deliveryId === opts.deliveryId);
        timeline = dedupeTimeline(timeline.filter((h) =>
            !h.deliveryId || h.deliveryId === opts.deliveryId
            || h.action === 'MANUFACTURED' || h.action === 'manufactured'
        ));
    }

    const highlightDelivery = opts.deliveryId
        ? deliveries[0] || (medicine.deliveries || []).find((d) => d.deliveryId === opts.deliveryId)
        : null;

    const chainNetwork = medicine.dataSources?.chainNetwork || 'Blockchain';
    const onChain = medicine.onChain?.medicine;
    const chainStatus = onChain?.status || medicine.blockchainStatus || '—';
    const ipfsOk = medicine.ipfsVerification?.accessible;

    const overviewFacts = `
        <div class="detail-facts-grid">
            ${detailRow('Proizvajalec', escapeHtml(medicine.manufacturerName || '—'))}
            ${detailRow('Serija', escapeHtml(medicine.batchNumber))}
            ${detailRow('Rok uporabe', formatDisplayDate(medicine.expiryDate))}
            ${detailRow('Zaloga / količina', escapeHtml(stockText))}
            ${onChain ? detailRow('Lastnik (veriga)', escapeHtml(medicine.onChain?.currentHolderLabel || onChain.currentHolder || '—')) : ''}
            ${onChain ? detailRow('Status', `<span class="chain-status-pill">${escapeHtml(chainStatus)}</span>`) : ''}
        </div>`;

    const deliveriesHtml = deliveries.length === 0
        ? '<p class="text-muted">Ni pošiljk v aplikaciji.</p>'
        : deliveries.map((d) => `
            <div class="delivery-chip${d.deliveryId === opts.deliveryId ? ' delivery-highlight' : ''}">
                <strong>${labelDeliveryStatus(d.status)}</strong> · ${d.quantity} en
                <span class="text-muted">${labelRole(d.sourceRole)} → ${labelRole(d.targetRole)}</span>
            </div>`).join('');

    const ipfsBlock = medicine.ipfsHash
        ? `${renderIpfsLinksHtml(medicine.ipfsHash)}
           <p class="detail-tech-meta">${ipfsOk ? '✓ Dostopen' : '✗ Nedosegljiv'}${medicine.ipfsHashOnChain ? ' · hash na verigi' : ''}</p>`
        : '<p class="text-muted">Ni IPFS zapisa.</p>';

    el.innerHTML = `
        <div class="medicine-detail-panel dashboard-card">
            <header class="detail-header">
                <div>
                    <h3>${escapeHtml(medicine.name)}</h3>
                    <p class="detail-header-sub">Serija ${escapeHtml(medicine.batchNumber)} · ${escapeHtml(stockText)}</p>
                </div>
                <button type="button" class="btn btn-ghost btn-close-detail" aria-label="Zapri">✕</button>
            </header>

            ${renderTrustStrip(medicine)}

            <nav class="detail-tabs" role="tablist" aria-label="Pregled zdravila">
                <button type="button" class="detail-tab detail-tab--active" data-tab="overview" role="tab" aria-selected="true">Pregled</button>
                <button type="button" class="detail-tab" data-tab="journey" role="tab" aria-selected="false">Pot dobave</button>
                <button type="button" class="detail-tab" data-tab="credentials" role="tab" aria-selected="false">Potrdila (VC)</button>
                <button type="button" class="detail-tab" data-tab="explain" role="tab" aria-selected="false">Razlaga</button>
            </nav>

            <div class="detail-tab-panels">
                <section class="detail-tab-panel detail-tab-panel--active" data-panel="overview" role="tabpanel">
                    ${renderHumanOverview(medicine, highlightDelivery, chainNetwork)}
                    ${overviewFacts}
                    ${highlightDelivery ? `<div class="detail-focus-box">
                        <span class="detail-focus-label">Izbrana pošiljka</span>
                        <strong>${highlightDelivery.quantity} en</strong> · ${labelDeliveryStatus(highlightDelivery.status)}
                        <span class="text-muted">${labelRole(highlightDelivery.sourceRole)} → ${labelRole(highlightDelivery.targetRole)}</span>
                    </div>` : ''}
                    <details class="detail-accordion detail-accordion--tech">
                        <summary>Tehnični podatki (ID, IPFS, veriga)</summary>
                        <div class="detail-tech-block">
                            ${detailRow('ID zdravila', `<code class="code-break">${escapeHtml(medicine.medicineId)}</code>`)}
                            ${detailRow('IPFS', ipfsBlock)}
                            ${onChain && onChain.currentHolderDID ? detailRow('DID lastnika', `<code class="code-break" title="${escapeHtml(onChain.currentHolderDID)}">${escapeHtml(truncateDid(onChain.currentHolderDID))}</code>`) : ''}
                            ${renderBlockchainExplorerHtml(medicine)}
                        </div>
                    </details>
                    <details class="detail-accordion">
                        <summary>Pošiljke v aplikaciji (${deliveries.length})</summary>
                        <p class="detail-accordion-hint text-muted">Operativni indeks (PostgreSQL) — za dokazilo porekla uporabite zavihek Pot dobave.</p>
                        ${deliveriesHtml}
                    </details>
                </section>

                <section class="detail-tab-panel" data-panel="journey" role="tabpanel" hidden>
                    ${renderJourneyStepper(timeline, chainNetwork, true)}
                </section>

                <section class="detail-tab-panel" data-panel="credentials" role="tabpanel" hidden>
                    <p class="detail-tab-intro text-muted"><strong>Verifiable Credentials</strong> so podpisana digitalna potrdila. Proizvajalec izda potrdilo o zdravilu, ob vsakem premiku nastane transportno potrdilo.</p>
                    ${renderVcBlock(medicine.medicineVcClaims, 'Potrdilo o zdravilu (proizvajalec)', medicine.vcSigned)}
                    ${deliveries.filter((d) => d.transportVcClaims || d.transportVcSigned).map((d) =>
                        renderVcBlock(
                            d.transportVcClaims,
                            `Transportno potrdilo — ${labelDeliveryStatus(d.status)}`,
                            d.transportVcVerified
                        )
                    ).join('')}
                </section>

                <section class="detail-tab-panel" data-panel="explain" role="tabpanel" hidden>
                    <p class="detail-tab-intro text-muted">Pomoč pri razumevanju podatkov — najprej kratek povzetek, z <strong>AI razlago</strong> dobite naravni jezik (Groq).</p>
                    <div class="explain-actions">
                        <button type="button" class="btn btn-secondary btn-sm btn-vc-assistant">Kratek povzetek</button>
                        <button type="button" class="btn btn-primary btn-sm btn-vc-assistant-ai">🤖 AI razlaga</button>
                    </div>
                    <div class="vc-assistant-output" hidden aria-live="polite"></div>
                </section>
            </div>

            ${opts.onVerify ? '<footer class="detail-footer"><button type="button" class="btn btn-secondary btn-verify-detail">Preveri VC + blockchain</button></footer>' : ''}
        </div>
    `;

    setupDetailTabs(el.querySelector('.medicine-detail-panel'));

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
