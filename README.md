# HMCTS API Marketplace — auth server

A small Node.js/Express backend that provides real account creation and
sign-in for the HMCTS API Marketplace mockup. It replaces the mock
"Signed in — this is a demo" behaviour in `sign-in.html` and `register.html`
with actual accounts, stored in a real (if simple) database.

**Why this exists separately from the rest of the site:** the rest of the
site is static HTML hosted on GitHub Pages, which can only serve files — it
cannot run server-side code, hash passwords, or store data. This server is
the piece that does that. It needs to run somewhere that can execute
Node.js (your own machine for testing, or a hosting provider for real use —
see "Deploying" below).

## What it does

- `POST /api/register` — create an account (first name, last name, email,
  organisation, role, password). Passwords are hashed with bcrypt before
  being stored — the plain password is never saved.
- `POST /api/login` — verify email + password, and start a session.
- `POST /api/logout` — end the session.
- `GET /api/me` — return the currently signed-in user (used to check
  "is someone logged in" from the front end).

Sessions are stored as a JWT in an `httpOnly` cookie, so the token itself
isn't readable by JavaScript in the browser (this protects against a common
class of attack where a script on the page could otherwise steal it).

Data is stored in a local SQLite file (`data.sqlite`), created automatically
the first time you run the server. No separate database installation is
required for testing. For real production use with more than one server
instance, you'd want to swap this for a hosted database (e.g. Postgres) —
ask if you'd like help with that step later.

## Entra and APIM registration

This is where an application gets its credentials. There are two independent grants, and each can happen
without the other:

| Credential | From | When |
|---|---|---|
| **Client ID and Client Secret** | Microsoft Entra External ID: an app registration from a **pre-provisioned pool** (`src/entraPool.js`) | When a sandbox application is created |
| **Subscription Key**, one per API | Azure API Management: a subscription on that API's **Product** (`src/apim.js`) | When an API is connected to the application |

```mermaid
sequenceDiagram
    participant U as Developer
    participant A as This server
    participant K as Key Vault (kvspsextidsbox)
    participant M as Azure API Management
    U->>A: create application (sandbox)
    A->>A: allocate a free pool row (entra_app_pool)
    A->>K: read that app's client secret
    A-->>U: Client ID + Client Secret (shown once, never stored)
    U->>A: connect an API
    A->>M: PUT subscription scoped to the API's Product
    M-->>A: Subscription Key
    A->>A: store key + subscription name (api_subscriptions)
    A-->>U: API connected; key shown on the application page
    U->>A: disconnect the API / delete the application
    A->>M: DELETE the subscription(s) first
    A->>A: then forget them (and free the pool row)
```

**The order is always the same:** refuse what can be refused, ask Azure, write the database last. A failure
after something was issued undoes it, and undoing never throws, so it cannot hide the failure being handled.
Taking a key away deletes it in APIM *before* the row that remembers it: if APIM refuses, the key is still
shown and the action can be tried again. Deleting something already gone is not a failure.

**APIM is off until it is configured.** With `APIM_CLIENT_ID` and `APIM_CLIENT_SECRET` unset, connecting an API
works as it always did and simply issues no key. There is deliberately no mock key.

| Setting | What it is | State |
|---|---|---|
| `APIM-CLIENT-ID` / `APIM-CLIENT-SECRET` | A service principal that can manage subscriptions on the APIM instance | **Does not exist yet** (needs CloudOps) |
| `APIM-PRODUCT-MAP` | `api-id:product-id,...`: which APIM Product backs which API | Not decided |
| `APIM_TENANT_ID`, `APIM_SUBSCRIPTION_ID`, `APIM_RESOURCE_GROUP`, `APIM_SERVICE_NAME` | The shared sandbox instance; defaults are its real values | Default is fine |
| `APIM_ARM_BASE_URL`, `APIM_LOGIN_BASE_URL` | Where Microsoft is. **Only for a demo or a test**; leave unset everywhere real | Unset |
| `ENTRA-KEYVAULT-*` | How the pool's secrets are read (existing) | See below |

**Entra needs the pool to exist.** The pool apps are created by `hmcts/external-entra-id`
(`tenants/sbox/config/apps.yaml`), not by this server. **That file has no pool entries yet**, and this server's
identity has not been given read access to their secrets, so Entra registration cannot work in sandbox until both
are done. APIM keys do not depend on it.

### Try it without Microsoft

```bash
./demo/run-demo.sh        # Postgres + a stand-in for APIM in Docker; walks the whole journey; offline
./demo/run-demo.sh --down
```

It starts the server against a local Postgres and a WireMock stand-in for Azure, creates an account and an
application, connects an API (a key comes back and shows on the application page), tries an API with no Product,
disconnects, deletes, and prints every call the server made to "APIM". `npm test` runs the unit tests (no
database or network needed).

### What has and has not been shown

- **Shown:** the routes, the SQL and the ordering, against a real Postgres and the stand-in; 25 unit tests.
- **Shown for real, but not from this repo:** the same Azure calls (create, return the key, delete) were run
  against the real sandbox APIM from the Java service, `hmcts/service-api-marketplace`.
- **Not shown:** this server issuing a key from the real APIM. It needs the service principal above.
- **Not shown:** the Entra pool in sandbox (see above).

## Running it locally

You'll need [Node.js](https://nodejs.org) installed (version 18 or later).

```bash
cd auth-server
npm install
cp .env.example .env
```

Open `.env` and:
1. Generate a secret and paste it in as `JWT_SECRET`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
2. Set `FRONTEND_ORIGIN` to wherever you're serving the site from while
   testing (e.g. `http://localhost:8000` if you run
   `python3 -m http.server 8000` inside the site folder).

Then start the server:

```bash
npm start
```

You should see:
```
HMCTS API Marketplace auth server listening on http://localhost:3001
```

## Connecting the front end to it

The `sign-in.html` and `register.html` files need to know where this API
lives. Near the top of each file's `<script>` block there's a line like:

```js
const API_BASE = "http://localhost:3001";
```

Change this to wherever you've deployed the server (see below), then the
forms will call the real API instead of showing the mock confirmation.

## Deploying so it's reachable from your real GitHub Pages site

GitHub Pages itself can't run this — you need a separate host that runs
Node.js. Reasonable options, roughly easiest first:

- **Render** (render.com) — free tier available, connects directly to a
  GitHub repo, detects Node automatically.
- **Railway** (railway.app) — similar, very quick to get running.
- **Fly.io** — a bit more setup, more control.
- Your organisation's own Azure/AWS hosting, if HMCTS has an existing
  approved platform for internal tools — likely the right long-term answer
  for anything beyond a prototype, since it'll already meet whatever
  security/compliance requirements apply.

Whichever you choose, you'll set the same environment variables from
`.env.example` in that provider's dashboard instead of a local `.env` file,
and update `FRONTEND_ORIGIN` to your real site's URL, and `API_BASE` in the
front-end files to the server's real deployed URL.

## Infrastructure (AKS / CNP)

`infrastructure/` provisions this service's Postgres Flexible Server via
Terraform, following
[HMCTS's CNP onboarding process](https://hmcts.github.io/cloud-native-platform/new-component/).
It does **not** create its own Key Vault - `hmcts/shared-platform-services-infra`
already provisions `kvspsplatformsbox` (in `rg-sps-platform-sbox`) as the one
shared vault for every component of this product, with `DTS AMp Developers`
already granted access there. Terraform here writes `DATABASE-URL` into that
existing vault, composed from the Postgres module's outputs. Two things it
deliberately does **not** set, which need adding by hand via the Azure CLI
(per the CNP convention of writing secrets via CLI, not the Portal):

- `JWT_SECRET` — generate a random value once:
  ```bash
  az keyvault secret set --vault-name kvspsplatformsbox --name JWT-SECRET \
    --value "$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
  ```
- `ENTRA-TENANT-ID`, `ENTRA-CLIENT-ID`, `ENTRA-CLIENT-SECRET` — copied from
  the `hmcts-api-marketplace-sbox-app-registrar` app registration's own
  secrets in the `kvspsextidsbox` vault (see `hmcts/external-entra-id`) —
  a different vault from `kvspsplatformsbox`, since that app registration is
  platform identity tooling, not this product's own infrastructure.

The AKS pod reads all of these as mounted files via the Helm chart's
`nodejs.keyVaults` config (`charts/amp-auth/values.yaml`), not as plain
environment variables the way the Render deployment does today - `src/`
will need updating to read them that way (via `properties-volume-nodejs`)
before this is live.

## Security notes for a real deployment

This covers the basics (password hashing, rate limiting on login attempts,
httpOnly cookies) but before this held real user data you'd also want:

- HTTPS enforced everywhere (most hosts do this by default)
- Email verification on signup
- A password reset flow (currently "Forgotten password?" is not wired up)
- Proper logging/monitoring and a backup strategy for the database
- A privacy notice and data retention policy, given this collects personal
  data (names, email addresses, organisation)
