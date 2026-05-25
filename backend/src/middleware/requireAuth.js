// src/middleware/requireAuth.js
// Express middleware that protects patient-facing routes.
//
// It reads the signed session cookie, verifies the signature, looks up the
// server-side session (enforcing the idle + absolute timeouts), and attaches
// the authenticated patient to `req.patient`. Unauthenticated requests get a
// generic 401 — no detail that could aid an attacker.
import { config } from '../config.js';
import { AppError } from './errorHandler.js';
import { getPatientById, toPatientView } from '../services/patientService.js';
import { unsignSessionValue, touchSession } from '../services/authService.js';

/**
 * Minimal cookie-header parser. Express 4 does not parse cookies natively;
 * rather than add a dependency for one cookie, parse the single name we need.
 * TODO(prod): if more cookies are introduced, swap this for the `cookie-parser`
 * middleware.
 */
export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Resolve the authenticated patient for a request, or null. Shared by the
 * strict `requireAuth` guard and the soft `attachPatient` helper.
 */
function resolvePatient(req) {
  const cookieValue = readCookie(req, config.auth.cookieName);
  if (!cookieValue) return null;
  const sessionId = unsignSessionValue(cookieValue);
  if (!sessionId) return null; // bad signature / tampered cookie
  const patientId = touchSession(sessionId); // enforces idle + absolute timeout
  if (!patientId) return null; // expired or unknown session
  const patient = getPatientById(patientId);
  if (!patient) return null;
  return patient;
}

/**
 * Strict guard — use on routes that MUST have an authenticated patient
 * (dashboard reads, order reads, associating an intake with the account).
 * Attaches `req.patient` (the full record) and `req.patientId`.
 */
export function requireAuth(req, _res, next) {
  const patient = resolvePatient(req);
  if (!patient) {
    // Generic message — never reveal whether the session expired vs. was
    // never valid vs. the account is gone.
    return next(new AppError('Authentication required', 401));
  }
  req.patient = patient;
  req.patientId = patient.id;
  next();
}

/**
 * Soft helper — attaches `req.patient` when a valid session is present but
 * does NOT reject anonymous requests. Useful for endpoints (like intake
 * submission) that work for both guests and logged-in patients, associating
 * the submission with the account only when one exists.
 */
export function attachPatient(req, _res, next) {
  const patient = resolvePatient(req);
  if (patient) {
    req.patient = patient;
    req.patientId = patient.id;
  }
  next();
}

export { toPatientView };
