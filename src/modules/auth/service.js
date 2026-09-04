import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';

const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const PLAYER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function issueToken() {
  return randomBytes(32).toString('base64url');
}

function nowSeconds(clock) {
  return Math.floor(clock() / 1000);
}

function normalizePhone(phone) {
  return String(phone || '').trim();
}

export function parseBearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * In-memory session adapter for BE-103. It intentionally uses opaque tokens:
 * only their SHA-256 hashes are retained, so replacing this adapter with a
 * reviewed provider or a persistent session repository does not change the
 * command contract. It is not a production identity provider.
 */
export class AuthService {
  constructor({
    mode = 'stub',
    accessTtlSeconds = DEFAULT_ACCESS_TTL_SECONDS,
    refreshTtlSeconds = DEFAULT_REFRESH_TTL_SECONDS,
    stubCode = '000000',
    clock = () => Date.now()
  } = {}) {
    this.mode = mode;
    this.accessTtlSeconds = accessTtlSeconds;
    this.refreshTtlSeconds = refreshTtlSeconds;
    this.stubCode = stubCode;
    this.clock = clock;
    this.users = new Map();
    this.phoneToUser = new Map();
    this.sessions = new Map();
    this.accessTokens = new Map();
    this.refreshTokens = new Map();
    this.usedRefreshTokens = new Map();
    this.bannedUsers = new Set();
  }

  login({ phone, code, playerId, deviceId = 'unknown-device', platform = 'unknown', displayName } = {}) {
    if (this.mode !== 'stub') throw new AppError('MODULE_UNAVAILABLE');
    const normalizedPhone = phone ? normalizePhone(phone) : null;
    let userId;

    if (playerId !== undefined) {
      if (!PLAYER_ID_PATTERN.test(String(playerId))) throw new AppError('AUTH_INVALID');
      userId = String(playerId);
    } else {
      if (!normalizedPhone || !code || String(code) !== this.stubCode) throw new AppError('OTP_INVALID');
      userId = this.phoneToUser.get(normalizedPhone) || randomUUID();
    }

    if (this.bannedUsers.has(userId)) throw new AppError('FORBIDDEN');
    const user = this.users.get(userId) || {
      id: userId,
      phone: normalizedPhone,
      displayName: displayName || `玩家${userId.slice(0, 6)}`,
      createdAt: new Date(this.clock()).toISOString()
    };
    if (normalizedPhone) {
      user.phone = normalizedPhone;
      this.phoneToUser.set(normalizedPhone, userId);
    }
    if (displayName) user.displayName = String(displayName).slice(0, 64);
    this.users.set(userId, user);
    return this.createSession({ user, deviceId, platform });
  }

  createSession({ user, deviceId, platform }) {
    const now = nowSeconds(this.clock);
    const session = {
      id: randomUUID(),
      userId: user.id,
      deviceId: String(deviceId || 'unknown-device').slice(0, 128),
      platform: String(platform || 'unknown').slice(0, 32),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.refreshTtlSeconds,
      revokedAt: null,
      accessTokenHash: null,
      refreshTokenHash: null
    };
    this.sessions.set(session.id, session);
    return this.rotateTokens(session);
  }

  rotateTokens(session) {
    const now = nowSeconds(this.clock);
    if (session.accessTokenHash) this.accessTokens.delete(session.accessTokenHash);
    if (session.refreshTokenHash) {
      this.refreshTokens.delete(session.refreshTokenHash);
      this.usedRefreshTokens.set(session.refreshTokenHash, session.id);
    }
    const accessToken = issueToken();
    const refreshToken = issueToken();
    const accessTokenHash = hashToken(accessToken);
    const refreshTokenHash = hashToken(refreshToken);
    session.accessTokenHash = accessTokenHash;
    session.refreshTokenHash = refreshTokenHash;
    session.lastSeenAt = now;
    session.expiresAt = Math.max(session.expiresAt, now + this.refreshTtlSeconds);
    this.accessTokens.set(accessTokenHash, { sessionId: session.id, expiresAt: now + this.accessTtlSeconds });
    this.refreshTokens.set(refreshTokenHash, { sessionId: session.id, expiresAt: session.expiresAt });
    return {
      accessToken,
      refreshToken,
      sessionId: session.id,
      expiresIn: this.accessTtlSeconds,
      user: this.publicUser(this.users.get(session.userId))
    };
  }

  requireAuth(accessToken) {
    if (!accessToken) throw new AppError('AUTH_REQUIRED');
    const accessRecord = this.accessTokens.get(hashToken(accessToken));
    if (!accessRecord) throw new AppError('AUTH_INVALID');
    const sessionId = accessRecord.sessionId;
    const session = this.sessions.get(sessionId);
    const now = nowSeconds(this.clock);
    if (!session || session.revokedAt) throw new AppError('AUTH_INVALID');
    if (accessRecord.expiresAt <= now) {
      this.accessTokens.delete(hashToken(accessToken));
      throw new AppError('AUTH_EXPIRED');
    }
    if (session.expiresAt <= now) {
      this.revokeSession(session.id);
      throw new AppError('AUTH_EXPIRED');
    }
    if (this.bannedUsers.has(session.userId)) throw new AppError('FORBIDDEN');
    session.lastSeenAt = now;
    const user = this.users.get(session.userId);
    return Object.freeze({
      userId: session.userId,
      sessionId: session.id,
      deviceId: session.deviceId,
      platform: session.platform,
      displayName: user?.displayName || null
    });
  }

  refresh(refreshToken) {
    if (!refreshToken) throw new AppError('AUTH_REQUIRED');
    const tokenHash = hashToken(refreshToken);
    const record = this.refreshTokens.get(tokenHash);
    if (!record) {
      const reusedSessionId = this.usedRefreshTokens.get(tokenHash);
      if (reusedSessionId) this.revokeSession(reusedSessionId);
      throw new AppError('AUTH_INVALID');
    }
    const now = nowSeconds(this.clock);
    const session = this.sessions.get(record.sessionId);
    if (!session || session.revokedAt) throw new AppError('AUTH_INVALID');
    if (record.expiresAt <= now) {
      this.revokeSession(session.id);
      throw new AppError('AUTH_EXPIRED');
    }
    return this.rotateTokens(session);
  }

  logout(accessToken) {
    const principal = this.requireAuth(accessToken);
    this.revokeSession(principal.sessionId);
    return { sessionId: principal.sessionId };
  }

  revokeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.revokedAt = nowSeconds(this.clock);
    if (session.accessTokenHash) this.accessTokens.delete(session.accessTokenHash);
    if (session.refreshTokenHash) this.refreshTokens.delete(session.refreshTokenHash);
    return true;
  }

  banUser(userId) {
    this.bannedUsers.add(userId);
    for (const session of this.sessions.values()) {
      if (session.userId === userId) this.revokeSession(session.id);
    }
  }

  publicUser(user) {
    if (!user) return null;
    return { id: user.id, displayName: user.displayName };
  }

  sessionSnapshot(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return Object.freeze({
      id: session.id,
      userId: session.userId,
      deviceId: session.deviceId,
      platform: session.platform,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt
    });
  }
}
