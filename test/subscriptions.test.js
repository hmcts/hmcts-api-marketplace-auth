const test = require('node:test');
const assert = require('node:assert/strict');
const { createSubscriptions, HttpError } = require('../src/subscriptions');

const APP = { id: 'app-1', name: 'My App', connected_apis: [] };

// A database that records what it was asked and answers from a script keyed by a fragment of the SQL.
function fakeDb(answers = {}) {
  const log = [];
  return {
    log,
    async query(sql, params) {
      log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      for (const [fragment, answer] of Object.entries(answers)) {
        if (sql.includes(fragment)) {
          if (answer instanceof Error) throw answer;
          return typeof answer === 'function' ? answer(sql, params) : answer;
        }
      }
      return { rows: [] };
    },
  };
}

function fakeApim(overrides = {}) {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    productFor: (apiId) => ({ 'hearing-results': 'product-1' })[apiId],
    createSubscription: async (name, productId) => {
      calls.push(['create', name, productId]);
      return { subscriptionName: 'my-app-1a2b3c4d', subscriptionKey: 'the-key', productId };
    },
    deleteSubscription: async (name) => { calls.push(['delete', name]); },
    ...overrides,
  };
}

const updatedRow = (apis) => ({ rows: [{ id: 'app-1', connected_apis: apis }] });
const sqlOf = (db) => db.log.map((entry) => entry.sql);

test.beforeEach((t) => t.mock.method(console, 'error', () => {}));

// ----------------------------------------------------------------------------------------------- connect

test('connecting issues a key, stores it, then records the API - Azure first, the database last', async () => {
  const db = fakeDb({ 'UPDATE applications': updatedRow([{ id: 'hearing-results', name: 'Hearing Results' }]) });
  const apim = fakeApim();

  const result = await createSubscriptions({ db, apim }).connect(APP, 'hearing-results', 'Hearing Results');

  assert.deepEqual(apim.calls, [['create', 'My App', 'product-1']]);
  assert.match(sqlOf(db)[0], /^INSERT INTO api_subscriptions/);
  assert.deepEqual(db.log[0].params, ['app-1', 'hearing-results', 'product-1', 'my-app-1a2b3c4d', 'the-key']);
  assert.match(sqlOf(db)[1], /^UPDATE applications SET connected_apis/);
  assert.deepEqual(JSON.parse(db.log[1].params[1]), [{ id: 'hearing-results', name: 'Hearing Results' }]);
  assert.equal(result.connected_apis[0].id, 'hearing-results');
});

test('without an APIM credential it only records the API, as it always did, and asks Azure nothing', async () => {
  const db = fakeDb({ 'UPDATE applications': updatedRow([]) });
  const apim = fakeApim({ isConfigured: () => false });

  await createSubscriptions({ db, apim }).connect(APP, 'hearing-results', 'Hearing Results');

  assert.deepEqual(apim.calls, []);
  assert.deepEqual(sqlOf(db).map((s) => s.split(' ')[0]), ['UPDATE']);
});

test('an API connected twice is refused before anything else happens', async () => {
  const db = fakeDb();
  const apim = fakeApim();
  const application = { ...APP, connected_apis: [{ id: 'hearing-results', name: 'x' }] };

  await assert.rejects(createSubscriptions({ db, apim }).connect(application, 'hearing-results', 'x'),
    (err) => err instanceof HttpError && err.status === 409);

  assert.deepEqual(apim.calls, []);
  assert.deepEqual(db.log, []);
});

test('an API with no APIM Product is turned away before anything is created', async () => {
  const db = fakeDb();
  const apim = fakeApim();

  await assert.rejects(createSubscriptions({ db, apim }).connect(APP, 'no-such-api', 'None'),
    (err) => err instanceof HttpError && err.status === 400 && /not available/.test(err.message));

  assert.deepEqual(apim.calls, []);
  assert.deepEqual(db.log, []);
});

test('when Azure refuses, the caller gets the generic 502 and nothing is written', async () => {
  const db = fakeDb();
  const apim = fakeApim({ createSubscription: async () => { throw new Error('azure detail bd2864ed'); } });

  await assert.rejects(createSubscriptions({ db, apim }).connect(APP, 'hearing-results', 'x'), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 502);
    assert.ok(!err.message.includes('bd2864ed'));
    return true;
  });
  assert.deepEqual(db.log, []);
});

test('a key that could not be stored is deleted in APIM again', async () => {
  const db = fakeDb({ 'INSERT INTO api_subscriptions': new Error('db is down') });
  const apim = fakeApim();

  await assert.rejects(createSubscriptions({ db, apim }).connect(APP, 'hearing-results', 'x'), /db is down/);

  assert.deepEqual(apim.calls, [['create', 'My App', 'product-1'], ['delete', 'my-app-1a2b3c4d']]);
});

test('if recording the API fails after the key was stored, the row and the subscription are both undone', async () => {
  const db = fakeDb({ 'UPDATE applications': new Error('db is down') });
  const apim = fakeApim();

  await assert.rejects(createSubscriptions({ db, apim }).connect(APP, 'hearing-results', 'x'), /db is down/);

  assert.ok(sqlOf(db).some((s) => s.startsWith('DELETE FROM api_subscriptions')));
  assert.deepEqual(apim.calls, [['create', 'My App', 'product-1'], ['delete', 'my-app-1a2b3c4d']]);
});

test('undoing never throws, so it cannot hide the failure being handled', async () => {
  const db = fakeDb({ 'INSERT INTO api_subscriptions': new Error('db is down') });
  const apim = fakeApim({ deleteSubscription: async () => { throw new Error('azure is down too'); } });

  await assert.rejects(createSubscriptions({ db, apim }).connect(APP, 'hearing-results', 'x'), /db is down/);

  assert.ok(console.error.mock.calls.some((c) => /remove it manually/.test(String(c.arguments[0]))));
});

// -------------------------------------------------------------------------------------------- disconnect

test('disconnecting deletes the subscription in APIM before the row, then drops the API', async () => {
  const db = fakeDb({
    'SELECT subscription_name': { rows: [{ subscription_name: 'my-app-1a2b3c4d' }] },
    'UPDATE applications': updatedRow([{ id: 'other', name: 'Other' }]),
  });
  const apim = fakeApim();
  const application = { ...APP, connected_apis: [{ id: 'hearing-results', name: 'x' }, { id: 'other', name: 'Other' }] };

  await createSubscriptions({ db, apim }).disconnect(application, 'hearing-results');

  assert.deepEqual(apim.calls, [['delete', 'my-app-1a2b3c4d']]);
  assert.deepEqual(sqlOf(db).map((s) => s.split(' ').slice(0, 3).join(' ')),
    ['SELECT subscription_name FROM', 'DELETE FROM api_subscriptions', 'UPDATE applications SET']);
  assert.deepEqual(JSON.parse(db.log[2].params[1]), [{ id: 'other', name: 'Other' }]);
});

test('when APIM will not delete the subscription, nothing changes and the key is still shown', async () => {
  const db = fakeDb({ 'SELECT subscription_name': { rows: [{ subscription_name: 'my-app-1a2b3c4d' }] } });
  const apim = fakeApim({ deleteSubscription: async () => { throw new Error('no'); } });

  await assert.rejects(createSubscriptions({ db, apim }).disconnect(APP, 'hearing-results'),
    (err) => err instanceof HttpError && err.status === 502);

  assert.deepEqual(sqlOf(db).map((s) => s.split(' ')[0]), ['SELECT']);
});

test('disconnecting an API that never had a key just drops it', async () => {
  const db = fakeDb({ 'UPDATE applications': updatedRow([]) });
  const apim = fakeApim();

  await createSubscriptions({ db, apim }).disconnect(APP, 'hearing-results');

  assert.deepEqual(apim.calls, []);
  assert.deepEqual(sqlOf(db).map((s) => s.split(' ')[0]), ['SELECT', 'UPDATE']);
});

// ---------------------------------------------------------------------------------------------- delete

test('deleting an application takes every subscription back first', async () => {
  const db = fakeDb({ 'SELECT subscription_name': { rows: [{ subscription_name: 'a-1' }, { subscription_name: 'b-2' }] } });
  const apim = fakeApim();

  await createSubscriptions({ db, apim }).revokeAll(APP);

  assert.deepEqual(apim.calls, [['delete', 'a-1'], ['delete', 'b-2']]);
});

test('when APIM refuses one, the delete is stopped so the keys are not forgotten', async () => {
  const db = fakeDb({ 'SELECT subscription_name': { rows: [{ subscription_name: 'a-1' }, { subscription_name: 'b-2' }] } });
  const apim = fakeApim({ deleteSubscription: async (name) => { if (name === 'a-1') throw new Error('no'); } });

  await assert.rejects(createSubscriptions({ db, apim }).revokeAll(APP),
    (err) => err instanceof HttpError && err.status === 502);
});

// ------------------------------------------------------------------------------------------------ list

test('the keys for an application are listed with the API each belongs to', async () => {
  const db = fakeDb({ 'SELECT api_id': { rows: [{ api_id: 'hearing-results', subscription_key: 'k1' }] } });

  assert.deepEqual(await createSubscriptions({ db, apim: fakeApim() }).listFor('app-1'),
    [{ apiId: 'hearing-results', subscriptionKey: 'k1' }]);
});
