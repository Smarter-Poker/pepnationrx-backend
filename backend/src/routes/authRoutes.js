// src/routes/authRoutes.js
// Patient account / authentication endpoints.
//
//   POST /api/auth/register         - create an account (+ email verification)
//   POST /api/auth/login            - verify password, issue a session cookie
//   POST /api/auth/logout           - destroy the session
//   GET  /api/auth/me               - current authenticated patient
//   POST /api/auth/verify-email     - confirm an email-verification token
//   POST /api/auth/password/forgot  - request a password-reset email
//   POST /api/auth/password/reset   - confirm a reset token + set new password
//
// Security posture (researched — see README "Authentication"):
//  * Passwords hashed with argon2id (bcrypt fallback).
//  * Sessions are server-side, delivered in a signed httpOnly+Secure+SameSite
//    cookie. No PHI is ever placed in the cookie or any token.
//  * Generic responses everywhere — registration, login, and forgot-password
//    never reveal whether an email exists (no user enumeration).
//  * Per-IP login rate limiting + per-account lockout after repeated failures.
//  * Every auth event is written to the HIPAA auth audit trail.
import { Router } from 'express';
import { config } from '../config.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../lib/logger.js';
import { auditAuthEvent } from '../lib/authAudit.js';
import {
  createPatient,
  getPatientByEmail,
  updatePatient,
  toPatientView,
  normalizeEmail,
  patientStoreIterator,
} from '../services/patientService.js';
import {
  hashPassword,
  verifyPassword,
  checkPasswordStrength,
  generateToken,
  tokenMatches,
  createSession,
  destroySession,
  destroyPatientSessions,
  signSessionValue,
  sessionCookieOptions,
  isLockedOut,
  nextLockoutState,
} from '../services/authService.js';
import { requireAuth, readCookie } from '../middleware/requireAuth.js';

export const authRoutes = Router();

// --- Login rate limiter (per IP) -------------------------------------------
// In-process sliding-window counter. Complements the per-account lockout in
// authService — this stops an attacker spraying many accounts from one IP.
// TODO(prod): replace with a shared store (Redis) so the limit holds across
// instances, and consider a dedicated middleware (e.g. express-rate-limit).
const RL_WINDOW_MS = 15 * 60 * 1000; // 15 min
const RL_MAX = 20; // 20 login attempts / IP / window
const ipHits = new Map(); // ip -> number[] (timestamps)

function rateLimitLogin(req, _res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (hits.length >= RL_MAX) {
    auditAuthEvent('login.rate_limited', { ip, userAgent: req.headers['user-agent'] });
    return next(new AppError('Too many attempts. Please try again later.', 429));
  }
  hits.push(now);
  ipHits.set(ip, hits);
  next();
}

// --- Helpers ---------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A valid-format argon2id hash of a random value — used as a decoy so that a
// login attempt on an unknown account still spends time doing a hash verify
// and cannot be distinguished by response timing.
const DECOY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZWRlY295c2FsdA$ZGVjb3lkZWNveWRlY295ZGVjb3lkZWNveQ';

function reqContext(req) {
  return { ip: req.ip || 'unknown', userAgent: req.headers['user-agent'] || null };
}

/**
 * Stub email send. TODO(prod): integrate a HIPAA-eligible transactional email
 * provider under a signed BAA (e.g. AWS SES with a BAA, Paubox, LuxSci).
 * Verification / reset emails must NOT contain PHI — only the action link.
 */
function sendEmailStub(kind, toEmail, link) {
  // TODO(prod): replace this log line with a real provider API call.
  logger.info('EMAIL_STUB', { kind, to: toEmail, link });
}

// --- Token lookup (scaffold scan; index in a real DB) ----------------------
// TODO(prod): in a real DB, index emailVerification.tokenHash and
// passwordReset.tokenHash so these become O(1) indexed lookups, not scans.
function findByVerificationToken(rawToken) {
  for (const patient of patientStoreIterator()) {
    if (tokenMatches(rawToken, patient.emailVerification.tokenHash)) return patient;
  }
  return null;
}
function findByResetToken(rawToken) {
  for (const patient of patientStoreIterator()) {
    if (tokenMatches(rawToken, patient.passwordReset.tokenHash)) return patient;
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
authRoutes.post('/auth/register', async (req, res, next) => {
  try {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const password = body.password;

    if (!EMAIL_RE.test(email)) {
      throw new AppError('A valid email is required', 422);
    }
    const strength = checkPasswordStrength(password);
    if (!strength.ok) {
      throw new AppError(strength.message, 422);
    }

    // Generic success even if the email is already taken — do not let an
    // attacker enumerate accounts via the registration endpoint.
    const genericResponse = {
      message:
        'If that email is not already registered, an account has been created. ' +
        'Check your inbox to verify your email address.',
    };

    const existing = getPatientByEmail(email);
    if (existing) {
      auditAuthEvent('register.duplicate', { ...reqContext(req) });
      // TODO(prod): send a "you already have an account" email here so a real
      // owner is informed without revealing existence to the requester.
      return res.status(201).json(genericResponse);
    }

    const passwordHash = await hashPassword(password);
    const patient = createPatient({
      email,
      passwordHash,
      firstName: typeof body.firstName === 'string' ? body.firstName.trim() : null,
      lastName: typeof body.lastName === 'string' ? body.lastName.trim() : null,
    });

    // Email-verification token — store only the hash; email the raw value.
    const { raw, hash } = generateToken();
    updatePatient(patient.id, {
      emailVerification: {
        tokenHash: hash,
        expiresAt: new Date(Date.now() + config.auth.verifyTokenTtlMs).toISOString(),
      },
    });
    // TODO(prod): build this link from a configured public base URL.
    sendEmailStub('verify-email', email, `/verify-email?token=${raw}`);

    auditAuthEvent('register', { patientId: patient.id, ...reqContext(req) });
    res.status(201).json(genericResponse);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
authRoutes.post('/auth/login', rateLimitLogin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const password = body.password;
    const ctx = reqContext(req);

    // Single generic failure used for EVERY rejection reason below.
    const genericFail = () => next(new AppError('Invalid email or password', 401));

    if (!email || typeof password !== 'string') {
      return genericFail();
    }

    const patient = getPatientByEmail(email);

    // Even when the account is unknown, run a hash verify against a decoy so
    // response timing does not betray account existence.
    if (!patient) {
      await verifyPassword(password, DECOY_HASH);
      auditAuthEvent('login.failure', { reason: 'unknown_account', ...ctx });
      return genericFail();
    }

    if (isLockedOut(patient)) {
      auditAuthEvent('login.locked', { patientId: patient.id, ...ctx });
      return genericFail(); // still generic to the client
    }

    const ok = await verifyPassword(password, patient.passwordHash);
    if (!ok) {
      const lock = nextLockoutState(patient.failedLoginCount);
      updatePatient(patient.id, lock);
      auditAuthEvent('login.failure', {
        patientId: patient.id,
        reason: lock.lockedUntil ? 'bad_password_locked' : 'bad_password',
        ...ctx,
      });
      return genericFail();
    }

    // Success — reset the brute-force counter and issue a fresh session.
    updatePatient(patient.id, { failedLoginCount: 0, lockedUntil: null });
    const sessionId = createSession(patient.id);
    res.cookie(config.auth.cookieName, signSessionValue(sessionId), sessionCookieOptions());

    auditAuthEvent('login.success', { patientId: patient.id, ...ctx });
    res.json({
      message: 'Signed in',
      patient: toPatientView(patient),
      // Surface (don't block) so the UI can nudge unverified patients.
      emailVerified: patient.emailVerified,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
authRoutes.post('/auth/logout', (req, res, next) => {
  try {
    // Destroy the server-side session referenced by the cookie, if present.
    const raw = readCookie(req, config.auth.cookieName);
    if (raw && raw.includes('.')) {
      const sessionId = raw.slice(0, raw.lastIndexOf('.'));
      destroySession(sessionId);
    }
    res.clearCookie(config.auth.cookieName, { path: '/' });
    auditAuthEvent('logout', { ...reqContext(req) });
    res.json({ message: 'Signed out' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/me — current authenticated patient
// ---------------------------------------------------------------------------
authRoutes.get('/auth/me', requireAuth, (req, res) => {
  res.json({ patient: toPatientView(req.patient) });
});

// ---------------------------------------------------------------------------
// POST /api/auth/verify-email   Body: { token }
// ---------------------------------------------------------------------------
authRoutes.post('/auth/verify-email', (req, res, next) => {
  try {
    const token = (req.body || {}).token;
    if (typeof token !== 'string' || !token) {
      throw new AppError('A verification token is required', 422);
    }
    const patient = findByVerificationToken(token);
    if (
      !patient ||
      !patient.emailVerification.expiresAt ||
      Date.now() > new Date(patient.emailVerification.expiresAt).getTime()
    ) {
      throw new AppError('Invalid or expired verification link', 400);
    }
    // Single-use: clear the token on success.
    updatePatient(patient.id, {
      emailVerified: true,
      emailVerification: { tokenHash: null, expiresAt: null },
    });
    auditAuthEvent('email.verify', { patientId: patient.id, ...reqContext(req) });
    res.json({ message: 'Email verified' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/password/forgot — request a reset email   Body: { email }
// Always returns the same generic response (no user enumeration).
// ---------------------------------------------------------------------------
authRoutes.post('/auth/password/forgot', (req, res, next) => {
  try {
    const email = normalizeEmail((req.body || {}).email);
    const patient = email ? getPatientByEmail(email) : null;

    if (patient) {
      const { raw, hash } = generateToken();
      // A new request invalidates any previous reset token.
      updatePatient(patient.id, {
        passwordReset: {
          tokenHash: hash,
          expiresAt: new Date(Date.now() + config.auth.resetTokenTtlMs).toISOString(),
        },
      });
      // TODO(prod): build the link from a configured public base URL.
      sendEmailStub('password-reset', email, `/reset-password?token=${raw}`);
      auditAuthEvent('password.reset.request', { patientId: patient.id, ...reqContext(req) });
    } else {
      auditAuthEvent('password.reset.request', {
        reason: 'unknown_account',
        ...reqContext(req),
      });
    }

    res.json({
      message: 'If an account exists for that email, a password-reset link has been sent.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/password/reset — confirm a reset token + set a new password
// Body: { token, password }
// ---------------------------------------------------------------------------
authRoutes.post('/auth/password/reset', async (req, res, next) => {
  try {
    const body = req.body || {};
    const token = body.token;
    const password = body.password;

    if (typeof token !== 'string' || !token) {
      throw new AppError('A reset token is required', 422);
    }
    const strength = checkPasswordStrength(password);
    if (!strength.ok) {
      throw new AppError(strength.message, 422);
    }

    const patient = findByResetToken(token);
    if (
      !patient ||
      !patient.passwordReset.expiresAt ||
      Date.now() > new Date(patient.passwordReset.expiresAt).getTime()
    ) {
      throw new AppError('Invalid or expired reset link', 400);
    }

    const passwordHash = await hashPassword(password);
    // Single-use: clear the token; also clear any lockout.
    updatePatient(patient.id, {
      passwordHash,
      passwordReset: { tokenHash: null, expiresAt: null },
      failedLoginCount: 0,
      lockedUntil: null,
    });
    // Revoke every existing session — a reset should log out all devices.
    destroyPatientSessions(patient.id);
    auditAuthEvent('password.reset.confirm', { patientId: patient.id, ...reqContext(req) });
    res.json({ message: 'Password updated. Please sign in with your new password.' });
  } catch (err) {
    next(err);
  }
});
