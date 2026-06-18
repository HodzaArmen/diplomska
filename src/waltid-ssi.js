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
    const now = new Date().toISOString();
    const credentialData = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'MedicineCredential'],
        issuer: { id: manufacturer.did },
        issuanceDate: now,
        credentialSubject: {
            id: manufacturer.did,
            eventType: 'MANUFACTURED',
            eventTimestamp: now,
            medicineId: medicine.medicineId,
            name: medicine.name,
            batchNumber: medicine.batchNumber,
            quantity: medicine.quantity,
            expiryDate: medicine.expiryDate,
            creatorRole: 'manufacturer',
            creatorName: manufacturer.companyName || manufacturer.company_name,
            creatorWallet: manufacturer.wallet_address,
            creatorDID: manufacturer.did,
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

/**
 * VC za vsak korak dobave: kdo pošilja, komu, koliko, kdaj.
 * eventType: SENT_TO_DISTRIBUTOR | FORWARDED_TO_PHARMACY
 */
export async function issueHandoffCredential({
    delivery,
    medicine,
    sender,
    recipient,
    eventType,
    walletOpts = {}
}) {
    const now = new Date().toISOString();
    const medicineId = medicine.medicine_id || medicine.medicineId;
    const deliveryId = delivery.delivery_id || delivery.deliveryId;

    const credentialData = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'MedicineTransportCredential'],
        issuer: { id: sender.did },
        issuanceDate: now,
        credentialSubject: {
            id: sender.did,
            eventType,
            eventTimestamp: now,
            medicineId,
            medicineName: medicine.name,
            batchNumber: medicine.batch_number || medicine.batchNumber,
            deliveryId,
            quantity: delivery.quantity,
            senderRole: sender.role,
            senderName: sender.company_name || sender.companyName,
            senderWallet: sender.wallet_address,
            senderDID: sender.did,
            recipientRole: recipient.role,
            recipientName: recipient.company_name || recipient.companyName || recipient.target_pharmacy_name,
            recipientWallet: recipient.wallet_address,
            recipientDID: recipient.did || null
        }
    };

    const walletId = walletOpts.walletId || sender.wallet_id || sender.walletId || null;
    const waltCookie = walletOpts.waltCookie || sender.walt_api_cookie || sender.waltCookie || null;

    return issueSignedCredential({
        credentialConfigurationId: 'MedicineTransportCredential_jwt_vc_json',
        credentialData,
        subjectDid: sender.did,
        walletId,
        waltCookie
    });
}

/** @deprecated uporabi issueHandoffCredential */
export async function issueTransportCredential(delivery, distributor, medicine, walletOpts = {}) {
    return issueHandoffCredential({
        delivery,
        medicine,
        sender: distributor,
        recipient: { role: 'pharmacy', company_name: delivery.target_pharmacy_name },
        eventType: 'FORWARDED_TO_PHARMACY',
        walletOpts
    });
}

export function decodeVcClaims(jwt) {
    if (!jwt || typeof jwt !== 'string' || !jwt.includes('.')) return null;
    try {
        const payload = decodeJwtPayload(jwt);
        const vc = payload.vc || payload;
        return vc.credentialSubject || payload.credentialSubject || null;
    } catch {
        return null;
    }
}

function decodeJwtPayload(jwt) {
    const parts = jwt.split('.');
    if (parts.length !== 3) {
        throw new Error('Neveljaven JWT format');
    }
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
}

function extractVcParties(jwt) {
    const payload = decodeJwtPayload(jwt);
    const vc = payload.vc || payload;
    return {
        payload,
        vc,
        issuer: vc?.issuer?.id || payload.iss,
        subject: vc?.credentialSubject || payload.credentialSubject
    };
}

function matchesExpectedIssuer({ issuer, subject }, expectedIssuerDid) {
    if (!expectedIssuerDid) return true;
    return issuer === expectedIssuerDid ||
        subject?.id === expectedIssuerDid ||
        subject?.manufacturerDID === expectedIssuerDid ||
        subject?.distributorDID === expectedIssuerDid ||
        subject?.creatorDID === expectedIssuerDid;
}

function structuralVerify(jwt, expectedIssuerDid) {
    const { issuer, subject } = extractVcParties(jwt);
    const issuerOk = matchesExpectedIssuer({ issuer, subject }, expectedIssuerDid);

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

const SUPPORTED_CREDENTIAL_TYPES = new Set([
    'MedicineCredential',
    'MedicineTransportCredential'
]);

function getCredentialTypeFromJwt(jwt) {
    const payload = decodeJwtPayload(jwt);
    const vc = payload.vc || payload;
    const types = Array.isArray(vc?.type) ? vc.type : [];
    const specific = types.find((type) => SUPPORTED_CREDENTIAL_TYPES.has(type));
    if (specific) return specific;
    if (jwt.includes('MedicineTransportCredential')) return 'MedicineTransportCredential';
    return 'MedicineCredential';
}

function parseOid4vpAuthorizationUrl(authorizationUrl) {
    const httpLike = String(authorizationUrl).replace(/^openid4vp:\/\/authorize\?/, 'http://local?');
    const params = new URL(httpLike).searchParams;
    const state = params.get('state');
    const responseUri = params.get('response_uri');
    const presentationDefinitionUri = params.get('presentation_definition_uri');

    if (!state || !responseUri || !presentationDefinitionUri) {
        throw new Error('OID4VP authorization URL ne vsebuje state/response_uri/presentation_definition_uri');
    }

    return { state, responseUri, presentationDefinitionUri };
}

function buildPresentationSubmission(presentationDefinition) {
    const descriptor = presentationDefinition?.input_descriptors?.[0];
    const descriptorId = descriptor?.id;
    const definitionId = presentationDefinition?.id;

    if (!descriptorId || !definitionId) {
        throw new Error('Presentation definition nima input descriptorja');
    }

    return {
        id: definitionId,
        definition_id: definitionId,
        descriptor_map: [{
            id: descriptorId,
            format: 'jwt_vp',
            path: '$',
            path_nested: {
                id: descriptorId,
                format: 'jwt_vc_json',
                path: '$.verifiableCredential[0]'
            }
        }]
    };
}

function policiesPassed(policyResults) {
    const groups = policyResults?.results || [];
    return groups.every((group) =>
        (group.policyResults || []).every((policy) => policy.is_success === true)
    );
}

const verifierCallbackResults = new Map();

export function storeVerifierCallbackResult(stateOrId, payload) {
    if (stateOrId) verifierCallbackResults.set(stateOrId, payload);
}

export function getVerifierCallbackResult(stateOrId) {
    return verifierCallbackResults.get(stateOrId) || null;
}

function waltWalletAuthHeaders({ waltCookie, waltBearerToken } = {}) {
    if (waltBearerToken) {
        return { Authorization: `Bearer ${waltBearerToken}` };
    }
    if (waltCookie) {
        return { Cookie: waltCookie };
    }
    return {};
}

/** Wallet auth podatki iz users vrstice (custodial wallet). */
export function holderWalletAuthFromUser(user) {
    if (!user?.wallet_id) return null;
    const waltCookie = user.walt_api_cookie || user.waltCookie || null;
    const waltBearerToken = user.walt_bearer_token || user.waltBearerToken || null;
    if (!waltCookie && !waltBearerToken) return null;
    return { walletId: user.wallet_id, waltCookie, waltBearerToken };
}

/**
 * Seznam VC v Walt.id walletu — vir resnice za credentials (ne PostgreSQL).
 */
export async function listWalletCredentials(walletId, auth = {}) {
    if (!walletId) throw new Error('Manjka wallet_id');
    const response = await axios.get(
        `${WALLET_API}/wallet/${walletId}/credentials`,
        {
            headers: {
                ...waltWalletAuthHeaders(auth),
                Accept: 'application/json'
            },
            timeout: 30000,
            validateStatus: () => true
        }
    );
    if (response.status >= 400) {
        throw new Error(`wallet credentials list ${response.status}: ${JSON.stringify(response.data)?.slice(0, 200)}`);
    }
    return Array.isArray(response.data) ? response.data : [];
}

function credentialJwtFromWalletEntry(entry) {
    const doc = entry?.document || entry?.credential || entry?.parsedDocument;
    return (typeof doc === 'string' && doc.includes('.')) ? doc : null;
}

/** Filtriraj wallet credential po claims (medicineId, deliveryId, eventType). */
export function matchesCredentialFilters(entry, {
    credentialType = null,
    medicineId = null,
    deliveryId = null,
    eventType = null
} = {}) {
    const jwt = credentialJwtFromWalletEntry(entry);
    if (!jwt) return false;
    if (credentialType && getCredentialTypeFromJwt(jwt) !== credentialType) return false;
    const claims = decodeVcClaims(jwt);
    const sub = claims?.credentialSubject || claims;
    if (medicineId && sub?.medicineId !== medicineId) return false;
    if (deliveryId && sub?.deliveryId !== deliveryId) return false;
    if (eventType && sub?.eventType !== eventType) return false;
    return true;
}

/**
 * Poišči JWT v walletu imetnika (brez PostgreSQL kopije).
 */
export async function resolveHolderCredentialJwt(holderUser, filters = {}) {
    const auth = holderWalletAuthFromUser(holderUser);
    if (!auth) return null;
    const list = await listWalletCredentials(auth.walletId, auth);
    const hit = list.find((entry) => matchesCredentialFilters(entry, filters));
    return hit ? credentialJwtFromWalletEntry(hit) : null;
}

/**
 * OID4VP presentation iz walleta imetnika + filtri po medicineId/deliveryId.
 */
export async function verifyCredentialPresentationFromHolder({
    holderUser,
    credentialType,
    expectedIssuerDid = null,
    filters = {}
}) {
    const auth = holderWalletAuthFromUser(holderUser);
    if (!auth) {
        return {
            verified: false,
            structuralOnly: false,
            message: 'Manjka Walt.id seja imetnika VC — ponovna prijava pošiljatelja',
            source: 'wallet-api'
        };
    }

    return verifyCredentialViaWallet({
        ...auth,
        credentialType,
        expectedIssuerDid,
        claimFilters: filters
    });
}

async function initOid4vpVerificationSession(credentialType, options = {}) {
    const { statusCallbackUri, authorizeBaseUrl, walletId } = options;
    const body = {
        request_credentials: [
            {
                type: credentialType,
                format: 'jwt_vc_json'
            }
        ]
    };
    if (statusCallbackUri) {
        body.statusCallbackUri = statusCallbackUri;
    }

    const resolvedAuthorizeBase = authorizeBaseUrl
        || (walletId
            ? `${WALLET_API}/wallet/${walletId}/exchange/usePresentationRequest`
            : 'openid4vp://authorize');

    const response = await axios.post(
        `${VERIFIER_API}/openid4vc/verify`,
        body,
        {
            headers: {
                'Content-Type': 'application/json',
                responseMode: 'direct_post',
                authorizeBaseUrl: resolvedAuthorizeBase
            },
            timeout: 30000,
            validateStatus: () => true
        }
    );

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Verifier init ${response.status}: ${JSON.stringify(response.data)?.slice(0, 200)}`);
    }

    if (typeof response.data !== 'string') {
        throw new Error(`Verifier init ni vrnil authorization URL (prejel: ${JSON.stringify(response.data)?.slice(0, 120)})`);
    }

    const isOid4vp = response.data.startsWith('openid4vp://');
    const isHttpPresentation = response.data.startsWith('http://') || response.data.startsWith('https://');
    if (!isOid4vp && !isHttpPresentation) {
        throw new Error(`Verifier init ni vrnil OID4VP URL (prejel: ${JSON.stringify(response.data)?.slice(0, 120)})`);
    }

    const auth = parseOid4vpAuthorizationUrl(response.data);
    const pdResponse = await axios.get(auth.presentationDefinitionUri, {
        timeout: 15000,
        validateStatus: () => true
    });

    if (pdResponse.status < 200 || pdResponse.status >= 300) {
        throw new Error(`Branje presentation definition ni uspelo (${pdResponse.status})`);
    }

    return {
        ...auth,
        authorizationUrl: response.data,
        presentationDefinition: pdResponse.data
    };
}

/**
 * Tutorial tok: wallet matchCredentials → resolvePresentationRequest → usePresentationRequest → GET session
 */
export async function verifyCredentialViaWallet({
    walletId,
    waltCookie = null,
    waltBearerToken = null,
    credentialType,
    expectedIssuerDid = null,
    claimFilters = null
}) {
    if (!walletId) {
        return { verified: false, message: 'Manjka wallet_id za wallet verify tok' };
    }

    const authHeaders = waltWalletAuthHeaders({ waltCookie, waltBearerToken });

    try {
        const session = await initOid4vpVerificationSession(credentialType, {
            walletId,
            statusCallbackUri: process.env.VERIFIER_STATUS_CALLBACK_URL || null
        });

        const resolvedResponse = await axios.post(
            `${WALLET_API}/wallet/${walletId}/exchange/resolvePresentationRequest`,
            session.authorizationUrl,
            {
                headers: {
                    ...authHeaders,
                    'Content-Type': 'text/plain',
                    Accept: 'text/plain'
                },
                transformRequest: [(data) => data],
                timeout: 30000,
                validateStatus: () => true
            }
        );

        if (resolvedResponse.status >= 400) {
            throw new Error(`resolvePresentationRequest ${resolvedResponse.status}`);
        }

        const resolvedRequest = resolvedResponse.data;
        const matchResponse = await axios.post(
            `${WALLET_API}/wallet/${walletId}/exchange/matchCredentialsForPresentationDefinition`,
            session.presentationDefinition,
            {
                headers: {
                    ...authHeaders,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                timeout: 30000,
                validateStatus: () => true
            }
        );

        if (matchResponse.status >= 400) {
            throw new Error(`matchCredentials ${matchResponse.status}`);
        }

        const matches = Array.isArray(matchResponse.data) ? matchResponse.data : [];
        const filtered = claimFilters
            ? matches.filter((m) => matchesCredentialFilters(m, { credentialType, ...claimFilters }))
            : matches;

        if (filtered.length === 0) {
            return {
                verified: false,
                message: claimFilters
                    ? `Wallet nima ${credentialType} za ${JSON.stringify(claimFilters)}`
                    : `Wallet nima ustreznega ${credentialType} credentiala`,
                source: 'wallet-api'
            };
        }

        const selectedCredentials = filtered.map((m) => m.id).filter(Boolean);
        await axios.post(
            `${WALLET_API}/wallet/${walletId}/exchange/usePresentationRequest`,
            {
                presentationRequest: resolvedRequest,
                selectedCredentials
            },
            {
                headers: {
                    ...authHeaders,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                timeout: 60000,
                validateStatus: () => true
            }
        );

        const result = await fetchOid4vpVerificationSession(session.state);
        const signatureOk = policiesPassed(result.policyResults);
        const verified = result.verificationResult === true && signatureOk;

        const jwt = credentialJwtFromWalletEntry(filtered[0]);
        const parties = jwt ? extractVcParties(jwt) : { issuer: null, subject: null };
        const issuerOk = matchesExpectedIssuer(parties, expectedIssuerDid);

        return {
            verified: verified && issuerOk,
            structuralOnly: false,
            issuer: parties.issuer,
            subject: parties.subject,
            jwt,
            message: verified && issuerOk
                ? 'VC predstavljen iz wallet-a in preverjen (tutorial OID4VP)'
                : verified
                    ? `Podpis veljaven, DID se ne ujema (${expectedIssuerDid})`
                    : 'Wallet predstavitev ni prestala verifier politik',
            source: 'wallet-api',
            details: { sessionId: result.id, policyResults: result.policyResults }
        };
    } catch (error) {
        return {
            verified: false,
            message: `Wallet verify napaka: ${error.message}`,
            source: 'wallet-api'
        };
    }
}

async function submitOid4vpPresentation({ responseUri, state, jwt, presentationDefinition }) {
    const presentationSubmission = buildPresentationSubmission(presentationDefinition);
    const form = new URLSearchParams({
        vp_token: jwt,
        presentation_submission: JSON.stringify(presentationSubmission),
        state
    });

    const response = await axios.post(responseUri, form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
        validateStatus: () => true
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Verifier presentation submit ${response.status}: ${JSON.stringify(response.data)?.slice(0, 300)}`);
    }
}

async function fetchOid4vpVerificationSession(state) {
    const response = await axios.get(`${VERIFIER_API}/openid4vc/session/${state}`, {
        timeout: 15000,
        validateStatus: () => true
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Verifier session ${response.status}: ${JSON.stringify(response.data)?.slice(0, 200)}`);
    }

    return response.data;
}

/**
 * Preveri JWT VC prek uradnega Walt.id OID4VP toka:
 * init seja → direct_post vp_token → GET /openid4vc/session/{state}
 * @param {object} [options]
 * @param {boolean} [options.strict] — brez strukturnega fallbacka (produkcijski gate)
 */
export async function verifyCredentialJwt(jwt, expectedIssuerDid = null, options = {}) {
    const { strict = false, statusCallbackUri = process.env.VERIFIER_STATUS_CALLBACK_URL || null } = options;

    if (!jwt || typeof jwt !== 'string') {
        return { verified: false, message: 'Manjka JWT credential', structuralOnly: false };
    }

    try {
        const credentialType = getCredentialTypeFromJwt(jwt);
        const session = await initOid4vpVerificationSession(credentialType, { statusCallbackUri });
        await submitOid4vpPresentation({
            responseUri: session.responseUri,
            state: session.state,
            jwt,
            presentationDefinition: session.presentationDefinition
        });

        const callbackHit = getVerifierCallbackResult(session.state);
        const result = callbackHit || await fetchOid4vpVerificationSession(session.state);
        const signatureOk = policiesPassed(result.policyResults);
        const verified = result.verificationResult === true && signatureOk;

        if (verified) {
            const { issuer, subject } = extractVcParties(jwt);
            const issuerOk = matchesExpectedIssuer({ issuer, subject }, expectedIssuerDid);

            return {
                verified: issuerOk,
                structuralOnly: false,
                issuer,
                subject,
                message: issuerOk
                    ? 'VC kriptografsko preverjen prek Walt.id Verifier API (OID4VP)'
                    : `Podpis veljaven, vendar udeleženec se ne ujema s pričakovanim DID (${expectedIssuerDid})`,
                details: {
                    sessionId: result.id,
                    policyResults: result.policyResults,
                    viaCallback: Boolean(callbackHit)
                }
            };
        }

        console.warn(
            `Walt.id Verifier politike niso uspele (${credentialType}, state=${session.state}):`,
            JSON.stringify(result.policyResults)?.slice(0, 500)
        );
    } catch (error) {
        console.log(`Verifier API OID4VP verify error: ${error.message}`);
    }

    if (strict) {
        return {
            verified: false,
            structuralOnly: false,
            message: 'Kriptografsko preverjanje prek Verifier API ni uspelo (fail-closed)'
        };
    }

    return structuralVerify(jwt, expectedIssuerDid);
}

/**
 * Preveri VC ob prevzemu — čist SSI: presentation iz walleta imetnika (pošiljatelja).
 * JWT iz PostgreSQL se ne uporablja.
 */
export async function verifyCredentialForReceive({
    holderUser,
    expectedIssuerDid,
    credentialType,
    filters = {},
    jwt = null
}) {
    if (holderUser) {
        const resolvedJwt = jwt || await resolveHolderCredentialJwt(holderUser, { credentialType, ...filters });
        if (resolvedJwt) {
            const jwtResult = await verifyCredentialJwt(resolvedJwt, expectedIssuerDid, { strict: true });
            if (jwtResult.verified) {
                return { ...jwtResult, jwt: resolvedJwt, source: 'wallet-api+verifier-api' };
            }
            if (!jwtResult.structuralOnly) {
                return { ...jwtResult, jwt: resolvedJwt, source: 'wallet-api+verifier-api' };
            }
        }

        const walletResult = await verifyCredentialPresentationFromHolder({
            holderUser,
            credentialType,
            expectedIssuerDid,
            filters
        });
        if (walletResult.verified) {
            return {
                ...walletResult,
                jwt: walletResult.jwt || resolvedJwt || await resolveHolderCredentialJwt(holderUser, { credentialType, ...filters })
            };
        }
        return walletResult;
    }

    if (jwt) {
        return verifyCredentialJwt(jwt, expectedIssuerDid, { strict: true });
    }

    return {
        verified: false,
        structuralOnly: false,
        message: 'VC ni v walletu imetnika in ni JWT reference',
        source: 'wallet-api'
    };
}

export function isIssuerConfigured() {
    return Boolean(ISSUER_API);
}

export function isVerifierConfigured() {
    return Boolean(VERIFIER_API);
}
