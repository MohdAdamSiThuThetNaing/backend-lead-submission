# Adding the 50th PSP

What I'd aim for: adding a PSP means writing one adapter file, one config entry
and a folder of sample callbacks. Nobody adding a PSP should need to touch the
code that locks wallets or writes the ledger.

## Rough shape

```
POST /psp/:code/callbacks
   |
   keep the raw body (signatures are over the exact bytes)
   |
   look up adapter for :code
   |   adapter.verify(...)   -> reject if signature is wrong
   |   adapter.parse(...)    -> our own event shape
   |
   save the raw callback (audit only, never used to skip a delivery)
   |
   handlePspCallback(event)  -> what exists today in depositService.ts:
   |                            lock, state machine, amount check, ledger
   |
   adapter.ack(result)       -> whatever response that PSP expects
```

The adapter's only job is translating their format into ours. It never gets a
wallet or a transaction, so a bug in an adapter can at worst reject or ignore a
callback. It can't credit the wrong amount on its own: the core still compares
the amount with what we asked for and holds the deposit for review if they
differ.

Duplicates are still stopped by handlePspCallback (row lock plus status check),
not by the raw callback table. If we skipped a delivery because its event id
was already saved, a crash between saving it and crediting the wallet would
make us ignore the PSP's retry and the deposit would never be credited.

## The interface

```ts
interface PspAdapter {
  code: string;
  verify(req: RawCallback, cfg: PspConfig): void; // throws if invalid
  parse(req: RawCallback, cfg: PspConfig): NormalizedEvent;
  // result.outcome: 'credited' | 'failed' | 'duplicate' | 'held_for_review'
  ack(result: CallbackResult): { status: number; body: unknown };
}

type NormalizedEvent = {
  providerEventId: string; // their id, for audit and tracing
  pspRef: string;
  kind: "completed" | "failed" | "ignore";
  amount: string; // always major units, as a decimal string
  currency: string;
};
```

Anything that isn't a final success or failure (pending, processing, info
events) becomes `ignore`. That covers PSPs that send `success` and then a late
`pending`: the deposit is already Completed, so the pending does nothing.

A currency that doesn't match the deposit is treated like an amount mismatch:
nothing is credited and the deposit is held for a person to look at.

## Verification and normalisation

Each adapter does its own verify, but most PSPs use one of a handful of schemes
(HMAC-SHA256 over the body, RSA signature, sometimes with a timestamp). So I'd
have shared helpers for those, and an adapter mostly just picks one.

Same for normalising. A shared `toMajorUnits(value, unit, currency)` handles the
minor/major unit problem, using BigNumber like the rest of the code. Status
names come from a map in config, not from if/else in each adapter.

## Config

One entry per PSP, validated with zod at startup:

```ts
{
  code: 'acmepay',
  enabled: true,               // can differ per environment
  secretRef: 'psp/acmepay',    // name in the secret manager, not the secret itself
  signature: 'hmac-sha256',
  amountUnit: 'minor',
  statusMap: { SUCCESS: 'completed', DECLINED: 'failed', PENDING: 'ignore' },
}
```

My guess is that a fair number of PSPs would end up as config only, with a
small adapter. Only the unusual ones need much code.

## Testing without the real PSP

I wouldn't call any provider from CI. Instead:

- Save real example callbacks (body, headers, signature) from their docs or
  sandbox into `test/psp/<code>/`.
- Have one shared test suite that runs against every registered adapter: a
  good sample verifies, a changed body or wrong secret fails, each sample parses
  to the expected event, amounts convert correctly, and an unknown status turns
  into `ignore` instead of throwing. Registering an adapter is enough to pull it
  into this suite.
- One end-to-end test per PSP that sends a signed sample through the real route,
  twice at the same time, and checks the wallet is credited once. If the unit
  conversion is wrong, this test sees the deposit held instead of credited.
- A scheduled smoke test against the sandbox, outside CI, so a flaky provider
  never blocks a merge.

## Keeping it safe for someone junior

- The money code stays the same for every PSP, and it's the part with the
  concurrency tests.
- TypeScript makes them return a complete event.
- New PSPs start in shadow mode: callbacks are verified, parsed and stored but
  not applied, and we compare them with the PSP's own dashboard for a while
  before turning `enabled` on.
- A PR checklist: samples added, shared suite passes, secret is in the secret
  manager, amount unit confirmed with the PSP (this is the one I'd expect people
  to get wrong).
