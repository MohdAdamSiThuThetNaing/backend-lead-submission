import express, { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from './lib/errors';
import { healthRouter } from './routes/health';
import { membersRouter } from './routes/members';
import { depositsRouter } from './routes/deposits';
import { pspCallbacksRouter } from './routes/pspCallbacks';
import { walletsRouter } from './routes/wallets';
import { withdrawalsRouter } from './routes/withdrawals';

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation_error', details: err.issues });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, ...err.details });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
};

export function createApp() {
  const app = express();
  app.use(express.json());

  app.use('/health', healthRouter);
  app.use('/members', membersRouter);
  app.use('/deposits', depositsRouter);
  app.use('/psp/callbacks', pspCallbacksRouter);
  app.use('/wallets', walletsRouter);
  app.use('/withdrawals', withdrawalsRouter);

  app.use(errorHandler);
  return app;
}
