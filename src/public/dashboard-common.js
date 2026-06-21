/**
 * dashboard-common.js — skupna logika dashboardov
 */

async function ensureDashboardSession(requiredRole) {
    const sessionId = sessionStorage.getItem('sessionId');
    const userJson = sessionStorage.getItem('user');
    if (!sessionId || !userJson) {
        window.location.href = '/';
        return null;
    }
    const validateResponse = await fetch(`/api/auth/validate-session?sessionId=${encodeURIComponent(sessionId)}`);
    const validation = validateResponse.ok ? await validateResponse.json() : { valid: false };
    if (!validation.valid) {
        sessionStorage.clear();
        window.location.href = '/';
        return null;
    }
    if (!validation.readyForDashboard) {
        sessionStorage.clear();
        window.location.href = '/?auth=pending-onchain';
        return null;
    }
    let user = validation.user || JSON.parse(userJson);
    const userInfoResponse = await fetch(`/api/auth/user-info?sessionId=${encodeURIComponent(sessionId)}`);
    if (userInfoResponse.ok) {
        const userInfo = await userInfoResponse.json();
        if (userInfo.user) {
            user = userInfo.user;
            sessionStorage.setItem('user', JSON.stringify(user));
        }
    }
    if (requiredRole && user.role !== requiredRole) {
        alert('Dostop zavrnjen za to vlogo.');
        window.location.href = '/';
        return null;
    }
    return { sessionId, user };
}

function setupDashboardNav(user, roleEmoji) {
    const title = document.querySelector('.navbar-title');
    if (title) title.textContent = `${roleEmoji} ${user.companyName || user.role}`;
    const walletBtn = document.getElementById('wallet-status');
    if (!walletBtn) return;
    const short = `${user.walletAddress.slice(0, 6)}…${user.walletAddress.slice(-4)}`;
    const email = user.waltEmail || user.email || '';
    walletBtn.innerHTML = `${email} · <strong>${short}</strong>`;
    walletBtn.title = 'Klik za kopiranje naslova';
    walletBtn.onclick = () => ProfilePanel?.openProfilePanel?.(sessionStorage.getItem('sessionId'));
    walletBtn.title = 'Klik za profil';
}

function setupDashboardLogout(sessionId) {
    const btn = document.getElementById('btn-back-home');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        try {
            if (sessionId) {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId })
                });
            }
            await disconnectMetaMask?.();
        } finally {
            sessionStorage.clear();
            window.location.href = '/';
        }
    });
}

async function openMedicinePreview(medicineId, sessionId, optsOrDeliveryId = null) {
    const opts = typeof optsOrDeliveryId === 'string'
        ? { deliveryId: optsOrDeliveryId }
        : (optsOrDeliveryId || {});
    const panel = document.getElementById('medicine-detail-panel');
    if (panel) {
        panel.style.display = 'block';
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return loadMedicineDetails(medicineId, sessionId, 'medicine-detail-panel', opts);
}

async function tryEnsureOnChainUser(sessionId, user) {
    if (!window.BlockchainMetaMask || !user?.did || !user?.role) return;
    try {
        await BlockchainMetaMask.ensureOnChainUser(sessionId, user.did, user.role);
    } catch (error) {
        console.warn('On-chain registracija:', error.message);
    }
}

function closeMedicineDetailPanel() {
    const panel = document.getElementById('medicine-detail-panel');
    if (panel) {
        panel.style.display = 'none';
        panel.innerHTML = '';
    }
}

const JAZMP_APPROVAL_ROLES = ['manufacturer', 'distributor', 'pharmacy'];

function userNeedsJazmpApproval(user) {
    return JAZMP_APPROVAL_ROLES.includes(user?.role);
}

function isUserJazmpApproved(user) {
    if (!user) return false;
    if (user.role === 'regulator') return true;
    return Boolean(user.jazmpApproved);
}

/**
 * Prikaže opozorilo in onemogoči ustvarjanje/pošiljanje, dokler JAZMP ne potrdi računa.
 * @returns {boolean} true če je uporabnik odobren
 */
function setupJazmpApprovalGate(user, options = {}) {
    if (!userNeedsJazmpApproval(user) || isUserJazmpApproved(user)) {
        return true;
    }

    const main = document.querySelector('main.container, main.dashboard-layout');
    if (main && !document.getElementById('jazmp-pending-banner')) {
        const banner = document.createElement('div');
        banner.id = 'jazmp-pending-banner';
        banner.className = 'jazmp-pending-banner';
        banner.innerHTML = `
            <strong>Čakanje na potrditev JAZMP</strong>
            <p>Vaš račun še ni odobren. Ustvarjanje zdravil in pošiljanje pošiljk sta onemogočena, dokler regulator (JAZMP) ne potrdi vaše registracije.</p>
        `;
        main.insertBefore(banner, main.firstChild);
    }

    const selectors = options.disableSelectors || [
        '#btn-create-medicine',
        '#btn-send-delivery',
        '#btn-send-forward',
        '#create-medicine-section input',
        '#create-medicine-section select',
        '#create-medicine-section textarea',
        '#send-delivery-section input',
        '#send-delivery-section select',
        '#forward-send-section input',
        '#forward-send-section select'
    ];

    selectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
            if ('disabled' in el) el.disabled = true;
        });
    });

    if (options.lockCreateSection !== false) {
        const createCard = document.getElementById('create-medicine-section')
            || document.querySelector('section.dashboard-card:has(#btn-create-medicine)');
        if (createCard && !createCard.classList.contains('jazmp-locked')) {
            createCard.classList.add('jazmp-locked');
        }
    }

    return false;
}
