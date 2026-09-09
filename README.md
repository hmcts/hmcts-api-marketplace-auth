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

`infrastructure/` provisions this service's Postgres Flexible Server and its
`amp-sbox` Key Vault via Terraform, following
[HMCTS's CNP onboarding process](https://hmcts.github.io/cloud-native-platform/new-component/).
Terraform populates `DATABASE-URL` in the vault automatically from the
Postgres module's outputs. Two things it deliberately does **not** set,
which need adding by hand via the Azure CLI once the vault exists (per the
CNP convention of writing secrets via CLI, not the Portal):

- `JWT_SECRET` — generate a random value once:
  ```bash
  az keyvault secret set --vault-name amp-sbox --name JWT-SECRET \
    --value "$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
  ```
- `ENTRA-TENANT-ID`, `ENTRA-CLIENT-ID`, `ENTRA-CLIENT-SECRET` — copied from
  the `hmcts-api-marketplace-sbox-app-registrar` app registration's own
  secrets in the `kvspsextidsbox` vault (see `hmcts/external-entra-id`) —
  a different vault, since that app registration is platform identity
  tooling, not this product's own infrastructure.

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
