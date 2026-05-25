// src/clients/steadymdClient.js
// SteadyMD clinical API client.
//
// Described behavior: the backend submits a patient's intake (JSON payload)
// to SteadyMD. A SteadyMD clinician reviews it asynchronously and either
// approves (signs a prescription) or declines. SteadyMD then fires a webhook
// back to /webhooks/steadymd with the decision.
//
// This client is built to that DESCRIBED behavior with placeholder
// credentials. Endpoint paths and request/response shapes below are STUBS.
// TODO(onboarding): reconcile with real SteadyMD API spec.
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// TODO(onboarding): reconcile with real SteadyMD API spec — confirm the
// actual case-submission path. Placeholder path used until docs arrive.
const SUBMIT_PATH = '/v1/cases';

/**
 * Submit an order's intake to SteadyMD for asynchronous clinician review.
 *
 * @param {object} order - order created by orderService (contains intake PHI)
 * @returns {Promise<{ caseId: string, status: string }>}
 */
export async function submitIntake(order) {
  // TODO(onboarding): reconcile with real SteadyMD API spec — request body
  // shape is a placeholder mapping of our intake to SteadyMD's case model.
  const requestBody = {
    externalOrderId: order.id,
    patient: order.intake.patient,
    stateOfResidence: order.intake.stateOfResidence,
    requestedProducts: order.intake.productIds,
    questionnaire: order.intake.questionnaire,
    consent: order.intake.consent,
  };

  const url = `${config.steadymd.baseUrl}${SUBMIT_PATH}`;

  // --- Stubbed network call ------------------------------------------------
  // TODO(onboarding): reconcile with real SteadyMD API spec — replace this
  // stub with a real fetch() once base URL + auth scheme are confirmed.
  //
  //   const res = await fetch(url, {
  //     method: 'POST',
  //     headers: {
  //       'Content-Type': 'application/json',
  //       // TODO(onboarding): confirm auth header name/scheme (Bearer? X-Api-Key?)
  //       Authorization: `Bearer ${config.steadymd.apiKey}`,
  //     },
  //     body: JSON.stringify(requestBody),
  //   });
  //   if (!res.ok) throw new Error(`SteadyMD submit failed: ${res.status}`);
  //   return await res.json();
  // -------------------------------------------------------------------------

  logger.info('STUB: SteadyMD submitIntake', { url, orderId: order.id });
  void requestBody; // referenced for shape documentation; unused in stub

  // Placeholder response shape — mirrors the described "case created, pending
  // asynchronous clinician review" behavior.
  return {
    caseId: `steadymd-stub-${order.id}`,
    status: 'PENDING_REVIEW',
  };
}
