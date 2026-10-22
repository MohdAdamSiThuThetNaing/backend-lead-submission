'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wallets', 'turnover_required', {
      type: Sequelize.DECIMAL(36, 18),
      allowNull: false,
      defaultValue: '0',
    });
    await queryInterface.addColumn('wallets', 'turnover_accrued', {
      type: Sequelize.DECIMAL(36, 18),
      allowNull: false,
      defaultValue: '0',
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE wallets
        ADD CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        ADD CONSTRAINT wallets_turnover_non_negative
          CHECK (turnover_required >= 0 AND turnover_accrued >= 0);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE wallets
        DROP CONSTRAINT IF EXISTS wallets_balance_non_negative,
        DROP CONSTRAINT IF EXISTS wallets_turnover_non_negative;
    `);
    await queryInterface.removeColumn('wallets', 'turnover_accrued');
    await queryInterface.removeColumn('wallets', 'turnover_required');
  },
};
