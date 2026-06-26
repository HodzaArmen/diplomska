/**
 * vc-assistant.js — razlaga Verifiable Credentials v kontekstu zdravila
 * Privzeto: strukturirana rule-based razlaga (brez zunanjih API-jev).
 * Opcijsko: Groq / Gemini / OpenAI prek ai-provider.js
 */

import { generateAiText, getAiStatus } from './ai-provider.js';

export { getAiStatus };

const ROLE_LABELS = {
    manufacturer: 'proizvajalec',
    distributor: 'distributer',
    pharmacy: 'lekarna'
};

function labelRole(role) {
    return ROLE_LABELS[role] || role || 'neznana vloga';
}

function fmtDate(iso) {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString('sl-SI');
    } catch {
        return String(iso);
    }
}

function explainMedicineVc(medicine) {
    const claims = medicine.medicineVcClaims;
    if (!claims) {
        return {
            title: 'VC zdravila (MedicineCredential)',
            status: 'manjka',
            text: 'Proizvajalec še ni izdal ali shranil podpisanega MedicineCredential. Brez tega potrdila lekarna ne more kriptografsko preveriti porekla serije.'
        };
    }

    const verified = medicine.vcSigned;
    const lines = [
        `To je **verifikabilno potrdilo (VC)** o ustvarjanju zdravila, ki ga je izdal pooblaščeni **issuer** (Walt.id issuer-api).`,
        `**Zdravilo:** ${claims.medicineName || medicine.name || '—'}`,
        `**Serija (batch):** ${claims.batchNumber || medicine.batchNumber || '—'}`,
        `**Količina:** ${claims.quantity ?? medicine.quantity ?? '—'} enot`,
        `**Rok uporabe:** ${claims.expiryDate || medicine.expiryDate || '—'}`,
        `**Dogodek:** ${claims.eventType || 'MANUFACTURED'}`,
        `**Čas dogodka:** ${fmtDate(claims.eventTimestamp)}`,
        `**Ustvaril:** ${claims.creatorName || claims.manufacturer || medicine.manufacturerName || '—'} (${labelRole(claims.creatorRole || 'manufacturer')})`,
        claims.creatorDID || claims.manufacturerDID
            ? `**DID proizvajalca:** ${claims.creatorDID || claims.manufacturerDID}`
            : null,
        verified
            ? '**Podpis:** Verifier API je potrdil kriptografsko veljavnost JWT (OID4VP politika signature). To pomeni, da podpis ni bil spremenjen in izhaja od zaupanja vrednega izdajatelja.'
            : `**Podpis:** ${medicine.vcVerificationMessage || 'Podpis še ni bil kriptografsko preverjen prek verifier-api.'}`
    ].filter(Boolean);

    return {
        title: 'VC zdravila (MedicineCredential)',
        status: verified ? 'veljavno' : 'opozorilo',
        text: lines.join('\n\n')
    };
}

function explainTransportVc(delivery) {
    const claims = delivery.transportVcClaims;
    if (!claims && !delivery.transportVcSigned) {
        return null;
    }

    const verified = delivery.transportVcVerified;
    const lines = [
        `Transportno potrdilo dokumentira **premik pošiljke** v dobavni verigi.`,
        `**Pošiljka:** ${delivery.deliveryId || '—'}`,
        `**Status (operativno):** ${delivery.status || '—'}`,
        `**Količina:** ${delivery.quantity ?? claims?.quantity ?? '—'} enot`,
        `**Dogodek:** ${claims?.eventType || '—'}`,
        `**Čas:** ${fmtDate(claims?.eventTimestamp)}`,
        claims?.senderName
            ? `**Pošiljatelj:** ${claims.senderName} (${labelRole(claims.senderRole)})`
            : null,
        claims?.recipientName
            ? `**Prejemnik:** ${claims.recipientName} (${labelRole(claims.recipientRole)})`
            : null,
        verified
            ? '**Podpis:** Transport VC je kriptografsko preverjen — pošiljka je dokumentirana s podpisanim JWT.'
            : `**Podpis:** ${delivery.transportVcMessage || 'Transport VC ni bil v celoti preverjen.'}`
    ].filter(Boolean);

    return {
        title: `VC pošiljke (${claims?.eventType || delivery.status})`,
        status: verified ? 'veljavno' : 'opozorilo',
        text: lines.join('\n\n')
    };
}

function explainChainContext(medicine) {
    const onChain = medicine.onChain?.medicine;
    const timeline = medicine.supplyChainHistory || [];

    if (!onChain?.medicineId) {
        return {
            title: 'Blockchain kontekst',
            status: 'manjka',
            text: 'Zdravilo **ni registrirano na pametni pogodbi**. VC in IPFS lahko obstajata, vendar prevzem v distributerju/lekarni fail-closed logika blokira, dokler ni `registerMedicine` na verigi.'
        };
    }

    const steps = timeline.length
        ? timeline.map((h) => `• ${h.actionLabel || h.action} — ${fmtDate(h.timestamp)}`).join('\n')
        : '• Registrirano (MANUFACTURED), handoff dogodki še niso zabeleženi.';

    return {
        title: 'Blockchain kontekst',
        status: 'ok',
        text: [
            `Zdravilo je na verigi **${medicine.dataSources?.chainNetwork || 'blockchain'}** z IPFS hash \`${onChain.ipfsHash || medicine.ipfsHash || '—'}\`.`,
            `**Status:** ${onChain.status || medicine.blockchainStatus}`,
            `**Trenutni lastnik (veriga):** ${medicine.onChain?.currentHolderLabel || onChain.currentHolder || '—'}`,
            `**Pot dogodkov na verigi:**\n${steps}`
        ].join('\n\n')
    };
}

function explainForViewerRole(medicine, viewerRole) {
    const tips = [];

    if (viewerRole === 'manufacturer') {
        tips.push('Kot proizvajalec ste izdajatelj Medicine VC. Preverite, da je IPFS CID enak zapisu na verigi.');
    } else if (viewerRole === 'distributor') {
        tips.push('Kot distributer preverite Medicine VC (poreklo) in Transport VC (SENT_TO_DISTRIBUTOR) pred prevzemom.');
        if (!medicine.vcSigned) {
            tips.push('⚠ Medicine VC ni kriptografsko potrjen — prevzem bo zavrnjen (PONAREDEK).');
        }
    } else if (viewerRole === 'pharmacy') {
        tips.push('Kot lekarna potrebujete celotno verigo: MANUFACTURED → SENT_TO_DISTRIBUTOR → RECEIVED_BY_DISTRIBUTOR → FORWARDED_TO_PHARMACY.');
        const hasChain = Boolean(medicine.onChain?.medicine?.medicineId);
        if (!hasChain) {
            tips.push('⚠ Manjka zapis na verigi — ne izdajajte zdravila pacientom.');
        }
    }

    return {
        title: `Priporočilo za ${labelRole(viewerRole)}`,
        status: 'info',
        text: tips.join('\n\n') || 'Preglejte vse plasti: VC, IPFS, blockchain.'
    };
}

function buildTrustSummary(medicine) {
    const checks = [
        { ok: medicine.vcSigned, label: 'Medicine VC (Verifier)' },
        { ok: Boolean(medicine.ipfsHash && medicine.ipfsVerification?.accessible), label: 'IPFS dostopnost' },
        { ok: Boolean(medicine.onChain?.medicine?.medicineId), label: 'Registracija na verigi' },
        { ok: medicine.ipfsHashOnChain, label: 'IPFS hash na verigi' }
    ];
    const passed = checks.filter((c) => c.ok).length;
    const level = passed === checks.length ? 'visoko' : passed >= 2 ? 'delno' : 'nizko';

    const detail = checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}`).join('\n');

    return {
        title: 'Skupna ocena zaupanja',
        status: level === 'visoko' ? 'veljavno' : level === 'delno' ? 'opozorilo' : 'manjka',
        text: `**Raven zaupanja: ${level}** (${passed}/${checks.length} plasti OK)\n\n${detail}\n\nSistem uporablja fail-closed politiko: če katera plast ne uspe ob prevzemu, se pošiljka označi kot sum ponaredka (HTTP 422).`
    };
}

/**
 * @param {object} medicine — odgovor buildMedicineDetailsResponse
 * @param {string} viewerRole
 * @param {string|null} deliveryId
 */
export function buildVcAssistantExplanation(medicine, viewerRole, deliveryId = null) {
    let deliveries = medicine.deliveries || [];
    if (deliveryId) {
        deliveries = deliveries.filter((d) => d.deliveryId === deliveryId);
    }

    const sections = [
        {
            title: 'Povzetek',
            status: 'info',
            text: [
                `**${medicine.name}** (serija ${medicine.batchNumber}, ID \`${medicine.medicineId}\`)`,
                `Pregledujete podatke kot **${labelRole(viewerRole)}**.`,
                'Spodaj je razlaga verifikabilnih potrdil (W3C VC) v povezavi z IPFS metapodatki in blockchain zapisom.'
            ].join('\n\n')
        },
        explainMedicineVc(medicine),
        ...deliveries.map(explainTransportVc).filter(Boolean),
        explainChainContext(medicine),
        buildTrustSummary(medicine),
        explainForViewerRole(medicine, viewerRole)
    ];

    const fullText = sections.map((s) => `## ${s.title}\n\n${s.text}`).join('\n\n---\n\n');

    return {
        mode: 'rule-based',
        medicineId: medicine.medicineId,
        medicineName: medicine.name,
        viewerRole,
        deliveryId,
        sections,
        summary: sections.find((s) => s.title === 'Skupna ocena zaupanja')?.text?.split('\n')[0] || '',
        fullText
    };
}

export async function enhanceExplanationWithAi(baseExplanation, medicine) {
    const aiStatus = getAiStatus();
    if (!aiStatus.configured) {
        return {
            enhanced: false,
            reason: aiStatus.hint
        };
    }

    const systemPrompt = `Si prijazen asistent v aplikaciji za sledljivost zdravil.
Uporabnik NI tehnična oseba — ne razume blockchain, VC, DID, IPFS.
Razloži v navadni slovenščini, kratko in jasno:
1) Kdo je proizvedel zdravilo in kdaj
2) Kako je potovalo (proizvajalec → distributer → lekarna), korak za korakom
3) Ali so preverjanja uspela (poreklo, pošiljke, zapis poti) — brez žargona, povej kaj to pomeni za varnost pacienta
4) Ali je vse v redu ali kaj manjka / je sumljivo
Ne izmišljuj podatkov. Ne omenjaj OID4VP, JWT, CID. Max 450 besed.`;

    const journeyText = (medicine.journeySteps || [])
        .map((s) => `- ${s.summary || s.actionLabel}`)
        .join('\n');

    const transportVcs = (medicine.deliveries || [])
        .map((d) => {
            const c = d.transportVcClaims;
            if (!c) return `- Pošiljka ${d.deliveryId}: transportno potrdilo ni na voljo`;
            return `- ${c.eventType}: ${c.quantity} en, ${c.senderName || '?'} → ${c.recipientName || '?'}, preverjeno: ${d.transportVcVerified ? 'da' : 'ne'}`;
        })
        .join('\n');

    const userPrompt = `Zdravilo: ${medicine.name} (${medicine.medicineId})
Serija: ${medicine.batchNumber}
Proizvajalec: ${medicine.manufacturerName}
Pregleduje: ${baseExplanation.viewerRole}

Pot po korakih:
${journeyText || 'Ni podatkov o poti'}

Potrdilo o izdelavi (Medicine): preverjeno=${medicine.vcSigned ? 'da' : 'ne'}
Transportna potrdila:
${transportVcs || 'Ni pošiljk'}

Zapis na verigi: ${Boolean(medicine.onChain?.medicine?.medicineId) ? 'da' : 'ne'}
Metapodatki (IPFS) dostopni: ${medicine.ipfsVerification?.accessible ? 'da' : 'ne'}

Napiši razumljivo zgodbo poti tega zdravila za uporabnika dashboarda.`;

    const result = await generateAiText({ systemPrompt, userPrompt });

    if (!result.ok) {
        return {
            enhanced: false,
            reason: result.error,
            provider: result.provider
        };
    }

    return {
        enhanced: true,
        aiSummary: result.text,
        model: result.model,
        provider: result.provider,
        providerLabel: result.providerLabel
    };
}
