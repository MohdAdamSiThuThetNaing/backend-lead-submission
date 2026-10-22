import { DataTypes, Model, Sequelize } from 'sequelize';

export class Wallet extends Model {
  declare id: string;
  declare memberId: string;
  // DECIMAL comes back from the pg driver as a string. Keep it that way; see src/lib/money.ts.
  declare balance: string;
  /** Sum of amount x turnoverMultiplier over completed deposits. */
  declare turnoverRequired: string;
  /** Sum of wager amounts. Withdrawal is allowed once accrued >= required. */
  declare turnoverAccrued: string;
}

export function initWallet(sequelize: Sequelize): void {
  Wallet.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      memberId: { type: DataTypes.UUID, allowNull: false },
      balance: { type: DataTypes.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
      turnoverRequired: { type: DataTypes.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
      turnoverAccrued: { type: DataTypes.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
    },
    { sequelize, tableName: 'wallets', underscored: true },
  );
}
