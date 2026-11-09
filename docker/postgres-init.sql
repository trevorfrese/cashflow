-- Runs once when the volume is first created. Adds a separate database for integration tests.
CREATE DATABASE cashflow_test;
GRANT ALL PRIVILEGES ON DATABASE cashflow_test TO cashflow;
