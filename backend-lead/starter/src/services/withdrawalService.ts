import { sequelize } from '../db/sequelize';
import { FundingTx, Wallet } from '../db/models';
import { HttpError } from '../lib/errors';
import { dec, toMoneyString } from '../lib/money';
import { lockWallet, postLedgerEntry } from './ledger';

/**
 * A4: withdraw, gated by the turnover lock.
 *
 * Turnover is checked on the locked wallet row, in the same transaction as the
 * debit, so a wager or deposit callback cannot change it between check and use.
 * The debit happens now (funds are reserved for the payout); the funding tx
 * stays Pending until a human approves it.
 */
export async function requestWithdrawal(
  memberId: string,
  amount: string,
): Promise<{ wallet: Wallet; fundingTx: FundingTx }> {
  return sequelize.transaction(async (t) => {
    const wallet = await lockWallet({ memberId }, t);
    if (!wallet) {
      throw new HttpError(404, 'member_not_found');
    }

    const required = dec(wallet.turnoverRequired);
    const accrued = dec(wallet.turnoverAccrued);
    if (accrued.lt(required)) {
      throw new HttpError(422, 'turnover_requirement_not_met', {
        outstandingTurnover: toMoneyString(required.minus(accrued)),
        turnoverRequired: toMoneyString(required),
        turnoverAccrued: toMoneyString(accrued),
      });
    }

    const value = dec(amount);
    const fundingTx = await FundingTx.create(
      {
        walletId: wallet.id,
        type: 'withdrawal',
        status: 'Pending',
        amount: toMoneyString(value),
        turnoverMultiplier: 0,
        pspRef: null,
      },
      { transaction: t },
    );
    // Throws insufficient_balance (and rolls back the funding tx) if it does not fit.
    await postLedgerEntry(wallet, { kind: 'withdrawal', amount: value.negated(), fundingTxId: fundingTx.id }, t);

    return { wallet, fundingTx };
  });
}
