// src/services/orderService.js
// Order model, lifecycle state machine, and persistence.
//
// TODO(onboarding): replace the in-memory store below with a real DB
// (DATABASE_URL). Orders contain PHI — the production datastore MUST be
// HIPAA-eligible and covered by a signed BAA.
import { randomUUID } from 'node:crypto';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../lib/logger.js';

/** Canonical order lifecycle states. */
export const ORDER_STATE = Object.freeze({
  DRAFT: 'DRAFT',
  INTAKE_SUBMITTED: 'INTAKE_SUBMITTED',
  CLINICIAN_REVIEW: 'CLINICIAN_REVIEW',
  APPROVED: 'APPROVED',
  DECLINED: 'DECLINED',
  ROUTED_TO_PHARMACY: 'ROUTED_TO_PHARMACY',
  COMPOUNDING: 'COMPOUNDING',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  ON_HOLD: 'ON_HOLD',
});

// Allowed transitions. Any non-terminal state may move to CANCELLED or ON_HOLD.
const TRANSITIONS = {
  [ORDER_STATE.DRAFT]: [ORDER_STATE.INTAKE_SUBMITTED],
  [ORDER_STATE.INTAKE_SUBMITTED]: [ORDER_STATE.CLINICIAN_REVIEW],
  [ORDER_STATE.CLINICIAN_REVIEW]: [ORDER_STATE.APPROVED, ORDER_STATE.DECLINED],
  [ORDER_STATE.APPROVED]: [ORDER_STATE.ROUTED_TO_PHARMACY],
  [ORDER_STATE.ROUTED_TO_PHARMACY]: [ORDER_STATE.COMPOUNDING],
  [ORDER_STATE.COMPOUNDING]: [ORDER_STATE.SHIPPED],
  [ORDER_STATE.SHIPPED]: [ORDER_STATE.DELIVERED],
  [ORDER_STATE.DECLINED]: [],
  [ORDER_STATE.DELIVERED]: [],
  [ORDER_STATE.CANCELLED]: [],
  [ORDER_STATE.ON_HOLD]: [],
};

// States from which cancellation / hold is no longer meaningful.
const TERMINAL = new Set([
  ORDER_STATE.DECLINED,
  ORDER_STATE.DELIVERED,
  ORDER_STATE.CANCELLED,
]);

// --- In-memory store -------------------------------------------------------
// TODO(onboarding): replace with real DB-backed repository.
const store = new Map();

function isValidTransition(from, to) {
  if (to === ORDER_STATE.CANCELLED || to === ORDER_STATE.ON_HOLD) {
    return !TERMINAL.has(from);
  }
  return (TRANSITIONS[from] || []).includes(to);
}

/**
 * Create a new order. Starts in INTAKE_SUBMITTED because creation is
 * triggered by a validated intake submission.
 */
export function createOrder({ intake }) {
  const now = new Date().toISOString();
  // Surface the owning patient id (set when a logged-in patient submits an
  // intake) at the top of the intake object so the auth ownership check in
  // orderRoutes can read it without reaching into intake.patient.
  const patientId = intake?.patient?.patientId || intake?.patientId || null;
  const order = {
    id: randomUUID(),
    state: ORDER_STATE.INTAKE_SUBMITTED,
    intake: { ...intake, patientId }, // validated intake payload (contains PHI)
    productIds: intake.productIds,
    pharmacy: null, // set by the router after approval
    steadymd: { caseId: null, decision: null },
    tracking: { carrier: null, trackingNumber: null },
    history: [{ state: ORDER_STATE.INTAKE_SUBMITTED, at: now }],
    createdAt: now,
    updatedAt: now,
  };
  store.set(order.id, order);
  logger.info('Order created', { orderId: order.id, state: order.state });
  return order;
}

/** Fetch an order or throw a 404. */
export function getOrder(orderId) {
  const order = store.get(orderId);
  if (!order) {
    throw new AppError(`Order not found: ${orderId}`, 404);
  }
  return order;
}

/**
 * Transition an order to a new state, enforcing the state machine.
 * `patch` lets callers attach data captured at that step (e.g. tracking #).
 */
export function transitionOrder(orderId, nextState, patch = {}) {
  const order = getOrder(orderId);
  if (!isValidTransition(order.state, nextState)) {
    throw new AppError(
      `Invalid transition: ${order.state} -> ${nextState}`,
      409,
    );
  }
  const now = new Date().toISOString();
  Object.assign(order, patch, { state: nextState, updatedAt: now });
  order.history.push({ state: nextState, at: now });
  logger.info('Order transitioned', { orderId, state: nextState });
  return order;
}

/** Public read-only snapshot for the patient dashboard. */
export function toDashboardView(order) {
  return {
    orderId: order.id,
    state: order.state,
    productIds: order.productIds,
    pharmacy: order.pharmacy,
    tracking: order.tracking,
    history: order.history,
    updatedAt: order.updatedAt,
  };
}
