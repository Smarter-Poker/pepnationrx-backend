// src/services/patientService.js
// Patient account model + persistence for the authentication layer.
//
// TODO(prod): replace the in-memory store below with a real, HIPAA-eligible
// database (DATABASE_URL) covered by a signed BAA. Patient rows contain PHI
// (email, name) and authentication secrets — the production datastore MUST be
// encrypted at rest, access-controlled, and audit-logged. This mirrors the
// in-memory pattern used by orderService.js so the swap-in point is identical.
import { randomUUID } from 'node:crypto';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../lib/logger.js';

// --- In-memory store -------------------------------------------------------
// TODO(prod): replace with a real DB-backed repository (e.g. a `patients`
// table). Email is the natural login key and must carry a UNIQUE constraint.
const store = new Map(); // patientId -> patient record
const emailIndex = new Map(); // normalizedEmail -> patientId

/** Normalize an email for consistent lookup (case-insensitive, trimmed). */
export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Create a patient account. The caller is responsible for hashing the
 * password — this layer never sees a plaintext password persisted.
 *
 * @param {object} args
 * @param {string} args.email
 * @param {string} args.passwordHash - argon2id (or bcrypt fallback) hash
 * @param {string} [args.firstName]
 * @param {string} [args.lastName]
 * @returns {object} the new patient record
 */
export function createPatient({ email, passwordHash, firstName, lastName }) {
  const normalized = normalizeEmail(email);
  if (emailIndex.has(normalized)) {
    // Surfaced as a generic message at the route layer to avoid user enumeration.
    throw new AppError('Email already registered', 409);
  }
  const now = new Date().toISOString();
  const patient = {
    id: randomUUID(),
    email: normalized,
    passwordHash,
    firstName: firstName || null,
    lastName: lastName || null,
    emailVerified: false,
    // Hashed, single-use tokens only — raw tokens are never stored.
    emailVerification: { tokenHash: null, expiresAt: null },
    passwordReset: { tokenHash: null, expiresAt: null },
    // Brute-force tracking (see authService.js).
    failedLoginCount: 0,
    lockedUntil: null,
    createdAt: now,
    updatedAt: now,
  };
  store.set(patient.id, patient);
  emailIndex.set(normalized, patient.id);
  logger.info('Patient account created', { patientId: patient.id });
  return patient;
}

/** Fetch a patient by id or return null. */
export function getPatientById(patientId) {
  return store.get(patientId) || null;
}

/** Fetch a patient by id or throw a 404. */
export function requirePatient(patientId) {
  const patient = getPatientById(patientId);
  if (!patient) {
    throw new AppError('Patient not found', 404);
  }
  return patient;
}

/** Fetch a patient by email or return null. */
export function getPatientByEmail(email) {
  const id = emailIndex.get(normalizeEmail(email));
  return id ? store.get(id) : null;
}

/** Shallow-merge a patch onto a patient record and bump updatedAt. */
export function updatePatient(patientId, patch) {
  const patient = requirePatient(patientId);
  Object.assign(patient, patch, { updatedAt: new Date().toISOString() });
  return patient;
}

/**
 * Dashboard-safe projection — never leaks the password hash, token hashes,
 * or brute-force counters to the client.
 */
export function toPatientView(patient) {
  return {
    patientId: patient.id,
    email: patient.email,
    firstName: patient.firstName,
    lastName: patient.lastName,
    emailVerified: patient.emailVerified,
    createdAt: patient.createdAt,
  };
}

/**
 * Iterate every patient record. Used by the auth layer to find a patient by a
 * verification / reset token hash.
 * TODO(prod): in a real DB this is replaced by an indexed lookup on
 * emailVerification.tokenHash / passwordReset.tokenHash — do NOT full-scan.
 */
export function patientStoreIterator() {
  return store.values();
}

// Test-only: reset the store between runs. Not exported into route handlers.
export function __resetPatientStore() {
  store.clear();
  emailIndex.clear();
}
