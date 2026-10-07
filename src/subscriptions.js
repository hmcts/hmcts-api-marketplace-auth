// What connecting an application to an API, disconnecting it, and deleting the application mean for the
// Subscription Keys behind them. Kept apart from the routes so that the order of things, and what is undone
// when something fails, can be tested without a database or Azure: both are handed in.
//
// The order is always the same: refuse what can be refused, ask Azure, write the database last. A failure after
// something was issued undoes it; undoing never throws, so it cannot hide the failure being handled.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const KEY_NOT_ISSUED = 'Could not issue an API key. Please try again.';
const KEY_NOT_REMOVED = 'Could not remove the API key. Please try again.';

function createSubscriptions({ db, apim }) {
  async function undoQuietly(subscriptionName) {
    try {
      await apim.deleteSubscription(subscriptionName);
    } catch (err) {
      console.error(`Could not delete APIM subscription ${subscriptionName} after a failure - remove it manually`);
    }
  }

  async function subscriptionNamesFor(applicationId, apiId) {
    const rows = apiId === undefined
      ? await db.query('SELECT subscription_name FROM api_subscriptions WHERE application_id = $1', [applicationId])
      : await db.query(
        'SELECT subscription_name FROM api_subscriptions WHERE application_id = $1 AND api_id = $2',
        [applicationId, apiId]
      );
    return rows.rows.map((row) => row.subscription_name);
  }

  // Deleted in APIM first, before the row that remembers them: if Azure refuses, the key is still shown and
  // the whole thing can be tried again.
  async function deleteInApim(names) {
    for (const name of names) {
      try {
        await apim.deleteSubscription(name);
      } catch (err) {
        throw new HttpError(502, KEY_NOT_REMOVED);
      }
    }
  }

  async function connect(application, apiId, apiName) {
    const current = application.connected_apis || [];
    if (current.some((api) => api.id === apiId)) {
      throw new HttpError(409, 'That API is already connected.');
    }
    const connected = JSON.stringify([...current, { id: apiId, name: apiName }]);

    // Without an APIM credential this is what it always was: the API is recorded, no key is issued.
    if (!apim.isConfigured()) {
      return (await db.query('UPDATE applications SET connected_apis = $2 WHERE id = $1 RETURNING *',
        [application.id, connected])).rows[0];
    }

    // An API with no Product is turned away before anything exists to undo.
    const productId = apim.productFor(apiId);
    if (!productId) throw new HttpError(400, 'That API is not available yet.');

    let issued;
    try {
      issued = await apim.createSubscription(application.name, productId);
    } catch (err) {
      throw new HttpError(502, KEY_NOT_ISSUED);
    }
    try {
      await db.query(
        `INSERT INTO api_subscriptions (application_id, api_id, product_id, subscription_name, subscription_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [application.id, apiId, productId, issued.subscriptionName, issued.subscriptionKey]
      );
      return (await db.query('UPDATE applications SET connected_apis = $2 WHERE id = $1 RETURNING *',
        [application.id, connected])).rows[0];
    } catch (err) {
      await db.query('DELETE FROM api_subscriptions WHERE application_id = $1 AND api_id = $2',
        [application.id, apiId]).catch(() => undefined);
      await undoQuietly(issued.subscriptionName);
      throw err;
    }
  }

  async function disconnect(application, apiId) {
    const names = await subscriptionNamesFor(application.id, apiId);
    await deleteInApim(names);
    if (names.length) {
      await db.query('DELETE FROM api_subscriptions WHERE application_id = $1 AND api_id = $2',
        [application.id, apiId]);
    }
    const remaining = (application.connected_apis || []).filter((api) => api.id !== apiId);
    return (await db.query('UPDATE applications SET connected_apis = $2 WHERE id = $1 RETURNING *',
      [application.id, JSON.stringify(remaining)])).rows[0];
  }

  // Before the application is deleted: with the row gone nothing would remember what to take back. The rows
  // themselves go with the application (ON DELETE CASCADE).
  async function revokeAll(application) {
    await deleteInApim(await subscriptionNamesFor(application.id));
  }

  async function listFor(applicationId) {
    const rows = await db.query(
      'SELECT api_id, subscription_key FROM api_subscriptions WHERE application_id = $1 ORDER BY created_at',
      [applicationId]
    );
    return rows.rows.map((row) => ({ apiId: row.api_id, subscriptionKey: row.subscription_key }));
  }

  return { connect, disconnect, revokeAll, listFor };
}

module.exports = { createSubscriptions, HttpError };
