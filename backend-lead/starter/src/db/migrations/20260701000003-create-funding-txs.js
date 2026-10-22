'use strict';

/**
 * funding_txs: money crossing the platform boundary (PSP deposits, withdrawals).
 *
 * Invariants live in the database, not only in services, so a bug in
 * application code fails loudly instead of corrupting money state:
 *   - deposits always carry a psp_ref (otherwise a callback can never match)
 *   - only deposits carry a turnover multiplier
 *   - settled_at is set iff the tx has left Pending (DB backstop for the
 *     Pending -> Completed | Failed state machine in src/services/fundingStateMachine.ts)
 *
 * CHECK constraints instead of Postgres ENUMs: adding a status later is a
 * constraint swap inside a transaction; ALTER TYPE ... ADD VALUE is not.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'funding_txs',
        {
          id: {
            type: Sequelize.UUID,
            primaryKey: true,
            defaultValue: Sequelize.literal('gen_random_uuid()'),
          },
          wallet_id: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: 'wallets', key: 'id' },
            onDelete: 'RESTRICT', // money records never disappear with their wallet
            onUpdate: 'CASCADE',
          },
          type: { type: Sequelize.STRING(16), allowNull: false },
          status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'Pending' },
          // Amount we asked the PSP for. Never overwritten by a callback.
          amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
          // Amount the PSP reported in its callback. Kept for audit and mismatch review.
          psp_amount: { type: Sequelize.DECIMAL(36, 18), allowNull: true },
          // Set when an automated settlement was refused and a human must decide
          // (e.g. 'amount_mismatch'). A flagged tx is never auto-settled.
          review_reason: { type: Sequelize.STRING(64), allowNull: true },
          turnover_multiplier: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          // Our opaque reference, echoed back by the PSP. UNIQUE: one row per payment.
          psp_ref: { type: Sequelize.STRING(64), allowNull: true, unique: true },
          settled_at: { type: Sequelize.DATE, allowNull: true },
          created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
          updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        },
        { transaction },
      );

      await queryInterface.sequelize.query(
        `
        ALTER TABLE funding_txs
          ADD CONSTRAINT funding_txs_type_chk
            CHECK (type IN ('deposit', 'withdrawal')),
          ADD CONSTRAINT funding_txs_status_chk
            CHECK (status IN ('Pending', 'Completed', 'Failed')),
          ADD CONSTRAINT funding_txs_amount_chk
            CHECK (amount > 0),
          ADD CONSTRAINT funding_txs_psp_amount_chk
            CHECK (psp_amount IS NULL OR psp_amount >= 0),
          ADD CONSTRAINT funding_txs_multiplier_chk
            CHECK (turnover_multiplier >= 0),
          ADD CONSTRAINT funding_txs_deposit_has_psp_ref_chk
            CHECK (type <> 'deposit' OR psp_ref IS NOT NULL),
          ADD CONSTRAINT funding_txs_multiplier_deposit_only_chk
            CHECK (type = 'deposit' OR turnover_multiplier = 0),
          ADD CONSTRAINT funding_txs_settled_consistency_chk
            CHECK ((status = 'Pending') = (settled_at IS NULL));

        -- Wallet history, newest first.
        CREATE INDEX funding_txs_wallet_created_idx
          ON funding_txs (wallet_id, created_at DESC);

        -- Ops queues: pending withdrawals awaiting approval, stuck or flagged deposits.
        CREATE INDEX funding_txs_pending_idx
          ON funding_txs (type, created_at)
          WHERE status = 'Pending';
        `,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('funding_txs');
  },
};
