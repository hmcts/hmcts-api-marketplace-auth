require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

const { getSecret } = require('./secrets');
const { pool, initDb } = require('./db');
const entra = require('./entra');

const app = express();

// Render (and most hosting platforms) sit behind a reverse proxy, which adds
// an X-Forwarded-For header identifying the real client IP. Express needs to
// be told to trust this, otherwise express-rate-limit throws a validation
// error on every request and login/registration silently fail.
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3001;
const JWT_SECRET = getSecret('JWT-SECRET');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

if (!JWT_SECRET) {
  console.error(
    'JWT_SECRET is not set. Set it as a JWT_SECRET environment variable (Render, local dev) ' +
    'or as a mounted JWT-SECRET Key Vault secret (AKS).'
  );
  process.exit(1);
}

// Auth uses a bearer token (sent in the Authorization header, stored by the
// browser in localStorage) rather than a cookie. This is a deliberate choice:
// the front end (GitHub Pages) and this API (Render) live on two completely
// different domains, and modern browsers increasingly block or restrict
// cookies set across different sites ("third-party cookies") even with
// SameSite=None configured correctly. A bearer token sidesteps that
// entirely, since it's sent explicitly by the page's own JavaScript rather
// than relying on the browser to attach a cookie automatically.
const allowedOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:8000';
app.use(
  cors({
    origin: allowedOrigin,
  })
);

// Email is optional - if SMTP isn't configured, access requests are still
// stored in the database, but no email is actually sent (the request just
// gets logged instead). This means the feature degrades gracefully rather
// than crashing if someone hasn't set up SMTP yet.
let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  console.log('SMTP configured - access request emails will actually be sent.');
} else {
  console.log(
    'SMTP not configured - access requests will be stored but no email will be sent. ' +
    'Set SMTP_HOST, SMTP_USER, SMTP_PASS (and optionally SMTP_PORT) to enable real emails.'
  );
}

app.use(express.json());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in.' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

function toPublicUser(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    role: row.role,
  };
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { firstName, lastName, email, organisation, role, password } = req.body || {};

    if (!firstName || !lastName || !email || !role || !password) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (!['consumer', 'producer'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "consumer" or "producer".' });
    }
    if (typeof password !== 'string' || password.length < 12) {
      return res.status(400).json({ error: 'Password must be at least 12 characters long.' });
    }

    const normalizedEmail = email.toLowerCase();

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with these details could not be created.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (first_name, last_name, email, organisation, role, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, first_name, last_name, email, role`,
      [firstName, lastName, normalizedEmail, organisation || null, role, passwordHash]
    );

    const user = result.rows[0];
    const token = issueToken(user);

    res.status(201).json({ user: toPublicUser(user), token });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];

    const passwordHash = user ? user.password_hash : '$2a$12$invalidsaltinvalidsaltinvalidsalte';
    const passwordMatches = await bcrypt.compare(password, passwordHash);

    if (!user || !passwordMatches) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const token = issueToken(user);

    res.json({ user: toPublicUser(user), token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/logout', (req, res) => {
  // Nothing to do server-side - the token lives in the browser's localStorage,
  // not a cookie, so "logging out" just means the client deletes its copy.
  // This endpoint is kept for compatibility with the front end's existing call.
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.sub]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Not signed in.' });

    res.json({ user: toPublicUser(user) });
  } catch (err) {
    console.error('/api/me error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Applications - "my applications and teams", Phase 1 (see the design doc:
// no teams yet, every application is owned directly by the user who created
// it - owner is always { type: 'user', id: <user id> }).

const ENVIRONMENTS = ['sandbox', 'development', 'integration-test', 'production'];

function toPublicApplication(row) {
  return {
    id: row.id,
    // The real OAuth client ID for sandbox applications with a genuine
    // Entra app registration (see src/entra.js); falls back to our own
    // internal id for anything that doesn't have one, matching the value
    // this always used to show before entra_app_id existed.
    clientId: row.entra_app_id || row.id,
    name: row.name,
    description: row.description,
    environment: row.environment,
    owner: { type: row.owner_type, id: row.owner_id },
    publicKeyUrl: row.public_key_url,
    callbackUrl: row.callback_url,
    customAttributes: row.custom_attributes,
    connectedApis: row.connected_apis,
    createdAt: row.created_at,
    // Set by loadAccessibleApplication / the list query below - the calling
    // user's own role on this specific application, so the frontend can
    // show or hide administrator-only actions (change details, manage
    // secrets, manage the team) without a second round trip.
    viewerRole: row.viewer_role || 'owner',
  };
}

// Permission tiers, ranked. 'owner' is not a application_team_members row -
// it's whoever created the application, and always outranks any team role.
const ROLE_RANK = { developer: 1, administrator: 2, owner: 3 };

function newApiKey() {
  return 'amp_' + crypto.randomBytes(24).toString('hex');
}

// rawKey/entraKeyId let a caller record a real Entra-issued secret (see
// src/entra.js) under the same api_keys bookkeeping the client-secrets page
// already lists, generates against and deletes from - self-issued
// amp_-prefixed keys and real Entra secrets otherwise look identical to the
// rest of this file. Only revoke (below) needs to tell them apart, via
// entra_key_id being set or not.
async function issueApiKey(applicationId, rawKey, entraKeyId) {
  rawKey = rawKey || newApiKey();
  const keyHash = await bcrypt.hash(rawKey, 12);
  const keyId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO api_keys (id, application_id, key_hash, key_preview, entra_key_id) VALUES ($1, $2, $3, $4, $5)`,
    [keyId, applicationId, keyHash, rawKey.slice(-4), entraKeyId || null]
  );
  return { id: keyId, rawKey };
}

// Loads an application and checks the current user can access it at at
// least minRole, writing the appropriate error response and returning null
// if not - every route below that takes :id calls this first and returns
// immediately when it does.
//
// The owner always has full access, and is not a application_team_members
// row - a team member's access comes from a row matching their own email
// (from their JWT, not a foreign key to users.id, so inviting someone who
// hasn't registered yet still works). A caller who is neither gets exactly
// the same 404 as an application that doesn't exist, so this never confirms
// an application's existence to someone with no access to it.
async function loadAccessibleApplication(req, res, minRole) {
  const result = await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
  const application = result.rows[0];
  if (!application || application.owner_type !== 'user') {
    res.status(404).json({ error: 'Application not found.' });
    return null;
  }

  let role = null;
  if (application.owner_id === req.user.sub) {
    role = 'owner';
  } else {
    const member = await pool.query(
      `SELECT role FROM application_team_members WHERE application_id = $1 AND lower(email) = lower($2)`,
      [application.id, req.user.email]
    );
    if (member.rows[0]) role = member.rows[0].role;
  }

  if (!role) {
    res.status(404).json({ error: 'Application not found.' });
    return null;
  }
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    res.status(403).json({ error: 'You do not have permission to do this.' });
    return null;
  }

  application.viewer_role = role;
  return application;
}

app.get('/api/applications', requireAuth, async (req, res) => {
  try {
    // Includes applications the caller is a team member on, not just ones
    // they own - matching HMRC's "View all applications" list, which shows
    // a "Your role" column rather than only the applications you created.
    const result = await pool.query(
      `SELECT a.*, CASE WHEN a.owner_id = $1 THEN 'owner' ELSE tm.role END AS viewer_role
       FROM applications a
       LEFT JOIN application_team_members tm
         ON tm.application_id = a.id AND lower(tm.email) = lower($2)
       WHERE a.owner_type = 'user' AND (a.owner_id = $1 OR tm.email IS NOT NULL)
       ORDER BY a.created_at DESC`,
      [req.user.sub, req.user.email]
    );
    res.json({ applications: result.rows.map(toPublicApplication) });
  } catch (err) {
    console.error('List applications error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/applications', requireAuth, async (req, res) => {
  try {
    const { name, environment, description } = req.body || {};

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Enter an application name.' });
    }
    if (!ENVIRONMENTS.includes(environment)) {
      return res.status(400).json({ error: 'Select a valid environment.' });
    }

    // Uniqueness is scoped per environment, not just per owner - this is what
    // lets the same logical application be registered separately for sandbox
    // and production, each with its own credentials, the way HMRC's
    // Developer Hub treats a sandbox and a production application as two
    // distinct registrations sharing a name.
    const trimmedName = name.trim();
    const existing = await pool.query(
      `SELECT id FROM applications WHERE owner_type = 'user' AND owner_id = $1 AND lower(name) = lower($2) AND environment = $3`,
      [req.user.sub, trimmedName, environment]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'You already have an application with this name in this environment. Choose a different name, or a different environment to register this one in.',
      });
    }

    const applicationId = crypto.randomUUID();
    const created = await pool.query(
      `INSERT INTO applications (id, name, description, environment, owner_type, owner_id, created_by)
       VALUES ($1, $2, $3, $4, 'user', $5, $5)
       RETURNING *`,
      [applicationId, trimmedName, description || null, environment, req.user.sub]
    );

    // Sandbox only, and only once the sbox app registrar's credentials are
    // actually configured (see src/entra.js) - every other environment, and
    // sandbox itself if Entra isn't set up yet, keeps the existing
    // self-issued amp_-prefixed key so this degrades to today's behaviour
    // rather than failing outright.
    let apiKey;
    if (environment === 'sandbox' && entra.isConfigured()) {
      let registration;
      try {
        registration = await entra.createAppRegistration(`amp-sandbox-${applicationId}`);
      } catch (err) {
        // The application row already exists at this point - roll it back
        // rather than leaving an application with no usable credentials at
        // all, which would be worse than the create simply failing.
        console.error('Entra app registration error:', err);
        await pool.query('DELETE FROM applications WHERE id = $1', [applicationId]);
        return res.status(502).json({
          error: 'Could not create your application credentials with Microsoft Entra. Please try again.',
        });
      }

      await pool.query(
        'UPDATE applications SET entra_app_id = $2, entra_object_id = $3 WHERE id = $1',
        [applicationId, registration.appId, registration.objectId]
      );
      created.rows[0].entra_app_id = registration.appId;
      created.rows[0].entra_object_id = registration.objectId;
      await issueApiKey(applicationId, registration.secretText, registration.keyId);
      apiKey = registration.secretText;
    } else {
      apiKey = (await issueApiKey(applicationId)).rawKey;
    }

    res.status(201).json({ application: toPublicApplication(created.rows[0]), apiKey });
  } catch (err) {
    console.error('Create application error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/applications/:id', requireAuth, async (req, res) => {
  try {
    const application = await loadAccessibleApplication(req, res, 'developer');
    if (!application) return;

    const keys = await pool.query(
      `SELECT id, key_preview, created_at, revoked_at FROM api_keys
       WHERE application_id = $1 ORDER BY created_at DESC`,
      [application.id]
    );

    res.json({
      application: toPublicApplication(application),
      apiKeys: keys.rows.map((k) => ({
        id: k.id,
        preview: k.key_preview,
        createdAt: k.created_at,
        revokedAt: k.revoked_at,
      })),
    });
  } catch (err) {
    console.error('Get application error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.patch('/api/applications/:id', requireAuth, async (req, res) => {
  try {
    // Administrator-only: changing application details is not a Developer
    // permission (see the Team members roles below).
    const application = await loadAccessibleApplication(req, res, 'administrator');
    if (!application) return;

    const { description, publicKeyUrl, callbackUrl, customAttributes } = req.body || {};
    const mergedAttributes = customAttributes
      ? { ...application.custom_attributes, ...customAttributes }
      : application.custom_attributes;

    const updated = await pool.query(
      `UPDATE applications SET
         description = COALESCE($2, description),
         public_key_url = COALESCE($3, public_key_url),
         callback_url = COALESCE($4, callback_url),
         custom_attributes = $5
       WHERE id = $1
       RETURNING *`,
      [application.id, description ?? null, publicKeyUrl ?? null, callbackUrl ?? null, JSON.stringify(mergedAttributes)]
    );

    res.json({ application: toPublicApplication(updated.rows[0]) });
  } catch (err) {
    console.error('Update application error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.delete('/api/applications/:id', requireAuth, async (req, res) => {
  try {
    // Owner-only, not just Administrator - this is the one action that
    // outranks Administrator, since it takes the application (and every
    // team member's access to it) away from everyone at once, not just
    // something an Administrator can undo by re-inviting people.
    const application = await loadAccessibleApplication(req, res, 'owner');
    if (!application) return;

    // api_keys and application_team_members cascade on application_id (see
    // db.js); connected_apis and custom_attributes are columns on this same
    // row, so a single delete removes everything.
    await pool.query('DELETE FROM applications WHERE id = $1', [application.id]);

    res.status(204).end();
  } catch (err) {
    console.error('Delete application error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/applications/:id/api-keys', requireAuth, async (req, res) => {
  try {
    // Administrator-only: HMRC's Developer role can test with existing
    // credentials but does not generate or revoke them.
    const application = await loadAccessibleApplication(req, res, 'administrator');
    if (!application) return;

    let keyId, rawKey;
    if (application.entra_object_id) {
      const password = await entra.addPassword(application.entra_object_id);
      ({ id: keyId } = await issueApiKey(application.id, password.secretText, password.keyId));
      rawKey = password.secretText;
    } else {
      ({ id: keyId, rawKey } = await issueApiKey(application.id));
    }
    res.status(201).json({ id: keyId, apiKey: rawKey });
  } catch (err) {
    console.error('Create API key error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.delete('/api/applications/:id/api-keys/:keyId', requireAuth, async (req, res) => {
  try {
    const application = await loadAccessibleApplication(req, res, 'administrator');
    if (!application) return;

    const existing = await pool.query(
      `SELECT entra_key_id FROM api_keys WHERE id = $1 AND application_id = $2 AND revoked_at IS NULL`,
      [req.params.keyId, application.id]
    );

    // A real Entra secret must actually be removed from the app
    // registration - marking our own row revoked_at is not enough on its
    // own, or the credential would keep working against a real token
    // request even though our UI shows it as deleted.
    if (existing.rows[0] && existing.rows[0].entra_key_id) {
      await entra.removePassword(application.entra_object_id, existing.rows[0].entra_key_id);
    }

    await pool.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND application_id = $2 AND revoked_at IS NULL`,
      [req.params.keyId, application.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Revoke API key error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/applications/:id/connected-apis', requireAuth, async (req, res) => {
  try {
    // Developer permission: "Subscribe to sandbox APIs" per HMRC's role list.
    const application = await loadAccessibleApplication(req, res, 'developer');
    if (!application) return;

    const { id: apiId, name: apiName } = req.body || {};
    if (!apiId || !apiName) {
      return res.status(400).json({ error: 'API id and name are required.' });
    }

    const current = application.connected_apis || [];
    if (current.some((a) => a.id === apiId)) {
      return res.status(409).json({ error: 'That API is already connected.' });
    }

    const updated = await pool.query(
      `UPDATE applications SET connected_apis = $2 WHERE id = $1 RETURNING *`,
      [application.id, JSON.stringify([...current, { id: apiId, name: apiName }])]
    );
    res.status(201).json({ application: toPublicApplication(updated.rows[0]) });
  } catch (err) {
    console.error('Connect API error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.delete('/api/applications/:id/connected-apis/:apiId', requireAuth, async (req, res) => {
  try {
    const application = await loadAccessibleApplication(req, res, 'developer');
    if (!application) return;

    const updated = await pool.query(
      `UPDATE applications SET connected_apis = $2 WHERE id = $1 RETURNING *`,
      [application.id, JSON.stringify((application.connected_apis || []).filter((a) => a.id !== req.params.apiId))]
    );
    res.json({ application: toPublicApplication(updated.rows[0]) });
  } catch (err) {
    console.error('Disconnect API error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Team members - Phase 2 of the design doc, added on top of Phase 1's
// single-owner model. Two roles, matching HMRC Developer Hub's Developer /
// Administrator split:
//   developer     - view the application, test with existing credentials,
//                   subscribe/unsubscribe sandbox APIs, view the team
//   administrator - everything a developer can, plus change application
//                   details, manage client secrets, add/remove team members
// The owner is not a row in this table - they always outrank both roles and
// can't be removed via this endpoint (there's nothing to remove).

function toPublicTeamMember(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    addedAt: row.added_at,
  };
}

app.get('/api/applications/:id/team-members', requireAuth, async (req, res) => {
  try {
    const application = await loadAccessibleApplication(req, res, 'developer');
    if (!application) return;

    const [owner, members] = await Promise.all([
      pool.query(`SELECT email FROM users WHERE id = $1`, [application.owner_id]),
      pool.query(
        `SELECT * FROM application_team_members WHERE application_id = $1 ORDER BY added_at ASC`,
        [application.id]
      ),
    ]);

    res.json({
      ownerEmail: owner.rows[0] ? owner.rows[0].email : null,
      teamMembers: members.rows.map(toPublicTeamMember),
    });
  } catch (err) {
    console.error('List team members error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/applications/:id/team-members', requireAuth, async (req, res) => {
  try {
    const application = await loadAccessibleApplication(req, res, 'administrator');
    if (!application) return;

    const { email, role } = req.body || {};
    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'Enter an email address.' });
    }
    if (!['developer', 'administrator'].includes(role)) {
      return res.status(400).json({ error: 'Select a permission level.' });
    }

    const trimmedEmail = email.trim();

    if (trimmedEmail.toLowerCase() === req.user.email.toLowerCase()) {
      return res.status(400).json({ error: 'You already have access to this application.' });
    }

    const existing = await pool.query(
      `SELECT id FROM application_team_members WHERE application_id = $1 AND lower(email) = lower($2)`,
      [application.id, trimmedEmail]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'That person is already a team member on this application.' });
    }

    const id = crypto.randomUUID();
    const created = await pool.query(
      `INSERT INTO application_team_members (id, application_id, email, role)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, application.id, trimmedEmail, role]
    );

    res.status(201).json({ teamMember: toPublicTeamMember(created.rows[0]) });
  } catch (err) {
    console.error('Add team member error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.delete('/api/applications/:id/team-members/:memberId', requireAuth, async (req, res) => {
  try {
    const application = await loadAccessibleApplication(req, res, 'administrator');
    if (!application) return;

    const member = await pool.query(
      `SELECT * FROM application_team_members WHERE id = $1 AND application_id = $2`,
      [req.params.memberId, application.id]
    );
    if (!member.rows[0]) {
      return res.status(404).json({ error: 'Team member not found.' });
    }
    if (member.rows[0].email.toLowerCase() === req.user.email.toLowerCase()) {
      return res.status(400).json({ error: 'You cannot remove yourself from this application.' });
    }

    await pool.query(`DELETE FROM application_team_members WHERE id = $1`, [req.params.memberId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Remove team member error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Requests - submissions from the three "ask the marketplace team for
// something" forms (request API access, publish an API, request a new API).
// Stored against the signed-in user who submitted them, so their account
// dashboard can list their own submission history. No review workflow yet -
// every request just sits at status 'submitted'.

const REQUEST_KINDS = ['access-request', 'publish-api', 'new-api'];
const REQUEST_REFERENCE_PREFIX = { 'access-request': 'AR', 'publish-api': 'PA', 'new-api': 'NA' };

function toPublicRequest(row) {
  return {
    id: row.id,
    kind: row.kind,
    reference: row.reference,
    status: row.status,
    details: row.details,
    createdAt: row.created_at,
  };
}

app.get('/api/requests', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM requests WHERE owner_id = $1 ORDER BY created_at DESC`,
      [req.user.sub]
    );
    res.json({ requests: result.rows.map(toPublicRequest) });
  } catch (err) {
    console.error('List requests error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/requests', requireAuth, async (req, res) => {
  try {
    const { kind, details } = req.body || {};

    if (!REQUEST_KINDS.includes(kind)) {
      return res.status(400).json({ error: 'Unknown request kind.' });
    }
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      return res.status(400).json({ error: 'Request details are required.' });
    }

    const id = crypto.randomUUID();
    const reference = REQUEST_REFERENCE_PREFIX[kind] + '-' + new Date().getFullYear() + '-' +
      crypto.randomBytes(3).toString('hex').toUpperCase();

    const created = await pool.query(
      `INSERT INTO requests (id, kind, owner_id, reference, details)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, kind, req.user.sub, reference, JSON.stringify(details)]
    );

    res.status(201).json({ request: toPublicRequest(created.rows[0]) });
  } catch (err) {
    console.error('Create request error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`HMCTS API Marketplace auth server listening on http://localhost:${PORT}`);
      console.log(`Accepting requests from: ${allowedOrigin}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
