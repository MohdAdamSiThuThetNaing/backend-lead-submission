'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('funding_txs', {
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
      type: { type: Sequelize.STRING(16), allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'Pending' },
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      turnover_multiplier: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      psp_ref: { type: Sequelize.STRING(64), allowNull: true, unique: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE funding_txs
        ADD CONSTRAINT funding_txs_type_chk       CHECK (type IN ('deposit', 'withdrawal')),
        ADD CONSTRAINT funding_txs_status_chk     CHECK (status IN ('Pending', 'Completed', 'Failed')),
        ADD CONSTRAINT funding_txs_amount_chk     CHECK (amount > 0),
        ADD CONSTRAINT funding_txs_multiplier_chk CHECK (turnover_multiplier >= 0);
    `);
    await queryInterface.addIndex('funding_txs', ['wallet_id']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('funding_txs');
  },
};
