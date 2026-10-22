import request from 'supertest';
import http from 'http';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../src/db/sequelize';
import { Wallet } from '../src/db/models';
import { dec } from '../src/lib/money';

let counter = 0;

export async function createMember(app: http.Server): Promise<{ memberId: string; walletId: string }> {
  counter += 1;
  const res = await request(app)
    .post('/members')
    .send({ username: `player_${process.pid}_${counter}` });
  expect(res.status).toBe(201);
  return { memberId: res.body.member.id, walletId: res.body.wallet.id };
}

export async function getBalance(app: http.Server, memberId: string): Promise<string> {
  const res = await request(app).get(`/members/${memberId}/wallet`);
  expect(res.status).toBe(200);
  return res.body.balance;
}

export async function createDeposit(
  app: http.Server,
  memberId: string,
  amount: string,
  turnoverMultiplier = 1,
): Promise<{ id: string; pspRef: string }> {
  const res = await request(app).post('/deposits').send({ memberId, amount, turnoverMultiplier });
  expect(res.status).toBe(201);
  return res.body;
}

export function callback(app: http.Server, pspRef: string, status: 'completed' | 'failed', amount: string) {
  return request(app).post('/psp/callbacks').send({ pspRef, status, amount });
}

export function wager(app: http.Server, walletId: string, amount: string) {
  return request(app).post(`/wallets/${walletId}/wagers`).send({ amount });
}

export function withdraw(app: http.Server, memberId: string, amount: string) {
  return request(app).post('/withdrawals').send({ memberId, amount });
}

/**
 * Deposit + completed callback: money arrives the same way it does in
 * production, so tests never write balances directly.
 */
export async function fundWallet(
  app: http.Server,
  memberId: string,
  amount: string,
  turnoverMultiplier = 1,
): Promise<void> {
  const { pspRef } = await createDeposit(app, memberId, amount, turnoverMultiplier);
  const res = await callback(app, pspRef, 'completed', amount);
  expect(res.body.outcome).toBe('credited');
}
export const fund = fundWallet;

export async function getWallet(walletId: string): Promise<Wallet> {
  const wallet = await Wallet.findByPk(walletId);
  if (!wallet) throw new Error(`wallet ${walletId} not found`);
  return wallet;
}

export async function ledgerCount(walletId: string, kind?: string): Promise<number> {
  const [row] = await sequelize.query<{ n: string }>(
    `SELECT count(*) AS n FROM wallet_txs WHERE wallet_id = :walletId ${kind ? 'AND kind = :kind' : ''}`,
    { replacements: { walletId, kind }, type: QueryTypes.SELECT },
  );
  return Number(row.n);
}

/**
 * The money invariant every money test ends with:
 *   - SUM(ledger.amount) == wallet.balance  (balance is reconstructible from the ledger)
 *   - each row's balance_after == previous balance_after + amount  (no gaps, no edits)
 * Ordered by seq, not created_at: concurrent entries can share a millisecond.
 */
export async function expectLedgerMatchesBalance(walletId: string): Promise<void> {
  const wallet = await getWallet(walletId);
  const rows = await sequelize.query<{ amount: string; balance_after: string }>(
    `SELECT amount, balance_after FROM wallet_txs WHERE wallet_id = :walletId ORDER BY seq`,
    { replacements: { walletId }, type: QueryTypes.SELECT },
  );

  let running = dec(0);
  for (const row of rows) {
    running = running.plus(row.amount);
    expect(dec(row.balance_after).toFixed()).toBe(running.toFixed());
  }
  expect(running.toFixed()).toBe(dec(wallet.balance).toFixed());
}
export const expectLedgerReconciles = expectLedgerMatchesBalance;
