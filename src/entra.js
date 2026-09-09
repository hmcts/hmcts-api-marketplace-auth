// Creates a real Entra App Registration - a real OAuth client ID and client
// secret - per sandbox consumer application, via Microsoft Graph, using the
// hmcts-api-marketplace-sbox-app-registrar service principal (see
// hmcts/external-entra-id, tenants/sbox/config/apps.yaml) against the
// External ID (CIAM) tenant hmctsextsbox.onmicrosoft.com.
//
// Sandbox only, deliberately - see isConfigured()/the caller in server.js.
// Development/integration-test/production applications still get the
// existing self-issued amp_-prefixed key from issueApiKey() in server.js,
// unchanged.
const { getSecret } = require('./secrets');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function isConfigured() {
  return Boolean(getSecret('ENTRA-TENANT-ID') && getSecret('ENTRA-CLIENT-ID') && getSecret('ENTRA-CLIENT-SECRET'));
}

// Cached in memory for its lifetime (an hour, typically) rather than
// fetched on every request - this only ever runs once per application
// creation, but there is no reason to make an extra round trip when the
// token is still valid.
let cachedToken = null;

async function getGraphToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const tenantId = getSecret('ENTRA-TENANT-ID');
  const clientId = getSecret('ENTRA-CLIENT-ID');
  const clientSecret = getSecret('ENTRA-CLIENT-SECRET');

  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to authenticate to Microsoft Graph: ${response.status} ${body}`);
  }

  const data = await response.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function graphRequest(token, path, options = {}) {
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph API ${options.method || 'GET'} ${path} failed: ${response.status} ${body}`);
  }

  // addPassword and application creation both return a body; a 204 (e.g.
  // some delete calls, not used here yet) would not.
  return response.status === 204 ? null : response.json();
}

// Creates the app registration, a service principal for it (required before
// it can authenticate at all - Graph does not create one automatically the
// way the Portal does), and an initial client secret. Returns the values
// the rest of the application needs to store and show the consumer.
async function createAppRegistration(displayName) {
  const token = await getGraphToken();

  const application = await graphRequest(token, '/applications', {
    method: 'POST',
    body: JSON.stringify({ displayName, signInAudience: 'AzureADMyOrg' }),
  });

  await graphRequest(token, '/servicePrincipals', {
    method: 'POST',
    body: JSON.stringify({ appId: application.appId }),
  });

  const endDateTime = new Date();
  endDateTime.setMonth(endDateTime.getMonth() + 12);

  const password = await graphRequest(token, `/applications/${application.id}/addPassword`, {
    method: 'POST',
    body: JSON.stringify({
      passwordCredential: {
        displayName: 'Generated at application creation',
        endDateTime: endDateTime.toISOString(),
      },
    }),
  });

  return {
    appId: application.appId,
    objectId: application.id,
    secretText: password.secretText,
    keyId: password.keyId,
  };
}

// Used by "Generate another client secret" (see the client-secrets route in
// server.js) - the app registration already exists, this just adds a new
// secret the same way the Portal's "New client secret" does. keyId (Graph's
// ID for this specific password credential, not the app itself) must be
// stored against whatever record represents this secret in our own
// database - removePassword() below needs it to remove this exact one
// later, since an app registration can hold several passwords at once.
async function addPassword(objectId) {
  const token = await getGraphToken();

  const endDateTime = new Date();
  endDateTime.setMonth(endDateTime.getMonth() + 12);

  const password = await graphRequest(token, `/applications/${objectId}/addPassword`, {
    method: 'POST',
    body: JSON.stringify({
      passwordCredential: {
        displayName: 'Generated at rotation',
        endDateTime: endDateTime.toISOString(),
      },
    }),
  });

  return { secretText: password.secretText, keyId: password.keyId };
}

// Used by the "Delete" action on the client-secrets page - removes this one
// password credential from the app registration, not the app registration
// itself (an app can, and here always does, have several).
async function removePassword(objectId, keyId) {
  const token = await getGraphToken();
  await graphRequest(token, `/applications/${objectId}/removePassword`, {
    method: 'POST',
    body: JSON.stringify({ keyId }),
  });
}

module.exports = { isConfigured, createAppRegistration, addPassword, removePassword };
