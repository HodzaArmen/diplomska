/**
 * trace.js — javni pregled porekla zdravila (brez MetaMask / prijave)
 */

const TRUST_LABELS = { high: 'Visoka zanesljivost', mid: 'Delno preverjeno', low: 'Nezanesljivo' };

document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const medicineId = params.get('medicineId') || '';
    const batch = params.get('batch') || '';

    if (medicineId) {
        document.getElementById('trace-medicine-id').value = medicineId;
        if (batch) document.getElementById('trace-batch').value = batch;
        loadPublicTrace(medicineId, batch);
    }

    document.getElementById('trace-search-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const id = document.getElementById('trace-medicine-id').value.trim();
        const b = document.getElementById('trace-batch').value.trim();
        const url = new URL(window.location.href);
        url.searchParams.set('medicineId', id);
        if (b) url.searchParams.set('batch', b);
        else url.searchParams.delete('batch');
        window.history.replaceState({}, '', url);
        loadPublicTrace(id, b);
    });
});

async function loadPublicTrace(medicineId, batch) {
    const resultEl = document.getElementById('trace-result');
    const errorEl = document.getElementById('trace-error');
    resultEl.hidden = true;
    errorEl.style.display = 'none';
    resultEl.innerHTML = '<p class="text-muted">Preverjam…</p>';
    resultEl.hidden = false;

    try {
        const qs = new URLSearchParams({ medicineId });
        if (batch) qs.set('batch', batch);
        const res = await fetch(`/api/public/medicine-trace?${qs}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Napaka pri preverjanju');

        renderPublicTrace(data.trace);
    } catch (error) {
        resultEl.hidden = true;
        errorEl.textContent = error.message;
        errorEl.style.display = 'block';
    }
}

function renderPublicTrace(trace) {
    const resultEl = document.getElementById('trace-result');
    const trust = TRUST_LABELS[trace.trustLevel] || trace.trustLevel || '—';
    const checks = [
        trace.chainVerified ? '✓ Pot na verigi' : '✗ Pot na verigi',
        trace.ipfsVerified ? '✓ Metapodatki (IPFS)' : '✗ Metapodatki',
        trace.vcVerified ? '✓ Digitalno potrdilo' : '✗ Digitalno potrdilo'
    ].join(' · ');

    const stepsHtml = (trace.steps || []).map((s) => `
        <li class="trace-step">
            <span class="trace-step-num">${s.step}</span>
            <div>
                <strong>${escapeHtml(s.actionLabel)}</strong>
                <p>${escapeHtml(s.summary)}</p>
                <span class="text-muted">${formatDisplayDateTime(s.timestamp)}</span>
            </div>
        </li>
    `).join('');

    resultEl.innerHTML = `
        <article class="trace-card trace-card--${trace.trustLevel || 'low'}">
            <header class="trace-card-head">
                <h2>${escapeHtml(trace.name)}</h2>
                <p class="trace-meta">Serija <strong>${escapeHtml(trace.batchNumber || '—')}</strong>
                    · Proizvajalec: <strong>${escapeHtml(trace.manufacturerName || '—')}</strong></p>
                ${trace.journeySummary ? `<p class="journey-path-summary">${escapeHtml(trace.journeySummary)}</p>` : ''}
            </header>
            <div class="trace-trust-row">
                <span class="trace-trust-badge trace-trust-badge--${trace.trustLevel || 'low'}">${escapeHtml(trust)}</span>
                <span class="text-muted">${checks}</span>
            </div>
            <ol class="trace-steps">${stepsHtml || '<li class="text-muted">Pot še ni zabeležena na verigi.</li>'}</ol>
        </article>`;
    resultEl.hidden = false;
}

function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}
