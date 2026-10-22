import { sequelize } from '../db/sequelize';
import { Wallet, WalletTx } from '../db/models';
import { HttpError } from '../lib/errors';
import { dec, toMoneyString } from '../lib/money';
import { lockWallet, postLedgerEntry } from './ledger';

/**
 * A3: debit a wager and accrue turnover.
 *
 * The wallet row lock serialises concurrent wagers, so the balance check in
 * postLedgerEntry always sees the latest committed balance: two wagers that
 * each fit the balance alone cannot both pass. wallets_balance_non_negative
 * and wallet_txs_balance_after_chk would reject an overdraw even if they did.
 */
export async function placeWager(
  walletId: string,
  amount: string,
): Promise<{ wallet: Wallet; entry: WalletTx }> {
  return sequelize.transaction(async (t) => {
    const wallet = await lockWallet({ id: walletId }, t);
    if (!wallet) {
      throw new HttpError(404, 'wallet_not_found');
    }

    const stake = dec(amount);
    wallet.turnoverAccrued = toMoneyString(dec(wallet.turnoverAccrued).plus(stake));
    const entry = await postLedgerEntry(wallet, { kind: 'wager', amount: stake.negated() }, t);

    return { wallet, entry };
  });
}
