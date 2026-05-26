// src/services/authService.js
// Authentication core: password hashing, server-side sessions, signed session
// cookies, single-use email-verification / password-reset tokens, and
// brute-force lockout.
//
// --- Design decisions (researched, see README "Authentication") ------------
//  * Password hashing: argon2id — the OWASP-recommended gold standard
//    (memory-hard, GPU- and side-channel resistant). bcrypt (cost 12) is a
//    documented fallback for environments where argon2 native bindings are
//    unavailable. The chosen scheme is recorded in the hash string itself, so
//    verification picks the right algorithm automatically.
//  * Sessions: a SERVER-SIDE session record keyed by a random id, delivered to
//    the browser in a signed, httpOnly cookie. We deliberately did NOT use a
//    JWT-as-session: OWASP / Curity caution that JWTs were not designed for
//    session management; a server-side session supports immediate revocation
//    (logout, password reset, lockout), a true sliding inactivity timeout, and
//    keeps ZERO PHI in anything sent to the client.
//  * Tokens (verify + reset): cryptographically random, emailed as the raw
//    value, but stored only as a SHA-256 hash, single-use, short-lived.
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// --- Password hashing backend ----------------------------------------------
// TODO(prod): add "argon2" (preferred) and/or "bcryptjs" to package.json
// dependencies and run `npm install`. They are optional native modules; this
// module loads whichever is present and degrades safely if neither is.
let argon2 = null;
let bcrypt = null;
try {
  argon2 = (await import('argon2')).default;
} catch {
  /* argon2 not installed — try bcrypt */
}
if (!argon2) {
  try {
    const mod = await import('bcryptjs');
    bcrypt = mod.default || mod;
  } catch {
    /* bcrypt not installed either */
  }
}

if (argon2) {
  logger.info('Auth: password hashing backend = argon2id');
} else if (bcrypt) {
  logger.warn('Auth: argon2 unavailable — falling back to bcrypt');
} else {
  // The scaffold must still boot for the demo even with no native module.
  // TODO(prod): this scrypt path is a LAST-RESORT scaffold fallback. Install
  // argon2 (or bcryptjs) before handling real patient credentials.
  logger.warn(
    'Auth: neither argon2 nor bcrypt installed — using Node scrypt fallback. ' +
      'TODO(prod): install argon2 before production.',
  );
}

// OWASP minimum argon2id parameters: 19 MiB memory, 2 iterations, parallelism 1.
const ARGON2_OPTS = argon2
  ? { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }
  : null;

const SCRYPT_PREFIX = 'scrypt$';

/** Hash a plaintext password. Returns a self-describing hash string. */
export async function hashPassword(plaintext) {
  if (argon2) return argon2.hash(plaintext, ARGON2_OPTS);
  if (bcrypt) return bcrypt.hash(plaintext, 12); // cost factor 12 (OWASP >=10)
  // scrypt fallback — self-describing so verifyPassword can route correctly.
  const { scryptSync } = await import('node:crypto');
  const salt = randomBytes(16);
  const derived = scryptSync(plaintext, salt, 64);
  return `${SCRYPT_PREFIX}${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Verify a plaintext password against a stored hash. Never throws on mismatch. */
export async function verifyPassword(plaintext, hash) {
  try {
    if (typeof hash !== 'string' || !hash) return false;
    if (hash.startsWith('$argon2')) {
      if (!argon2) return false;
      return await argon2.verify(hash, plaintext);
    }
    if (hash.startsWith('$2')) {
      if (!bcrypt) return false;
      return await bcrypt.compare(plaintext, hash);
    }
    if (hash.startsWith(SCRYPT_PREFIX)) {
      const { scryptSync } = await import('node:crypto');
      const [, saltHex, derivedHex] = hash.split('$');
      const salt = Buffer.from(saltHex, 'hex');
      const expected = Buffer.from(derivedHex, 'hex');
      const actual = scryptSync(plaintext, salt, expected.length);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    }
    return false;
  } catch (err) {
    logger.error('verifyPassword error', { message: err.message });
    return false;
  }
}

// --- Password strength rules -----------------------------------------------
// NIST 800-63B-aligned: length is the primary strength lever (min 12).
/**
 * @returns {{ ok: boolean, message?: string }}
 */
export function checkPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 12) {
    return { ok: false, message: 'Password must be at least 12 characters long' };
  }
  if (password.length > 128) {
    return { ok: false, message: 'Password must be 128 characters or fewer' };
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  if (classes < 3) {
    return {
      ok: false,
      message:
        'Password must include at least 3 of: lowercase, uppercase, number, symbol',
    };
  }
  return { ok: true };
}

// --- Single-use tokens (email verification + password reset) ---------------
/** Generate a raw token and its storable SHA-256 hash. Email the raw value. */
export function generateToken() {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

/** SHA-256 of a token — what we persist; the raw token is never stored. */
export function hashToken(raw) {
  return createHash('sha256').update(String(raw)).digest('hex');
}

/** Constant-time compare of a presented token against a stored hash. */
export function tokenMatches(rawPresented, storedHash) {
  if (!storedHash) return false;
  const presentedHash = Buffer.from(hashToken(rawPresented), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presentedHash.length === stored.length && timingSafeEqual(presentedHash, stored);
}

// --- Server-side session store ---------------------------------------------
// TODO(prod): replace this in-memory Map with a shared, persistent session
// store (e.g. Redis/Valkey or a `sessions` table) so sessions survive a
// restart and work across multiple app instances. The store must be covered
// by a BAA. Sessions hold ZERO PHI — only a patient id and timestamps.
const sessions = new Map(); // sessionId -> { patientId, createdAt, lastSeenAt }

/** Create a session for a patient and return its random id. */
export function createSession(patientId) {
  const sessionId = randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions.set(sessionId, { patientId, createdAt: now, lastSeenAt: now });
  return sessionId;
}

/**
 * Look up a session, enforcing both the sliding idle timeout and the absolute
 * lifetime cap. Expired sessions are destroyed. On success the lastSeenAt is
 * refreshed (sliding window). Returns the patientId or null.
 */
export function touchSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  const now = Date.now();
  const idleExpired = now - s.lastSeenAt > config.auth.idleTimeoutMs;
  const absoluteExpired = now - s.createdAt > config.auth.absoluteTimeoutMs;
  if (idleExpired || absoluteExpired) {
    sessions.delete(sessionId);
    return null;
  }
  s.lastSeenAt = now;
  return s.patientId;
}

/** Destroy a single session (logout). */
export function destroySession(sessionId) {
  return sessions.delete(sessionId);
}

/** Destroy every session for a patient (used on password reset). */
export function destroyPatientSessions(patientId) {
  for (const [id, s] of sessions) {
    if (s.patientId === patientId) sessions.delete(id);
  }
}

// --- Signed session cookie -------------------------------------------------
// The cookie value is `sessionId.hmac` so a tampered id is rejected before any
// store lookup. The signing secret comes from config (env / secrets manager).
function sign(value) {
  return createHmac('sha256', config.auth.cookieSecret).update(value).digest('base64url');
}

/** Build the signed cookie value for a session id. */
export function signSessionValue(sessionId) {
  return `${sessionId}.${sign(sessionId)}`;
}

/** Verify a signed cookie value; returns the session id or null. */
export function unsignSessionValue(cookieValue) {
  if (typeof cookieValue !== 'string' || !cookieValue.includes('.')) return null;
  const idx = cookieValue.lastIndexOf('.');
  const sessionId = cookieValue.slice(0, idx);
  const presented = cookieValue.slice(idx + 1);
  const expected = sign(sessionId);
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return sessionId;
}

/** Standard cookie options — httpOnly, Secure, SameSite=Strict in prod.
 * In development (NODE_ENV !== 'production') we relax to SameSite=Lax so the
 * dev server reached from a local-typed URL on a fresh tab still receives
 * the cookie. Prod keeps Strict — this never weakens the production posture.
 */
export function sessionCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true, // not readable by JS — mitigates XSS token theft
    secure: config.auth.cookieSecure, // HTTPS-only in production
    sameSite: isProd ? 'strict' : 'lax', // strict in prod; lax in dev for smooth localhost UX
    path: '/',
    maxAge: config.auth.absoluteTimeoutMs,
  };
}

// --- Brute-force lockout helpers -------------------------------------------
/** True if the patient is currently locked out from logging in. */
export function isLockedOut(patient) {
  return Boolean(patient.lockedUntil) && Date.now() < new Date(patient.lockedUntil).getTime();
}

/**
 * Given the current failed-login count, decide the next counter + lock state.
 * @returns {{ failedLoginCount: number, lockedUntil: string|null }}
 */
export function nextLockoutState(currentFailedCount) {
  const failedLoginCount = currentFailedCount + 1;
  if (failedLoginCount >= config.auth.maxFailedLogins) {
    return {
      failedLoginCount,
      lockedUntil: new Date(Date.now() + config.auth.lockoutMs).toISOString(),
    };
  }
  return { failedLoginCount, lockedUntil: null };
}

// Test-only: clear all sessions between runs.
export function __resetSessions() {
  sessions.clear();
}
