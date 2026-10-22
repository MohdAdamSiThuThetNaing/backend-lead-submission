import { Router } from 'express';
import { z } from 'zod';
import * as depositService from '../services/depositService';
import { nonNegativeMoney } from '../lib/validation';

export const pspCallbacksRouter = Router();

const callbackBody = z.object({
  pspRef: z.string().min(1).max(64),
  status: z.enum(['completed', 'failed']),
  amount: nonNegativeMoney,
});

// 2xx tells the PSP "stop retrying". We return it for everything we have
// durably handled, including duplicates and held-for-review. 404 / 409 are
// left to retry: they need attention, and a retry costs us nothing.
const STATUS_BY_OUTCOME: Record<depositService.CallbackOutcome, number> = {
  credited: 200,
  failed: 200,
  duplicate: 200,
  held_for_review: 202,
};

pspCallbacksRouter.post('/', async (req, res, next) => {
  try {
    const body = callbackBody.parse(req.body);
    const { outcome, fundingTx } = await depositService.handlePspCallback(body);
    res.status(STATUS_BY_OUTCOME[outcome]).json({
      outcome,
      fundingTxId: fundingTx.id,
      status: fundingTx.status,
      reviewReason: fundingTx.reviewReason,
    });
  } catch (err) {
    next(err);
  }
});
