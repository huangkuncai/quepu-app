import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService, parseBearerToken } from '../src/modules/auth/index.js';

test('stub auth logs in with the development verification code and returns opaque sessions', () => {
  const auth = new AuthService({ stubCode: '123456' });
  const first = auth.login({ phone: '13800000000', code: '123456', deviceId: 'android-1', platform: 'android' });
  assert.match(first.accessToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(first.refreshToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(first.user.displayName.startsWith('玩家'), true);
  assert.equal(auth.requireAuth(first.accessToken).userId, first.user.id);
  assert.equal(parseBearerToken(`Bearer ${first.accessToken}`), first.accessToken);
});

test('stub auth rejects invalid verification code and missing credentials', () => {
  const auth = new AuthService();
  assert.throws(() => auth.login({ phone: '13800000000', code: 'nope' }), error => error.code === 'OTP_INVALID');
  assert.throws(() => auth.requireAuth(), error => error.code === 'AUTH_REQUIRED');
  assert.throws(() => auth.requireAuth('unknown'), error => error.code === 'AUTH_INVALID');
});

test('refresh rotates tokens and rejects a replayed refresh token', () => {
  const auth = new AuthService();
  const first = auth.login({ playerId: 'player-1' });
  const second = auth.refresh(first.refreshToken);
  assert.notEqual(second.accessToken, first.accessToken);
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.throws(() => auth.refresh(first.refreshToken), error => error.code === 'AUTH_INVALID');
  assert.throws(() => auth.requireAuth(first.accessToken), error => error.code === 'AUTH_INVALID');
  assert.throws(() => auth.requireAuth(second.accessToken), error => error.code === 'AUTH_INVALID');
});

test('logout and ban revoke all active sessions', () => {
  const auth = new AuthService();
  const first = auth.login({ playerId: 'player-1', deviceId: 'one' });
  const second = auth.login({ playerId: 'player-1', deviceId: 'two' });
  auth.logout(first.accessToken);
  assert.throws(() => auth.requireAuth(first.accessToken), error => error.code === 'AUTH_INVALID');
  auth.banUser('player-1');
  assert.throws(() => auth.requireAuth(second.accessToken), error => error.code === 'AUTH_INVALID');
});

test('access tokens expire according to the injected clock', () => {
  let time = 1_700_000_000_000;
  const auth = new AuthService({ clock: () => time, accessTtlSeconds: 10, refreshTtlSeconds: 100 });
  const session = auth.login({ playerId: 'player-1' });
  assert.doesNotThrow(() => auth.requireAuth(session.accessToken));
  time += 101_000;
  assert.throws(() => auth.requireAuth(session.accessToken), error => error.code === 'AUTH_EXPIRED');
});
