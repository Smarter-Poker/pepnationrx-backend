// src/services/orchestrator.js
// Ties the end-to-end flow together. Routes call into the orchestrator;
// the orchestrator coordinates orderService, the pharmacy router, and the
// vendor clients.
//
// Flow:
//   1. handleIntake()          -> create order, submit to SteadyMD, -> CLINICIAN_REVIEW
//   2. handleSteadyMDDecision()-> approve: route + submit Rx -> ROUTED_TO_PHARMACY
//                                 decline: -> DECLINED
//   3. handlePharmacyUpdate()  -> advance COMPOUNDING -> SHIPPED -> DELIVERED
import {
  createOrder,
  getOrder,
  transitionOrder,
  ORDER_STATE,
} from './orderService.js';
import { routeOrder } from './pharmacyRouter.js';
import { PHARMACY } from '../data/catalog.js';
import * as steadymdClient from '../clients/steadymdClient.js';
import * as empowerClient from '../clients/empowerClient.js';
import * as hallandaleClient from '../clients/hallandaleClient.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../lib/logger.js';

const pharmacyClients = {
  [PHARMACY.EMPOWER]: empowerClient,
  [PHARMACY.HALLANDALE]: hallandaleClient,
};

/**
 * Step 1 — patient submits intake.
 * Creates the order (INTAKE_SUBMITTED), submits to SteadyMD, then moves to
 * CLINICIAN_REVIEW. SteadyMD reviews asynchronously and will call back via
 * the /webhooks/steadymd webhook.
 *
 * @param {object} validatedIntake - output of validateIntake()
 * @returns {Promise<object>} the order
 */
export async function handleIntake(validatedIntake) {
  const order = createOrder({ intake: validatedIntake });

  const submission = await steadymdClient.submitIntake(order);

  transitionOrder(order.id, ORDER_STATE.CLINICIAN_REVIEW, {
    steadymd: { caseId: submission.caseId, decision: null },
  });

  logger.info('Intake submitted to SteadyMD', {
    orderId: order.id,
    caseId: submission.caseId,
  });
  return getOrder(order.id);
}

/**
 * Step 2 — SteadyMD webhook delivers the clinician decision.
 * Approved: order -> APPROVED, run the pharmacy router, submit the Rx to the
 * chosen pharmacy, order -> ROUTED_TO_PHARMACY.
 * Declined: order -> DECLINED.
 *
 * @param {object} args
 * @param {string} args.orderId
 * @param {'approved'|'declined'} args.decision
 * @param {string} [args.caseId]
 */
export async function handleSteadyMDDecision({ orderId, decision, caseId }) {
  const order = getOrder(orderId);

  if (decision === 'declined') {
    return transitionOrder(orderId, ORDER_STATE.DECLINED, {
      steadymd: { caseId: caseId || order.steadymd.caseId, decision },
    });
  }

  if (decision !== 'approved') {
    throw new AppError(`Unknown SteadyMD decision: ${decision}`, 422);
  }

  // Approved — sign-off received.
  transitionOrder(orderId, ORDER_STATE.APPROVED, {
    steadymd: { caseId: caseId || order.steadymd.caseId, decision },
  });

  // Conditional pharmacy routing.
  const routing = routeOrder(order.productIds);

  // TODO(onboarding): if routing.single is null the order spans BOTH
  // pharmacies and must be split into two prescriptions. This scaffold
  // submits to the primary pharmacy and flags the split for follow-up.
  const targetPharmacy =
    routing.single ||
    (routing.split[PHARMACY.HALLANDALE].length ? PHARMACY.HALLANDALE : PHARMACY.EMPOWER);

  if (!routing.single) {
    logger.warn('Order spans multiple pharmacies — split fulfillment needed', {
      orderId,
      split: routing.split,
    });
  }

  const client = pharmacyClients[targetPharmacy];
  const pharmacyResult = await client.submitPrescription(order);

  return transitionOrder(orderId, ORDER_STATE.ROUTED_TO_PHARMACY, {
    pharmacy: targetPharmacy,
    pharmacyOrderId: pharmacyResult.pharmacyOrderId,
  });
}

// Maps a pharmacy webhook event type to the next order state.
const PHARMACY_EVENT_TO_STATE = {
  compounding: ORDER_STATE.COMPOUNDING,
  shipped: ORDER_STATE.SHIPPED,
  delivered: ORDER_STATE.DELIVERED,
};

/**
 * Step 3 — pharmacy webhook delivers a fulfillment update.
 * Advances the order through COMPOUNDING -> SHIPPED -> DELIVERED and captures
 * the tracking number when the shipment goes out.
 *
 * @param {object} args
 * @param {string} args.orderId
 * @param {'compounding'|'shipped'|'delivered'} args.event
 * @param {string} [args.carrier]        - e.g. 'FedEx'
 * @param {string} [args.trackingNumber]
 */
export function handlePharmacyUpdate({ orderId, event, carrier, trackingNumber }) {
  const nextState = PHARMACY_EVENT_TO_STATE[event];
  if (!nextState) {
    throw new AppError(`Unknown pharmacy event: ${event}`, 422);
  }

  const patch = {};
  if (event === 'shipped') {
    patch.tracking = {
      carrier: carrier || 'FedEx',
      trackingNumber: trackingNumber || null,
    };
  }

  return transitionOrder(orderId, nextState, patch);
}
