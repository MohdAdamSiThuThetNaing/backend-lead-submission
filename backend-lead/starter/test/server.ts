import http from 'http';
import { createApp } from '../src/app';

/**
 * One real server per test file, bound to 127.0.0.1.
 * Passing the Express app straight to supertest starts a new ephemeral server
 * per request, which is flaky on macOS when concurrency tests fire many at once.
 */
export async function startTestServer(): Promise<http.Server> {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return server;
}

export async function stopTestServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}
