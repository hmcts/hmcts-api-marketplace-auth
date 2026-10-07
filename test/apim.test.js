const test = require('node:test');
const assert = require('node:assert/strict');

// secrets.js reads from the `config` package, which reads the environment: set what apim.js looks for first.
process.env.APIM_CLIENT_ID = 'apim-client';
process.env.APIM_CLIENT_SECRET = 'apim-secret';
process.env.APIM_PRODUCT_MAP = ' hearing-results : product-1 , Court-Listings:product-2, broken, :x ';
process.env.APIM_TENANT_ID = 'tenant-1';
process.env.APIM_SUBSCRIPTION_ID = 'sub-1';
process.env.APIM_RESOURCE_GROUP = 'rg-1';
process.env.APIM_SERVICE_NAME = 'apim-1';
process.env.APIM_ARM_BASE_URL = 'http://arm.test';
process.env.APIM_LOGIN_BASE_URL = 'http://login.test';

const apim = require('../src/apim');

// A scripted fetch: each call takes the next reply and is recorded.
function scriptFetch(t, replies) {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, ...options });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return { ok: next.status < 300, status: next.status, text: async () => next.body ?? '' };
  });
  return calls;
}

const token = { status: 200, body: JSON.stringify({ access_token: 'arm-token', expires_in: 3600 }) };
const subscription = { status: 201, body: JSON.stringify({ properties: { primaryKey: 'the-key' } }) };

test.beforeEach((t) => {
  apim.resetTokenCache();
  t.mock.method(console, 'error', () => {});
});

test('is configured only when both halves of the credential are set', () => {
  assert.equal(apim.isConfigured(), true);
});

test('the product map is read leniently and by lower-cased api id', () => {
  assert.equal(apim.productFor('hearing-results'), 'product-1');
  assert.equal(apim.productFor('COURT-LISTINGS'), 'product-2');
  assert.equal(apim.productFor('nope'), undefined);
  assert.equal(apim.parseProductMap('a:b').get('a'), 'b');
  assert.equal(apim.parseProductMap(undefined).size, 0);
});

test('a subscription name is a slug of the application name plus a short unique suffix', () => {
  const a = apim.subscriptionNameFor('My App! (sandbox)');
  const b = apim.subscriptionNameFor('My App! (sandbox)');
  assert.match(a, /^my-app-sandbox-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
  assert.match(apim.subscriptionNameFor('!!!'), /^app-[0-9a-f]{8}$/);
});

test('creating a subscription asks for a token, then PUTs one scoped to the product, and returns the key', async (t) => {
  const calls = scriptFetch(t, [token, subscription]);

  const created = await apim.createSubscription('My App', 'product-1');

  assert.equal(created.subscriptionKey, 'the-key');
  assert.equal(created.productId, 'product-1');
  assert.match(created.subscriptionName, /^my-app-[0-9a-f]{8}$/);

  assert.equal(calls[0].url, 'http://login.test/tenant-1/oauth2/v2.0/token');
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_id'), 'apim-client');
  assert.equal(form.get('client_secret'), 'apim-secret');
  assert.equal(form.get('scope'), 'https://management.azure.com/.default');

  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].url, 'http://arm.test/subscriptions/sub-1/resourceGroups/rg-1/providers/'
    + `Microsoft.ApiManagement/service/apim-1/subscriptions/${created.subscriptionName}?api-version=2022-08-01`);
  assert.equal(calls[1].headers.Authorization, 'Bearer arm-token');
  assert.deepEqual(JSON.parse(calls[1].body),
    { properties: { scope: '/products/product-1', displayName: 'My App (product-1)' } });
});

test('the token is reused until it is about to expire', async (t) => {
  const calls = scriptFetch(t, [token, subscription, subscription]);

  await apim.createSubscription('One', 'product-1');
  await apim.createSubscription('Two', 'product-1');

  assert.equal(calls.filter((c) => c.url.includes('/oauth2/')).length, 1);
});

test('deleting a subscription DELETEs it by name with no body', async (t) => {
  const calls = scriptFetch(t, [token, { status: 200, body: '' }]);

  await apim.deleteSubscription('my-app-1a2b3c4d');

  assert.equal(calls[1].method, 'DELETE');
  assert.match(calls[1].url, /\/subscriptions\/my-app-1a2b3c4d\?api-version=2022-08-01$/);
  assert.equal(calls[1].body, undefined);
});

test('deleting one that is already gone is not a failure', async (t) => {
  scriptFetch(t, [token, { status: 404, body: '{"error":"not found"}' }]);

  await assert.doesNotReject(apim.deleteSubscription('already-gone-1a2b3c4d'));
});

test('any other failure gives the generic error and keeps Azure\'s detail out of it', async (t) => {
  scriptFetch(t, [token, { status: 403, body: '{"error":"sub bd2864ed forbidden"}' }]);

  await assert.rejects(apim.createSubscription('My App', 'product-1'), (err) => {
    assert.equal(err.name, 'ApimError');
    assert.equal(err.message, apim.GENERIC_FAILURE);
    assert.ok(!err.message.includes('bd2864ed'));
    return true;
  });
});

test('the detail Azure gave is logged, not lost', async (t) => {
  scriptFetch(t, [token, { status: 500, body: 'azure said no' }]);

  await assert.rejects(apim.createSubscription('My App', 'product-1'));

  assert.ok(console.error.mock.calls.some((c) => String(c.arguments[0]).includes('azure said no')));
});

test('a network failure, a timeout, and a response that is not JSON are all the generic error', async (t) => {
  scriptFetch(t, [new Error('connect ECONNREFUSED')]);
  await assert.rejects(apim.createSubscription('A', 'p'), { name: 'ApimError' });

  apim.resetTokenCache();
  const timeout = new Error('slow');
  timeout.name = 'TimeoutError';
  scriptFetch(t, [timeout]);
  await assert.rejects(apim.createSubscription('A', 'p'), { name: 'ApimError' });

  apim.resetTokenCache();
  scriptFetch(t, [token, { status: 200, body: 'not json' }]);
  await assert.rejects(apim.createSubscription('A', 'p'), { name: 'ApimError' });
});

test('a token response with no token, and a subscription with no key, are refused', async (t) => {
  scriptFetch(t, [{ status: 200, body: '{}' }]);
  await assert.rejects(apim.createSubscription('A', 'p'), { name: 'ApimError' });

  apim.resetTokenCache();
  scriptFetch(t, [token, { status: 201, body: '{}' }]);
  await assert.rejects(apim.createSubscription('A', 'p'), { name: 'ApimError' });
});
