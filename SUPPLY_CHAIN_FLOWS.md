# 🏥 Farmacevtski Supply Chain - Diagram Tokov in Logika Podatkov

## 📋 Povzetek Sistema

Sistem je razdeljen na tri glavne vloge:
1. **🏭 PROIZVAJALEC (Manufacturer)** - Ustvari in registrira zdravila
2. **📦 DISTRIBUTOR (Distributor)** - Prejme zdravila in jih pošlje lekarnama
3. **💊 LEKARNA (Pharmacy)** - Prejme zdravila in preveri njihovo avtentičnost

---

## 🏭 1. FLOW PROIZVAJALCA (Manufacturer)

### Koraki Procesa:

```
┌─────────────────────────────────────────────────────────────────┐
│                    PROIZVAJALEC - TOK PODATKOV                  │
└─────────────────────────────────────────────────────────────────┘

1. IZBIRA IN OPIS ZDRAVILA
   ↓
2. ZBIRANJE PODATKOV
   ├─ Zdravilo (Aspirin, Antibiotika, itd.)
   ├─ Količina (število enot)
   ├─ Batch/Serijska Številka
   ├─ Datum Poteka
   ├─ Opis (dodatni podatki)
   └─ Izbira Lekarne za Dostavo
   ↓
3. KREIRANJE VC (Verifiable Credential)
   └─ Walt.id Issuer API → Digitalna Poverilnica
   ↓
4. NALAGANJE NA IPFS
   ├─ Podatki + VC → Pinata IPFS
   └─ Prejmi: IPFS Hash (npr. QmXxxx...)
   ↓
5. REGISTRACIJA NA BLOCKCHAINU
   ├─ medicineId + IPFS Hash
   └─ Ethereum Smart Contract → Blockchain Sepolia
   ↓
6. STATUS: "MANUFACTURING_COMPLETE"
   └─ Dodaj v dostavo - "Ready for Distribution"
```

### Podrobni Koraki:

#### **Korak 1: Izbira Zdravila**
- **Možnost 1**: Izbira iz predpripravljenega seznama
  - Aspirin 500mg
  - Antibiotika Amoxicillin
  - Vitamini kompleks B
  - ... (razširljiv seznam)
- **Možnost 2**: Dodaj Custom Zdravilo
  - Lastna imena zdravila in specifikacije

#### **Korak 2: Zbiranje Podatkov**
```json
{
  "medicineInfo": {
    "medicineId": "MED-2024-001",
    "name": "Aspirin 500mg",
    "serialNumber": "SN-12345678",
    "batchNumber": "BATCH-2024-001",
    "quantity": 1000,
    "expiryDate": "2026-12-31",
    "description": "Analgetik in antipropestnik",
    "manufacturerDID": "did:key:z6Mkr...",
    "targetPharmacy": "Lekarna Ljubljana - Mestni trg",
    "manufacturingDate": "2024-01-15"
  }
}
```

#### **Korak 3: Kreiranje VC (Verifiable Credential)**
```
MANUFACTURER DASHBOARD
↓
Walt.id Issuer API (port 7002)
    └─ POST /credentials/issue
       ├─ Subject: medicineInfo
       ├─ Issuer: Manufacturer DID
       └─ Timestamp: now
↓
Prejete VC
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "MedicineCredential"],
  "issuer": "did:key:manufacturer...",
  "issuanceDate": "2024-01-15T10:00:00Z",
  "credentialSubject": {
    "medicineId": "MED-2024-001",
    "name": "Aspirin 500mg",
    ...
  }
}
```

#### **Korak 4: Nalaganje na IPFS**
```
VC + medicineInfo
    ↓
Pinata IPFS Upload
    ├─ API: https://api.pinata.cloud/pinning/pinJSONToIPFS
    └─ Vrne: IPFS Hash
        └─ "QmZa8aSu3hzRHK3k7RvX..."
```

#### **Korak 5: Registracija na Blockchainu**
```
Smart Contract Call:
    registerMedicine(
        medicineId = "MED-2024-001",
        ipfsHash = "QmZa8aSu3hzRHK3k7RvX..."
    )
    
Ethereum Sepolia Blockchain:
    ✓ Transakcija poslana
    ✓ Block potrjen
    └─ Permanent on-chain record
```

#### **Korak 6: Dodaj v Dostavo**
```
Zdravilo je sedaj "Ready for Distribution"
    ↓
Distributor vidi v svojem seznamu:
    - MED-2024-001 (Aspirin) - 1000 enot
    - Target Pharmacy: Lekarna Ljubljana
    - Batch: BATCH-2024-001
```

---

## 📦 2. FLOW DISTRIBUTORJA (Distributor)

### Koraki Procesa:

```
┌─────────────────────────────────────────────────────────────────┐
│                    DISTRIBUTOR - TOK PODATKOV                   │
└─────────────────────────────────────────────────────────────────┘

1. PREGLEDAJ DOSTAVO OD PROIZVAJALCA
   └─ Seznam zdravil "Ready for Distribution"
   ↓
2. IZBIRA ZDRAVIL
   ├─ Izberi izmed dostupnih serij
   ├─ Izberi količino za dostavo
   └─ Potrdi sprejem
   ↓
3. KREIRANJE VC ZA DISTRIBUTOR
   └─ Walt.id Issuer API → Distributor VC
      └─ Potrdilo o prevzemu od proizvajalca
   ↓
4. IZBIRA DESTINACIJE (LEKARNE)
   ├─ Izberi katero lekarne
   ├─ Izberi količino za vsako
   └─ Spremi dostave
   ↓
5. KREIRANJE TRANSPORTNE VC
   └─ Potrdilo o pošiljki
      ├─ medicineId
      ├─ Količina
      ├─ Origin: Manufacturer
      ├─ Destination: Pharmacy
      └─ Timestamp
   ↓
6. NALAGANJE NA IPFS
   ├─ Transport VC → Pinata
   └─ Prejmi: Transport IPFS Hash
   ↓
7. REGISTRACIJA NA BLOCKCHAINU
   ├─ updateMedicineStatus(medicineId, "IN_TRANSIT")
   └─ Blockchain Sepolia
   ↓
8. STATUS: "IN_TRANSIT"
   └─ Lekarna čaka dostavo
```

### Podrobni Koraki:

#### **Korak 1: Pregledaj Dostavo**
```
DISTRIBUTOR DASHBOARD
    ↓
API: GET /api/available-medicines
    ├─ MED-2024-001 (Aspirin) - 1000 enot ✓ Ready
    ├─ MED-2024-002 (Amoxicillin) - 500 enot ✓ Ready
    └─ MED-2024-003 (Vitamini) - 200 enot ✓ Ready
```

#### **Korak 2: Prevzem od Proizvajalca**
```
Distributor izbere zdravilo:
{
  "medicines": [
    {
      "medicineId": "MED-2024-001",
      "batchNumber": "BATCH-2024-001",
      "quantityReceived": 1000,
      "manufacturerDID": "did:key:manufacturer...",
      "receiptTimestamp": "2024-01-16T09:00:00Z"
    }
  ]
}
```

#### **Korak 3: Kreiranje Distributor VC**
```
Walt.id Issuer API → Issue VC
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "DistributorReceipt"],
  "issuer": "did:key:distributor...",
  "issuanceDate": "2024-01-16T09:00:00Z",
  "credentialSubject": {
    "action": "RECEIVED_FROM_MANUFACTURER",
    "medicineId": "MED-2024-001",
    "quantity": 1000,
    "from": "did:key:manufacturer...",
    "timestamp": "2024-01-16T09:00:00Z"
  }
}
```

#### **Korak 4: Izbira Destinacije**
```
Distributor izbere lekarne za dostavo:

DOSTAVA #1:
├─ Lekarna: "Lekarna Ljubljana - Mestni trg"
├─ Zdravilo: "Aspirin 500mg"
├─ Količina: 500 enot
└─ Dostava ID: "SHIP-2024-001"

DOSTAVA #2:
├─ Lekarna: "Lekarna Ljubljana - Tržnica"
├─ Zdravilo: "Aspirin 500mg"
├─ Količina: 500 enot
└─ Dostava ID: "SHIP-2024-002"
```

#### **Korak 5-7: Transport VC in Blockchain**
```
Za vsako dostavo:
    1. Kreiraj Transport VC
    2. Naloži na IPFS → Transport Hash
    3. Poklici updateMedicineStatus na Smart Contract
       ├─ medicineId: "MED-2024-001"
       ├─ status: "IN_TRANSIT"
       ├─ currentHolder: Distributor wallet
       └─ destination: Pharmacy wallet
    4. Blockchain potrdi
```

---

## 💊 3. FLOW LEKARNE (Pharmacy)

### Koraki Procesa:

```
┌─────────────────────────────────────────────────────────────────┐
│                     LEKARNA - TOK PODATKOV                      │
└─────────────────────────────────────────────────────────────────┘

1. PREJMI OBVESTILO O DOSTAVI
   ├─ Distributor pošlje health ali notification
   ├─ Dostava ID: SHIP-2024-001
   └─ Medicineinfo pravi v obvestilu
   ↓
2. PREVERI DOSTAVO
   ├─ Prejmi fizično zdravilo
   ├─ Preberi/Skeniraj ID
   └─ Potrdi sprejem
   ↓
3. KREIRANJE PHARMACY VC
   └─ Walt.id Issuer API → Pharmacy Receipt VC
   ↓
4. NALAGANJE NA IPFS
   ├─ Pharmacy Receipt VC → Pinata
   └─ Prejmi: Pharmacy IPFS Hash
   ↓
5. REGISTRACIJA NA BLOCKCHAINU
   ├─ updateMedicineStatus(medicineId, "DELIVERED")
   └─ Blockchain Sepolia
   ↓
6. VIZUALIZACIJA IN VERIFIKACIJA
   ├─ Prikaži vse podatke o zdravilu
   ├─ Preusmeri na Blockchain za verifikacijo
   ├─ Prikaži Manufacturer VC
   ├─ Prikaži Distributor VC
   ├─ Prikaži Pharmacy VC
   └─ Prikaži celoten zgodovino
   ↓
7. STATUS: "DELIVERED"
   └─ Zdravilo je v lekarnski zalogi
```

### Podrobni Koraki:

#### **Korak 1-2: Prejmi Dostavo**
```
PHARMACY DASHBOARD
    ↓
Notifikacija: "Dostava SHIP-2024-001 je prispela!"
    ├─ Medicineinfo:
    │   ├─ ID: MED-2024-001
    │   ├─ Name: Aspirin 500mg
    │   ├─ Batch: BATCH-2024-001
    │   ├─ Quantity: 500
    │   └─ Expiry: 2026-12-31
    │
    └─ Distributor: "Distributor Ljubljana"
```

#### **Korak 3: Kreiraj Pharmacy Receipt VC**
```
Walt.id Issuer API → Issue VC
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "PharmacyReceipt"],
  "issuer": "did:key:pharmacy...",
  "issuanceDate": "2024-01-17T14:30:00Z",
  "credentialSubject": {
    "action": "RECEIVED_AT_PHARMACY",
    "medicineId": "MED-2024-001",
    "quantity": 500,
    "from": "did:key:distributor...",
    "pharmacy": "did:key:pharmacy...",
    "timestamp": "2024-01-17T14:30:00Z",
    "condition": "Good",
    "verifiedBy": "pharmacist_john_doe"
  }
}
```

#### **Korak 4-5: IPFS + Blockchain**
```
1. Naloži Pharmacy VC na IPFS
   └─ Prejmi: "QmPharmacy123..."

2. Poklici Smart Contract:
   updateMedicineStatus(
       medicineId = "MED-2024-001",
       status = "DELIVERED"
   )
   └─ Block potrjen ✓
```

#### **Korak 6: Vizualizacija in Verifikacija**

```
┌──────────────────────────────────────────────────────────┐
│         LEKARNA - VIZUALIZATOR ZDRAVILA                  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  💊 Aspirin 500mg                                        │
│  ─────────────────────────────────────────────────────   │
│  ID: MED-2024-001                                        │
│  Batch: BATCH-2024-001                                   │
│  Quantity: 500 enot                                      │
│  Expiry: 2026-12-31                                      │
│                                                          │
│  📊 BLOCKCHAIN INFORMACIJE:                              │
│  ─────────────────────────────────────────────────────   │
│  Status: ✓ DELIVERED                                     │
│  Manufacturer: Pharma Corp                               │
│  Distributor: Distributor Ljubljana                      │
│  Current Holder: Lekarna Ljubljana - Mestni trg          │
│                                                          │
│  🔐 VERIGE POVERIL (VC Chain):                           │
│  ─────────────────────────────────────────────────────   │
│  ✓ Manufacturer VC                                       │
│    └─ Datum: 2024-01-15, Hash: QmXxx...                 │
│                                                          │
│  ✓ Distributor VC (Transport)                            │
│    └─ Datum: 2024-01-16, Hash: QmYyy...                 │
│                                                          │
│  ✓ Pharmacy Receipt VC                                   │
│    └─ Datum: 2024-01-17, Hash: QmZzz...                 │
│                                                          │
│  📋 ZGODOVINA (Blockchain Log):                          │
│  ─────────────────────────────────────────────────────   │
│  1. 2024-01-15 10:00 - MANUFACTURED (Pharma Corp)        │
│  2. 2024-01-16 09:00 - IN_TRANSIT (Distributor Ljub)     │
│  3. 2024-01-17 14:30 - DELIVERED (Lekarna Ljubljana)     │
│                                                          │
│  🔍 VERIFIKACIJA:                                        │
│  ─────────────────────────────────────────────────────   │
│  [ Preveri na Blockchainu ]                              │
│  [ Prenesi Manufacturer VC ]                             │
│  [ Prenesi Transport VC ]                                │
│  [ Prenesi Receipt VC ]                                  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## 🔄 Celoten Podatkovni Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         FARMACEVTSKI SUPPLY CHAIN                        │
│                       POLNI TOK - OD A DO Ž                             │
└─────────────────────────────────────────────────────────────────────────┘

STEP 1: PROIZVAJALEC PRAVI ZDRAVILO
                    │
                    ├─→ 1a. Zbira podatke (Ime, Batch, Količina, Datum Poteka)
                    │       └─→ Izbira Lekarne za Dostavo
                    │
                    ├─→ 1b. Kreiraj VC
                    │       └─→ Walt.id API /credentials/issue
                    │
                    ├─→ 1c. Naloži na IPFS
                    │       └─→ Pinata → IPFS Hash #1
                    │
                    └─→ 1d. Registriraj na Blockchainu
                            └─→ registerMedicine(medicineId, ipfsHash)
                                └─→ Status: MANUFACTURED

STEP 2: DISTRIBUTOR PREJME IN POŠLJE
                    │
                    ├─→ 2a. Vidi zdravilo v "Ready" listi
                    │
                    ├─→ 2b. Prejme od Proizvajalca
                    │       └─→ Kreiraj Distributor Receipt VC
                    │
                    ├─→ 2c. Izbira Lekarne za dostavo
                    │       └─→ Kreiraj Transport VC
                    │           └─→ Naloži na IPFS → IPFS Hash #2
                    │
                    └─→ 2d. Registriraj Status na Blockchainu
                            └─→ updateMedicineStatus("IN_TRANSIT")
                                └─→ Status: IN_TRANSIT

STEP 3: LEKARNA PREJME IN PREVERI
                    │
                    ├─→ 3a. Prejmi Dostavo
                    │       └─→ Fizična Verifikacija
                    │
                    ├─→ 3b. Kreiraj Pharmacy Receipt VC
                    │       └─→ Naloži na IPFS → IPFS Hash #3
                    │
                    ├─→ 3c. Registriraj Status na Blockchainu
                    │       └─→ updateMedicineStatus("DELIVERED")
                    │
                    └─→ 3d. Vizualiziranje in Verifikacija
                            └─→ Prikaži vse VCs in Blockchain podatke
                                └─→ Preusmeri na Blockchainu za verifikacijo


                        ═════════════════════════════════════
                        │  BLOCKCHAIN SEPOLIA REGISTER     │
                        ├─────────────────────────────────┤
                        │ MED-2024-001:                   │
                        │ ├─ IPFS Hash: QmXxx...          │
                        │ ├─ Manufacturer: 0x123...       │
                        │ ├─ Status: DELIVERED            │
                        │ ├─ Current Holder: Pharmacy     │
                        │ └─ Timestamp: 2024-01-17        │
                        │                                 │
                        │ HISTORY:                        │
                        │ 1. MANUFACTURED                │
                        │ 2. IN_TRANSIT                   │
                        │ 3. DELIVERED                    │
                        ═════════════════════════════════════
```

---

## 💾 Podatkovne Strukture

### Medicina Objekt (Medicine Object)
```json
{
  "medicineId": "MED-2024-001",
  "name": "Aspirin 500mg",
  "serialNumber": "SN-12345678",
  "batchNumber": "BATCH-2024-001",
  "quantity": 1000,
  "expiryDate": "2026-12-31",
  "description": "Analgetik in antipropestnik",
  "manufacturerDID": "did:key:z6Mkr...",
  "manufacturingDate": "2024-01-15",
  "targetPharmacy": "Lekarna Ljubljana - Mestni trg",
  "uploadedAt": "2024-01-15T10:00:00Z",
  "version": "1.0"
}
```

### Blockchain Registracija
```json
{
  "medicineId": "MED-2024-001",
  "ipfsHash": "QmXxxx...",
  "manufacturer": "0x123... (signer address)",
  "createdAt": 1705315200,
  "status": "DELIVERED",
  "currentHolder": "0xPharmacy...",
  "currentHolderDID": "did:key:pharmacy...",
  "history": [
    {
      "medicineId": "MED-2024-001",
      "from": "0x123...",
      "fromDID": "did:key:manufacturer...",
      "to": "0x456...",
      "toDID": "did:key:distributor...",
      "timestamp": 1705401600,
      "status": "IN_TRANSIT"
    },
    {
      "medicineId": "MED-2024-001",
      "from": "0x456...",
      "fromDID": "did:key:distributor...",
      "to": "0x789...",
      "toDID": "did:key:pharmacy...",
      "timestamp": 1705488000,
      "status": "DELIVERED"
    }
  ]
}
```

---

## 🔐 Varnostni in Verifikacijski Procesi

### Kaj se Preveri?

```
┌─ MANUFACTURER SIDE ─────────┐
│ ✓ DID authentičnost         │
│ ✓ VC podpis                 │
│ ✓ Medicineinfo integracija  │
│ ✓ IPFS Hash verzafnost      │
│ ✓ Blockchain zapis          │
└────────────────────────────┘

                    ↓

        ┌─ BLOCKCHAIN ─┐
        │ ✓ Immutable  │
        │ ✓ Timestamped│
        │ ✓ Auditable  │
        └──────────────┘

                    ↓

┌─ DISTRIBUTOR SIDE ──────────┐
│ ✓ Prevzem od Manufact.      │
│ ✓ Transport VC              │
│ ✓ Integracija na IPFS       │
│ ✓ Blockchain Status update  │
└────────────────────────────┘

                    ↓

┌─ PHARMACY VERIFICATION ─────┐
│ ✓ Preusmeri na Blockchain   │
│ ✓ Preusmeri IPFS podatke    │
│ ✓ Potrdilo VC verige        │
│ ✓ Fizična verifikacija      │
│ ✓ Sestav in integracija     │
└────────────────────────────┘
```

---

## 🏗️ Tehnična Arhitektura

```
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND APLIKACIJA                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Manufacturer │  │ Distributor  │  │   Pharmacy   │      │
│  │  Dashboard   │  │  Dashboard   │  │  Dashboard   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┴─────────────┐
         │                           │
┌────────▼────────┐      ┌──────────▼────────┐
│  EXPRESS SERVER │      │   POSTGRESQL DB   │
│   (Port 3000)   │      │   (Podatki)       │
├─────────────────┤      └───────────────────┘
│ /api/* routes   │
│ Authentication  │
│ Session mgmt    │
└────────┬────────┘
         │
    ┌────┴────┬────────────┬─────────────┐
    │          │            │             │
┌───▼──┐  ┌───▼──┐  ┌─────▼──┐  ┌─────▼──┐
│Walt.id│  │IPFS/ │  │Ethereum│  │Database│
│API    │  │Pinata│  │Sepolia │  │Tables  │
│       │  │      │  │Blockchain│         │
└───────┘  └──────┘  └────────┘  └────────┘
```

---

## ✅ Povzetek Logike

### Proizvajalec
- ✓ Zbira podatke o zdravilu
- ✓ Kreiraj VC preko Walt.id
- ✓ Naloži VC + podatke na IPFS
- ✓ Prejmi IPFS Hash
- ✓ Registriraj na Blockchainu (registerMedicine)
- ✓ Postavi Status: MANUFACTURED
- ✓ Doda v dostavo

### Distributor
- ✓ Vidi zdravila "Ready for Distribution"
- ✓ Prejme od Proizvajalca (Receipt VC)
- ✓ Izbira Lekarne za dostavo
- ✓ Kreiraj Transport VC
- ✓ Naloži Transport VC na IPFS
- ✓ Update Status na Blockchainu: IN_TRANSIT
- ✓ Pošlje na Lekarne

### Lekarna
- ✓ Prejmi Dostavo
- ✓ Kreiraj Pharmacy Receipt VC
- ✓ Naloži Receipt VC na IPFS
- ✓ Update Status na Blockchainu: DELIVERED
- ✓ Prikaži Vizualizator z vsemi VCs
- ✓ Preveri na Blockchainu za verifikacijo
- ✓ Preusmeri IPFS podatke in VC verige

---

## 📝 Zakaj IPFS?

```
IPFS HASH = Podpisana Kopija Vseh Podatkov na Decentralni Mreži

Prednosti:
✓ Immutable - če se podatki spremenijo, se hash spremeni
✓ Decentralized - dostopno od vsepovsod
✓ Content-addressed - hash predstavlja vsebino, ne lokacijo
✓ Audit Trail - vsaka verzija ima svoj hash
✓ Blockchain Verification - blockchain hrani samo hash, podatki na IPFS
```

---

## 🔗 Zakaj Blockchain?

```
BLOCKCHAIN = Transparent, Immutable, Auditable Log

Prednosti:
✓ Permanent Record - zgodovino ne moremo spremeniti
✓ Decentralized Trust - ni potreben centralni server
✓ Smart Contracts - avtomatiziran status management
✓ Transparency - vsi lahko vidijo istoriju
✓ Supply Chain Tracing - popolna vidljivost medicineinfo poti
```

---

## 🚀 Optionalni Sprošnjaje za Prihodnost

1. **Notifikacije**: Avtomatske notifikacije med fazami
2. **QR Codes**: Skeniranje za brzo verifikacijo
3. **Real-time Tracking**: GPS za Transport
4. **Insurance Integration**: Avtomatske zavarovalnice za dostavo
5. **Regulatory Reports**: Avtomatski JAZMP Reports
6. **Multi-language**: Prevod v več jezikov
7. **Mobile App**: Native aplikacije za distributerje

---

## 📞 API Endpoints Povzetek

```
PROIZVAJALEC:
POST /api/medicines/create          - Kreiraj novo zdravilo
POST /api/medicines/issue-vc        - Kreiraj VC
POST /api/medicines/upload-ipfs     - Naloži na IPFS
POST /api/medicines/register-blockchain - Registriraj na BC
GET /api/medicines/my-medicines     - Prikaži moja zdravila

DISTRIBUTOR:
GET /api/medicines/available        - Prikaži dostopna zdravila
POST /api/distributor/receive       - Prejmi zdravilo
POST /api/distributor/transport-vc  - Kreiraj Transport VC
POST /api/distributor/send-to-pharmacy - Pošji na Lekarne
GET /api/distributor/inventory      - Prikaži inventar

LEKARNA:
GET /api/pharmacy/incoming          - Prikaži dohodne dostave
POST /api/pharmacy/receive          - Prejmi dostavo
POST /api/pharmacy/verify           - Preveri na Blockchainu
GET /api/pharmacy/inventory         - Prikaži inventar
GET /api/pharmacy/medicine-details  - Prikaži Vizualizator
```

---

**Ustvarjeno**: 2024
**Verzija**: 1.0
**Sistem**: Farmacevtski Supply Chain SSI + Blockchain
