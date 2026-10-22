import { Router } from 'express';
import { z } from 'zod';
import * as withdrawalService from '../services/withdrawalService';
import { positiveMoney, uuid } from '../lib/validation';

export const withdrawalsRouter = Router();

const withdrawalBody = z.object({
  memberId: uuid,
  amount: positiveMoney,
});

withdrawalsRouter.post('/', async (req, res, next) => {
  try {
    const body = withdrawalBody.parse(req.body);
    const { wallet, fundingTx } = await withdrawalService.requestWithdrawal(body.memberId, body.amount);
    res.status(201).json({
      id: fundingTx.id,
      status: fundingTx.status,
      amount: fundingTx.amount,
      balance: wallet.balance,
    });
  } catch (err) {
    next(err);
  }
});
