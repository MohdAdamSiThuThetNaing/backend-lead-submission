import { DataTypes, Model, Sequelize } from 'sequelize';

export const WALLET_TX_KINDS = ['deposit', 'wager', 'withdrawal'] as const;
export type WalletTxKind = (typeof WALLET_TX_KINDS)[number];

/** Kinds that add money to the wallet; every other kind must be a debit. */
const CREDIT_KINDS: ReadonlySet<WalletTxKind> = new Set(['deposit']);

/**
 * Append-only ledger. Every balance change writes exactly one row, so
 *   SUM(amount) per wallet == wallets.balance
 * holds at all times and the balance is reconstructible from history.
 *
 * Immutability is enforced in three places:
 *   1. DB trigger rejects UPDATE/DELETE (migration 20260701000004) - the real guarantee
 *   2. Model hooks below fail fast in application code with a clear message
 *   3. No updatedAt column: there is nothing to update
 *
 * Corrections are new compensating rows, never edits.
 */
export class WalletTx extends Model {
  declare id: string;
  declare walletId: string;
  declare kind: WalletTxKind;
  /** Signed DECIMAL as string: positive = credit, negative = debit. */
  declare amount: string;
  /** Wallet balance right after this entry; lets audits verify the chain row by row. */
  declare balanceAfter: string;
  /** Set for deposit/withdrawal entries; UNIQUE(funding_tx_id, kind) blocks double-credit. */
  declare fundingTxId: string | null;
  declare readonly createdAt: Date;
}

const appendOnly = (): never => {
  throw new Error('wallet_txs is append-only: write a compensating entry instead');
};

export function initWalletTx(sequelize: Sequelize): void {
  WalletTx.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      walletId: { type: DataTypes.UUID, allowNull: false },
      kind: {
        type: DataTypes.STRING(16),
        allowNull: false,
        validate: { isIn: [WALLET_TX_KINDS as unknown as string[]] },
      },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      balanceAfter: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      fundingTxId: { type: DataTypes.UUID, allowNull: true },
    },
    {
      sequelize,
      tableName: 'wallet_txs',
      underscored: true,
      updatedAt: false,
      validate: {
        // Sign must match the kind: deposits credit, wagers/withdrawals debit.
        signMatchesKind(this: WalletTx) {
          const negative = String(this.amount).trim().startsWith('-');
          if (CREDIT_KINDS.has(this.kind) === negative) {
            throw new Error(`wallet_txs.amount sign does not match kind '${this.kind}'`);
          }
        },
      },
      hooks: {
        beforeUpdate: appendOnly,
        beforeBulkUpdate: appendOnly,
        beforeDestroy: appendOnly,
      },
    },
  );
}
