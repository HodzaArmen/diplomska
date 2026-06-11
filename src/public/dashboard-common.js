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
    if (!validateResponse.ok || !(await validateResponse.json()).valid) {
        sessionStorage.clear();
        window.location.href = '/';
        return null;
    }
    let user = JSON.parse(userJson);
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
    walletBtn.onclick = () => navigator.clipboard?.writeText(user.walletAddress).catch(() => {});
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
