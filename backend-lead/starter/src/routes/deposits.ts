import { Router } from 'express';
import { z } from 'zod';
import * as depositService from '../services/depositService';
import { positiveMoney, uuid } from '../lib/validation';

export const depositsRouter = Router();

const createDepositBody = z.object({
  memberId: uuid,
  amount: positiveMoney,
  turnoverMultiplier: z.number().int().min(0).max(1000).default(1),
});

depositsRouter.post('/', async (req, res, next) => {
  try {
    const body = createDepositBody.parse(req.body);
    const tx = await depositService.createDeposit(body);
    res.status(201).json({
      id: tx.id,
      pspRef: tx.pspRef,
      status: tx.status,
      amount: tx.amount,
      turnoverMultiplier: tx.turnoverMultiplier,
    });
  } catch (err) {
    next(err);
  }
});
