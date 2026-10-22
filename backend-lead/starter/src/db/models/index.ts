import { sequelize } from '../sequelize';
import { Member, initMember } from './member';
import { Wallet, initWallet } from './wallet';
import { FundingTx, initFundingTx } from './fundingTx';
import { WalletTx, initWalletTx } from './walletTx';

initMember(sequelize);
initWallet(sequelize);
initFundingTx(sequelize);
initWalletTx(sequelize);

Member.hasOne(Wallet, { foreignKey: 'memberId', as: 'wallet' });
Wallet.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });

Wallet.hasMany(FundingTx, { foreignKey: 'walletId', as: 'fundingTxs' });
FundingTx.belongsTo(Wallet, { foreignKey: 'walletId', as: 'wallet' });

Wallet.hasMany(WalletTx, { foreignKey: 'walletId', as: 'ledger' });
WalletTx.belongsTo(Wallet, { foreignKey: 'walletId', as: 'wallet' });
WalletTx.belongsTo(FundingTx, { foreignKey: 'fundingTxId', as: 'fundingTx' });

export { Member, Wallet, FundingTx, WalletTx };
