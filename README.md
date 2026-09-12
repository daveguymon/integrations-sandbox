# Integration Sandbox

Small local app for simulating messy external-service integration behavior such as retries, rate limits, pagination, and partial failures.

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
```

## Included scenarios

- `happy-path`: clean paginated reads and a successful batch sync
- `flaky-retries`: first two reads fail with 500 before succeeding
- `rate-limit-recover`: first read returns 429 before succeeding
- `partial-batch-failure`: reads succeed but selected items fail during batch sync
- `mixed-chaos`: combines a transient 500, a rate limit, and a partial batch failure

## Validation

```bash
npm run build
npm test
```
