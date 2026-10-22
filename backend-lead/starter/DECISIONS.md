# Decisions

Time spent: about 2 hours in total (code, tests and both notes). A bit over
the budget, mostly because of the flaky test issue described below.

`npm test` runs the whole suite against a real Postgres. The four tests the
brief asks for are in `pspCallbacks.test.ts` (sequential + concurrent duplicate
callback), `wagers.test.ts` (concurrent overdraw) and `withdrawals.test.ts`
(turnover block/unblock). The starter README maps each requirement to its test.

## Schema

I added two tables and changed `wallets`.

`funding_txs` holds both deposits and withdrawals. They go through the same
Pending -> Completed/Failed lifecycle, so one table and one state machine felt
simpler than two. `psp_ref` is unique and only set for deposits.

`wallet_txs` is the ledger. Amounts are signed (+ for credits, - for debits), so
the balance is always `SUM(amount)` for the wallet. Every money test checks that.
I also store `balance_after` on each row, mostly so a single row makes sense on
its own when someone is looking at an incident.

The ledger is append-only at the database level: a trigger raises on UPDATE or
DELETE. Tests use TRUNCATE, which the trigger doesn't block.

On `wallets` I added `turnover_required`, `turnover_accrued` and
`CHECK (balance >= 0)`.

A few smaller choices:

- Status/type/kind columns are VARCHAR with a CHECK, not Postgres ENUMs. Adding
  a value to an ENUM later is more awkward to migrate.
- There's a partial unique index on `wallet_txs (funding_tx_id, kind)`. The
  callback logic should already prevent a double credit; this is the backstop if
  it ever doesn't.
- Turnover lives on the wallet row rather than being computed from the ledger.
  It's updated under the same lock as the balance, so they can't drift, and the
  withdrawal check stays a simple comparison.
- `wallet_txs.seq` (an identity column) orders the ledger. `created_at` only has
  millisecond resolution, so two concurrent wagers can tie on it; `seq` is
  assigned while the wallet lock is held, so it's the real order.
- A few more CHECKs as backstops: the ledger sign must match the kind (deposits
  positive, wagers and withdrawals negative), deposits must have a `psp_ref`, and
  `settled_at` is set if and only if the status has left Pending.
- `funding_txs.amount` is what we asked for and is never overwritten. What the
  PSP reported goes in `psp_amount`, and `review_reason` says why a deposit is
  held.

## Locking

Every operation that moves money runs in one transaction and takes a row lock
with `SELECT ... FOR UPDATE` (default READ COMMITTED).

- Callback: lock the funding tx, then the wallet.
- Wager and withdrawal: lock the wallet.

For duplicate callbacks, the second request blocks on the funding tx lock. When
the first commits, the second re-reads the row, sees it's no longer Pending and
does nothing. For wagers, concurrent requests on one wallet just queue up and
each one sees the balance the previous one left.

Lock order is always funding tx before wallet, and wagers/withdrawals never lock
an existing funding tx, so I don't see a path to a deadlock.

I went with pessimistic locks over optimistic (version column + retry) because
it's easier to reason about for money and there's no retry loop to get wrong.
The cost is contention if one wallet gets very busy, which seems acceptable since
locks are per member.

The concurrency tests send 5 requests at once, which matches Sequelize's default
pool of 5 connections, so all of them really are inside Postgres at the same
time. With a pool of 1 they would queue in Node and pass without testing
anything; that's worth keeping in mind if anyone changes the pool size.

## Callback behaviour

- Pending + completed, amount matches: credit the wallet, write the ledger row,
  add `amount x multiplier` to required turnover. 200.
- Pending + failed: mark Failed, no money moves. 200.
- Same status again: no-op, 200 with `outcome: duplicate`, so the PSP stops retrying.
- Opposite status (Completed -> Failed or the reverse): 409. Never applied.
- Unknown pspRef: 404.
- Amount mismatch: nothing credited, deposit stays Pending, the PSP's amount is
  saved in `psp_amount`, `review_reason` is set to `amount_mismatch`. 202 with
  `outcome: held_for_review`.

The mismatch case was the main judgement call. I didn't want to credit whatever
the PSP says, because that means trusting external input with money. Marking it
Failed felt wrong too, since the member may really have paid. So it stays
Pending and is flagged for a person to look at.

Once a deposit is flagged, a later callback with the "right" amount doesn't
complete it either. The first mismatch might be the real signal (a PSP bug, or
someone tampering), and I'd rather a human decide than have the second callback
quietly settle it. Mismatches should be rare, so a review queue is cheap.
Amounts are compared as BigNumbers, so "100.50" and "100.500" match.

I return 202 for the mismatch, not an error, because we have handled it and
saved what we need: there is nothing for the PSP to retry. One thing I'm still
not fully happy with is 404 and 409: some PSPs keep retrying anything that isn't
2xx. In production I'd probably store the raw callback, return 200 and alert. I
kept those status codes here because they make the behaviour obvious in tests.

## Turnover

Required goes up by `amount x multiplier` when a deposit completes (not when
it's created). Accrued goes up by the wager amount. A withdrawal needs
accrued >= required, otherwise it's a 422 with `outstandingTurnover`,
`turnoverRequired` and `turnoverAccrued` in the body.

I treated both counters as lifetime totals that withdrawals don't reset. A real
rule might track each deposit separately and expire old requirements; I'd want
to check that with the business before building it.

A valid withdrawal debits straight away and leaves a Pending funding tx, so the
money can't be wagered or withdrawn again while it waits for approval.

## Assumptions

- `turnoverMultiplier` is capped at 1000. It's not in the brief; it's there to
  catch typos that would lock someone's funds.
- Money must be a decimal string that fits DECIMAL(36,18). Numbers, exponents and
  negative signs are rejected at the edge, so a float never gets in.
- Every endpoint returns money at the database scale (`"50.000000000000000000"`),
  the same as the starter's member endpoint. Tests compare values, not text.
- A wager or withdrawal can take the balance to exactly 0.
- pspRef is `dep_` + a UUID, so it can't be guessed.

## Something the tests caught

zod v3 still runs `.refine()` after `.regex()` has failed. For an input like
"abc" that meant `dec()` threw and the API returned 500 instead of 400. The
validation test caught it and the refine now checks the format first.

The tests were also flaky on my Mac: random 404s from POST /members, a route
that never returns 404. supertest listens on "::" but connects to 127.0.0.1,
so when another local program already had that port on 127.0.0.1 the request
went there instead of our app. The test server now binds to 127.0.0.1 itself
(`test/server.ts`), and 5 runs in a row passed after that. The starter's
`members.test.ts` still passes the app straight to supertest; I left it as it
was, but moving it to the same server would be the consistent thing to do.

## Next, with more time

1. Store every raw PSP callback, for audit and replaying incidents. Audit only:
   duplicates are still stopped by the row lock and status check, so a crash
   after saving a callback can't make us ignore the PSP's retry.
2. Idempotency keys on wagers and withdrawals. Right now a client that retries
   after a timeout would place the wager twice.
3. Approve/reject for withdrawals, with a reversing ledger entry on reject, and
   a way for ops to resolve deposits held for review.
4. Callback signature checks (see DESIGN-PSP.md).
5. A job that compares each balance with its ledger sum and alerts on a mismatch.
6. Per-deposit turnover if the business needs expiry.

## AI use

I used Claude to help me understand the brief, and to draft the migrations,
services, tests, this file and DESIGN-PSP.md. I read and ran everything,
changed what I disagreed with, and debugged the two issues above with it.
I can explain every line and every decision here.
