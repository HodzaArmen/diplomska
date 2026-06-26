/**
 * shared-utils.js — datumi, IPFS, statusi, blockchain
 */

const DELIVERY_STATUS_LABELS = {
    PENDING: 'Čaka na prevzem',
    IN_TRANSIT: 'V dostavi',
    RECEIVED: 'Sprejeto',
    DELIVERED: 'Dostavljeno'
};

const MEDICINE_CHAIN_STATUS_LABELS = {
    MANUFACTURED: 'Registrirano',
    IN_TRANSIT: 'V dobavni verigi',
    DELIVERED: 'Dostavljeno v lekarno'
};

function formatDisplayDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        const str = String(value);
        return str.includes('T') ? str.slice(0, 10) : str;
    }
    return date.toLocaleDateString('sl-SI', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatDisplayDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('sl-SI', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
    });
}

function getIpfsGatewayLinks(ipfsHash) {
    if (!ipfsHash) return null;
    const hash = ipfsHash.replace(/^ipfs:\/\//, '');
    return {
        hash,
        ipfsIo: `https://ipfs.io/ipfs/${hash}`,
        pinata: `https://gateway.pinata.cloud/ipfs/${hash}`
    };
}

function labelDeliveryStatus(status) {
    return DELIVERY_STATUS_LABELS[status] || status || '—';
}

function labelMedicineChainStatus(status) {
    return MEDICINE_CHAIN_STATUS_LABELS[status] || status || '—';
}

/** Človeški opis zaloge proizvajalca */
function formatManufacturerStockStatus(m) {
    const available = m.available_quantity ?? 0;
    const pending = m.pending_quantity ?? 0;
    const atDist = m.at_distributor_quantity ?? 0;
    const inTransit = m.in_transit_to_pharmacy ?? 0;
    const delivered = m.delivered_to_pharmacy ?? 0;
    const pendingMeta = parseInt(m.pending_metamask_quantity ?? 0, 10);
    const parts = [];
    if (available > 0) parts.push(`${available} na zalogi`);
    if (pendingMeta > 0) parts.push(`${pendingMeta} čaka MetaMask`);
    if (pending > pendingMeta) parts.push(`${pending - pendingMeta} čaka prevzem`);
    else if (pending > 0 && pendingMeta === 0) parts.push(`${pending} čaka prevzem`);
    if (atDist > 0) parts.push(`${atDist} pri distributorju`);
    if (inTransit > 0) parts.push(`${inTransit} v dostavi v lekarno`);
    if (delivered > 0) parts.push(`${delivered} v lekarni`);
    if (parts.length === 0) return 'Vse poslano';
    return parts.join(' · ');
}

function renderStatusBadge(status, type = 'delivery') {
    const label = type === 'medicine' ? labelMedicineChainStatus(status) : labelDeliveryStatus(status);
    const cls = {
        PENDING: 'badge-warning',
        IN_TRANSIT: 'badge-info',
        RECEIVED: 'badge-success',
        DELIVERED: 'badge-success',
        MANUFACTURED: 'badge-neutral'
    }[status] || 'badge-neutral';
    return `<span class="badge ${cls}">${label}</span>`;
}

function renderBlockchainExplorerHtml(medicine) {
    const ex = medicine.blockchainExplorer;
    const onChain = medicine.onChain;
    if (!ex?.tx && !ex?.contract && !onChain?.available) {
        return '<p class="text-muted">Ni blockchain zapisa</p>';
    }
    let html = '';
    if (ex?.tx) {
        const tx = medicine.txHash || '';
        const shortTx = tx.length > 16 ? `${tx.slice(0, 10)}…${tx.slice(-6)}` : tx;
        html += `<p><a href="${ex.tx}" target="_blank" rel="noopener" class="link-external">Etherscan TX ↗</a> <code class="code-break">${shortTx}</code></p>`;
    }
    if (ex?.contract) {
        html += `<p><a href="${ex.contract}" target="_blank" rel="noopener" class="link-external">Pogodba ↗</a></p>`;
    }
    if (onChain?.available && onChain.medicine) {
        const om = onChain.medicine;
        html += `<p>Na verigi: <em>${om.status || '—'}</em></p>`;
        if (om.ipfsHash) html += `<p>IPFS: <code class="code-break">${om.ipfsHash}</code></p>`;
    }
    return html || '<p class="text-muted">Ni blockchain podatkov</p>';
}

function renderIpfsLinksHtml(ipfsHash) {
    const links = getIpfsGatewayLinks(ipfsHash);
    if (!links) return '<p class="text-muted">IPFS hash ni na voljo</p>';
    return `
        <p><code class="code-break">${links.hash}</code></p>
        <p class="link-row">
            <a href="${links.ipfsIo}" target="_blank" rel="noopener">ipfs.io ↗</a>
            <a href="${links.pinata}" target="_blank" rel="noopener">Pinata ↗</a>
        </p>
    `;
}

function formatVerificationAlert(verification) {
    if (!verification) return '';
    const lines = [];
    const med = verification.medicineVc;
    const tr = verification.transportVc;
    const ipfs = verification.ipfs;
    if (med) lines.push(med.verified ? `✓ VC zdravila: ${med.message}` : `⚠ VC zdravila: ${med.message}`);
    if (tr) lines.push(tr.verified ? `✓ VC pošiljke: ${tr.message}` : `⚠ VC pošiljke: ${tr.message}`);
    if (ipfs) lines.push(ipfs.accessible ? `✓ IPFS dostopen` : `⚠ IPFS: ${ipfs.message || ipfs.error || 'ni dostopen'}`);
    return lines.join('\n');
}

function formatCounterfeitError(data) {
    const lines = [data.error || 'Prevzem zavrnjen'];
    if (Array.isArray(data.reasons)) {
        data.reasons.forEach((r) => lines.push(`• ${r}`));
    }
    if (Array.isArray(data.nextSteps) && data.nextSteps.length > 0) {
        lines.push('', 'Kaj storiti:');
        data.nextSteps.forEach((s) => lines.push(`→ ${s}`));
    }
    return lines.join('\n');
}

function formatChainPendingError(data) {
    const lines = [data.error || 'Manjkajo potrditve na verigi'];
    if (Array.isArray(data.reasons)) {
        data.reasons.forEach((r) => {
            if (!String(r).startsWith('Potrdite')) lines.push(`• ${r}`);
        });
    }
    const steps = data.nextSteps
        || (Array.isArray(data.reasons) ? data.reasons.filter((r) => String(r).startsWith('Potrdite')) : []);
    if (steps.length > 0) {
        lines.push('', 'Kaj mora storiti proizvajalec / distributer:');
        steps.forEach((s) => lines.push(`→ ${s}`));
    }
    lines.push('', 'To ni ponaredek — pošiljka še ni popolnoma potrjena v MetaMask.');
    return lines.join('\n');
}
