import BigNumber from 'bignumber.js';

// Money invariants for this codebase:
// - Money is stored as DECIMAL(36,18) in Postgres and travels as strings in JS/JSON.
// - All arithmetic on money MUST go through BigNumber. Never use JS number math on money.
BigNumber.config({ DECIMAL_PLACES: 18, ROUNDING_MODE: BigNumber.ROUND_DOWN });

export function dec(value: string | number | BigNumber): BigNumber {
  const bn = new BigNumber(value);
  if (!bn.isFinite()) {
    throw new Error(`Invalid money value: ${value}`);
  }
  return bn;
}

export const ZERO = dec(0);

/** Same scale as the DB column, so values written and values read back compare as equal strings. */
export const MONEY_SCALE = 18;

/**
 * Accepted wire format for amounts: plain decimal, no sign, no exponent, no
 * whitespace, at most 18 integer digits and 18 fractional digits (fits
 * DECIMAL(36,18) exactly, so nothing is ever rounded on the way in).
 */
export const MONEY_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,18})?$/;

export function toMoneyString(value: BigNumber): string {
  return value.toFixed(MONEY_SCALE);
}
