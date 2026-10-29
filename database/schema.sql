-- ============================================================================
-- Local AI Data Analyst - PostgreSQL Database Schema
-- Telemetry and shipment monitoring data schema
-- ============================================================================

-- Table 1: devices
CREATE TABLE IF NOT EXISTS devices (
    device_uid VARCHAR(20) PRIMARY KEY,
    device_id VARCHAR(100) NOT NULL UNIQUE,
    device_type VARCHAR(150) NOT NULL,
    created_at BIGINT NULL -- epoch milliseconds
);

-- Table 2: consignments
CREATE TABLE IF NOT EXISTS consignments (
    consignment_uid BIGINT PRIMARY KEY,
    consignment_id VARCHAR(255) NOT NULL,
    starttime INTEGER NOT NULL, -- epoch seconds
    endtime INTEGER NOT NULL,   -- epoch seconds
    origin VARCHAR(255) NOT NULL,
    destination VARCHAR(255) NOT NULL,
    created_at INTEGER NULL    -- epoch seconds
);

-- Table 3: consignment_devices (associates devices to consignments with threshold configurations)
CREATE TABLE IF NOT EXISTS consignment_devices (
    device_uid VARCHAR(20) NOT NULL REFERENCES devices(device_uid) ON DELETE CASCADE,
    consignment_uid BIGINT NOT NULL REFERENCES consignments(consignment_uid) ON DELETE CASCADE,
    temp_violation_max REAL NOT NULL,
    temp_violation_min REAL NOT NULL,
    temp_warning_max REAL NOT NULL,
    temp_warning_min REAL NOT NULL,
    collection_interval REAL NOT NULL,
    sending_interval REAL NOT NULL,
    PRIMARY KEY (device_uid, consignment_uid)
);

-- Table 4: device_pings (high-frequency telemetry readings)
CREATE TABLE IF NOT EXISTS device_pings (
    device_uid VARCHAR(20) NOT NULL REFERENCES devices(device_uid) ON DELETE CASCADE,
    timestamp INTEGER NOT NULL, -- epoch seconds
    temperature REAL NULL,
    humidity REAL NULL,
    latitude REAL NULL,
    longitude REAL NULL,
    light INTEGER NULL,
    acceleration INTEGER NULL,
    battery REAL NULL,
    created_at INTEGER NULL,    -- epoch seconds
    PRIMARY KEY (device_uid, timestamp)
);

-- Table 5: events (alerts, threshold violations, status transitions)
CREATE TABLE IF NOT EXISTS events (
    device_uid VARCHAR(20) NOT NULL REFERENCES devices(device_uid) ON DELETE CASCADE,
    consignment_uid BIGINT NOT NULL REFERENCES consignments(consignment_uid) ON DELETE CASCADE,
    event_uid VARCHAR(255) PRIMARY KEY,
    timestamp INTEGER NOT NULL, -- epoch seconds
    type VARCHAR(30) NOT NULL,
    level VARCHAR(30) NOT NULL,
    "setValue" TEXT NULL,
    data TEXT NULL,
    created_at INTEGER NULL    -- epoch seconds
);

-- Indexes for optimal analytics query performance
-- Note: composite PKs already cover (device_uid, consignment_uid) on consignment_devices
-- and (device_uid, timestamp) on device_pings.

CREATE INDEX IF NOT EXISTS idx_device_pings_timestamp 
    ON device_pings(timestamp);

CREATE INDEX IF NOT EXISTS idx_device_pings_device_timestamp_desc 
    ON device_pings(device_uid, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_events_consignment_timestamp_desc 
    ON events(consignment_uid, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_events_device_timestamp_desc 
    ON events(device_uid, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_events_level_timestamp_desc 
    ON events(level, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_consignment_devices_consignment_device 
    ON consignment_devices(consignment_uid, device_uid);
