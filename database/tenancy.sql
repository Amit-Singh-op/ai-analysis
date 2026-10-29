-- ============================================================================
-- Multi-tenant isolation (spec §5–6). Safe to re-run.
--
-- Ownership hangs off consignments. A client sees a device's pings only while the
-- device is on one of the client's consignments (starttime..endtime).
--
-- Two independent layers, both keyed on the per-transaction setting app.client_id:
--   1. Views (v_*) filter by client. They are owned by analyst_views (NOLOGIN), the only
--      role with SELECT on base tables. The app role analyst_ro can only read the views.
--   2. Row-level security on the base tables applies to analyst_views, so even a view
--      that forgot its WHERE clause could not return another client's rows.
-- Unset / empty app.client_id -> NULL -> no rows (fail closed).
-- ============================================================================

CREATE TABLE IF NOT EXISTS clients (
    client_id BIGINT PRIMARY KEY,
    name TEXT NOT NULL
);

ALTER TABLE consignments ADD COLUMN IF NOT EXISTS client_id BIGINT REFERENCES clients(client_id);
CREATE INDEX IF NOT EXISTS idx_consignments_client ON consignments(client_id);

-- Current tenant, or NULL when unset (never an error, never "all clients")
CREATE OR REPLACE FUNCTION app_client_id() RETURNS BIGINT
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.client_id', true), '')::bigint $$;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'analyst_views') THEN
    CREATE ROLE analyst_views NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'analyst_ro') THEN
    CREATE ROLE analyst_ro LOGIN;
  END IF;
END $$;

-- The app role: read-only, bounded, no base tables
ALTER ROLE analyst_ro SET default_transaction_read_only = on;
ALTER ROLE analyst_ro SET statement_timeout = '15s';
ALTER ROLE analyst_ro SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE analyst_ro CONNECTION LIMIT 20;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM analyst_ro;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO analyst_ro, analyst_views;
GRANT EXECUTE ON FUNCTION app_client_id() TO analyst_ro, analyst_views;

-- The view owner: SELECT on base tables, filtered by RLS below
GRANT SELECT ON clients, consignments, consignment_devices, devices, device_pings, events TO analyst_views;

-- ---------------------------------------------------------------------------
-- Row-level security (defense in depth; applies to analyst_views, not to the
-- table owner used for ingestion/seeding)
-- ---------------------------------------------------------------------------
ALTER TABLE consignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE consignment_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_pings ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant ON clients;
CREATE POLICY tenant ON clients TO analyst_views
  USING (client_id = app_client_id());

DROP POLICY IF EXISTS tenant ON consignments;
CREATE POLICY tenant ON consignments TO analyst_views
  USING (client_id = app_client_id());

DROP POLICY IF EXISTS tenant ON consignment_devices;
CREATE POLICY tenant ON consignment_devices TO analyst_views
  USING (EXISTS (SELECT 1 FROM consignments c WHERE c.consignment_uid = consignment_devices.consignment_uid AND c.client_id = app_client_id()));

DROP POLICY IF EXISTS tenant ON devices;
CREATE POLICY tenant ON devices TO analyst_views
  USING (EXISTS (SELECT 1 FROM consignment_devices cd JOIN consignments c ON c.consignment_uid = cd.consignment_uid
                 WHERE cd.device_uid = devices.device_uid AND c.client_id = app_client_id()));

DROP POLICY IF EXISTS tenant ON device_pings;
CREATE POLICY tenant ON device_pings TO analyst_views
  USING (EXISTS (SELECT 1 FROM consignment_devices cd JOIN consignments c ON c.consignment_uid = cd.consignment_uid
                 WHERE cd.device_uid = device_pings.device_uid AND c.client_id = app_client_id()
                   AND device_pings.timestamp BETWEEN c.starttime AND c.endtime));

DROP POLICY IF EXISTS tenant ON events;
CREATE POLICY tenant ON events TO analyst_views
  USING (EXISTS (SELECT 1 FROM consignments c WHERE c.consignment_uid = events.consignment_uid AND c.client_id = app_client_id()));

-- ---------------------------------------------------------------------------
-- Views: the only surface the app queries. All times in epoch seconds.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_pings_enriched, v_events, v_consignment_devices, v_consignments;

CREATE VIEW v_consignments WITH (security_barrier) AS
SELECT c.consignment_uid, c.consignment_id, c.origin, c.destination, c.starttime, c.endtime
FROM consignments c
WHERE c.client_id = app_client_id();

-- Devices on the client's consignments, with that consignment's thresholds
CREATE VIEW v_consignment_devices WITH (security_barrier) AS
SELECT cd.consignment_uid, c.consignment_id, cd.device_uid, d.device_id, d.device_type,
       (d.created_at / 1000)::bigint AS device_created_at,   -- source is milliseconds
       cd.temp_violation_min, cd.temp_violation_max, cd.temp_warning_min, cd.temp_warning_max,
       c.starttime, c.endtime
FROM consignment_devices cd
JOIN consignments c ON c.consignment_uid = cd.consignment_uid
JOIN devices d ON d.device_uid = cd.device_uid
WHERE c.client_id = app_client_id();

-- Pings inside the client's consignment windows, with thresholds and flags
CREATE VIEW v_pings_enriched WITH (security_barrier) AS
SELECT p.device_uid, d.device_id, d.device_type,
       c.consignment_uid, c.consignment_id, c.origin, c.destination,
       p.timestamp, p.temperature, p.humidity, p.battery, p.light, p.acceleration,
       ROUND(p.latitude::numeric, 2)  AS latitude,     -- coarsened (~1 km)
       ROUND(p.longitude::numeric, 2) AS longitude,
       cd.temp_violation_min, cd.temp_violation_max, cd.temp_warning_min, cd.temp_warning_max,
       (p.temperature > cd.temp_violation_max OR p.temperature < cd.temp_violation_min) AS is_violation,
       (NOT (p.temperature > cd.temp_violation_max OR p.temperature < cd.temp_violation_min)
        AND (p.temperature > cd.temp_warning_max OR p.temperature < cd.temp_warning_min)) AS is_warning
FROM device_pings p
JOIN consignment_devices cd ON cd.device_uid = p.device_uid
JOIN consignments c ON c.consignment_uid = cd.consignment_uid
JOIN devices d ON d.device_uid = p.device_uid
WHERE p.timestamp BETWEEN c.starttime AND c.endtime
  AND c.client_id = app_client_id();

-- Events for the client; free-text columns (data, "setValue") intentionally excluded
CREATE VIEW v_events WITH (security_barrier) AS
SELECT e.event_uid, e.device_uid, d.device_id, e.consignment_uid, c.consignment_id,
       e.timestamp, e.type, e.level
FROM events e
JOIN consignments c ON c.consignment_uid = e.consignment_uid
JOIN devices d ON d.device_uid = e.device_uid
WHERE c.client_id = app_client_id();

ALTER VIEW v_consignments OWNER TO analyst_views;
ALTER VIEW v_consignment_devices OWNER TO analyst_views;
ALTER VIEW v_pings_enriched OWNER TO analyst_views;
ALTER VIEW v_events OWNER TO analyst_views;
GRANT SELECT ON v_consignments, v_consignment_devices, v_pings_enriched, v_events TO analyst_ro;

-- client_id becomes mandatory once every consignment has one (after backfill)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM consignments WHERE client_id IS NULL) THEN
    ALTER TABLE consignments ALTER COLUMN client_id SET NOT NULL;
  END IF;
END $$;
