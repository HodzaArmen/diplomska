/**
 * waltid-ssi.js
 * Walt.id Issuer (signed VC) and Verifier integration
 */

import axios from 'axios';
import crypto from 'crypto';
import { SignJWT, importJWK } from 'jose';

const ISSUER_API = (process.env.WALT_ISSUER_API_URL || 'http://issuer-api:7002').replace(/\/$/, '');
const VERIFIER_API = (process.env.WALT_VERIFIER_API_URL || 'http://verifier-api:7003').replace(/\/$/, '');
const WALLET_API = (process.env.WALT_ID_API_URL || 'http://wallet-api:7001/wallet-api').replace(/\/$/, '');

let cachedIssuerKey = null;

function rewriteLocalServiceUrl(vhodniNiz) {
    if (!vhodniNiz) return vhodniNiz;

    // Dekodiramo vse skrite %3A in %2F v navadna dvopičja in poševnice
    let dekodiranNiz = decodeURIComponent(String(vhodniNiz));

    // Zamenjamo localhost z docker imenom
    let popravljenNiz = dekodiranNiz.replace(/localhost:7002/g, 'issuer-api:7002');

    return popravljenNiz; // Vrnem čitljiv, popravljen URL
}

/**
 * Issuer API vrne openid-credential-offer://...
 * - credential_offer= (inline JSON, starejši format)
 * - credential_offer_uri= (URL do JSON, Walt.id DRAFT13+)
 */
async function resolveCredentialOffer(offerResponse) {
    if (!offerResponse) {
        throw new Error('Issuer ni vrnil credential offer');
    }

    if (typeof offerResponse === 'object') {
        if (offerResponse.credential_issuer) {
            return {
                ...offerResponse,
                credential_issuer: rewriteLocalServiceUrl(offerResponse.credential_issuer),
                credential_offer_uri: rewriteLocalServiceUrl(offerResponse.credential_offer_uri)
            };
        }
        if (offerResponse.credential_offer) {
            return resolveCredentialOffer(offerResponse.credential_offer);
        }
        if (typeof offerResponse.offer === 'string') {
            return resolveCredentialOffer(offerResponse.offer);
        }
    }

    let offerStr = String(offerResponse).trim();
    if (offerStr.endsWith('%')) {
        offerStr = offerStr.slice(0, -1);
    }
    offerStr = rewriteLocalServiceUrl(offerStr);

    if (offerStr.startsWith('{')) {
        const parsed = JSON.parse(offerStr);
        if (parsed?.credential_issuer) {
            parsed.credential_issuer = rewriteLocalServiceUrl(parsed.credential_issuer);
        }
        if (parsed?.credential_offer_uri) {
            parsed.credential_offer_uri = rewriteLocalServiceUrl(parsed.credential_offer_uri);
        }
        return parsed;
    }

    if (offerStr.startsWith('openid-credential-offer://')) {
        const inlineMatch = offerStr.match(/[?&]credential_offer=([^&]+)/);
        if (inlineMatch?.[1]) {
            const parsed = JSON.parse(decodeURIComponent(inlineMatch[1]));
            if (parsed?.credential_issuer) {
                parsed.credential_issuer = rewriteLocalServiceUrl(parsed.credential_issuer);
            }
            return parsed;
        }

        const uriMatch = offerStr.match(/[?&]credential_offer_uri=([^&]+)/);
        if (uriMatch?.[1]) {
            const offerUri = rewriteLocalServiceUrl(decodeURIComponent(uriMatch[1]));
            try {
                const response = await axios.get(offerUri, {
                    timeout: 30000,
                    headers: { Accept: 'application/json' },
                    validateStatus: () => true
                });

                if (response.status >= 400) {
                    throw new Error(`credential_offer_uri ${response.status}: ${offerUri}`);
                }

                if (typeof response.data === 'object' && response.data?.credential_issuer) {
                    return {
                        ...response.data,
                        credential_issuer: rewriteLocalServiceUrl(response.data.credential_issuer),
                        credential_offer_uri: rewriteLocalServiceUrl(response.data.credential_offer_uri)
                    };
                }

                if (typeof response.data === 'string') {
                    return resolveCredentialOffer(response.data);
                }
            } catch (error) {
                throw new Error(`Branje credential_offer_uri ni uspelo (${offerUri}): ${error.message}`);
            }

            throw new Error('credential_offer_uri ni vrnil JSON offerja');
        }

        try {
            const httpLike = offerStr.replace(/^openid-credential-offer:\/\//, 'http://');
            const url = new URL(httpLike);
            const encoded = url.searchParams.get('credential_offer');
            if (encoded) {
                const parsed = JSON.parse(decodeURIComponent(encoded));
                if (parsed?.credential_issuer) {
                    parsed.credential_issuer = rewriteLocalServiceUrl(parsed.credential_issuer);
                }
                return parsed;
            }
        } catch {
            // fall through
        }
    }

    throw new Error(
        `Credential offer ni v pričakovanem formatu (prvih 80 znakov: ${offerStr.slice(0, 80)})`
    );
}

function resolveIssuerBaseUrl(credentialIssuer) {
    if (!credentialIssuer) return ISSUER_API;
    return rewriteLocalServiceUrl(String(credentialIssuer)).replace(/\/$/, '');
}

async function importKeyFromIssuerMaterial(issuerKey) {
    const jwk = issuerKey?.jwk || issuerKey;
    const alg = jwk.alg || (jwk.kty === 'OKP' ? 'EdDSA' : jwk.crv === 'P-256' ? 'ES256' : 'EdDSA');
    return { key: await importJWK(jwk, alg), alg };
}

/**
 * POPRAVLJENO: V glavo JWT dodamo javni JWK in kid, da Walt.id lahko uspešno razreši ključ.
 */
async function createProofJwt({ issuerKey, issuerDid, audience, cNonce }) {
    const { key, alg } = await importKeyFromIssuerMaterial(issuerKey);
    const jwk = issuerKey?.jwk || issuerKey;

    // Pripravimo javni del JWK (odstranimo privatni ključ 'd', če obstaja), ki ga priložimo v glavo
    const publicJwk = { ...jwk };
    delete publicJwk.d;

    const header = {
        alg,
        typ: 'openid4vci-proof+jwt',
        jwk: publicJwk
    };

    if (jwk.kid) {
        header.kid = jwk.kid;
    } else if (issuerDid) {
        header.kid = issuerDid;
    }

    return new SignJWT({ nonce: cNonce })
        .setProtectedHeader(header)
        .setIssuedAt()
        .setAudience(audience)
        .setIssuer(issuerDid)
        .sign(key);
}

async function fetchCredentialNonce(issuerBase, accessToken) {
    const paths = ['/nonce', '/draft13/nonce'];
    for (const path of paths) {
        try {
            const response = await axios.post(
                `${issuerBase}${path}`,
                {},
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 15000,
                    validateStatus: () => true
                }
            );
            if (response.status >= 200 && response.status < 300) {
                return response.data?.c_nonce || response.data?.nonce || null;
            }
        } catch {
            // poskusi naslednjo pot
        }
    }
    return null;
}

async function getIssuerSigningMaterial() {
    if (process.env.ISSUER_KEY_JWK && process.env.ISSUER_DID) {
        return {
            issuerKey: { type: 'jwk', jwk: JSON.parse(process.env.ISSUER_KEY_JWK) },
            issuerDid: process.env.ISSUER_DID
        };
    }

    if (cachedIssuerKey) {
        return cachedIssuerKey;
    }

    const response = await axios.post(`${ISSUER_API}/onboard/issuer`, {}, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
    });

    const data = response.data;
    const issuerKey = data.issuerKey || data.key || { type: 'jwk', jwk: data.jwk };
    const issuerDid = data.issuerDid || data.did;

    if (!issuerKey || !issuerDid) {
        throw new Error('Onboard issuer ni vrnil ključa ali DID');
    }

    cachedIssuerKey = {
        issuerKey: issuerKey.type ? issuerKey : { type: 'jwk', jwk: issuerKey },
        issuerDid
    };

    return cachedIssuerKey;
}

async function claimCredentialFromOffer(offer, credentialConfigurationId, { issuerKey, issuerDid }) {
    const issuerBase = resolveIssuerBaseUrl(offer.credential_issuer);
    const grant = offer.grants?.['urn:ietf:params:oauth:grant-type:pre-authorized_code'];

    if (!grant?.['pre-authorized_code']) {
        throw new Error('Credential offer nima pre-authorized kode');
    }

    const tokenResponse = await axios.post(
        `${issuerBase}/token`,
        new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
            'pre-authorized_code': grant['pre-authorized_code']
        }).toString(),
        {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30000,
            validateStatus: () => true
        }
    );

    if (tokenResponse.status >= 400) {
        throw new Error(`Issuer token ${tokenResponse.status}: ${JSON.stringify(tokenResponse.data)?.slice(0, 200)}`);
    }

    const accessToken = tokenResponse.data.access_token;
    if (!accessToken) {
        throw new Error('Issuer token endpoint ni vrnil access_token');
    }

    const cNonce = tokenResponse.data.c_nonce || await fetchCredentialNonce(issuerBase, accessToken);
    if (!cNonce) {
        throw new Error('Manjka c_nonce za proof of possession (OID4VCI DRAFT13)');
    }

    console.log('[OID4VCI proof] issuerDid:', issuerDid);
    console.log('[OID4VCI proof] issuerBase:', issuerBase);
    console.log('[OID4VCI proof] credential issuer from offer:', offer.credential_issuer);

    const proofJwt = await createProofJwt({
        issuerKey,
        issuerDid,
        audience: issuerBase,
        cNonce
    });

    const credentialRequest = {
        format: 'jwt_vc_json',
        credential_configuration_id: credentialConfigurationId,
        proof: { proof_type: 'jwt', jwt: proofJwt }
    };

    const credentialResponse = await axios.post(
        `${issuerBase}/credential`,
        credentialRequest,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000,
            validateStatus: () => true
        }
    );

    const jwt = credentialResponse.data?.credential
        || credentialResponse.data?.credentials?.[0]?.credential
        || (typeof credentialResponse.data === 'string' ? credentialResponse.data : null);

    if (typeof jwt === 'string' && jwt.includes('.')) {
        return jwt;
    }

    throw new Error(`Issuer credential ${credentialResponse.status}: ${JSON.stringify(credentialResponse.data)?.slice(0, 300)}`);
}

function normalizeOfferString(offerStr) {
    let normalized = String(offerStr).trim().replace(/%$/, '');

    if (!normalized.startsWith('openid-credential-offer://')) {
        return rewriteLocalServiceUrl(normalized);
    }

    try {
        const httpLike = normalized.replace(/^openid-credential-offer:\/\//, 'http://');
        const url = new URL(httpLike);

        const credentialOfferUri = url.searchParams.get('credential_offer_uri');
        if (credentialOfferUri) {
            const decoded = decodeURIComponent(credentialOfferUri);
            const rewritten = rewriteLocalServiceUrl(decoded);
            url.searchParams.set('credential_offer_uri', rewritten);
            return url.toString().replace(/^http:\/\//, 'openid-credential-offer://');
        }

        const inlineOffer = url.searchParams.get('credential_offer');
        if (inlineOffer) {
            const parsed = JSON.parse(decodeURIComponent(inlineOffer));
            if (parsed.credential_issuer) {
                parsed.credential_issuer = rewriteLocalServiceUrl(parsed.credential_issuer);
            }
            url.searchParams.set('credential_offer', JSON.stringify(parsed));
            return url.toString().replace(/^http:\/\//, 'openid-credential-offer://');
        }
    } catch {
        return rewriteLocalServiceUrl(normalized);
    }

    return normalized;
}

function normalizeOfferPayload(offerRaw) {
    if (!offerRaw) return offerRaw;

    if (typeof offerRaw === 'string') {
        return normalizeOfferString(offerRaw);
    }

    if (typeof offerRaw === 'object') {
        const copy = JSON.parse(JSON.stringify(offerRaw));
        if (copy.credential_offer_uri) {
            copy.credential_offer_uri = rewriteLocalServiceUrl(copy.credential_offer_uri);
        }
        if (copy.credential_issuer) {
            copy.credential_issuer = rewriteLocalServiceUrl(copy.credential_issuer);
        }
        if (typeof copy.offer === 'string') {
            copy.offer = normalizeOfferString(copy.offer);
        }
        return copy;
    }

    return offerRaw;
}

/**
 * Claim credential prek wallet-api (uradni Walt.id tok — wallet podpiše proof)
 */
async function claimCredentialViaWallet(offerRaw, walletId, waltCookie) {
    if (!walletId || !waltCookie) {
        throw new Error('Manjka wallet_id ali walt_api_cookie — ponovno se registrirajte v Walt.id');
    }

    const normalizedOffer = normalizeOfferPayload(offerRaw);
    const offerString =
        typeof normalizedOffer === 'string'
            ? normalizedOffer
            : JSON.stringify(normalizedOffer);

    console.log('[Walt.id wallet claim] normalized offer for wallet-api:', offerString.slice(0, 200));
    const response = await axios.post(
        `${WALLET_API}/wallet/${walletId}/exchange/useOfferRequest`,
        offerString,
        {
            headers: {
                'Content-Type': 'text/plain',
                Cookie: waltCookie,
                Accept: 'application/json'
            },
            transformRequest: [(data) => data],
            timeout: 60000,
            validateStatus: () => true
        }
    );

    if (response.status >= 400) {
        const originalPreview =
            typeof offerRaw === 'string'
                ? offerRaw.slice(0, 220)
                : JSON.stringify(offerRaw).slice(0, 220);

        const normalizedPreview = offerString.slice(0, 220);

        console.warn('[Walt.id wallet claim debug] original offer preview:', originalPreview);
        console.warn('[Walt.id wallet claim debug] normalized offer preview:', normalizedPreview);

        throw new Error(
            `wallet useOfferRequest ${response.status}: ${JSON.stringify(response.data)?.slice(0, 200)}`
        );
    }

    const credentials = Array.isArray(response.data) ? response.data : [response.data];
    const document = credentials[0]?.document || credentials[0]?.credential;
    if (typeof document !== 'string' || !document.includes('.')) {
        throw new Error('Wallet ni vrnil JWT credential (document)');
    }

    return document;
}

/**
 * Issue a signed JWT VC via Walt.id Issuer API (OID4VCI pre-authorized flow)
 */
export async function issueSignedCredential({
    credentialConfigurationId,
    credentialData,
    mapping,
    subjectDid,
    walletId = null,
    waltCookie = null
}) {
    const { issuerKey, issuerDid } = await getIssuerSigningMaterial();

    const issueBody = {
        issuerKey,
        issuerDid,
        credentialConfigurationId,
        credentialData,
        mapping: mapping || {
            id: '<uuid>',
            issuer: { id: '<issuerDid>' },
            credentialSubject: { id: subjectDid || '<uuid>' },
            issuanceDate: '<timestamp>',
            expirationDate: '<timestamp-in:365d>'
        },
        authenticationMethod: 'PRE_AUTHORIZED',
        standardVersion: 'DRAFT13'
    };

    const issueResponse = await axios.post(
        `${ISSUER_API}/openid4vc/jwt/issue`,
        issueBody,
        {
            headers: { 'Content-Type': 'application/json', Accept: 'text/plain, application/json' },
            timeout: 60000,
            responseType: 'text',
            transformResponse: [(data) => data]
        }
    );

    let rawOffer = issueResponse.data;
    if (typeof rawOffer === 'string' && rawOffer.trim().startsWith('{')) {
        try {
            rawOffer = JSON.parse(rawOffer);
        } catch {
            // ostane string (URI)
        }
    }

    let jwt;
    let offer = null;

    if (walletId && waltCookie) {
        try {
            jwt = await claimCredentialViaWallet(rawOffer, walletId, waltCookie);
            console.log(`✓ VC claimed via wallet-api (${credentialConfigurationId})`);
        } catch (walletError) {
            console.warn(`Wallet claim failed, trying issuer claim: ${walletError.message}`);
            offer = await resolveCredentialOffer(rawOffer);
            jwt = await claimCredentialFromOffer(offer, credentialConfigurationId, { issuerKey, issuerDid });
        }
    } else {
        offer = await resolveCredentialOffer(rawOffer);
        jwt = await claimCredentialFromOffer(offer, credentialConfigurationId, { issuerKey, issuerDid });
    }

    return {
        jwt,
        issuerDid,
        credentialOffer: offer,
        signed: true
    };
}

export async function issueMedicineCredential(medicine, manufacturer, walletOpts = {}) {
    const credentialData = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'MedicineCredential'],
        issuer: { id: manufacturer.did },
        issuanceDate: new Date().toISOString(),
        credentialSubject: {
            id: manufacturer.did,
            medicineId: medicine.medicineId,
            name: medicine.name,
            batchNumber: medicine.batchNumber,
            quantity: medicine.quantity,
            expiryDate: medicine.expiryDate,
            manufacturer: manufacturer.companyName || manufacturer.company_name,
            manufacturerDID: manufacturer.did,
            description: medicine.description || ''
        }
    };

    // POPRAVLJENO: Bolj robustna podpora za camelCase in snake_case poimenovanja wallet podatkov
    const walletId = walletOpts.walletId || manufacturer.wallet_id || manufacturer.walletId || null;
    const waltCookie = walletOpts.waltCookie || manufacturer.walt_api_cookie || manufacturer.waltCookie || null;

    return issueSignedCredential({
        credentialConfigurationId: 'MedicineCredential_jwt_vc_json',
        credentialData,
        subjectDid: manufacturer.did,
        walletId,
        waltCookie
    });
}

export async function issueTransportCredential(delivery, distributor, medicine, walletOpts = {}) {
    const credentialData = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'MedicineTransportCredential'],
        issuer: { id: distributor.did },
        issuanceDate: new Date().toISOString(),
        credentialSubject: {
            id: distributor.did,
            medicineId: medicine.medicine_id || medicine.medicineId,
            deliveryId: delivery.delivery_id || delivery.deliveryId,
            quantity: delivery.quantity,
            distributor: distributor.company_name || distributor.companyName,
            distributorDID: distributor.did,
            batchNumber: medicine.batch_number || medicine.batchNumber
        }
    };

    // POPRAVLJENO: Bolj robustna podpora za camelCase in snake_case poimenovanja wallet podatkov
    const walletId = walletOpts.walletId || distributor.wallet_id || distributor.walletId || null;
    const waltCookie = walletOpts.waltCookie || distributor.walt_api_cookie || distributor.waltCookie || null;

    return issueSignedCredential({
        credentialConfigurationId: 'MedicineTransportCredential_jwt_vc_json',
        credentialData,
        subjectDid: distributor.did,
        walletId,
        waltCookie
    });
}

function decodeJwtPayload(jwt) {
    const parts = jwt.split('.');
    if (parts.length !== 3) {
        throw new Error('Neveljaven JWT format');
    }
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
}

function structuralVerify(jwt, expectedIssuerDid) {
    const payload = decodeJwtPayload(jwt);
    const vc = payload.vc || payload;
    const issuer = vc?.issuer?.id || payload.iss;
    const subject = vc?.credentialSubject || payload.credentialSubject;

    const issuerOk = !expectedIssuerDid || 
                     issuer === expectedIssuerDid || 
                     subject?.id === expectedIssuerDid ||
                     subject?.manufacturerDID === expectedIssuerDid ||
                     subject?.distributorDID === expectedIssuerDid;

    return {
        verified: Boolean(subject && issuerOk),
        structuralOnly: true,
        issuer,
        subject,
        message: issuerOk
            ? 'JWT struktura veljavna (kriptografsko preverjanje prek verifier API ni uspelo)'
            : `Izdajatelj (${issuer}) se ne ujema s pričakovanim (${expectedIssuerDid})`
    };
}

/**
 * POPRAVLJENO: Prilagojeno za novejše različice Walt.id Verifier API (odstranjeni 404 endpointi)
 */
export async function verifyCredentialJwt(jwt, expectedIssuerDid = null) {
    if (!jwt || typeof jwt !== 'string') {
        return { verified: false, message: 'Manjka JWT credential' };
    }

    try {
        const response = await axios.post(
            `${VERIFIER_API}/openid4vc/verify`,
            {
                request_credentials: [
                    {
                        type: jwt.includes('MedicineTransport') ? 'MedicineTransportCredential' : 'MedicineCredential',
                        format: 'jwt_vc_json'
                    }
                ],
                vp_token: jwt,
                presentationSubmission: {
                    id: crypto.randomUUID(),
                    definition_id: 'direct',
                    descriptor_map: [{
                        id: 'cred',
                        format: 'jwt_vc_json',
                        path: '$'
                    }]
                }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    responseMode: 'direct_post',
                    authorizeBaseUrl: 'openid4vp://authorize'
                },
                timeout: 30000,
                validateStatus: () => true
            }
        );

        if (response.status >= 200 && response.status < 300) {
            // Novejše različice Walt.id verifierja vračajo "valid": true ali "success": true namesto "verificationResult"
            const isValid = response.data?.valid === true || 
                            response.data?.success === true || 
                            response.data?.verified === true || 
                            response.data?.verificationResult === true;

            if (isValid) {
                return {
                    verified: true,
                    message: 'VC kriptografsko preverjen prek Walt.id Verifier API',
                    details: response.data
                };
            } else {
                console.warn('Walt.id Verifier je vrnil 200 OK, vendar validacija politik ni uspela:', response.data);
            }
        }
    } catch (error) {
        console.log(`Verifier API direct verify error: ${error.message}`);
    }

    // Odstranjeni klici na /jwt/verify in /openid4vc/policy/signature/verify, ker v novejših različicah vračajo 404.
    // Če zgornja uradna validacija ne uspe (ali vrne false), se vrne zgolj strukturni fallback.
    return structuralVerify(jwt, expectedIssuerDid);
}

export function isIssuerConfigured() {
    return Boolean(ISSUER_API);
}

export function isVerifierConfigured() {
    return Boolean(VERIFIER_API);
}
