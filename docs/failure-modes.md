# Failure Modes Guide for Integration Engineers

This sandbox is meant to teach the operational side of platform integrations engineering: not just how to call an API, but how to survive when the API behaves imperfectly.

Each scenario in this project models a real class of integration failure. For each one, the key question is the same:

**What should a well-behaved integration do when the remote system is slow, inconsistent, partial, or wrong?**

## Why failure modes matter

Real integrations rarely fail in clean, obvious ways. More often, they fail in messy ways:

- a request works on the third try
- a page token changes how data must be traversed
- a batch succeeds for some records but not others
- a token expires mid-run
- a webhook endpoint is briefly unavailable
- an API returns a successful HTTP status with broken JSON structure

Strong integration systems treat those cases as part of the normal design, not as edge-case afterthoughts.

## How to use this guide

Start by listing the available scenarios:

```bash
npm run cli -- list
```

Then run one simulation at a time:

```bash
npm run cli -- simulate --scenario flaky-retries
```

The terminal trace shows the sequence of requests, retries, pagination steps, auth refreshes, and failures. That trace is the teaching tool: it shows how the integration behaves under stress.

## Core design habits for resilient integrations

Across all scenarios, resilient systems usually share the same habits:

1. **Assume every network call can fail transiently.**
2. **Differentiate retryable failures from permanent failures.**
3. **Track progress explicitly across pages, cursors, and batches.**
4. **Handle partial success at the item level, not just the request level.**
5. **Treat authentication as renewable, not permanent.**
6. **Validate response payloads even when HTTP status is 200.**
7. **Make retries observable with logs, counters, and trace output.**

## Scenario reference

### `happy-path`

**What it simulates**

A normal sync: paginated reads complete, then batch sync succeeds.

**Why it matters**

This is the control case. You need a stable baseline before you can reason about failures.

**How it is addressed**

- Fetch all pages in order
- Keep request tracing simple and readable
- Complete the batch operation with no retries

**Engineering lesson**

Always keep a known-good path in your test harness. It helps separate bugs in failure handling from bugs in basic integration logic.

### `flaky-retries`

**What it simulates**

The first two contact-list requests return HTTP 500 before the service recovers.

**Why it matters**

Transient upstream failures are common. Remote systems restart, overload, or hit intermittent database errors.

**How it is addressed**

- Detect 500s as retryable
- Retry the same request instead of advancing state
- Preserve the current pagination position during retries
- Stop retrying after a bounded maximum

**Engineering lesson**

Retry logic should be narrow and intentional. A robust integration retries the same unit of work, counts attempts, and fails clearly when the retry budget is exhausted.

### `rate-limit-recover`

**What it simulates**

The first list request returns HTTP 429 with retry hints before succeeding.

**Why it matters**

Platform APIs often defend themselves with rate limits. If your integration ignores those signals, it can create cascading failure and get throttled harder.

**How it is addressed**

- Recognize 429 as retryable
- Respect retry timing hints from response headers
- Delay before retrying instead of hammering the API
- Resume the same request after the backoff interval

**Engineering lesson**

Rate limiting is not just an error condition; it is part of the contract. Good integrations slow themselves down when the platform asks them to.

### `partial-batch-failure`

**What it simulates**

The read side succeeds, but batch sync rejects a subset of items.

**Why it matters**

Bulk endpoints often produce mixed results. Treating the whole batch as simply “passed” or “failed” loses critical operational detail.

**How it is addressed**

- Parse accepted and failed IDs separately
- Mark the run as partial rather than fully successful
- Surface failed items explicitly in the simulation report

**Engineering lesson**

Partial success is one of the defining challenges of integration engineering. Systems need item-level visibility so they can retry only the failed records or route them to remediation workflows.

### `mixed-chaos`

**What it simulates**

A combined scenario: a transient 500, then a 429, followed by a partial batch failure.

**Why it matters**

Production incidents rarely happen one failure at a time. Systems often need to recover from multiple categories of failure in a single run.

**How it is addressed**

- Retry transient request failures
- respect rate-limit pacing
- continue pagination once the upstream recovers
- finish the batch and surface partial item failures

**Engineering lesson**

The real challenge is composition. It is not enough for each handler to work in isolation; the overall workflow must stay coherent when several failure modes interact.

### `cursor-pagination`

**What it simulates**

The contacts API uses opaque cursors rather than numbered pages.

**Why it matters**

Many APIs do not support stable page numbers. Instead, they return a server-generated cursor that must be fed back exactly as provided.

**How it is addressed**

- Start with the initial cursor-free request
- Read the `nextCursor` value from the response
- Use that opaque token for the next request
- Stop only when `nextCursor` becomes `null`

**Engineering lesson**

Cursor pagination changes the state model of a sync. You are no longer traversing “page 1, 2, 3”; you are following a chain of provider-issued continuation tokens. Persist and replay those tokens carefully in real systems.

### `webhook-retries`

**What it simulates**

Webhook delivery fails twice with HTTP 502 before eventually succeeding.

**Why it matters**

Integrations are often bidirectional. Even if your polling or sync logic is correct, outbound event delivery can still fail transiently.

**How it is addressed**

- Treat 502 as retryable for webhook delivery
- Retry the same event with the same identity
- Track webhook attempts separately from read-side retries
- Surface webhook retry counts in the simulation report

**Engineering lesson**

Webhook delivery should behave like a durable message send, not a fire-and-forget HTTP call. Retries, attempt tracking, and idempotent event identity are essential.

### `auth-expiry`

**What it simulates**

The first bearer token expires immediately, forcing the integration to fetch a new token and retry.

**Why it matters**

Long-running integrations often outlive short-lived credentials. Token refresh is part of the runtime path, not just startup configuration.

**How it is addressed**

- Request an initial access token
- Detect 401 responses caused by token expiry
- Refresh the token
- Retry the protected request with the new token
- Record auth refresh activity in the trace

**Engineering lesson**

Authentication failures need classification. A missing token, an expired token, and an invalid token do not always deserve the same recovery path.

### `malformed-payload`

**What it simulates**

The API returns a 200 response whose JSON shape is wrong.

**Why it matters**

One of the most dangerous integration failures is a success-looking response that is semantically broken. If you trust it blindly, you can corrupt state or silently lose data.

**How it is addressed**

- Validate the response structure before using it
- Stop the simulation when required fields are missing
- Surface a clear parsing/contract error in the report

**Engineering lesson**

HTTP success does not guarantee contract success. Integration code should validate payload shape, required fields, and assumptions before continuing.

## Mapping scenarios to engineering concepts

| Scenario | Main concept | Primary recovery pattern |
| --- | --- | --- |
| `happy-path` | baseline behavior | no recovery needed |
| `flaky-retries` | transient server failure | bounded retry |
| `rate-limit-recover` | platform throttling | backoff and retry |
| `partial-batch-failure` | mixed result batches | item-level reconciliation |
| `mixed-chaos` | compound failures | layered recovery |
| `cursor-pagination` | continuation tokens | token-following traversal |
| `webhook-retries` | outbound delivery failure | idempotent event retry |
| `auth-expiry` | expiring credentials | token refresh and replay |
| `malformed-payload` | contract violation | validation and explicit failure |

## What “addressed” should mean in a real integration

In this sandbox, “addressed” means the simulator behaves correctly and visibly. In a production integration, it usually means more than that:

- emit logs and metrics for retries, failures, and partial outcomes
- persist enough state to resume safely after process restarts
- make retry policies configurable
- ensure duplicate-safe writes and idempotent event handling
- capture dead-letter or remediation paths for unrecoverable records
- document the recovery strategy per provider

## Suggested learning path

If you are new to integrations engineering, run the scenarios in this order:

1. `happy-path`
2. `flaky-retries`
3. `rate-limit-recover`
4. `partial-batch-failure`
5. `cursor-pagination`
6. `auth-expiry`
7. `webhook-retries`
8. `malformed-payload`
9. `mixed-chaos`

That order moves from straightforward transport issues to more subtle state-management and contract-validation problems.

## Next questions to explore

After working through these scenarios, useful follow-up topics include:

- idempotency keys
- duplicate webhooks
- out-of-order events
- cursor invalidation
- timeout budgets
- dead-letter queues
- reconciliation jobs
- exactly-once versus at-least-once delivery

These are the kinds of concerns that separate a simple API client from a production-grade integration platform.
