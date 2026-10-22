import { z } from 'zod';
import { MONEY_PATTERN, dec } from './money';

const moneyString = z
  .string()
  .regex(MONEY_PATTERN, 'must be a decimal string like "100.50" (max 18 decimals, no sign or exponent)');

/**
 * Strictly positive amount, e.g. a deposit, wager or withdrawal.
 *
 * Zod v3 still runs .refine() after .regex() fails, so the refinement must not
 * assume a well-formed value: dec('abc') would throw and turn a 400 into a 500.
 */
export const positiveMoney = moneyString.refine(
  (v) => MONEY_PATTERN.test(v) && dec(v).gt(0),
  'must be greater than 0',
);

/** Zero allowed, e.g. the amount a PSP reports on a failed payment. */
export const nonNegativeMoney = moneyString;

export const uuid = z.string().uuid();
