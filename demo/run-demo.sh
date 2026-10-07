#!/usr/bin/env bash
# Runs the auth server against a local Postgres and a stand-in for Azure API Management, then walks the journey:
# create an account, create an application, connect an API (APIM issues a Subscription Key), read the key,
# disconnect (the key is revoked in APIM), delete the application. Offline: nothing here reaches Microsoft.
#
#   ./demo/run-demo.sh          needs docker, node 20+, curl, python3
#   ./demo/run-demo.sh --down   stop the stand-ins and delete their data
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f demo/docker-compose.yml"
B=http://localhost:3001
STUB=http://localhost:8098
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

[ "${1:-}" = "--down" ] && { $COMPOSE down -v; exit 0; }

[ -d node_modules ] || npm install --no-audit --no-fund --silent
bold "Starting Postgres and the APIM stand-in"
$COMPOSE up -d >/dev/null
for _ in $(seq 1 30); do $COMPOSE exec -T db pg_isready -U postgres -d amp_auth >/dev/null 2>&1 && break; sleep 1; done
for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' $STUB/__admin/health || true)" = 200 ] && break; sleep 1; done
curl -s -X DELETE $STUB/__admin/requests >/dev/null

bold "Starting the auth server"
LOG=$(mktemp)
DATABASE_SSL=false DATABASE_URL=postgres://postgres:postgres@localhost:5435/amp_auth \
JWT_SECRET=demo-only-jwt-secret-0123456789abcdef FRONTEND_ORIGIN=http://localhost:3100 PORT=3001 \
APIM_CLIENT_ID=demo APIM_CLIENT_SECRET=demo \
APIM_PRODUCT_MAP="hearing-results:cp-crime-hearing-results,court-listings:cp-crime-schedulingandlisting" \
APIM_ARM_BASE_URL=$STUB/arm APIM_LOGIN_BASE_URL=$STUB \
  node src/server.js > "$LOG" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; echo; echo "(server stopped; the stand-ins are still up - ./demo/run-demo.sh --down to remove them)"' EXIT
for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' $B/api/health || true)" = 200 ] && break; sleep 1; done
curl -s -o /dev/null -w '  health: HTTP %{http_code}\n' $B/api/health

bold "1. Create an account"
EMAIL="demo+$RANDOM@example.com"
TOKEN=$(curl -s -X POST $B/api/register -H 'Content-Type: application/json' \
  -d "{\"firstName\":\"Demo\",\"lastName\":\"User\",\"email\":\"$EMAIL\",\"organisation\":\"Demo Org\",\"role\":\"consumer\",\"password\":\"correct-horse-battery-staple\"}" | j "d['token']")
AUTH="Authorization: Bearer $TOKEN"
echo "  registered $EMAIL"

bold "2. Create an application"
APP=$(curl -s -X POST $B/api/applications -H "$AUTH" -H 'Content-Type: application/json' -d '{"name":"Showcase app","environment":"sandbox"}' | j "d['application']['id']")
echo "  application $APP"
echo "  (its Client ID and secret come from the pre-provisioned Entra pool when that is configured - see README)"

bold "3. Connect an API: APIM issues a Subscription Key"
curl -s -o /dev/null -w '  HTTP %{http_code}\n' -X POST $B/api/applications/$APP/connected-apis -H "$AUTH" -H 'Content-Type: application/json' -d '{"id":"hearing-results","name":"Hearing Results API"}'
curl -s $B/api/applications/$APP -H "$AUTH" | j "'\n'.join('  Subscription Key for %s: %s' % (s['apiId'], s['subscriptionKey']) for s in d['apiSubscriptions'])"

bold "4. An API with no APIM Product behind it is turned away"
curl -s -w '  -> HTTP %{http_code}\n' -X POST $B/api/applications/$APP/connected-apis -H "$AUTH" -H 'Content-Type: application/json' -d '{"id":"fees-api","name":"Fees API"}'

bold "5. Disconnect (the key is revoked in APIM), then delete the application"
curl -s -o /dev/null -w '  disconnect: HTTP %{http_code}\n' -X DELETE $B/api/applications/$APP/connected-apis/hearing-results -H "$AUTH"
curl -s -o /dev/null -w '  delete application: HTTP %{http_code}\n' -X DELETE $B/api/applications/$APP -H "$AUTH"

bold "What the server asked Azure API Management for (from the stand-in's request log)"
curl -s $STUB/__admin/requests | python3 -c "
import json, sys
for r in sorted(json.load(sys.stdin)['requests'], key=lambda r: r['request']['loggedDate']):
    q = r['request']
    print('  %-6s %-72s -> %s' % (q['method'], q['url'].split('?')[0][:72], r['response']['status']))"
