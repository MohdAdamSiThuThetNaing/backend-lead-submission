import { DataTypes, Model, Sequelize } from 'sequelize';

export const FUNDING_TX_TYPES = ['deposit', 'withdrawal'] as const;
export const FUNDING_TX_STATUSES = ['Pending', 'Completed', 'Failed'] as const;

export type FundingTxType = (typeof FUNDING_TX_TYPES)[number];
export type FundingTxStatus = (typeof FUNDING_TX_STATUSES)[number];

/**
 * Money crossing the platform boundary. The DB enforces the invariants
 * (see migration 20260701000003); this model mirrors them for type safety.
 *
 * All DECIMAL columns are strings in JS. Do arithmetic via src/lib/money.ts,
 * never with Number().
 */
export class FundingTx extends Model {
  declare id: string;
  declare walletId: string;
  declare type: FundingTxType;
  declare status: FundingTxStatus;
  /** Amount we requested. Never overwritten by a callback. */
  declare amount: string;
  /** Amount the PSP reported in its callback; null until settled. Audit only. */
  declare pspAmount: string | null;
  /** Deposits only; withdrawals are always 0. */
  declare turnoverMultiplier: number;
  /** Our opaque reference echoed by the PSP. Unique: the idempotency key. */
  declare pspRef: string | null;
  /** Set exactly when status leaves Pending. */
  declare settledAt: Date | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export function initFundingTx(sequelize: Sequelize): void {
  FundingTx.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      walletId: { type: DataTypes.UUID, allowNull: false },
      type: {
        type: DataTypes.STRING(16),
        allowNull: false,
        validate: { isIn: [FUNDING_TX_TYPES as unknown as string[]] },
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'Pending',
        validate: { isIn: [FUNDING_TX_STATUSES as unknown as string[]] },
      },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      pspAmount: { type: DataTypes.DECIMAL(36, 18), allowNull: true },
      turnoverMultiplier: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      pspRef: { type: DataTypes.STRING(64), allowNull: true, unique: true },
      settledAt: { type: DataTypes.DATE, allowNull: true },
    },
    { sequelize, tableName: 'funding_txs', underscored: true },
  );
}
