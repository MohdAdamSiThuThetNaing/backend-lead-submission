import request from 'supertest';
import http from 'http';

let counter = 0;

export async function createMember(app: http.Server): Promise<{ memberId: string; walletId: string }> {
  counter += 1;
  const res = await request(app)
    .post('/members')
    .send({ username: `player_${process.pid}_${counter}` });
  expect(res.status).toBe(201);
  return { memberId: res.body.member.id, walletId: res.body.wallet.id };
}

export async function getBalance(app: http.Server, memberId: string): Promise<string> {
  const res = await request(app).get(`/members/${memberId}/wallet`);
  expect(res.status).toBe(200);
  return res.body.balance;
}
