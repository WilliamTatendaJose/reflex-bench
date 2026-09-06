import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const checksSource = await readFile(new URL('../lib/checks.js', import.meta.url), 'utf8');
const checks = await import(`data:text/javascript;base64,${Buffer.from(checksSource).toString('base64')}`);
const db = new PGlite();
await db.exec((await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8')).replace('create extension if not exists pgcrypto;', ''));
const q = (text, params) => db.query(text, params);
const transaction = work => db.transaction(tx => work((text, params) => tx.query(text, params)));
process.env.SIGNING_SECRET = 'test-only-signing-secret';
const signSource = (await readFile(new URL('../lib/sign.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/export /g, '');
const { mintGoToken, readGoToken } = new Function('crypto',
  `${signSource}; return { mintGoToken, readGoToken };`)(crypto);
async function route(path, method) {
  const source = (await readFile(new URL(`../${path}`, import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
  return new Function('transaction','q','crypto','L','checkRound','checkSession','median','mintGoToken','readGoToken',
    `${source};return ${method}`)(transaction,q,crypto,{ ...checks.L, DELAY_MIN: 1, DELAY_MAX: 2 },
      checks.checkRound,checks.checkSession,checks.median,mintGoToken,readGoToken);
}
const rounds = await route('app/api/rounds/route.js','POST');
const result = await route('app/api/rounds/[id]/result/route.js','POST');
const finish = await route('app/api/session/[id]/finish/route.js','POST');
const board = await route('app/api/leaderboard/route.js','GET');
const request = body => new Request('http://localhost/api', {method:'POST',body:JSON.stringify(body)});
async function session() {
  return (await q("insert into sessions(player_name,ip_hash,created_at) values('Test','hash',now()-interval '1 minute') returning id")).rows[0].id;
}

test('overlapping round openings reserve exactly one pending attempt', async () => {
  const id = await session();
  const responses = await Promise.all([rounds(request({sessionId:id})),rounds(request({sessionId:id}))]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  assert.equal((await q('select * from rounds where session_id=$1',[id])).rows.length,1);
});

test('result retries return the saved outcome without overwriting it, even after expiry', async () => {
  const sessionId = await session();
  const rd = await (await rounds(request({sessionId}))).json();
  const token = mintGoToken(rd.roundId,Date.now()-300);
  const first = await (await result(request({goToken:token,reportedMs:250}),{params:{id:rd.roundId}})).json();
  assert.equal(first.status,'valid');
  const expired = mintGoToken(rd.roundId,Date.now()-30000);
  const second = await (await result(request({goToken:expired,reportedMs:150}),{params:{id:rd.roundId}})).json();
  assert.equal(second.ms,250);
  const rows = (await q('select * from rounds where session_id=$1',[sessionId])).rows;
  assert.equal(rows.length,1);
  assert.equal(Number(rows[0].reported_ms),250);
});

test('finish retry preserves the first certificate and does not rescore new flags', async () => {
  const id = await session();
  for (let i=0;i<5;i++) await q(`insert into rounds(session_id,idx,delay_ms,go_sent_at,status,reported_ms)
    values($1,$2,1,now(),'valid',250)`,[id,i]);
  const first = await (await finish(request({}),{params:{id}})).json();
  const second = await (await finish(request({synthetic:true}),{params:{id}})).json();
  assert.equal(first.status,'verified');
  assert.deepEqual(second,first);
});

test('leaderboard includes the fastest name beyond the first 200 alphabetically', async () => {
  await q(`insert into sessions(player_name,ip_hash,status,median_ms,best_ms,sd_ms,completed_at)
    select 'A'||n, 'hash', 'verified', 300+n, 300+n, 10, now() from generate_series(1,205) n`);
  await q(`insert into sessions(player_name,ip_hash,status,median_ms,best_ms,sd_ms,completed_at)
    values('Z-fast','hash','verified',150,145,10,now()),('z-FAST','hash','verified',180,170,10,now())`);
  const {verified} = await (await board()).json();
  assert.equal(verified.length,50);
  assert.equal(verified[0].player_name,'Z-fast');
  assert.equal(verified.filter(r=>r.player_name.toLowerCase()==='z-fast').length,1);
});

test('expired pending rounds recover without consuming charged attempts', async () => {
  const id = await session();
  await q(`insert into rounds(session_id,idx,delay_ms,go_sent_at)
    values($1,0,1,now()-interval '1 minute')`,[id]);
  assert.equal((await rounds(request({sessionId:id}))).status,200);
  const rows = (await q('select status,fault from rounds where session_id=$1 order by idx',[id])).rows;
  assert.deepEqual(rows.map(r=>r.status),['void','pending']);
  assert.equal(rows[0].fault,'network');
});

test('an expired first submission is a network void and malformed tokens are refused', async () => {
  const sessionId = await session();
  const rd = await (await rounds(request({sessionId}))).json();
  assert.equal((await result(request({goToken:'bad'}),{params:{id:rd.roundId}})).status,403);
  const response = await result(request({goToken:mintGoToken(rd.roundId,Date.now()-30000),reportedMs:250}),{params:{id:rd.roundId}});
  const verdict = await response.json();
  assert.equal(verdict.status,'void');
  assert.equal(verdict.fault,'network');
});

test.after(async () => { await db.close(); });
