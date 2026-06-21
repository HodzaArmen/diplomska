/**
 * profile-panel.js — urejanje profila, Walt.id in blockchain status
 */

let profileOverlayEl = null;

const ROLE_META = {
    manufacturer: { label: 'Proizvajalec', emoji: '🏭', color: 'profile-role--mfg' },
    distributor: { label: 'Distributer', emoji: '📦', color: 'profile-role--dist' },
    pharmacy: { label: 'Lekarna', emoji: '💊', color: 'profile-role--phr' },
    regulator: { label: 'JAZMP / Regulator', emoji: '🏛️', color: 'profile-role--reg' }
};

function chainCapabilityText(role) {
    if (role === 'manufacturer') {
        return 'Lahko registrirate zdravila in podpisujete pošiljke na verigi.';
    }
    if (role === 'distributor') {
        return 'Lahko prevzemate pošiljke in pošiljate zdravila v lekarne.';
    }
    if (role === 'pharmacy') {
        return 'Lahko prevzemate dostave v lekarni.';
    }
    if (role === 'regulator') {
        return 'Regulativni pregled — brez pošiljanja ali prevzema zdravil.';
    }
    return 'Račun je registriran na pametni pogodbi.';
}

function roleMeta(role) {
    return ROLE_META[role] || { label: role || '—', emoji: '👤', color: 'profile-role--default' };
}

function shortWallet(addr) {
    if (!addr || addr.length < 12) return addr || '—';
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtDate(iso) {
    if (!iso) return null;
    try {
        return new Date(iso).toLocaleString('sl-SI', { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
        return null;
    }
}

function showProfileToast(overlay, message, type = 'ok') {
    let toast = overlay.querySelector('.profile-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'profile-toast';
        overlay.querySelector('.profile-panel')?.appendChild(toast);
    }
    toast.className = `profile-toast profile-toast--${type}`;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showProfileToast._t);
    showProfileToast._t = setTimeout(() => { toast.hidden = true; }, 2200);
}

async function copyText(overlay, text, label) {
    try {
        await navigator.clipboard.writeText(text);
        showProfileToast(overlay, `${label} kopirano`, 'ok');
    } catch {
        prompt(`Kopiraj ${label}:`, text);
    }
}

function renderProfilePanel(data) {
    const p = data.profile;
    const onChain = data.onChainUser || {};
    const chain = data.blockchain || {};
    const meta = roleMeta(p.role);
    const memberSince = fmtDate(p.waltIdRegisteredAt || p.walletConnectedAt);
    const networkLabel = chain.network || 'Blockchain';
    const needsJazmp = ['manufacturer', 'distributor', 'pharmacy'].includes(p.role);
    const jazmpBlock = needsJazmp
        ? (p.jazmpApproved
            ? `<div class="profile-chain-card profile-chain-card--ok">
                    <span class="profile-chain-icon">✓</span>
                    <div>
                        <strong>Potrditev JAZMP</strong>
                        <p class="text-muted">Račun je odobren${p.jazmpApprovedAt ? ` (${fmtDate(p.jazmpApprovedAt)})` : ''}.</p>
                    </div>
               </div>`
            : `<div class="profile-chain-card profile-chain-card--pending">
                    <span class="profile-chain-icon">!</span>
                    <div>
                        <strong>Čaka na potrditev JAZMP</strong>
                        <p class="text-muted">Ustvarjanje in pošiljanje sta onemogočena, dokler regulator ne potrdi vaše registracije.</p>
                    </div>
               </div>`)
        : '';

    const blockchainBlock = onChain.registered
        ? `<div class="profile-chain-card profile-chain-card--ok">
                <span class="profile-chain-icon">✓</span>
                <div>
                    <strong>Registriran na verigi (${networkLabel})</strong>
                    <p class="text-muted">${chainCapabilityText(p.role)}</p>
                </div>
           </div>`
        : `<div class="profile-chain-card profile-chain-card--pending">
                <span class="profile-chain-icon">!</span>
                <div>
                    <strong>Ni registriran na verigi</strong>
                    <p class="text-muted">Enkratna registracija na pametni pogodbi pred prvim pošiljanjem ali prevzemom.</p>
                    <button type="button" class="btn btn-secondary btn-sm btn-sync-chain">Registriraj na verigi</button>
                </div>
           </div>
           <p id="profile-chain-msg" class="profile-chain-msg"></p>`;

    return `
        <div class="profile-panel" role="dialog" aria-labelledby="profile-title">
            <header class="profile-hero">
                <div class="profile-hero-main">
                    <span class="profile-avatar" aria-hidden="true">${meta.emoji}</span>
                    <div>
                        <h3 id="profile-title">${p.companyName || 'Profil'}</h3>
                        <span class="profile-role-badge ${meta.color}">${meta.label}</span>
                    </div>
                </div>
                <button type="button" class="btn btn-ghost btn-close-profile profile-close" aria-label="Zapri">✕</button>
            </header>

            <section class="profile-card profile-card--edit">
                <h4 class="profile-card-title">Urejanje podatkov</h4>
                <div class="profile-form-grid">
                    <div class="profile-form-field">
                        <label class="profile-label" for="profile-company">Ime podjetja / ustanove</label>
                        <input type="text" class="form-control profile-input" id="profile-company" autocomplete="organization">
                    </div>
                    <div class="profile-form-field">
                        <label class="profile-label" for="profile-email">Kontaktni e-poštni naslov</label>
                        <input type="email" class="form-control profile-input" id="profile-email" autocomplete="email">
                    </div>
                </div>
                <p class="profile-hint">Wallet in vloga sta vezana na MetaMask in jih tukaj ne morete spremeniti.</p>
                <div class="profile-form-actions">
                    <button type="button" class="btn btn-primary btn-save-profile">Shrani spremembe</button>
                </div>
                <p id="profile-save-msg" class="profile-inline-msg profile-inline-msg--ok" hidden></p>
                <p id="profile-save-err" class="profile-inline-msg profile-inline-msg--err" hidden></p>
            </section>

            <section class="profile-card">
                <h4 class="profile-card-title">Identiteta</h4>
                <dl class="profile-dl">
                    <div class="profile-dl-row">
                        <dt>MetaMask wallet</dt>
                        <dd>
                            <button type="button" class="profile-chip btn-copy-wallet" title="Kopiraj celoten naslov">
                                <span class="profile-chip-label">${shortWallet(p.walletAddress)}</span>
                                <span class="profile-chip-action">Kopiraj</span>
                            </button>
                        </dd>
                    </div>
                    <div class="profile-dl-row">
                        <dt>DID (Walt.id)</dt>
                        <dd>
                            ${p.did
                                ? `<button type="button" class="profile-chip profile-chip--wide btn-copy-did" title="Kopiraj DID">
                                    <span class="profile-chip-label">${p.did.length > 42 ? p.did.slice(0, 20) + '…' + p.did.slice(-14) : p.did}</span>
                                    <span class="profile-chip-action">Kopiraj</span>
                                   </button>`
                                : '<span class="text-muted">Ni na voljo</span>'}
                        </dd>
                    </div>
                    <div class="profile-dl-row">
                        <dt>Walt.id prijava</dt>
                        <dd>${p.waltEmail || '—'}</dd>
                    </div>
                    ${memberSince ? `<div class="profile-dl-row"><dt>V sistemu od</dt><dd>${memberSince}</dd></div>` : ''}
                </dl>
            </section>

            ${needsJazmp ? `<section class="profile-card profile-card--jazmp">
                <h4 class="profile-card-title">JAZMP</h4>
                ${jazmpBlock}
            </section>` : ''}

            <section class="profile-card profile-card--chain">
                <h4 class="profile-card-title">Blockchain</h4>
                ${blockchainBlock}
            </section>

            <div class="profile-toast" hidden aria-live="polite"></div>
        </div>
    `;
}

async function fetchProfile(sessionId) {
    const res = await fetch(`/api/profile?sessionId=${encodeURIComponent(sessionId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Napaka pri nalaganju profila');
    return data;
}

function bindProfileEvents(sessionId, data) {
    const p = data.profile;
    const overlay = profileOverlayEl;
    if (!overlay) return;

    const companyInput = overlay.querySelector('#profile-company');
    const emailInput = overlay.querySelector('#profile-email');
    if (companyInput) companyInput.value = p.companyName || '';
    if (emailInput) emailInput.value = p.email || '';

    overlay.querySelector('.btn-close-profile')?.addEventListener('click', closeProfilePanel);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeProfilePanel();
    });

    overlay.querySelector('.btn-copy-wallet')?.addEventListener('click', () =>
        copyText(overlay, p.walletAddress, 'Wallet'));
    overlay.querySelector('.btn-copy-did')?.addEventListener('click', () => {
        if (p.did) copyText(overlay, p.did, 'DID');
    });

    overlay.querySelector('.btn-save-profile')?.addEventListener('click', async () => {
        const msg = overlay.querySelector('#profile-save-msg');
        const err = overlay.querySelector('#profile-save-err');
        msg.hidden = true;
        err.hidden = true;
        const btn = overlay.querySelector('.btn-save-profile');
        btn.disabled = true;
        btn.textContent = 'Shranjujem…';
        try {
            const res = await fetch('/api/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId,
                    companyName: companyInput?.value?.trim(),
                    email: emailInput?.value?.trim()
                })
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || 'Shranjevanje ni uspelo');

            const title = overlay.querySelector('#profile-title');
            if (title) title.textContent = body.user.companyName || title.textContent;

            msg.textContent = 'Spremembe shranjene.';
            msg.hidden = false;
            showProfileToast(overlay, 'Profil posodobljen', 'ok');

            const user = { ...JSON.parse(sessionStorage.getItem('user') || '{}'), ...body.user };
            sessionStorage.setItem('user', JSON.stringify(user));

            const emoji = document.body.dataset.roleEmoji || metaEmojiForRole(user.role);
            if (typeof displayUserProfile === 'function') {
                displayUserProfile();
            } else if (typeof setupDashboardNav === 'function') {
                setupDashboardNav(user, emoji);
            }
            if (typeof updateWalletStatus === 'function') {
                updateWalletStatus();
            }
        } catch (e) {
            err.textContent = e.message;
            err.hidden = false;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Shrani spremembe';
        }
    });

    overlay.querySelector('.btn-sync-chain')?.addEventListener('click', async () => {
        const chainMsg = overlay.querySelector('#profile-chain-msg');
        const btn = overlay.querySelector('.btn-sync-chain');
        if (chainMsg) chainMsg.textContent = 'Poteka registracija…';
        if (btn) btn.disabled = true;
        try {
            if (!data.onChainUser?.registered && window.BlockchainMetaMask && !data.blockchain?.autoSignEnabled) {
                await BlockchainMetaMask.ensureOnChainUser(sessionId, p.did, p.role);
                if (chainMsg) chainMsg.textContent = '✓ Registrirano prek MetaMask.';
                showProfileToast(overlay, 'Registrirano na verigi', 'ok');
                const fresh = await fetchProfile(sessionId);
                overlay.innerHTML = renderProfilePanel(fresh);
                bindProfileEvents(sessionId, fresh);
                return;
            }
            const res = await fetch('/api/profile/sync-blockchain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId })
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || 'Sync ni uspel');
            if (body.needsMetaMask && window.BlockchainMetaMask) {
                await BlockchainMetaMask.ensureOnChainUser(sessionId, p.did, p.role);
                if (chainMsg) chainMsg.textContent = '✓ Registrirano prek MetaMask.';
            } else if (chainMsg) {
                chainMsg.textContent = body.message || '✓ Registrirano na verigi.';
            }
            showProfileToast(overlay, 'Registrirano na verigi', 'ok');
            const fresh = await fetchProfile(sessionId);
            overlay.innerHTML = renderProfilePanel(fresh);
            bindProfileEvents(sessionId, fresh);
        } catch (e) {
            if (chainMsg) chainMsg.textContent = e.message;
            showProfileToast(overlay, e.message, 'err');
        } finally {
            if (btn) btn.disabled = false;
        }
    });
}

function metaEmojiForRole(role) {
    return roleMeta(role).emoji;
}

function ensureProfileOverlay() {
    if (profileOverlayEl) return profileOverlayEl;
    profileOverlayEl = document.createElement('div');
    profileOverlayEl.id = 'profile-overlay';
    profileOverlayEl.className = 'modal-overlay';
    profileOverlayEl.style.display = 'none';
    document.body.appendChild(profileOverlayEl);
    return profileOverlayEl;
}

async function openProfilePanel(sessionId) {
    const overlay = ensureProfileOverlay();
    overlay.style.display = 'flex';
    overlay.innerHTML = '<div class="profile-panel profile-panel--loading"><p class="text-muted">Nalagam profil…</p></div>';
    document.body.classList.add('profile-open');
    try {
        const data = await fetchProfile(sessionId);
        overlay.innerHTML = renderProfilePanel(data);
        bindProfileEvents(sessionId, data);
    } catch (e) {
        overlay.innerHTML = `<div class="profile-panel profile-panel--error">
            <p class="error-message">${e.message}</p>
            <button type="button" class="btn btn-ghost btn-close-profile">Zapri</button>
        </div>`;
        overlay.querySelector('.btn-close-profile')?.addEventListener('click', closeProfilePanel);
    }
}

function closeProfilePanel() {
    document.body.classList.remove('profile-open');
    if (profileOverlayEl) {
        profileOverlayEl.style.display = 'none';
        profileOverlayEl.innerHTML = '';
    }
}

function setupProfileButton(sessionId) {
    const btn = document.getElementById('btn-profile');
    if (!btn || !sessionId) return;
    btn.addEventListener('click', () => openProfilePanel(sessionId));
}

window.ProfilePanel = { openProfilePanel, closeProfilePanel, setupProfileButton };
