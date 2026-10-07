// Issues one real Azure API Management Subscription Key per (application, API), against the shared sandbox APIM
// instance: a PUT to Azure Resource Manager that creates a subscription scoped to the API's Product and returns
// its key in the same response. The same call, in the same form, as the Java service in service-api-marketplace.
//
// Off unless APIM_CLIENT_ID and APIM_CLIENT_SECRET are both set (a service principal allowed to manage
// subscriptions on the instance - it does not exist yet, so nothing here runs until CloudOps create it). With
// them unset, connecting an API works exactly as it always did and simply issues no key. There is deliberately
// no mock key: a made-up key that looks real is worse than no key.
//
// Everything Azure says goes to the log, never to the caller: its URLs carry the subscription and resource
// group, and its error bodies are Azure's business.
const crypto = require('crypto');
const { getSecret } = require('./secrets');

const REQUEST_TIMEOUT_MS = 10_000;
const API_VERSION = '2022-08-01';
const GENERIC_FAILURE = 'Could not issue an API key. Please try again.';

// Identify the shared sandbox instance and do not change per deploy, so they default rather than needing a
// Key Vault entry each. Overridable for another instance, or for a test.
const DEFAULTS = {
  APIM_TENANT_ID: '531ff96d-0ae9-462a-8d2d-bec7c0b42082',
  APIM_SUBSCRIPTION_ID: 'bd2864ed-4f3e-45ed-9c6a-8d179674bab1',
  APIM_RESOURCE_GROUP: 'rg-sps-platform-sbox',
  APIM_SERVICE_NAME: 'sps-api-mgmt-sbox',
};

// Where Microsoft is, unless a local demo or a test points these at a stand-in. Leave unset everywhere real.
const armBase = () => process.env.APIM_ARM_BASE_URL || 'https://management.azure.com';
const loginBase = () => process.env.APIM_LOGIN_BASE_URL || 'https://login.microsoftonline.com';
const setting = (name) => process.env[name] || DEFAULTS[name];

class ApimError extends Error {
  constructor(message = GENERIC_FAILURE) {
    super(message);
    this.name = 'ApimError';
  }
}

function isConfigured() {
  return Boolean(getSecret('APIM-CLIENT-ID') && getSecret('APIM-CLIENT-SECRET'));
}

// APIM_PRODUCT_MAP is "api-id:product-id,api-id:product-id": which APIM Product backs which API, keyed by the
// id the frontend uses for that API. An API with no entry cannot be given a key.
function parseProductMap(text) {
  const map = new Map();
  for (const entry of String(text || '').split(',')) {
    const [apiId, productId] = entry.split(':').map((part) => part && part.trim());
    if (apiId && productId) map.set(apiId.toLowerCase(), productId);
  }
  return map;
}

function productFor(apiId) {
  return parseProductMap(getSecret('APIM-PRODUCT-MAP')).get(String(apiId).toLowerCase());
}

// Short and unique per call, so subscribing again after a delete never meets the old, revoked name.
function subscriptionNameFor(applicationName) {
  const slug = String(applicationName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  return `${slug || 'app'}-${crypto.randomBytes(4).toString('hex')}`;
}

let cachedToken = null;

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const res = await send('POST', `${loginBase()}/${setting('APIM_TENANT_ID')}/oauth2/v2.0/token`, {
    contentType: 'application/x-www-form-urlencoded',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: getSecret('APIM-CLIENT-ID'),
      client_secret: getSecret('APIM-CLIENT-SECRET'),
      scope: 'https://management.azure.com/.default',
    }).toString(),
  });
  if (!res.access_token) {
    console.error('APIM token response had no access_token');
    throw new ApimError();
  }
  cachedToken = { value: res.access_token, expiresAt: Date.now() + (Number(res.expires_in) || 300) * 1000 };
  return cachedToken.value;
}

function subscriptionUrl(name) {
  return `${armBase()}/subscriptions/${setting('APIM_SUBSCRIPTION_ID')}/resourceGroups/${setting('APIM_RESOURCE_GROUP')}`
    + `/providers/Microsoft.ApiManagement/service/${setting('APIM_SERVICE_NAME')}/subscriptions/${encodeURIComponent(name)}`
    + `?api-version=${API_VERSION}`;
}

// One place that talks HTTP. A 404 is fine when `missingIsFine` (a DELETE of something already gone).
async function send(method, url, { token, contentType, body, missingIsFine = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(contentType ? { 'Content-Type': contentType } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`APIM call to ${url} failed:`, err.name === 'TimeoutError' ? 'timed out' : err.message);
    throw new ApimError();
  }
  const text = await res.text();
  if (missingIsFine && res.status === 404) return {};
  if (!res.ok) {
    console.error(`APIM call to ${url} returned ${res.status}: ${text}`);
    throw new ApimError();
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`APIM call to ${url} returned something that is not JSON`);
    throw new ApimError();
  }
}

function requireConfigured() {
  if (!isConfigured()) {
    console.error('APIM_CLIENT_ID / APIM_CLIENT_SECRET are not set');
    throw new ApimError();
  }
}

async function createSubscription(applicationName, productId) {
  requireConfigured();
  const name = subscriptionNameFor(applicationName);
  const created = await send('PUT', subscriptionUrl(name), {
    token: await getToken(),
    contentType: 'application/json',
    body: JSON.stringify({
      properties: { scope: `/products/${productId}`, displayName: `${applicationName} (${productId})` },
    }),
  });
  const key = created && created.properties && created.properties.primaryKey;
  if (!key) {
    console.error('APIM created a subscription but returned no primary key');
    throw new ApimError();
  }
  return { subscriptionName: name, subscriptionKey: key, productId };
}

// Deletes a subscription, and with it its key. One that is already gone is not a failure: the aim is that it
// does not exist, so a delete that stopped half-way can simply be tried again.
async function deleteSubscription(name) {
  requireConfigured();
  await send('DELETE', subscriptionUrl(name), { token: await getToken(), missingIsFine: true });
}

function resetTokenCache() {
  cachedToken = null;
}

module.exports = {
  ApimError, GENERIC_FAILURE, isConfigured, productFor, parseProductMap, subscriptionNameFor,
  createSubscription, deleteSubscription, resetTokenCache,
};
