/**
 * Expected business failures. Services throw these; the app error handler
 * turns them into `{ error: code, ...details }` with the given status.
 * Throwing inside sequelize.transaction() also rolls the transaction back,
 * so a rejected operation can never leave a half-written money change.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'HttpError';
  }
}
