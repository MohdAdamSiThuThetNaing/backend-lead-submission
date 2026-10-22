# Mini Wallet Service - Starter

This is the starter codebase for the Backend Lead take-home. The task itself is described in [`../readme.md`](../readme.md).

My solution is in this folder. The reasoning is in [`DECISIONS.md`](DECISIONS.md) and the Part B design note is in [`DESIGN-PSP.md`](DESIGN-PSP.md).

## What I built

- `POST /deposits` creates a `Pending` deposit and returns its `id` and `pspRef`. No money moves.
- `POST /psp/callbacks` credits the wallet exactly once. Duplicates, late retries and concurrent deliveries are safe. An amount mismatch is not credited: the deposit stays `Pending`, is flagged for review and the call returns 202. An unknown `pspRef` returns 404.
- `POST /wallets/:walletId/wagers` debits the wallet, rejects overdraws and accrues turnover.
- `POST /withdrawals` is blocked with 422 and the `outstandingTurnover` amount until turnover is met. When allowed, it debits immediately and creates a `Pending` withdrawal.
- Every balance change writes an append-only row to `wallet_txs`, so the balance can always be rebuilt from the ledger.

Main assumptions (details in `DECISIONS.md`): a callback amount that differs from the deposit is not credited and needs a person to look at it; `turnoverMultiplier` is capped at 1000; turnover counters are lifetime totals that withdrawals do not reset.

## Stack

TypeScript, Express, Sequelize, PostgreSQL, Jest. Money is `DECIMAL(36,18)` in Postgres, strings in JS/JSON, and all arithmetic goes through `bignumber.js` (see `src/lib/money.ts`).

## Setup

Requires Node 20+ and Docker. Docker only runs Postgres; the API and tests run with npm.

```bash
cp .env.example .env
npm install
npm run db:up        # starts Postgres on localhost:5439 (dev + test databases)
npm run db:migrate   # migrates the dev database
npm test             # migrates the test database and runs the test suite
npm run dev          # starts the API on :3000
```

If port 5439 clashes with something on your machine, change it in `docker-compose.yml` and `.env`.

## How to check

`npm test` runs the whole suite against a real Postgres database (no mocks). Every money test also checks that the wallet balance equals the sum of its ledger rows, and that each row's `balance_after` follows from the one before.

### Required tests (A5)

| Risk | Test file | Run only this |
|---|---|---|
| Duplicate callback (sequential) does not double-credit | `test/pspCallbacks.test.ts` | `npm test -- -t "sequential"` |
| Concurrent duplicate callbacks do not double-credit | `test/pspCallbacks.test.ts` | `npm test -- -t "concurrent duplicate callbacks"` |
| Concurrent wagers cannot overdraw a wallet | `test/wagers.test.ts` | `npm test -- -t "concurrent wagers"` |
| Turnover lock blocks and unblocks withdrawal | `test/withdrawals.test.ts` | `npm test -- -t "turnover lock"` |

### Each requirement

| Requirement | Code | Test |
|---|---|---|
| A1 Pending deposit with `pspRef`, positive decimal amount | `src/services/depositService.ts` (`createDeposit`), `src/lib/validation.ts` | `test/deposits.test.ts` |
| A2 Exactly-once credit: row lock, status check, unique ledger index | `src/services/depositService.ts` (`handlePspCallback`) | `test/pspCallbacks.test.ts` |
| A2 State machine, invalid transitions return 409 | `src/services/fundingStateMachine.ts` | `test/pspCallbacks.test.ts`, `test/ledgerInvariants.test.ts` |
| A2 Amount mismatch held for review (202) and unknown `pspRef` (404) | `src/services/depositService.ts` | `test/pspCallbacks.test.ts` |
| A2 Append-only ledger (trigger blocks UPDATE and DELETE), DB backstops | `src/db/migrations/...-create-wallet-txs.js`, `src/services/ledger.ts` | `test/ledgerInvariants.test.ts` |
| A3 Wager debit, no overdraw, turnover accrued | `src/services/walletService.ts` | `test/wagers.test.ts` |
| A4 Turnover lock, 422 with `outstandingTurnover`, Pending withdrawal | `src/services/withdrawalService.ts` | `test/withdrawals.test.ts` |
| B Design for the 50th PSP | `DESIGN-PSP.md` | - |

## Troubleshooting

- `ECONNRESET` right after `npm run db:up`: Postgres is still starting. Wait a few seconds and run the command again.
- `Cannot find module '../src/db/models'`: `src/db/models/index.ts` is missing. Run `git restore src/db/models`.
- `column "..." does not exist`: the test database has an older schema. Run `npx cross-env NODE_ENV=test sequelize-cli db:migrate:undo:all` and then `npm test`.
- `docker compose down` removes the container and its data. Run `npm run db:up` and `npm run db:migrate` again after it.
- On zsh, paste commands without the `#` comments, or run `setopt interactivecomments` first.

## Layout

Files marked `*` are new or changed in my solution.

~~~
src/
|-- app.ts                       * mounts the new routes, maps HttpError to HTTP
|-- index.ts                     # entrypoint
|-- config.ts
|-- lib/
|   |-- money.ts                 * BigNumber helpers, strict money format, 18-dp strings
|   |-- errors.ts                * HttpError(status, code, details)
|   `-- validation.ts            * zod schemas: positive money strings, uuids
|-- db/
|   |-- sequelize.ts
|   |-- cli-config.js            # sequelize-cli config (used by npm run db:migrate)
|   |-- migrations/
|   |   |-- ...-create-funding-txs.js        * deposits and withdrawals, status and settled_at CHECKs
|   |   |-- ...-create-wallet-txs.js         * append-only ledger, unique credit index, seq, sign CHECK
|   |   `-- ...-add-turnover-to-wallets.js   * turnover counters, balance >= 0
|   `-- models/
|       |-- index.ts             * registers all models and associations
|       |-- member.ts
|       |-- wallet.ts            * turnoverRequired, turnoverAccrued
|       |-- fundingTx.ts         * pspAmount, reviewReason, settledAt
|       `-- walletTx.ts          * no updatedAt, update hooks refuse (append-only)
|-- routes/                      * deposits, pspCallbacks, wallets (wagers), withdrawals
`-- services/
    |-- memberService.ts
    |-- ledger.ts                * the only code that changes a balance: lock, ledger row, balance
    |-- depositService.ts        * createDeposit + handlePspCallback (row lock, exactly-once credit)
    |-- fundingStateMachine.ts   * Pending -> Completed / Failed, nothing else
    |-- walletService.ts         * wagers
    `-- withdrawalService.ts     * turnover lock
test/
|-- server.ts                    * test server bound to 127.0.0.1
|-- helpers.ts                   * createMember, fundWallet, ledger check
|-- members.test.ts              # from the starter
|-- deposits.test.ts             *
|-- pspCallbacks.test.ts         *
|-- wagers.test.ts               *
|-- withdrawals.test.ts          *
`-- ledgerInvariants.test.ts     * raw SQL proves the DB itself refuses bad money state
~~~

## Conventions to keep

- Money never touches JS `number`. Strings at the boundaries, BigNumber in between.
- Any operation writing more than one row runs in a single DB transaction (see `memberService.createMember`).
- Routes validate input with zod and delegate to services; business logic lives in services, not routes.
- New tables are created via migrations, not `sync()`.

I kept all four. Locking and schema choices are explained in [`DECISIONS.md`](DECISIONS.md).
