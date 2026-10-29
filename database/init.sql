-- Initialize PostgreSQL database
SELECT 'CREATE DATABASE telemetry_db'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'telemetry_db')\gexec
