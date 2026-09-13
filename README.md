# Integration Sandbox

Small local app for simulating messy external-service integration behavior such as retries, rate limits, numbered and cursor-based pagination, auth expiry, webhook retries, malformed payloads, and partial failures.

## Install

```bash
npm install
```

## CLI usage

List available scenarios:

```bash
npm run cli -- list
```

Run a full simulation and print the request/response trace:

```bash
npm run cli -- simulate --scenario flaky-retries
```

Try newer failure modes:

```bash
npm run cli -- simulate --scenario cursor-pagination
npm run cli -- simulate --scenario webhook-retries
npm run cli -- simulate --scenario auth-expiry
npm run cli -- simulate --scenario malformed-payload
```

Start a persistent local mock service for manual testing:

```bash
npm run cli -- serve --scenario mixed-chaos --port 4010
```

Then call it from another shell:

```bash
curl http://127.0.0.1:4010/contacts?page=1&pageSize=2 | cat
curl -X POST http://127.0.0.1:4010/contacts/batch-sync \
  -H 'Content-Type: application/json' \
  -d '{"ids":["contact_1","contact_2","contact_5"]}' | cat
curl -X POST http://127.0.0.1:4010/auth/token | cat
curl -X POST http://127.0.0.1:4010/webhooks/outbound \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"evt_manual","ids":["contact_1"]}' | cat
```

## Included scenarios

- `happy-path`: clean paginated reads and a successful batch sync
- `flaky-retries`: first two reads fail with 500 before succeeding
- `rate-limit-recover`: first read returns 429 before succeeding
- `partial-batch-failure`: reads succeed but selected items fail during batch sync
- `mixed-chaos`: combines a transient 500, a rate limit, and a partial batch failure
- `cursor-pagination`: contacts are read via opaque cursors instead of numbered pages
- `webhook-retries`: outbound webhook delivery fails twice before succeeding
- `auth-expiry`: first bearer token expires immediately and the client refreshes it
- `malformed-payload`: first successful contacts response is malformed and the simulation reports the parsing failure

## Mock endpoints

- `GET /health`
- `POST /auth/token`
- `GET /contacts?page=1&pageSize=2`
- `GET /contacts?pageSize=2&cursor=cursor_2`
- `POST /contacts/batch-sync`
- `POST /webhooks/outbound`

## Validation

```bash
npm run build
npm test
```
