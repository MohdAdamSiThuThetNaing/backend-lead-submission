import { Router } from 'express';
import { z } from 'zod';
import * as walletService from '../services/walletService';
import { positiveMoney, uuid } from '../lib/validation';

export const walletsRouter = Router();

const wagerParams = z.object({ walletId: uuid });
const wagerBody = z.object({ amount: positiveMoney });

walletsRouter.post('/:walletId/wagers', async (req, res, next) => {
  try {
    const { walletId } = wagerParams.parse(req.params);
    const { amount } = wagerBody.parse(req.body);
    const { wallet, entry } = await walletService.placeWager(walletId, amount);
    res.status(201).json({
      ledgerEntryId: entry.id,
      amount: entry.amount,
      balance: wallet.balance,
      turnoverAccrued: wallet.turnoverAccrued,
    });
  } catch (err) {
    next(err);
  }
});
