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
