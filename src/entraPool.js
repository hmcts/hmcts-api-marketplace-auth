// Hands out pre-provisioned Entra app registrations - never creates one at
// request time. The app registrations themselves (Client ID + Client
// Secret) are created in bulk ahead of time by the external-entra-id
// Terraform pipeline (tenants/sbox/config/apps.yaml, entries named
// hmcts-api-marketplace-sbox-pool-NN), the same pattern HMRC's Developer
// Hub uses: registration is instant because it never waits on an external
// identity provider call.
//
// This module only ever talks to two things: this app's own Postgres
// (which pool rows are free/assigned - see entra_app_pool in db.js) and
// Azure Key Vault (to read the one-time-provisioned secret for a row this
// app has just allocated). It never calls the Microsoft Graph
// applications/servicePrincipals API - see src/entra.js, which this
// replaces, for what that looked like and why it was dropped.
const { getSecret } = require('./secrets');
const { pool } = require('./db');

const KEY_VAULT_API_VERSION = '7.4';

function isConfigured() {
  return Boolean(
    getSecret('ENTRA-TENANT-ID') &&
    getSecret('ENTRA-KEYVAULT-READER-CLIENT-ID') &&
    getSecret('ENTRA-KEYVAULT-READER-CLIENT-SECRET') &&
    getSecret('ENTRA-KEYVAULT-URL')
  );
}

// Cached for its lifetime (an hour, typically) - allocation happens once
// per application creation/rotation, so there's no reason to fetch a fresh
// token every time, but this credential is deliberately narrower than the
// old Graph one: it only needs Key Vault Secrets User on the shared Entra
// identity vault (kvspsextidsbox), not Application.ReadWrite.OwnedBy.
let cachedVaultToken = null;

async function getVaultToken() {
  if (cachedVaultToken && cachedVaultToken.expiresAt > Date.now() + 60_000) {
    return cachedVaultToken.value;
  }

  const tenantId = getSecret('ENTRA-TENANT-ID');
  const clientId = getSecret('ENTRA-KEYVAULT-READER-CLIENT-ID');
  const clientSecret = getSecret('ENTRA-KEYVAULT-READER-CLIENT-SECRET');

  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://vault.azure.net/.default',
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to authenticate to Key Vault: ${response.status} ${body}`);
  }

  const data = await response.json();
  cachedVaultToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedVaultToken.value;
}

async function getKeyVaultSecret(secretName) {
  const token = await getVaultToken();
  const vaultUrl = getSecret('ENTRA-KEYVAULT-URL').replace(/\/$/, '');

  const response = await fetch(`${vaultUrl}/secrets/${secretName}?api-version=${KEY_VAULT_API_VERSION}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to read Key Vault secret ${secretName}: ${response.status} ${body}`);
  }

  const data = await response.json();
  return data.value;
}

// Atomically claims one unassigned pool row for this application.
// FOR UPDATE SKIP LOCKED means two applications registering at the same
// instant never race for the same row - each takes the next free one
// unlocked, rather than blocking on or double-allocating one under
// contention. Throws if the pool has run dry - see the module doc comment
// in tenants/sbox/config/apps.yaml (external-entra-id) for topping it up.
async function allocate(applicationId, environment) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, entra_app_id, entra_object_id, key_vault_secret_name
         FROM entra_app_pool
        WHERE environment = $1 AND assigned_application_id IS NULL AND needs_rotation = false
        ORDER BY id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [environment]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(
        `Entra app pool for '${environment}' is exhausted - top up tenants/sbox/config/apps.yaml ` +
        `(external-entra-id) with more hmcts-api-marketplace-${environment}-pool-NN entries and apply.`
      );
    }

    const row = rows[0];
    await client.query(
      `UPDATE entra_app_pool SET assigned_application_id = $1, assigned_at = now() WHERE id = $2`,
      [applicationId, row.id]
    );

    await client.query('COMMIT');

    const secretText = await getKeyVaultSecret(row.key_vault_secret_name);
    return { appId: row.entra_app_id, objectId: row.entra_object_id, secretText };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Frees a pool row - used both when an application is deleted and when a
// consumer regenerates their secret (rotation is "release this row,
// allocate a new one", not a live Graph addPassword call - see the
// "Generate another client secret" route in server.js).
//
// This does NOT make the row available for a new application. It flags
// needs_rotation instead: the just-departed consumer still knows this
// Client ID + Secret, so handing the same row straight to someone else
// would let their old credential keep working against a stranger's
// application. The row only re-enters the pool once something has actually
// rotated its Key Vault secret - today that is a manual re-run of the
// external-entra-id Terraform for this one app (it regenerates the secret
// on every apply); the follow-up piece of work is a scheduled job that does
// this automatically and clears needs_rotation once done. Until that
// exists, a released row is a lost pool slot, not a reusable one - size the
// pool, and how often you top it up, accordingly.
async function release(applicationId) {
  await pool.query(
    `UPDATE entra_app_pool SET assigned_application_id = NULL, assigned_at = NULL, needs_rotation = true
      WHERE assigned_application_id = $1`,
    [applicationId]
  );
}

module.exports = { isConfigured, allocate, release };
