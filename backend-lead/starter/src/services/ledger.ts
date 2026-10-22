import BigNumber from 'bignumber.js';
import { Transaction, WhereOptions } from 'sequelize';
import { Wallet, WalletTx } from '../db/models';
import { WalletTxKind } from '../db/models/walletTx';
import { HttpError } from '../lib/errors';
import { dec, toMoneyString } from '../lib/money';

/**
 * The single code path that changes a wallet balance.
 *
 * Every money movement in the system goes:
 *   1. lockWallet()      SELECT ... FOR UPDATE: concurrent writers to the same
 *                        wallet queue here, so balance checks cannot race
 *   2. caller mutates any other wallet fields (turnover) on the locked row
 *   3. postLedgerEntry() writes the ledger row and the new balance together
 *
 * All three run inside the caller's transaction, so either both the ledger
 * row and the balance change commit, or neither does.
 */
export async function lockWallet(where: WhereOptions<Wallet>, t: Transaction): Promise<Wallet | null> {
  return Wallet.findOne({ where, transaction: t, lock: t.LOCK.UPDATE });
}

export async function postLedgerEntry(
  wallet: Wallet,
  entry: { kind: WalletTxKind; amount: BigNumber; fundingTxId?: string | null },
  t: Transaction,
): Promise<WalletTx> {
  const newBalance = dec(wallet.balance).plus(entry.amount);
  if (newBalance.isNegative()) {
    throw new HttpError(422, 'insufficient_balance', {
      balance: toMoneyString(dec(wallet.balance)),
      requested: toMoneyString(entry.amount.abs()),
    });
  }

  wallet.balance = toMoneyString(newBalance);
  await wallet.save({ transaction: t });

  return WalletTx.create(
    {
      walletId: wallet.id,
      kind: entry.kind,
      amount: toMoneyString(entry.amount),
      balanceAfter: wallet.balance,
      fundingTxId: entry.fundingTxId ?? null,
    },
    { transaction: t },
  );
}
