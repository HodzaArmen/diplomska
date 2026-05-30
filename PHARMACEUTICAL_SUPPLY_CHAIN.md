# 💊 Pharmaceutical Supply Chain Management System

## Overview

A complete multi-role pharmaceutical supply chain management system built with Node.js/Express, PostgreSQL, Walt.id SSI (Self-Sovereign Identity), IPFS, and Blockchain integration. The system automates the creation, verification, and tracking of medicines through three key roles: Manufacturer, Distributor, and Pharmacy.

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│         PHARMACEUTICAL SUPPLY CHAIN SYSTEM                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  MANUFACTURER        DISTRIBUTOR          PHARMACY          │
│  ─────────────       ────────────         ────────          │
│  • Creates Meds      • Receives Meds      • Receives Meds   │
│  • Issues VCs        • Forwards to        • Visualizes      │
│  • Uploads to IPFS   • Pharmacy           • Verifies        │
│  • Registers on      • Tracks Inventory   • On Blockchain   │
│    Blockchain                                                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
         ↓                    ↓                    ↓
    [Server API]         [Server API]        [Server API]
         ↓                    ↓                    ↓
    [PostgreSQL] ←────── [IPFS/Pinata] ←─── [Blockchain]
         ↓
    [Walt.id Services]
```

## 🔄 Complete Medicine Lifecycle

### Phase 1: Manufacturing & Registration

```
1. Manufacturer Dashboard
   ├─ Select from predefined templates (Aspirin, Amoxicillin, etc.)
   ├─ OR add custom medicine
   ├─ Enter: batch number, quantity, expiry date, description
   └─ Choose target pharmacy

2. Automatic Workflow (POST /api/medicines/create)
   ├─ Create Verifiable Credential (VC)
   │  └─ Contains: medicine info, batch, manufacturer DID, timestamp
   │
   ├─ Upload to IPFS via Pinata
   │  └─ Generates IPFS Hash (content identifier)
   │
   ├─ Register on Blockchain
   │  ├─ Stores: IPFS Hash, Manufacturer Wallet, Status
   │  └─ Status: MANUFACTURED
   │
   └─ Log to Supply Chain History
      └─ Audit trail: created_at, vc_issued_at, ipfs_uploaded_at, blockchain_registered_at

3. Database Storage
   └─ medicines table
      ├─ medicine_id (UUID)
      ├─ name, batch_number, quantity, expiry_date
      ├─ manufacturer_wallet, ipfs_hash
      ├─ blockchain_status: 'MANUFACTURED'
      └─ vc_json (stored JSON of credential)
```

### Phase 2: Distribution

```
1. Distributor Receives Medicine
   GET /api/distributor/available-medicines
   └─ Lists all medicines in MANUFACTURED status

2. Distributor Forwards to Pharmacy
   POST /api/distributor/send-to-pharmacy
   ├─ Input: medicineId, quantity, targetPharmacyName
   ├─ Creates delivery record
   ├─ Updates blockchain status: IN_TRANSIT
   ├─ Logs action to supply_chain_history
   └─ Returns: delivery_id

3. Database Changes
   └─ deliveries table
      ├─ delivery_id (UUID)
      ├─ medicine_id, source_wallet, target_wallet
      ├─ quantity, status: 'PENDING'
      └─ supply_chain_history: 'FORWARDED_TO_PHARMACY'
```

### Phase 3: Pharmacy Reception & Verification

```
1. Pharmacy Receives Delivery
   GET /api/pharmacy/incoming-deliveries
   └─ Lists all pending deliveries

2. Pharmacy Accepts Delivery
   POST /api/pharmacy/receive-delivery
   ├─ Updates delivery status: 'DELIVERED'
   ├─ Updates blockchain status: 'DELIVERED'
   └─ Logs to supply_chain_history: 'RECEIVED_AT_PHARMACY'

3. Pharmacy Visualizes Supply Chain
   GET /api/pharmacy/medicine-details/:medicineId
   └─ Returns full supply chain timeline:
      ├─ 🏭 Manufactured (timestamp, VC issued)
      ├─ 📦 IPFS Upload (hash, timestamp)
      ├─ ⛓️ Blockchain (registered, status, timestamp)
      ├─ 🚚 Forwarded (distributor, timestamp)
      └─ 🏥 Delivered (pharmacy, timestamp)

4. Pharmacy Verifies on Blockchain
   GET /api/pharmacy/verify-blockchain?txHash=...
   ├─ Queries blockchain for transaction
   ├─ Verifies IPFS hash matches
   ├─ Confirms manufacturer wallet
   └─ Returns: verified=true/false, status
```

## 📊 Database Schema

```sql
medicines
├─ id (serial, PK)
├─ medicine_id (text, unique, UUID format)
├─ name (text)
├─ batch_number (text, indexed)
├─ quantity (integer)
├─ expiry_date (date)
├─ description (text)
├─ manufacturer_wallet (text, indexed)
├─ ipfs_hash (text)
├─ blockchain_tx_hash (text)
├─ blockchain_status (enum: MANUFACTURED, IN_TRANSIT, DELIVERED)
├─ vc_json (jsonb)
├─ is_active (boolean)
└─ created_at, updated_at

deliveries
├─ id (serial, PK)
├─ delivery_id (text, unique, UUID format)
├─ medicine_id (UUID)
├─ source_wallet (text)
├─ source_role (enum: manufacturer, distributor)
├─ target_wallet (text)
├─ target_role (enum: distributor, pharmacy)
├─ target_pharmacy_name (text)
├─ quantity (integer)
├─ status (enum: PENDING, IN_TRANSIT, DELIVERED)
└─ created_at

supply_chain_history
├─ id (serial, PK)
├─ medicine_id (UUID)
├─ delivery_id (UUID, nullable)
├─ action (text: CREATED, VC_ISSUED, IPFS_UPLOADED, BLOCKCHAIN_REGISTERED, FORWARDED, RECEIVED)
├─ actor_wallet (text)
├─ actor_role (text)
├─ actor_did (text)
├─ details (jsonb)
└─ created_at

medicine_templates
├─ id (serial, PK)
├─ template_name (text, unique)
├─ template_description (text)

users (extended)
├─ id (serial, PK)
├─ wallet_address (text, unique)
├─ email (text, unique)
├─ role (enum: manufacturer, distributor, pharmacy)
├─ company_name (text)
├─ pharmacy_name (text)
├─ session_id (text, unique)
├─ created_at
└─ last_activity
```

## 🔐 Security Features

### Implemented Protections

1. **UUID v4 for ID Generation**
   - Medicine IDs: `MED-{uuid}`
   - Delivery IDs: `DELIVERY-{uuid}`
   - Cryptographically secure random generation
   - Prevents ID collisions and predictability

2. **XSS Prevention**
   - HTML escaping utility function applied to all dynamic content
   - Event listeners instead of inline onclick handlers
   - Sanitized data attributes
   - Safe DOM manipulation

3. **Rate Limiting**
   - Express rate limiter: 100 requests per 15 minutes per IP
   - Applied to all `/api/*` endpoints
   - Prevents API abuse and DDoS attacks

4. **SQL Injection Prevention**
   - Parameterized queries via PostgreSQL pg library
   - No string concatenation for SQL queries

5. **Session Management**
   - SessionId validation on all protected endpoints
   - Role-based access control (RBAC)
   - Session expiry: 7 days

## 📡 API Endpoints

### Manufacturer Endpoints

```
GET /api/medicines/templates
├─ Auth: sessionId
└─ Returns: { templates: [{ template_name, template_description }] }

POST /api/medicines/create
├─ Auth: sessionId
├─ Body: {
│   medicineName,
│   batchNumber,
│   quantity,
│   expiryDate,
│   description,
│   targetPharmacyName
│ }
└─ Returns: { medicine: {...}, ipfsHash, blockchainStatus }

GET /api/medicines/my-medicines
├─ Auth: sessionId
└─ Returns: { medicines: [{ id, name, batch_number, ... }] }
```

### Distributor Endpoints

```
GET /api/distributor/available-medicines
├─ Auth: sessionId
└─ Returns: { medicines: [{ id, name, manufacturer_wallet, ... }] }

POST /api/distributor/send-to-pharmacy
├─ Auth: sessionId
├─ Body: { medicineId, quantity, targetPharmacyName }
└─ Returns: { delivery: { deliveryId, medicineId, ... } }

GET /api/distributor/my-inventory
├─ Auth: sessionId
└─ Returns: { inventory: [{ name, batch_number, ... }] }
```

### Pharmacy Endpoints

```
GET /api/pharmacy/incoming-deliveries
├─ Auth: sessionId
└─ Returns: { deliveries: [{ id, medicine_name, quantity, ... }] }

POST /api/pharmacy/receive-delivery
├─ Auth: sessionId
├─ Body: { deliveryId, medicineId }
└─ Returns: { delivery: { status: 'DELIVERED' } }

GET /api/pharmacy/medicine-details/:medicineId
├─ Auth: sessionId
└─ Returns: { medicine: { ..., supply_chain_history: [...] } }

GET /api/pharmacy/verify-blockchain?txHash=...
├─ Auth: sessionId
└─ Returns: { verified: true/false, status, ... }

GET /api/pharmacy/my-inventory
├─ Auth: sessionId
└─ Returns: { inventory: [{ name, blockchain_status, ... }] }
```

## 🌐 Frontend Components

### Manufacturer Dashboard (manufacturer-dashboard.html)

```
┌─────────────────────────────────────────────┐
│ User Profile                                 │
├─────────────────────────────────────────────┤
│ Wallet Status: ✓ Wallet: 0x1234...5678     │
├─────────────────────────────────────────────┤
│ 📋 Create New Medicine                      │
│ ┌──────────────────────────────────────────┐│
│ │ Select Medicine: [Dropdown ▼]             ││
│ │                                           ││
│ │ + Add Custom: [_______________]           ││
│ │ Batch Number: [_______________]           ││
│ │ Quantity: [_______________]               ││
│ │ Expiry Date: [_______________]            ││
│ │ Description: [_______________]            ││
│ │ Target Pharmacy: [_______________]        ││
│ │                                           ││
│ │ [🔄 Create Medicine]                      ││
│ └──────────────────────────────────────────┘│
│                                              │
│ 📦 My Medicines                             │
│ ┌──────────────────────────────────────────┐│
│ │ ID │ Name │ Batch │ Qty │ IPFS │ Status  ││
│ │... │ ...  │ ...   │ ... │ ...  │ ...     ││
│ └──────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

### Distributor Dashboard (distributor-dashboard.html)

```
┌─────────────────────────────────────────────┐
│ User Profile & Wallet Status                │
├─────────────────────────────────────────────┤
│ 📦 Available Medicines                      │
│ ┌──────────────────────────────────────────┐│
│ │ Name │ Mfg │ Batch │ Qty │ Status │ Act  ││
│ │ ...  │ ... │ ...   │ ... │ ...    │ ...  ││
│ └──────────────────────────────────────────┘│
│                                              │
│ 🚚 Send to Pharmacy                        │
│ ┌──────────────────────────────────────────┐│
│ │ Medicine: [Selected Medicine]             ││
│ │ Quantity: [_______________]               ││
│ │ Target Pharmacy: [_______________]        ││
│ │ [🚚 Send to Pharmacy]                     ││
│ └──────────────────────────────────────────┘│
│                                              │
│ 📋 My Inventory                             │
│ ┌──────────────────────────────────────────┐│
│ │ Name │ Batch │ Qty │ Expiry │ Status     ││
│ │ ...  │ ...   │ ... │ ...    │ ...        ││
│ └──────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

### Pharmacy Dashboard (pharmacy-dashboard.html)

```
┌─────────────────────────────────────────────┐
│ User Profile & Wallet Status                │
├─────────────────────────────────────────────┤
│ 📬 Incoming Deliveries                      │
│ ┌──────────────────────────────────────────┐│
│ │ Med │ Source │ Batch │ Qty │ Status │ Act││
│ │ ... │ ...    │ ...   │ ... │ ...    │ ...││
│ └──────────────────────────────────────────┘│
│                                              │
│ 🏥 Medicine Visualizer                      │
│ ┌──────────────────────────────────────────┐│
│ │ Medicine Info:                            ││
│ │ ├─ Name: [...]                            ││
│ │ ├─ Batch: [...]                           ││
│ │ ├─ Qty: [...]                             ││
│ │ ├─ Expiry: [...]                          ││
│ │                                           ││
│ │ Supply Chain Timeline:                    ││
│ │ ├─ 🏭 Manufactured (timestamp)            ││
│ │ ├─ 📦 IPFS Uploaded (hash)                ││
│ │ ├─ ⛓️ Blockchain (status)                 ││
│ │ ├─ 🚚 Forwarded (distributor)             ││
│ │ └─ 🏥 Delivered (timestamp)               ││
│ │                                           ││
│ │ Blockchain Verification:                 ││
│ │ ├─ Status: [...]                          ││
│ │ ├─ IPFS Hash: [...]                       ││
│ │ ├─ TX Hash: [...]                         ││
│ │ └─ [🔗 Verify on Blockchain]              ││
│ └──────────────────────────────────────────┘│
│                                              │
│ 📋 My Inventory                             │
│ ┌──────────────────────────────────────────┐│
│ │ Name │ Batch │ Qty │ Expiry │ Status     ││
│ │ ...  │ ...   │ ... │ ...    │ ...        ││
│ └──────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

## 🚀 Getting Started

### Prerequisites

- Node.js (v14+)
- PostgreSQL (v12+)
- Docker (optional)
- Pinata API Key (for IPFS)
- Ethereum RPC endpoint (Sepolia testnet)

### Installation

1. **Clone & Install Dependencies**
   ```bash
   cd /tmp/workspace/HodzaArmen/diplomska/src
   npm install
   ```

2. **Setup Environment Variables**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Initialize Database**
   ```bash
   psql -U postgres -d your_db < db/init.sql
   ```

4. **Start Server**
   ```bash
   npm start
   # Server runs on http://localhost:3000
   ```

## 📋 Predefined Medicines

The system comes with 15+ predefined medicine templates:

- Aspirin 500mg
- Amoxicillin 250mg
- Vitamin C 1000mg
- Ibuprofen 200mg
- Paracetamol 500mg
- And more...

Plus full support for custom medicine names and descriptions.

## 🔍 Audit Trail

Every action is logged to `supply_chain_history`:

```
Action Types:
├─ CREATED: Medicine initially created
├─ VC_ISSUED: Verifiable Credential generated
├─ IPFS_UPLOADED: Data stored on IPFS
├─ BLOCKCHAIN_REGISTERED: Medicine registered on blockchain
├─ FORWARDED_TO_PHARMACY: Sent by distributor
├─ RECEIVED_AT_PHARMACY: Received by pharmacy
├─ VERIFIED_ON_BLOCKCHAIN: Pharmacy verified authenticity
└─ [Custom actions as needed]
```

Each entry contains:
- Timestamp
- Actor (wallet, role, DID)
- Metadata (quantities, changes, etc.)

## 🎯 Key Features

✅ **Automated Workflow**
- Single click creates medicine → VC → IPFS → Blockchain

✅ **Complete Traceability**
- Every action logged with timestamp and actor
- Supply chain timeline visualization

✅ **Security**
- UUID generation (cryptographically secure)
- XSS prevention with HTML escaping
- Rate limiting on all APIs
- SQL injection prevention
- Session management with RBAC

✅ **Interoperability**
- Walt.id SSI integration
- IPFS/Pinata storage
- Ethereum blockchain registration
- PostgreSQL persistent storage

✅ **User-Friendly**
- Role-specific dashboards
- Dropdown templates for common medicines
- Custom medicine support
- Visual supply chain timeline
- One-click blockchain verification

## 🛠️ Development Notes

### Adding New Medicine Templates

Edit `src/db/init.sql` and add to `medicine_templates` INSERT:

```sql
INSERT INTO medicine_templates (template_name, template_description) VALUES
    ('New Medicine', 'Description')
```

### Extending the System

1. **New Roles**: Add role to `users` table and create role-specific endpoints
2. **New Actions**: Add to `supply_chain_history` action types
3. **New Status States**: Extend `blockchain_status` enum in `medicines` table

## 📄 License

This project is part of a diploma thesis for pharmaceutical supply chain management.

## 👥 Support

For issues or questions, refer to:
- SUPPLY_CHAIN_FLOWS.md - Detailed flow diagrams
- API endpoints - RESTful API documentation
- Database schema - PostgreSQL structure

---

**System Status**: ✅ Production Ready

**Last Updated**: 2026-05-28

**Version**: 1.0.0
