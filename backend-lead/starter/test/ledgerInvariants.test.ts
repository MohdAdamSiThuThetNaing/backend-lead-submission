import http from 'http';
import { startTestServer, stopTestServer } from './server';
import { sequelize } from '../src/db/sequelize';
import { FundingTx, WalletTx } from '../src/db/models';
import { assertTransition, canTransition } from '../src/services/fundingStateMachine';
import { createMember, fundWallet } from './helpers';

let app: http.Server;

beforeAll(async () => {
  await sequelize.authenticate();
  app = await startTestServer();
});

beforeEach(async () => {
  await sequelize.truncate({ cascade: true });
});

afterAll(async () => {
  await stopTestServer(app);
  await sequelize.close();
});

// The services are the first line of defence. These tests skip them and use
// raw SQL, to prove the database itself refuses bad money state if a future
// code change gets it wrong.
describe('database-level money invariants', () => {
  it('refuses to UPDATE or DELETE ledger rows (append-only trigger)', async () => {
    const { memberId } = await createMember(app);
    await fundWallet(app, memberId, '10');

    await expect(sequelize.query('UPDATE wallet_txs SET amount = 999')).rejects.toThrow(/append-only/);
    await expect(sequelize.query('DELETE FROM wallet_txs')).rejects.toThrow(/append-only/);
  });

  it('refuses a second deposit ledger row for the same funding tx', async () => {
    const { memberId, walletId } = await createMember(app);
    await fundWallet(app, memberId, '10');
    const tx = await FundingTx.findOne({ where: { type: 'deposit' } });

    // Sequelize rewrites unique violations to "Validation error"; the
    // constraint name lives on the underlying pg error.
    await expect(
      sequelize.query(
        `INSERT INTO wallet_txs (wallet_id, kind, amount, balance_after, funding_tx_id)
         VALUES (:walletId, 'deposit', 10, 20, :fundingTxId)`,
        { replacements: { walletId, fundingTxId: tx!.id } },
      ),
    ).rejects.toMatchObject({ parent: { constraint: 'wallet_txs_funding_kind_uq' } });
  });

  it('refuses a negative balance', async () => {
    const { walletId } = await createMember(app);
    await expect(
      sequelize.query('UPDATE wallets SET balance = -1 WHERE id = :walletId', { replacements: { walletId } }),
    ).rejects.toThrow(/wallets_balance_non_negative/);
  });

  it('refuses a debit recorded with the wrong sign', async () => {
    const { walletId } = await createMember(app);
    await expect(
      sequelize.query(
        `INSERT INTO wallet_txs (wallet_id, kind, amount, balance_after) VALUES (:walletId, 'wager', 5, 5)`,
        { replacements: { walletId } },
      ),
    ).rejects.toThrow(/wallet_txs_sign_chk/);
  });

  it('refuses a settled funding tx without settled_at', async () => {
    const { memberId } = await createMember(app);
    await fundWallet(app, memberId, '10');
    await expect(sequelize.query('UPDATE funding_txs SET settled_at = NULL')).rejects.toThrow(
      /funding_txs_settled_consistency_chk/,
    );
  });

  it('the model refuses to update a ledger row before it reaches the DB', async () => {
    const { memberId } = await createMember(app);
    await fundWallet(app, memberId, '10');
    const row = await WalletTx.findOne();
    await expect(row!.update({ amount: '1' })).rejects.toThrow(/append-only/);
  });
});

describe('funding tx state machine', () => {
  it.each([
    ['Pending', 'Completed', true],
    ['Pending', 'Failed', true],
    ['Completed', 'Failed', false],
    ['Failed', 'Completed', false],
    ['Completed', 'Pending', false],
    ['Failed', 'Pending', false],
  ] as const)('%s -> %s allowed: %s', (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
    if (!allowed) expect(() => assertTransition(from, to)).toThrow('invalid_state_transition');
  });
});
