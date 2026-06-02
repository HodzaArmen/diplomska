/**
 * waltid-ssi.js
 * Walt.id Issuer (signed VC) and Verifier integration
 */

import axios from 'axios';
import crypto from 'crypto';

const ISSUER_API = process.env.WALT_ISSUER_API_URL || 'http://issuer-api:7002';
const VERIFIER_API = process.env.WALT_VERIFIER_API_URL || 'http://verifier-api:7003';

let cachedIssuerKey = null;

function parseCredentialOffer(offerResponse) {
    if (!offerResponse) {
        throw new Error('Issuer ni vrnil credential offer');
    }

    if (typeof offerResponse === 'object' && offerResponse.credential_issuer) {
        return offerResponse;
    }

    let offerStr = String(offerResponse).trim();

    if (offerStr.startsWith('openid-credential-offer://')) {
        const query = offerStr.includes('?') ? offerStr.split('?').slice(1).join('?') : '';
        const params = new URLSearchParams(query);
        const encoded = params.get('credential_offer');
        if (encoded) {
            offerStr = decodeURIComponent(encoded);
        }
    }

    return JSON.parse(offerStr);
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

async function claimCredentialFromOffer(offer, credentialConfigurationId) {
    const issuerBase = offer.credential_issuer.replace(/\/$/, '');
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
            timeout: 30000
        }
    );

    const accessToken = tokenResponse.data.access_token;
    if (!accessToken) {
        throw new Error('Issuer token endpoint ni vrnil access_token');
    }

    const credentialRequest = {
        format: 'jwt_vc_json',
        credential_definition: {
            '@context': ['https://www.w3.org/2018/credentials/v1'],
            type: ['VerifiableCredential', credentialConfigurationId.replace('_jwt_vc_json', '')]
        }
    };

    const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    };

    if (tokenResponse.data.c_nonce) {
        headers.c_nonce = tokenResponse.data.c_nonce;
    }

    const credentialResponse = await axios.post(
        `${issuerBase}/credential`,
        credentialRequest,
        { headers, timeout: 30000 }
    );

    const jwt = credentialResponse.data?.credential
        || credentialResponse.data?.credentials?.[0]?.credential
        || credentialResponse.data;

    if (typeof jwt !== 'string' || !jwt.includes('.')) {
        throw new Error('Issuer credential endpoint ni vrnil JWT');
    }

    return jwt;
}

/**
 * Issue a signed JWT VC via Walt.id Issuer API (OID4VCI pre-authorized flow)
 */
export async function issueSignedCredential({
    credentialConfigurationId,
    credentialData,
    mapping,
    subjectDid
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
            headers: { 'Content-Type': 'application/json', accept: 'text/plain, application/json' },
            timeout: 60000
        }
    );

    const offer = parseCredentialOffer(issueResponse.data);
    const jwt = await claimCredentialFromOffer(offer, credentialConfigurationId);

    return {
        jwt,
        issuerDid,
        credentialOffer: offer,
        signed: true
    };
}

export async function issueMedicineCredential(medicine, manufacturer) {
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

    return issueSignedCredential({
        credentialConfigurationId: 'MedicineCredential_jwt_vc_json',
        credentialData,
        subjectDid: manufacturer.did
    });
}

export async function issueTransportCredential(delivery, distributor, medicine) {
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

    return issueSignedCredential({
        credentialConfigurationId: 'MedicineTransportCredential_jwt_vc_json',
        credentialData,
        subjectDid: distributor.did
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

    const issuerOk = !expectedIssuerDid || issuer === expectedIssuerDid;

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
 * Verify JWT VC using Walt.id Verifier API (with structural fallback)
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
            if (response.data?.verificationResult === true || response.data?.verified === true) {
                return {
                    verified: true,
                    message: 'VC kriptografsko preverjen prek Walt.id Verifier API',
                    details: response.data
                };
            }
        }
    } catch (error) {
        console.log(`Verifier API direct verify: ${error.message}`);
    }

    try {
        const response = await axios.post(
            `${VERIFIER_API}/openid4vc/policy/signature/verify`,
            { verifiableCredential: jwt, credential: jwt },
            { timeout: 30000, validateStatus: () => true }
        );

        if (response.status === 200) {
            const success = response.data?.is_success
                ?? response.data?.valid
                ?? response.data?.verificationResult;
            if (success) {
                return {
                    verified: true,
                    message: 'VC podpis preverjen (signature policy)',
                    details: response.data
                };
            }
        }
    } catch (error) {
        console.log(`Verifier signature policy: ${error.message}`);
    }

    return structuralVerify(jwt, expectedIssuerDid);
}

export function isIssuerConfigured() {
    return Boolean(ISSUER_API);
}

export function isVerifierConfigured() {
    return Boolean(VERIFIER_API);
}
