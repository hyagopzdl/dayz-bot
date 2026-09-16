-- DEVELOPMENT ONLY
-- Reset application data created by onboarding/tests while preserving schemas.
-- DO NOT run against a production database containing real tenant data.
-- This intentionally does not touch Nitrado/DayZ server files.

BEGIN;

-- Tenant / admin identity and access
TRUNCATE TABLE
  admin_server_access,
  admin_organization_memberships,
  admin_users
RESTART IDENTITY CASCADE;

-- Managed tenant configuration
TRUNCATE TABLE
  managed_servers,
  managed_organizations,
  organization_integrations
RESTART IDENTITY CASCADE;

-- Application/runtime persistence that can retain server-scoped test state.
-- CASCADE is used so dependent indexes/relations are handled by PostgreSQL.
TRUNCATE TABLE
  bot_state,
  player_stats
RESTART IDENTITY CASCADE;

COMMIT;
