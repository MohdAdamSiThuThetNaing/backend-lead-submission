import request from 'supertest';
import http from 'http';
import { startTestServer, stopTestServer } from './server';
import { sequelize } from '../src/db/sequelize';
import { FundingTx, Wallet, WalletTx } from '../src/db/models';
import { dec } from '../src/lib/money';
import { createMember } from './helpers';

let app: http.Server;

beforeAll(async () => {
  await sequelize.authenticate();
  app = await startTestServer();
});

// Start every test from empty tables. TRUNCATE isn't blocked by the
// append-only trigger on wallet_txs (that only fires on UPDATE/DELETE).
beforeEach(async () => {
  await sequelize.truncate({ cascade: true });
});

afterAll(async () => {
  await stopTestServer(app);
  await sequelize.close();
});

// Creates a member and a Pending deposit through the API.
// Defaults: 100.50 with multiplier 2, so a completed callback should add
// 201 to turnover_required.
async function setupDeposit(amount = '100.50', turnoverMultiplier = 2) {
  const { memberId, walletId } = await createMember(app);
  const res = await request(app)
    .post('/deposits')
    .send({ memberId, amount, turnoverMultiplier });
  return { memberId, walletId, pspRef: res.body.pspRef as string, depositId: res.body.id as string };
}

// Plays the role of the mock PSP calling our webhook.
function callback(body: object) {
  return request(app).post('/psp/callbacks').send(body);
}

// The ledger must always add up to the wallet balance (brief, A2).
// Called after every test that moves money.
async function expectLedgerMatchesBalance(walletId: string) {
  const wallet = await Wallet.findByPk(walletId);
  const rows = await WalletTx.findAll({ where: { walletId } });
  const sum = rows.reduce((acc, r) => acc.plus(r.amount), dec(0));
  expect(sum.toFixed()).toBe(dec(wallet!.balance).toFixed());
}

describe('POST /psp/callbacks', () => {
  // Happy path: one callback, one credit, one ledger row, turnover added.
  it('credits the wallet once on completed, writes a ledger entry and adds turnover', async () => {
    const { walletId, pspRef, depositId } = await setupDeposit('100.50', 2);

    const res = await callback({ pspRef, status: 'completed', amount: '100.50' });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('credited');
    expect(res.body.status).toBe('Completed');

    const wallet = await Wallet.findByPk(walletId);
    expect(dec(wallet!.balance).toFixed()).toBe('100.5');
    expect(dec(wallet!.turnoverRequired).toFixed()).toBe('201'); // 100.50 x 2

    const ledger = await WalletTx.findAll({ where: { walletId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].kind).toBe('deposit');
    expect(ledger[0].fundingTxId).toBe(depositId);
    await expectLedgerMatchesBalance(walletId);
  });

  // Required by the brief: the PSP retries the same callback later.
  // The second one must be a no-op, and still 200 so the PSP stops retrying.
  it('does not double-credit a duplicate callback delivered later (sequential)', async () => {
    const { walletId, pspRef } = await setupDeposit();
    const body = { pspRef, status: 'completed', amount: '100.50' };

    const first = await callback(body);
    const second = await callback(body);

    expect(first.body.outcome).toBe('credited');
    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe('duplicate');

    const wallet = await Wallet.findByPk(walletId);
    expect(dec(wallet!.balance).toFixed()).toBe('100.5'); // not 201
    expect(await WalletTx.count({ where: { walletId } })).toBe(1);
    await expectLedgerMatchesBalance(walletId);
  });

  // Required by the brief: the same callback arrives several times at once.
  // Promise.all sends all 5 before any finishes, and the pool (Sequelize
  // default: 5 connections) lets them race inside Postgres. The row lock makes
  // exactly one of them credit; the rest wait, then see Completed.
  it('does not double-credit concurrent duplicate callbacks', async () => {
    const { walletId, pspRef } = await setupDeposit();
    const body = { pspRef, status: 'completed', amount: '100.50' };

    const results = await Promise.all(Array.from({ length: 5 }, () => callback(body)));

    results.forEach((r) => expect(r.status).toBe(200));
    // Order isn't guaranteed, so sort before comparing.
    const outcomes = results.map((r) => r.body.outcome).sort();
    expect(outcomes).toEqual(['credited', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);

    const wallet = await Wallet.findByPk(walletId);
    expect(dec(wallet!.balance).toFixed()).toBe('100.5');
    expect(dec(wallet!.turnoverRequired).toFixed()).toBe('201'); // added once, not five times
    expect(await WalletTx.count({ where: { walletId } })).toBe(1);
    await expectLedgerMatchesBalance(walletId);
  });

  it('marks a failed payment Failed and moves no money', async () => {
    const { walletId, pspRef } = await setupDeposit();

    const res = await callback({ pspRef, status: 'failed', amount: '100.50' });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('failed');
    expect(res.body.status).toBe('Failed');
    const wallet = await Wallet.findByPk(walletId);
    expect(dec(wallet!.balance).toFixed()).toBe('0');
    expect(await WalletTx.count()).toBe(0); // no money moved, so no ledger row
  });

  // State machine: Failed is final. A late "completed" must not credit.
  it('rejects Failed -> Completed', async () => {
    const { walletId, pspRef } = await setupDeposit();
    await callback({ pspRef, status: 'failed', amount: '100.50' });

    const res = await callback({ pspRef, status: 'completed', amount: '100.50' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'invalid_state_transition', from: 'Failed', to: 'Completed' });
    const wallet = await Wallet.findByPk(walletId);
    expect(dec(wallet!.balance).toFixed()).toBe('0');
  });

  // State machine: Completed is final too. A late "failed" must not
  // undo the credit or flip the status.
  it('rejects Completed -> Failed and keeps the credit', async () => {
    const { walletId, pspRef } = await setupDeposit();
    await callback({ pspRef, status: 'completed', amount: '100.50' });

    const res = await callback({ pspRef, status: 'failed', amount: '100.50' });

    expect(res.status).toBe(409);
    const tx = await FundingTx.findOne({ where: { pspRef } });
    expect(tx!.status).toBe('Completed');
    const wallet = await Wallet.findByPk(walletId);
    expect(dec(wallet!.balance).toFixed()).toBe('100.5');
  });

  it('returns 404 for an unknown pspRef', async () => {
    const res = await callback({ pspRef: 'dep_does_not_exist', status: 'completed', amount: '1' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_psp_ref');
  });

  // My decision for the brief's open question (see DECISIONS.md section 5):
  // never credit an amount we didn't ask for. Keep the deposit Pending, record
  // what the PSP claimed, flag it, and answer 202 so the PSP stops retrying.
  it('does not credit on amount mismatch, keeps it Pending and flags it for review', async () => {
    const { walletId, pspRef } = await setupDeposit('100.50');

    const res = await callback({ pspRef, status: 'completed', amount: '999.00' });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      outcome: 'held_for_review',
      status: 'Pending',
      reviewReason: 'amount_mismatch',
    });
    const tx = await FundingTx.findOne({ where: { pspRef } });
    expect(tx!.status).toBe('Pending');
    expect(dec(tx!.amount).toFixed()).toBe('100.5'); // what we asked for is never overwritten
    expect(dec(tx!.pspAmount!).toFixed()).toBe('999'); // what the PSP claimed, kept for audit
    const wallet = await Wallet.findByPk(walletId);
    expect(dec(wallet!.balance).toFixed()).toBe('0');
    expect(await WalletTx.count()).toBe(0);
  });

  // Once flagged, a human decides. A later "correct" callback must not
  // quietly settle it: the first mismatch may be the real signal.
  it('never auto-settles a flagged deposit, even if a matching callback follows', async () => {
    const { walletId, pspRef } = await setupDeposit('100.50');
    await callback({ pspRef, status: 'completed', amount: '999.00' });

    const retry = await callback({ pspRef, status: 'completed', amount: '100.50' });

    expect(retry.status).toBe(202);
    expect(retry.body.outcome).toBe('held_for_review');
    const wallet = await Wallet.findByPk(walletId);
    expect(dec(wallet!.balance).toFixed()).toBe('0');
  });

  // Amounts are compared as numbers (BigNumber), not as text,
  // so "100.500" is the same as "100.50".
  it('treats equal amounts written differently as a match', async () => {
    const { pspRef } = await setupDeposit('100.50');
    const res = await callback({ pspRef, status: 'completed', amount: '100.500' });
    expect(res.body.outcome).toBe('credited');
  });

  // Only "completed" and "failed" are valid. Anything else is rejected
  // by zod before it reaches the service.
  it('rejects an unknown status', async () => {
    const { pspRef } = await setupDeposit();
    const res = await callback({ pspRef, status: 'success', amount: '100.50' });
    expect(res.status).toBe(400);
  });
});
