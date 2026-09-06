import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../lib/checks.js', import.meta.url), 'utf8');
const { checkSession, checkRound } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
for (const times of [[240,243,246,249,252], [210,230,250,230,270]]) {
  test(`ordinary consistency/ties remain ranked: ${times}`, () => {
    assert.equal(checkSession({ times, voids: 0, spanMs: 15000 }).status, 'verified');
  });
}
test('impossible scores and explicit synthetic evidence still fail', () => {
  assert.equal(checkRound({ reportedMs: 1, serverElapsedMs: 80 }).status, 'void');
  assert.equal(checkSession({ times: [150,170,190,160,180], voids: 0,
    spanMs: 15000, clientReport: { synthetic: true } }).status, 'rejected');
});
test('network delay is a network void, not player misconduct', () => {
  assert.equal(checkRound({ reportedMs: 250, serverElapsedMs: 900 }).fault, 'network');
});
