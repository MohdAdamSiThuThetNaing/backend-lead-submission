import request from 'supertest';
import http from 'http';
import { startTestServer, stopTestServer } from './server';
import { sequelize } from '../src/db/sequelize';
import { FundingTx, WalletTx } from '../src/db/models';
import { createMember, getBalance } from './helpers';

let app: http.Server;

beforeAll(async () => {
  await sequelize.authenticate();
  app = await startTestServer();
});

beforeEach(async () => {
  await sequelize.truncate({ cascade: true });
});

afterAll(async () => {
  await stopTestServer(app);
  await sequelize.close();
});

describe('POST /deposits', () => {
  it('creates a Pending deposit with a pspRef and moves no money', async () => {
    const { memberId } = await createMember(app);

    const res = await request(app)
      .post('/deposits')
      .send({ memberId, amount: '100.50', turnoverMultiplier: 2 });

    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.pspRef).toMatch(/^dep_/);
    expect(res.body.status).toBe('Pending');
    expect(res.body.amount).toBe('100.500000000000000000');
    expect(res.body.turnoverMultiplier).toBe(2);

    expect(await getBalance(app, memberId)).toBe('0.000000000000000000');
    expect(await WalletTx.count()).toBe(0);
  });

  it('defaults turnoverMultiplier to 1', async () => {
    const { memberId } = await createMember(app);
    const res = await request(app).post('/deposits').send({ memberId, amount: '10' });
    expect(res.status).toBe(201);
    expect(res.body.turnoverMultiplier).toBe(1);
  });

  it('gives every deposit a unique pspRef', async () => {
    const { memberId } = await createMember(app);
    const a = await request(app).post('/deposits').send({ memberId, amount: '10' });
    const b = await request(app).post('/deposits').send({ memberId, amount: '10' });
    expect(a.body.pspRef).not.toBe(b.body.pspRef);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['a JS number, not a string', 100.5],
    ['not a number', 'abc'],
    ['exponent notation', '1e3'],
    ['too many decimals', '1.0000000000000000001'],
  ])('rejects amount: %s', async (_label, amount) => {
    const { memberId } = await createMember(app);
    const res = await request(app).post('/deposits').send({ memberId, amount });
    expect(res.status).toBe(400);
    expect(await FundingTx.count()).toBe(0);
  });

  it.each([
    ['negative', -1],
    ['not an integer', 1.5],
    ['a string', '1'],
  ])('rejects turnoverMultiplier: %s', async (_label, turnoverMultiplier) => {
    const { memberId } = await createMember(app);
    const res = await request(app)
      .post('/deposits')
      .send({ memberId, amount: '10', turnoverMultiplier });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown member', async () => {
    const res = await request(app)
      .post('/deposits')
      .send({ memberId: '00000000-0000-4000-8000-000000000000', amount: '10' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('member_not_found');
  });
});
