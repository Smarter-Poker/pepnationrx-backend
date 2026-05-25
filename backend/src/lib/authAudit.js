// src/lib/authAudit.js
// HIPAA-oriented authentication audit trail.
//
// The HIPAA Security Rule requires that access to systems holding ePHI be
// auditable: logins, logout, failed attempts, lockouts, password changes and
// account creation must all be recorded with who / when / from where.
//
// TODO(prod): ship these events to a tamper-evident, append-only, retained
// audit store (e.g. a write-once log sink or a dedicated audit table) covered
// by a BAA. Audit records must be retained per the organization's HIPAA
// retention policy (commonly 6 years). NEVER write PHI or raw secrets here —
// log the patient id, not the patient's clinical data, and never a password,
// password hash, session id, or raw token.
import { logger } from './logger.js';

/**
 * Record an authentication event.
 *
 * @param {string} event   - e.g. 'login.success', 'login.failure',
 *                            'login.locked', 'register', 'logout',
 *                            'password.reset.request', 'password.reset.confirm',
 *                            'email.verify'
 * @param {object} ctx
 * @param {string} [ctx.patientId] - subject of the event (omit if unknown)
 * @param {string} [ctx.ip]        - source IP
 * @param {string} [ctx.userAgent] - source user agent
 * @param {string} [ctx.reason]    - non-PHI detail (e.g. 'bad_password')
 */
export function auditAuthEvent(event, { patientId, ip, userAgent, reason } = {}) {
  logger.info('AUTH_AUDIT', {
    audit: true,
    event,
    patientId: patientId || null,
    ip: ip || null,
    userAgent: userAgent || null,
    reason: reason || null,
    at: new Date().toISOString(),
  });
}
