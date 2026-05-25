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
import { validateIntakeAnswers } from '../intake/validator.js';
import { buildSteadyMDPayload } from '../intake/steadymdPayload.js';
import {
  startSubscriptionOnApproval,
  markNotBillable,
} from './stripeService.js';

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
 * Step 1 (v2) — patient submits the dynamic 13-step intake.
 *
 * This is the questionnaire-driven entry point. It:
 *   1. Validates the answer set against src/intake/questionnaire.js, which is
 *      branch-aware (program + biological-sex branches) and runs red-flag /
 *      contraindication screening.
 *   2. If the intake is INELIGIBLE (a contraindication red flag fired) the
 *      order is created and immediately moved to DECLINED — it never reaches
 *      a SteadyMD clinician.
 *   3. Otherwise it builds the SteadyMD async-visit payload
 *      (src/intake/steadymdPayload.js) and submits it via the EMR + Consult
 *      flow, then moves the order to CLINICIAN_REVIEW.
 *
 * @param {object} submission
 * @param {object} submission.patient   - patient demographics
 * @param {string[]} submission.productIds
 * @param {Record<string,any>} submission.answers - 13-step answer set
 * @param {string} [submission.program] - optional program override
 * @returns {Promise<{ order: object, validation: object, steadymdPayload: object|null }>}
 */
export async function handleIntakeV2(submission) {
  const validation = validateIntakeAnswers({
    productIds: submission.productIds,
    answers: submission.answers,
    program: submission.program,
  });

  if (!validation.ok) {
    // Structural / required-field problems — reject before creating an order.
    throw new AppError('Intake validation failed', 422, validation.issues);
  }

  // Create the order now so an ineligible intake is still recorded/auditable.
  const order = createOrder({
    intake: {
      patient: submission.patient,
      productIds: submission.productIds,
      program: validation.program,
      answers: submission.answers,
    },
  });

  // --- Red-flag gate: ineligible intakes never reach a clinician -----------
  if (!validation.eligible) {
    transitionOrder(order.id, ORDER_STATE.CLINICIAN_REVIEW, {});
    transitionOrder(order.id, ORDER_STATE.DECLINED, {
      steadymd: { caseId: null, decision: 'declined' },
      ineligibleReasons: validation.redFlags,
    });
    // BUSINESS RULE: a red-flag decline is still a decline — never charged.
    markNotBillable(order.id);
    logger.warn('Intake declined — contraindication red flag', {
      orderId: order.id,
      redFlags: validation.redFlags,
    });
    return {
      order: getOrder(order.id),
      validation,
      steadymdPayload: null,
    };
  }

  // --- Build the SteadyMD async-visit payload + submit ---------------------
  const steadymdPayload = buildSteadyMDPayload({
    patient: submission.patient,
    program: validation.program,
    answers: submission.answers,
    externalOrderId: order.id,
  });

  const submissionResult = await steadymdClient.submitAsyncVisit(steadymdPayload);

  transitionOrder(order.id, ORDER_STATE.CLINICIAN_REVIEW, {
    steadymd: {
      caseId: submissionResult.consultId,
      episodeId: submissionResult.episodeId,
      decision: null,
    },
  });

  logger.info('Intake (v2) submitted to SteadyMD', {
    orderId: order.id,
    program: validation.program,
    consultId: submissionResult.consultId,
    questionnaireItems: steadymdPayload.meta.questionnaireItemCount,
  });

  return {
    order: getOrder(order.id),
    validation,
    steadymdPayload,
  };
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
    const declined = transitionOrder(orderId, ORDER_STATE.DECLINED, {
      steadymd: { caseId: caseId || order.steadymd.caseId, decision },
    });
    // BUSINESS RULE: a declined patient is NEVER charged. No Stripe
    // subscription is created; we only record that the order is not billable.
    markNotBillable(orderId);
    return declined;
  }

  if (decision !== 'approved') {
    throw new AppError(`Unknown SteadyMD decision: ${decision}`, 422);
  }

  // Approved — clinician sign-off received.
  transitionOrder(orderId, ORDER_STATE.APPROVED, {
    steadymd: { caseId: caseId || order.steadymd.caseId, decision },
  });

  // BUSINESS RULE: billing begins ONLY now, on clinician approval. Create the
  // recurring Stripe subscription against the card the patient saved at intake
  // (captured earlier via a SetupIntent — no charge was taken then). This is
  // the FIRST time money moves. A billing failure must not roll back a valid
  // clinical approval, so it is logged and surfaced rather than thrown.
  try {
    const billing = await startSubscriptionOnApproval(orderId);
    if (billing.created) {
      logger.info('Billing started on approval', {
        orderId,
        subscriptionId: billing.subscriptionId,
      });
    } else {
      logger.warn('Approval processed but subscription not created', {
        orderId,
        reason: billing.reason,
      });
    }
  } catch (err) {
    // TODO(prod): route this to an alerting / billing-ops queue so an approved
    // order with no active subscription is reconciled, not silently lost.
    logger.error('Subscription creation failed on approval', {
      orderId,
      error: err.message,
    });
  }

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
