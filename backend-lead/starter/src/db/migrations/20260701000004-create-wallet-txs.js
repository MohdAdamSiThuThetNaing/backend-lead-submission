'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wallet_txs', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      wallet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'wallets', key: 'id' },
      },
      kind: { type: Sequelize.STRING(16), allowNull: false },
      // Signed: +credit, -debit. SUM(amount) per wallet == wallets.balance.
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      balance_after: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      funding_tx_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'funding_txs', key: 'id' },
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE wallet_txs
        ADD CONSTRAINT wallet_txs_kind_chk          CHECK (kind IN ('deposit', 'wager', 'withdrawal')),
        ADD CONSTRAINT wallet_txs_amount_chk        CHECK (amount <> 0),
        -- Deposits credit, wagers and withdrawals debit. A flipped sign would
        -- silently double an error on reconciliation, so the DB refuses it.
        ADD CONSTRAINT wallet_txs_sign_chk          CHECK ((kind = 'deposit') = (amount > 0)),
        ADD CONSTRAINT wallet_txs_balance_after_chk CHECK (balance_after >= 0);

      CREATE UNIQUE INDEX wallet_txs_funding_kind_uq
        ON wallet_txs (funding_tx_id, kind)
        WHERE funding_tx_id IS NOT NULL;

      -- Total order of ledger entries. created_at has millisecond resolution and
      -- can tie under load; seq is assigned while the wallet row lock is held,
      -- so per wallet it is exactly the order balances were applied in.
      ALTER TABLE wallet_txs ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY;
      CREATE UNIQUE INDEX wallet_txs_wallet_seq_uq ON wallet_txs (wallet_id, seq);

      CREATE FUNCTION wallet_txs_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_txs is append-only';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER wallet_txs_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_txs
        FOR EACH ROW EXECUTE FUNCTION wallet_txs_append_only();
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('wallet_txs');
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS wallet_txs_append_only();');
  },
};
