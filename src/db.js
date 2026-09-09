const { Pool } = require('pg');
const { getSecret } = require('./secrets');

const DATABASE_URL = getSecret('DATABASE-URL');

if (!DATABASE_URL) {
  console.error(
    'DATABASE-URL is not set. Set it as a DATABASE_URL environment variable (Render, local ' +
    'dev) or as a mounted DATABASE-URL Key Vault secret (AKS).'
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Render's managed Postgres requires SSL, but uses a certificate that
  // Node won't automatically trust as a public CA - this is the standard,
  // documented way to connect to it. The Azure Database for PostgreSQL
  // Flexible Server infrastructure/ provisions also requires SSL
  // (sslmode=require is baked into the DATABASE-URL Terraform writes), so
  // this setting is correct for both.
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      organisation TEXT,
      role TEXT NOT NULL CHECK (role IN ('consumer', 'producer')),
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // "My applications and teams" - Phase 1 (see the design doc: no teams yet,
  // every application is owned directly by the user who created it).
  // Ids are generated in application code (crypto.randomUUID()) rather than
  // a DB-side default, so this doesn't depend on any Postgres extension
  // (pgcrypto/uuid-ossp) being available on the hosting Postgres instance.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'development', 'integration-test', 'production')),
      owner_type TEXT NOT NULL CHECK (owner_type IN ('user')),
      owner_id INTEGER NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      public_key_url TEXT,
      callback_url TEXT,
      custom_attributes JSONB NOT NULL DEFAULT '{}',
      connected_apis JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (owner_type, owner_id, name, environment)
    );
  `);

  // Migration for databases created before the uniqueness constraint above
  // included environment - CREATE TABLE IF NOT EXISTS is a no-op against an
  // existing table, so an already-deployed database keeps its original
  // (owner_type, owner_id, name) constraint (with no way to hold a sandbox
  // and a production application under the same name) until this runs.
  // Idempotent: safe to run on every boot, on a database that's already
  // been migrated or one that was created fresh with the constraint above.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'applications_owner_type_owner_id_name_key'
      ) THEN
        ALTER TABLE applications DROP CONSTRAINT applications_owner_type_owner_id_name_key;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'applications_owner_type_owner_id_name_environment_key'
      ) THEN
        ALTER TABLE applications
          ADD CONSTRAINT applications_owner_type_owner_id_name_environment_key
          UNIQUE (owner_type, owner_id, name, environment);
      END IF;
    END $$;
  `);

  // Team members - Phase 2 of the design doc. An application's owner can
  // invite others by email; membership is looked up by the signed-in
  // caller's own email (from their JWT), not a foreign key to users.id, so
  // inviting someone who hasn't registered yet still works - their row just
  // sits unmatched until they sign up with that address. The owner is not a
  // row here; they always have full access, checked separately.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS application_team_members (
      id UUID PRIMARY KEY,
      application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('developer', 'administrator')),
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (application_id, email)
    );
  `);

  // Raw keys are never stored, only bcrypt hashes, matching password
  // handling above - the raw value is returned once, at creation time, and
  // never again. key_preview (last 4 chars) is what the UI shows afterwards.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY,
      application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL,
      key_preview TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ
    );
  `);

  // Submissions from the three "ask the marketplace team for something"
  // forms - request API access, publish an API, request a new API - so a
  // signed-in user can see their own submission history on their account
  // dashboard. `details` is deliberately a JSONB bag rather than a column
  // per field, the same choice already made for applications.custom_attributes:
  // the three forms collect different fields, and a schema change every time
  // a form's fields change is worse than one flexible column all three share.
  // `status` has no CHECK constraint - there is no review workflow yet, only
  // ever 'submitted', and constraining it now would just mean a migration
  // later to add whatever status a real workflow needs.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS requests (
      id UUID PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('access-request', 'publish-api', 'new-api')),
      owner_id INTEGER NOT NULL REFERENCES users(id),
      reference TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'submitted',
      details JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = { pool, initDb };
