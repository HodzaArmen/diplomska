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
    const total = m.quantity ?? 0;
    const available = m.available_quantity ?? total;
    const pending = m.pending_quantity ?? 0;
    const atDist = m.at_distributor_quantity ?? 0;
    const parts = [];
    if (available > 0) parts.push(`${available} na zalogi`);
    if (pending > 0) parts.push(`${pending} čaka pri distributorju`);
    if (atDist > 0) parts.push(`${atDist} pri distributorju`);
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
