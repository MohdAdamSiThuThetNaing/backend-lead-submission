import request from 'supertest';
import http from 'http';
import { startTestServer, stopTestServer } from './server';
import { sequelize } from '../src/db/sequelize';
import { Wallet, WalletTx } from '../src/db/models';
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

// amount is `unknown` on purpose so the validation test can send a
// JS number and check it gets rejected.
function wager(walletId: string, amount: unknown) {
  return request(app).post(`/wallets/${walletId}/wagers`).send({ amount });
}

// The API returns money at the DB scale ("89.750000000000000000"), the same
// as every other endpoint. Compare values, not formatting.
const money = (value: string) => dec(value).toFixed();

describe('POST /wallets/:walletId/wagers', () => {
  // Happy path. fundWallet goes through deposit + completed callback, so
  // the money arrives the same way it would in production.
  it('debits the wallet, accrues turnover and writes a negative ledger entry', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '100');

    const res = await wager(walletId, '10.25');

    expect(res.status).toBe(201);
    expect(money(res.body.balance)).toBe('89.75');
    expect(money(res.body.turnoverAccrued)).toBe('10.25');

    // Debits are stored as negative amounts, so SUM(amount) == balance.
    const entries = await WalletTx.findAll({ where: { walletId, kind: 'wager' } });
    expect(entries).toHaveLength(1);
    expect(money(entries[0].amount)).toBe('-10.25');
    await expectLedgerMatchesBalance(walletId);
  });

  // Edge case: the check is balance >= amount, not balance > amount.
  it('allows a wager that takes the balance to exactly zero', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '50');

    const res = await wager(walletId, '50');

    expect(res.status).toBe(201);
    expect(money(res.body.balance)).toBe('0');
  });

  // A rejected wager must leave no trace: same balance, no turnover,
  // no ledger row. The whole thing runs in one transaction.
  it('rejects a wager larger than the balance and changes nothing', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '20');

    const res = await wager(walletId, '20.01');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_balance');
    expect(money(res.body.balance)).toBe('20');
    expect(money(res.body.requested)).toBe('20.01');
    const wallet = await Wallet.findByPk(walletId);
    expect(money(wallet!.balance)).toBe('20');
    expect(money(wallet!.turnoverAccrued)).toBe('0');
    expect(await WalletTx.count({ where: { walletId, kind: 'wager' } })).toBe(0);
  });

  // Required by the brief: concurrent wagers must not overdraw.
  // 100 in the wallet, 5 wagers of 30 sent at once. Without a lock, all five
  // could read "100" and pass the check. With FOR UPDATE on the wallet row
  // they run one at a time: 100 -> 70 -> 40 -> 10, then the last two see 10
  // and are rejected.
  it('does not let concurrent wagers overdraw the wallet', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '100');

    const results = await Promise.all(Array.from({ length: 5 }, () => wager(walletId, '30')));

    const ok = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 422);
    expect(ok).toHaveLength(3);
    expect(rejected).toHaveLength(2);

    const wallet = await Wallet.findByPk(walletId);
    expect(money(wallet!.balance)).toBe('10');
    // Only the 3 successful wagers count towards turnover.
    expect(money(wallet!.turnoverAccrued)).toBe('90');
    expect(await WalletTx.count({ where: { walletId, kind: 'wager' } })).toBe(3);
    await expectLedgerMatchesBalance(walletId);
  });

  // A valid UUID that doesn't exist.
  it('returns 404 for an unknown wallet', async () => {
    const res = await wager('00000000-0000-4000-8000-000000000000', '1');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('wallet_not_found');
  });

  // Bad input is rejected by zod before it reaches the service.
  // 10 (a number, not a string) is the important one: money must never
  // arrive as a JS number.
  it('rejects an invalid walletId and invalid amounts', async () => {
    expect((await wager('not-a-uuid', '1')).status).toBe(400);
    const { walletId } = await createMember(app);
    expect((await wager(walletId, 10)).status).toBe(400);
    expect((await wager(walletId, '0')).status).toBe(400);
    expect((await wager(walletId, '-1')).status).toBe(400);
  });
});
