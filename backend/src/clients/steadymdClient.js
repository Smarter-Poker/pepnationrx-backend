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

// TODO(onboarding): reconcile with real SteadyMD API spec - confirm the
// actual case-submission path. Placeholder path used until docs arrive.
const SUBMIT_PATH = '/v1/cases';

/**
 * Submit an order's intake to SteadyMD for asynchronous clinician review.
 *
 * @param {object} order - order created by orderService (contains intake PHI)
 * @returns {Promise<{ caseId: string, status: string }>}
 */
export async function submitIntake(order) {
  // TODO(onboarding): reconcile with real SteadyMD API spec - request body
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
  // TODO(onboarding): reconcile with real SteadyMD API spec - replace this
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

  // Placeholder response shape - mirrors the described "case created, pending
  // asynchronous clinician review" behavior.
  return {
    caseId: `steadymd-stub-${order.id}`,
    status: 'PENDING_REVIEW',
  };
}

// TODO(steadymd-onboarding): reconcile with real API docs - SteadyMD's public
// docs split submission into EMR endpoints (create the Episode of Care +
// Intake Questionnaire/Observations/Files) followed by a Consult endpoint to
// request the async clinician review. Real paths are gated behind the partner
// API Reference; these are placeholders.
const EMR_EPISODE_PATH = '/v1/emr/episodes-of-care';
const CONSULT_PATH = '/v1/consults';

/**
 * Submit an asynchronous visit to SteadyMD using the documented EMR + Consult
 * model. `payload` is produced by src/intake/steadymdPayload.js and carries
 * { episodeOfCare, consult, legacyCase, meta }.
 *
 * Described two-step flow (see https://docs.steadymd.com/docs/key-terms):
 *   1. POST the Episode of Care + Intake to the EMR endpoint.
 *   2. POST a Consult referencing that Episode to request async review.
 * The clinician decision then arrives asynchronously as a Platform Event
 * (AWS SNS) handled by /webhooks/steadymd.
 *
 * @param {object} payload - output of buildSteadyMDPayload()
 * @returns {Promise<{ episodeId: string, consultId: string, status: string }>}
 */
export async function submitAsyncVisit(payload) {
  const emrUrl = `${config.steadymd.baseUrl}${EMR_EPISODE_PATH}`;
  const consultUrl = `${config.steadymd.baseUrl}${CONSULT_PATH}`;

  // --- Stubbed two-step network call --------------------------------------
  // TODO(steadymd-onboarding): reconcile with real API docs - replace with
  // real fetch() calls once base URL, auth, and paths are confirmed.
  //
  //   const emrRes = await fetch(emrUrl, {
  //     method: 'POST',
  //     headers: {
  //       'Content-Type': 'application/json',
  //       // Docs: token auth with the literal prefix "Token".
  //       Authorization: `Token ${config.steadymd.apiKey}`,
  //     },
  //     body: JSON.stringify(payload.episodeOfCare),
  //   });
  //   const episode = await emrRes.json();
  //   const consultRes = await fetch(consultUrl, {
  //     method: 'POST',
  //     headers: { ...authHeaders },
  //     body: JSON.stringify({ ...payload.consult, episodeId: episode.id }),
  //   });
  //   const consult = await consultRes.json();
  //   return { episodeId: episode.id, consultId: consult.id, status: consult.status };
  // -------------------------------------------------------------------------

  logger.info('STUB: SteadyMD submitAsyncVisit', {
    emrUrl,
    consultUrl,
    program: payload?.consult?.consultType || null,
    questionnaireItems: payload?.meta?.questionnaireItemCount ?? null,
  });

  const externalId = payload?.episodeOfCare?.externalEpisodeId || 'unknown';
  return {
    episodeId: `steadymd-episode-stub-${externalId}`,
    consultId: `steadymd-consult-stub-${externalId}`,
    status: 'PENDING_REVIEW',
  };
}
