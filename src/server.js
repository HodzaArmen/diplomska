const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// walt.id API URL-ji iz docker-compose
const WALLET_API = 'http://localhost:7001/wallet-api';
const ISSUER_API = 'http://localhost:7002';
const VERIFIER_API = 'http://localhost:7003';

// 1. USTVARJANJE DENARNICE (za Lekarno/Pacienta)
app.post('/api/wallet/register', async (req, res) => {
    try {
        const response = await axios.post(`${WALLET_API}/auth/register`, {
            type: "email",
            name: req.body.name || "Lekarna Ljubljana",
            email: req.body.email || "lekarna@zdravstvo.si",
            password: req.body.password || "geslo123"
        }); // 
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. IZDAJA POVERILNICE (Farmacevtsko podjetje izda potrdilo o zdravilu)
app.post('/api/issuer/issue', async (req, res) => {
    try {
        const credentialPayload = {
            issuerKey: {
              type: "jwk",
              jwk: { "kty": "OKP", "d": "JvJIpga2GD8LJeRu4Sv-mL4thE31DuFlr9PA04CIoZY", "crv": "Ed25519", "kid": "iJMS5bkZVIlncfq_Lf_SuxJ2JtQ5Hvaz7tWPnAjUUds", "x": "FZdvwC8aGhRwqzWptej0NZgtwYAI1SyFg1mKDETOfqE" }
            }, // Zamenjaj s pravimi ključi v produkciji [cite: 24]
            issuerDid: "did:jwk:eyJrdHkiOiJPS1AiLCJjcnYiOiJFZDI1NTE5Iiwia2lkIjoiaUpNUzVia1pWSWxuY2ZxX0xmX1N1eEoySnRRNUh2YXo3dFdQbkFqVVVkcyIsIngiOiJGWmR2d0M4YUdoUndxeldwdGVqME5aZ3R3WUFJMVN5RmcxbUtERVRPZnFFIn0",
            credentialConfigurationId: "UniversityDegree_jwt_vc_json", // Za test uporabi tole, v diplomi pa ustvari 'MedicineCredential_jwt_vc_json' [cite: 38]
            credentialData: {
              "@context": ["https://www.w3.org/2018/credentials/v1"],
              "id": `http://farmacija.si/credentials/${Date.now()}`,
              "type": ["VerifiableCredential", "MedicineCredential"], // Prilagojeno za zdravilo
              "issuer": { "id": "did:web:farmacija.si" },
              "issuanceDate": new Date().toISOString(),
              "credentialSubject": {
                "id": req.body.subjectDid || "did:example:lekarna123",
                "medicine": {
                  "name": "Aspirin 500mg",
                  "batchNumber": "BATCH-99823",
                  "expiryDate": "2028-05-01",
                  "manufacturer": "Farmacevtska Tovarna d.d."
                }
              }
            },
            mapping: { "id": "<uuid>", "issuer": { "id": "<issuerDid>" }, "credentialSubject": { "id": "<subjectDid>" }, "issuanceDate": "<timestamp>" },
            authenticationMethod: "PRE_AUTHORIZED" // [cite: 47]
        };

        const response = await axios.post(`${ISSUER_API}/openid4vc/jwt/issue`, credentialPayload); // [cite: 24]
        res.json({ offerUrl: response.data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. PREVERJANJE (Inšpektor generira zahtevo za preverjanje)
app.post('/api/verifier/verify', async (req, res) => {
    try {
        const response = await axios.post(`${VERIFIER_API}/openid4vc/verify`, {
            request_credentials: [
                { type: "MedicineCredential", format: "jwt_vc_json" } // Zahtevamo poverilnico o zdravilu
            ]
        }, {
            headers: {
                'authorizeBaseUrl': 'openid4vp://authorize', // 
                'responseMode': 'direct_post' // 
            }
        });
        res.json({ authorizationRequestUrl: response.data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`UI Server teče na http://localhost:${PORT}`));