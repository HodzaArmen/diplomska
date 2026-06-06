/**
 * shared-utils.js
 * Date formatting and IPFS gateway links for dashboards
 */

function formatDisplayDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        const str = String(value);
        return str.includes('T') ? str.slice(0, 10) : str;
    }
    return date.toLocaleDateString('sl-SI', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
}

function formatDisplayDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('sl-SI', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
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

function renderBlockchainExplorerHtml(medicine) {
    const ex = medicine.blockchainExplorer;
    const onChain = medicine.onChain;
    if (!ex?.tx && !ex?.contract && !onChain?.available) {
        return '<p class="text-muted">Ni blockchain zapisa</p>';
    }

    let html = '';
    if (ex?.tx) {
        html += `<p><strong>TX (Sepolia):</strong> <a href="${ex.tx}" target="_blank" rel="noopener">Etherscan ↗</a> <code>${medicine.txHash || ''}</code></p>`;
    }
    if (ex?.contract) {
        html += `<p><strong>Pogodba:</strong> <a href="${ex.contract}" target="_blank" rel="noopener">SupplyChain na Etherscan</a></p>`;
    }
    if (onChain?.available && onChain.medicine) {
        const m = onChain.medicine;
        html += `<p><strong>Na verigi:</strong> status <em>${m.status || '—'}</em>, IPFS <code>${m.ipfsHash || '—'}</code></p>`;
        if (ex.manufacturer || onChain.explorer?.manufacturer) {
            const manUrl = ex.manufacturer || onChain.explorer?.manufacturer;
            html += `<p><strong>Proizvajalec (naslov):</strong> <a href="${manUrl}" target="_blank" rel="noopener">${m.manufacturer}</a></p>`;
        }
        if (onChain.history?.length) {
            html += `<p><strong>Zgodovina na verigi:</strong> ${onChain.history.length} dogodkov</p>`;
        }
    } else if (onChain?.error) {
        html += `<p class="text-muted">Branje s pogodbe: ${onChain.error}</p>`;
    }
    return html || '<p class="text-muted">Ni blockchain podatkov</p>';
}

function renderIpfsLinksHtml(ipfsHash) {
    const links = getIpfsGatewayLinks(ipfsHash);
    if (!links) {
        return '<p class="text-muted">IPFS hash ni na voljo</p>';
    }
    return `
        <p><strong>CID:</strong> <code>${links.hash}</code></p>
        <p>
            <a href="${links.ipfsIo}" target="_blank" rel="noopener">🌐 ipfs.io</a>
            &nbsp;|&nbsp;
            <a href="${links.pinata}" target="_blank" rel="noopener">📌 Pinata gateway</a>
        </p>
    `;
}
