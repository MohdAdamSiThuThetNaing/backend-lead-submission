import { FundingTxStatus } from '../db/models/fundingTx';
import { HttpError } from '../lib/errors';

/**
 * The only legal moves for a funding transaction. Completed and Failed are
 * terminal: a PSP that reports success after failure (or the reverse) needs a
 * human, not a silent overwrite. The DB backs this up with
 * funding_txs_settled_consistency_chk.
 */
const TRANSITIONS: Readonly<Record<FundingTxStatus, readonly FundingTxStatus[]>> = {
  Pending: ['Completed', 'Failed'],
  Completed: [],
  Failed: [],
};

export function canTransition(from: FundingTxStatus, to: FundingTxStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: FundingTxStatus, to: FundingTxStatus): void {
  if (!canTransition(from, to)) {
    throw new HttpError(409, 'invalid_state_transition', { from, to });
  }
}
