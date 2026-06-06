CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    wallet_address VARCHAR(255) UNIQUE NOT NULL,
    role VARCHAR(50) NOT NULL,
    email VARCHAR(255) NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    wallet_connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    walt_id_registered_at TIMESTAMP,
    did VARCHAR(255),
    wallet_id VARCHAR(255),
    walt_email VARCHAR(255),
    walt_api_cookie TEXT,
    session_id VARCHAR(255) UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) UNIQUE NOT NULL,
    wallet_address VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days'),
    last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wallet_address) REFERENCES users(wallet_address) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_session_id ON users(session_id);

-- ===== MEDICINES TABLE =====
CREATE TABLE IF NOT EXISTS medicines (
    id SERIAL PRIMARY KEY,
    medicine_id VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    quantity INTEGER NOT NULL,
    batch_number VARCHAR(255) NOT NULL,
    expiry_date DATE NOT NULL,
    manufacturer_wallet VARCHAR(255) NOT NULL,
    manufacturer_did VARCHAR(255) NOT NULL,
    manufacturer_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ipfs_hash VARCHAR(255),
    blockchain_tx_hash VARCHAR(255),
    blockchain_status VARCHAR(50), -- 'MANUFACTURED', 'IN_TRANSIT', 'DELIVERED'
    vc_credential TEXT, -- JSON serialized VC
    is_active BOOLEAN DEFAULT TRUE,
    FOREIGN KEY (manufacturer_wallet) REFERENCES users(wallet_address) ON DELETE CASCADE
);

-- ===== DELIVERIES TABLE =====
CREATE TABLE IF NOT EXISTS deliveries (
    id SERIAL PRIMARY KEY,
    delivery_id VARCHAR(255) UNIQUE NOT NULL,
    medicine_id VARCHAR(255) NOT NULL,
    source_wallet VARCHAR(255) NOT NULL, -- who sends
    source_role VARCHAR(50) NOT NULL, -- 'manufacturer' or 'distributor'
    target_wallet VARCHAR(255) NOT NULL, -- who receives
    target_role VARCHAR(50) NOT NULL, -- 'distributor' or 'pharmacy'
    target_pharmacy_name VARCHAR(255), -- pharmacy name if target_role is 'pharmacy'
    quantity INTEGER NOT NULL,
    status VARCHAR(50) DEFAULT 'PENDING', -- 'PENDING', 'IN_TRANSIT', 'RECEIVED'
    transport_vc_credential TEXT, -- JSON serialized VC for this shipment
    ipfs_hash VARCHAR(255), -- IPFS hash of this delivery's VC
    blockchain_tx_hash VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    received_at TIMESTAMP,
    pharmacy_receipt_vc TEXT, -- VC created when pharmacy receives
    is_active BOOLEAN DEFAULT TRUE,
    FOREIGN KEY (medicine_id) REFERENCES medicines(medicine_id) ON DELETE CASCADE,
    FOREIGN KEY (source_wallet) REFERENCES users(wallet_address) ON DELETE CASCADE,
    FOREIGN KEY (target_wallet) REFERENCES users(wallet_address) ON DELETE CASCADE
);

-- ===== SUPPLY CHAIN HISTORY TABLE =====
CREATE TABLE IF NOT EXISTS supply_chain_history (
    id SERIAL PRIMARY KEY,
    medicine_id VARCHAR(255) NOT NULL,
    delivery_id VARCHAR(255),
    action VARCHAR(50) NOT NULL, -- 'CREATED', 'VC_ISSUED', 'IPFS_UPLOADED', 'BLOCKCHAIN_REGISTERED', 'IN_TRANSIT', 'DELIVERED'
    actor_wallet VARCHAR(255),
    actor_role VARCHAR(50),
    actor_did VARCHAR(255),
    details TEXT, -- JSON serialized details
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    blockchain_block_number INTEGER,
    blockchain_tx_hash VARCHAR(255),
    FOREIGN KEY (medicine_id) REFERENCES medicines(medicine_id) ON DELETE CASCADE
);

-- ===== PHARMACIES TABLE (for reference) =====
CREATE TABLE IF NOT EXISTS pharmacies (
    id SERIAL PRIMARY KEY,
    pharmacy_wallet VARCHAR(255) UNIQUE NOT NULL,
    pharmacy_name VARCHAR(255) NOT NULL,
    pharmacy_location VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pharmacy_wallet) REFERENCES users(wallet_address) ON DELETE CASCADE
);

-- ===== MEDICINE TEMPLATES (predefined medicines) =====
CREATE TABLE IF NOT EXISTS medicine_templates (
    id SERIAL PRIMARY KEY,
    template_name VARCHAR(255) NOT NULL,
    template_description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert predefined medicine templates
INSERT INTO medicine_templates (template_name, template_description) VALUES
    ('Aspirin 500mg', 'Analgetik in antipiretik'),
    ('Amoxicillin 250mg', 'Antibiotika za zdravljenje okužb'),
    ('Vitamin C 1000mg', 'Dodatak vitamina C'),
    ('Ibuprofen 200mg', 'Protivnetni zdravilnik'),
    ('Paracetamol 500mg', 'Analgetik in antipiretik')
ON CONFLICT DO NOTHING;

-- ===== INDEXES =====
CREATE INDEX IF NOT EXISTS idx_medicines_manufacturer ON medicines(manufacturer_wallet);
CREATE INDEX IF NOT EXISTS idx_medicines_status ON medicines(blockchain_status);
CREATE INDEX IF NOT EXISTS idx_medicines_medicine_id ON medicines(medicine_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_source ON deliveries(source_wallet);
CREATE INDEX IF NOT EXISTS idx_deliveries_target ON deliveries(target_wallet);
CREATE INDEX IF NOT EXISTS idx_deliveries_medicine_id ON deliveries(medicine_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);
CREATE INDEX IF NOT EXISTS idx_supply_chain_history_medicine_id ON supply_chain_history(medicine_id);
CREATE INDEX IF NOT EXISTS idx_supply_chain_history_actor ON supply_chain_history(actor_wallet);
CREATE INDEX IF NOT EXISTS idx_pharmacies_wallet ON pharmacies(pharmacy_wallet);