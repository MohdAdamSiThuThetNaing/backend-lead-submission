import { randomUUID } from 'crypto';
import { sequelize } from '../db/sequelize';
import { FundingTx, Wallet } from '../db/models';
import { assertTransition } from '../domain/fundingTxStateMachine';
import { HttpError } from '../lib/errors';
import { dec, toMoneyString } from '../lib/money';
import { lockWallet, postLedgerEntry } from './ledger';

/** A1: record intent to deposit. No money moves until the PSP confirms. */
export async function createDeposit(input: {
  memberId: string;
  amount: string;
  turnoverMultiplier: number;
}): Promise<FundingTx> {
  const wallet = await Wallet.findOne({ where: { memberId: input.memberId } });
  if (!wallet) {
    throw new HttpError(404, 'member_not_found');
  }

  return FundingTx.create({
    walletId: wallet.id,
    type: 'deposit',
    status: 'Pending',
    amount: toMoneyString(dec(input.amount)),
    turnoverMultiplier: input.turnoverMultiplier,
    // Opaque to the PSP and unguessable; the UNIQUE index makes it our lookup key.
    pspRef: `dep_${randomUUID()}`,
  });
}

export type CallbackOutcome =
  | 'credited' //          Pending -> Completed, wallet credited (happens at most once)
  | 'failed' //            Pending -> Failed, no money moved
  | 'duplicate' //         replay of a callback we already applied; acknowledged, no-op
  | 'held_for_review'; //  refused to auto-settle (amount mismatch); a human decides

/**
 * A2: apply a PSP callback exactly once.
 *
 * Idempotency and concurrency come from one mechanism: the funding tx row is
 * locked (SELECT ... FOR UPDATE) before its status is read. Two concurrent
 * deliveries of the same callback serialise on that lock; the second one wakes
 * up, re-reads the row Postgres hands it (already Completed) and returns
 * 'duplicate'. The ledger's UNIQUE(funding_tx_id, kind) index is a second line
 * of defence: even if this code were wrong, a second credit row cannot commit.
 *
 * Lock order is always funding tx -> wallet. Wagers and withdrawals lock only
 * the wallet and never wait on a funding tx lock, so no cycle, no deadlock.
 */
export async function handlePspCallback(input: {
  pspRef: string;
  status: 'completed' | 'failed';
  amount: string;
}): Promise<{ outcome: CallbackOutcome; fundingTx: FundingTx }> {
  return sequelize.transaction(async (t) => {
    const fundingTx = await FundingTx.findOne({
      where: { pspRef: input.pspRef, type: 'deposit' },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!fundingTx) {
      // eslint-disable-next-line no-console
      console.warn('psp_callback_unknown_ref', { pspRef: input.pspRef });
      throw new HttpError(404, 'unknown_psp_ref');
    }

    const target = input.status === 'completed' ? 'Completed' : 'Failed';

    // Late or concurrent retry of something we already applied: acknowledge
    // with 2xx so the PSP stops retrying, and change nothing.
    if (fundingTx.status === target) {
      return { outcome: 'duplicate' as const, fundingTx };
    }

    // Completed -> Failed or Failed -> Completed: rejected, never applied.
    assertTransition(fundingTx.status, target);

    // Once flagged, only a human settles it, whatever later callbacks say.
    if (fundingTx.reviewReason) {
      return { outcome: 'held_for_review' as const, fundingTx };
    }

    const reported = dec(input.amount);

    if (target === 'Completed' && !reported.isEqualTo(fundingTx.amount)) {
      // Policy: never auto-credit an amount we did not ask for, in either
      // direction. Record what the PSP claims, keep the tx Pending, flag it.
      fundingTx.pspAmount = toMoneyString(reported);
      fundingTx.reviewReason = 'amount_mismatch';
      await fundingTx.save({ transaction: t });
      // eslint-disable-next-line no-console
      console.warn('psp_callback_amount_mismatch', {
        fundingTxId: fundingTx.id,
        expected: fundingTx.amount,
        reported: fundingTx.pspAmount,
      });
      return { outcome: 'held_for_review' as const, fundingTx };
    }

    fundingTx.status = target;
    fundingTx.pspAmount = toMoneyString(reported);
    fundingTx.settledAt = new Date();
    await fundingTx.save({ transaction: t });

    if (target === 'Failed') {
      return { outcome: 'failed' as const, fundingTx };
    }

    const wallet = await lockWallet({ id: fundingTx.walletId }, t);
    if (!wallet) {
      throw new Error(`wallet ${fundingTx.walletId} missing for funding tx ${fundingTx.id}`);
    }
    const amount = dec(fundingTx.amount);
    wallet.turnoverRequired = toMoneyString(
      dec(wallet.turnoverRequired).plus(amount.times(fundingTx.turnoverMultiplier)),
    );
    await postLedgerEntry(wallet, { kind: 'deposit', amount, fundingTxId: fundingTx.id }, t);

    return { outcome: 'credited' as const, fundingTx };
  });
}
