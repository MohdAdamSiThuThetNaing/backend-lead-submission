import request from 'supertest';
import http from 'http';
import { startTestServer, stopTestServer } from './server';
import { sequelize } from '../src/db/sequelize';
import { FundingTx, Wallet, WalletTx } from '../src/db/models';
import { dec } from '../src/lib/money';
import { createMember, fundWallet, expectLedgerMatchesBalance } from './helpers';

let app: http.Server;

beforeAll(async () => {
  await sequelize.authenticate();
  app = await startTestServer();
});

// Empty tables before each test. TRUNCATE isn't blocked by the
// append-only trigger on wallet_txs.
beforeEach(async () => {
  await sequelize.truncate({ cascade: true });
});

afterAll(async () => {
  await stopTestServer(app);
  await sequelize.close();
});

// amount is `unknown` so the validation test can send a JS number.
function withdraw(memberId: string, amount: unknown) {
  return request(app).post('/withdrawals').send({ memberId, amount });
}

function wager(walletId: string, amount: string) {
  return request(app).post(`/wallets/${walletId}/wagers`).send({ amount });
}

// The API returns money at the DB scale ("50.000000000000000000"), the same
// as every other endpoint. Compare values, not formatting.
const money = (value: string) => dec(value).toFixed();

// A note on setup: there's no "win" endpoint, so wagers only ever reduce the
// balance. To test "turnover met and still has money to withdraw", several
// tests add a second deposit with multiplier 0. That adds money without
// adding any turnover requirement.

describe('POST /withdrawals', () => {
  // Required by the brief: the turnover lock blocks, then unblocks.
  it('turnover lock blocks the withdrawal, then unblocks it once enough is wagered', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '100', 1); // requires 100 turnover
    await fundWallet(app, memberId, '100', 0); // extra money, no requirement

    // 40 wagered out of 100 required: blocked, and the body says 60 is left.
    await wager(walletId, '40');
    const blocked = await withdraw(memberId, '50');
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toBe('turnover_requirement_not_met');
    expect(money(blocked.body.turnoverRequired)).toBe('100');
    expect(money(blocked.body.turnoverAccrued)).toBe('40');
    expect(money(blocked.body.outstandingTurnover)).toBe('60');
    // A blocked withdrawal must not touch the balance (200 - 40 = 160).
    let wallet = await Wallet.findByPk(walletId);
    expect(money(wallet!.balance)).toBe('160');
    expect(await FundingTx.count({ where: { type: 'withdrawal' } })).toBe(0);

    // Another 60 brings accrued to exactly 100, so it's allowed now
    // (the check is accrued >= required, inclusive).
    await wager(walletId, '60');
    const allowed = await withdraw(memberId, '50');
    expect(allowed.status).toBe(201);
    expect(allowed.body.status).toBe('Pending');
    expect(money(allowed.body.balance)).toBe('50'); // 100 - 50, debited straight away

    wallet = await Wallet.findByPk(walletId);
    expect(money(wallet!.balance)).toBe('50');
    await expectLedgerMatchesBalance(walletId);
  });

  // Requirement is amount x multiplier, and the comparison is exact:
  // 0.01 short is still blocked.
  it('applies the multiplier: amount x multiplier must be wagered', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '50', 3); // requires 150
    await fundWallet(app, memberId, '200', 0);

    await wager(walletId, '149.99');
    const blocked = await withdraw(memberId, '10');
    expect(blocked.status).toBe(422);
    expect(money(blocked.body.outstandingTurnover)).toBe('0.01');

    await wager(walletId, '0.01');
    expect((await withdraw(memberId, '10')).status).toBe(201);
  });

  // Multiplier 0 means no turnover requirement at all.
  it('allows withdrawal straight away when the multiplier is 0', async () => {
    const { memberId } = await createMember(app);
    await fundWallet(app, memberId, '100', 0);
    expect((await withdraw(memberId, '100')).status).toBe(201);
  });

  // A Pending deposit hasn't brought in any money, so it mustn't add to the
  // requirement. Here a 1000 x 5 deposit is created but never completed.
  it('only counts completed deposits towards the requirement', async () => {
    const { memberId } = await createMember(app);
    await request(app).post('/deposits').send({ memberId, amount: '1000', turnoverMultiplier: 5 });
    await fundWallet(app, memberId, '50', 0);
    expect((await withdraw(memberId, '10')).status).toBe(201);
  });

  // The brief says a valid withdrawal debits immediately and creates a
  // Pending funding tx (a human approves it later). Debiting now means the
  // money can't be wagered or withdrawn again while it waits.
  it('debits immediately, creates a Pending withdrawal and a ledger entry', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '100', 0);

    const res = await withdraw(memberId, '30.5');

    expect(res.status).toBe(201);
    const tx = await FundingTx.findByPk(res.body.id);
    expect(tx!.type).toBe('withdrawal');
    expect(tx!.status).toBe('Pending');
    expect(money(tx!.amount)).toBe('30.5'); // stored positive on funding_txs

    // ...and negative on the ledger, linked back to the withdrawal.
    const entry = await WalletTx.findOne({ where: { walletId, kind: 'withdrawal' } });
    expect(money(entry!.amount)).toBe('-30.5');
    expect(entry!.fundingTxId).toBe(tx!.id);
    await expectLedgerMatchesBalance(walletId);
  });

  // Turnover is met (multiplier 0) but the balance isn't enough.
  // Nothing should be created: the funding tx insert rolls back with the debit.
  it('rejects a withdrawal larger than the balance', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '20', 0);

    const res = await withdraw(memberId, '20.01');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_balance');
    const wallet = await Wallet.findByPk(walletId);
    expect(money(wallet!.balance)).toBe('20');
    expect(await FundingTx.count({ where: { type: 'withdrawal' } })).toBe(0);
  });

  // Same idea as concurrent wagers: 100 in the wallet, three withdrawals of
  // 40 at once. The wallet row lock makes them run one at a time:
  // 100 -> 60 -> 20, then the third sees 20 and is rejected.
  it('does not let concurrent withdrawals overdraw the wallet', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '100', 0);

    const results = await Promise.all(Array.from({ length: 3 }, () => withdraw(memberId, '40')));

    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 422)).toHaveLength(1);
    const wallet = await Wallet.findByPk(walletId);
    expect(money(wallet!.balance)).toBe('20');
    expect(await FundingTx.count({ where: { type: 'withdrawal' } })).toBe(2);
    await expectLedgerMatchesBalance(walletId);
  });

  // Unknown member is a 404 from the service. Bad input (a JS number,
  // zero) is a 400 from zod before the service runs.
  it('returns 404 for an unknown member and 400 for bad input', async () => {
    const res = await withdraw('00000000-0000-4000-8000-000000000000', '1');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('member_not_found');

    const { memberId } = await createMember(app);
    expect((await withdraw(memberId, 5)).status).toBe(400);
    expect((await withdraw(memberId, '0')).status).toBe(400);
  });
});
