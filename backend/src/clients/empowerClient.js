// src/clients/empowerClient.js
// Empower Pharmacy API client (compounding pharmacy, REST/JSON).
//
// Described behavior: receives an approved prescription, compounds it, ships
// direct-to-patient, and fires a webhook to /webhooks/empower with FedEx
// tracking once shipped.
//
// Built to that DESCRIBED behavior with placeholder credentials. Endpoint
// path and request/response shapes are STUBS.
// TODO(onboarding): reconcile with real Empower Pharmacy API spec.
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// TODO(onboarding): reconcile with real Empower Pharmacy API spec — confirm
// the actual prescription-intake path. Placeholder until docs arrive.
const SUBMIT_PATH = '/api/prescriptions';

/**
 * Submit an approved prescription to Empower for compounding + DTP fulfillment.
 *
 * @param {object} order - approved order (contains intake PHI + SteadyMD case)
 * @param {string[]} [productIds] - subset routed to Empower; defaults to all
 * @returns {Promise<{ pharmacyOrderId: string, status: string }>}
 */
export async function submitPrescription(order, productIds = order.productIds) {
  // TODO(onboarding): reconcile with real Empower Pharmacy API spec — request
  // body is a placeholder mapping of our order to Empower's Rx model.
  const requestBody = {
    externalOrderId: order.id,
    steadymdCaseId: order.steadymd.caseId,
    patient: order.intake.patient,
    shipTo: {
      // TODO(onboarding): capture a real shipping address on intake.
      stateOfResidence: order.intake.stateOfResidence,
    },
    products: productIds,
  };

  const url = `${config.empower.baseUrl}${SUBMIT_PATH}`;

  // --- Stubbed network call ------------------------------------------------
  // TODO(onboarding): reconcile with real Empower Pharmacy API spec — replace
  // with a real fetch() once base URL + auth scheme are confirmed.
  //
  //   const res = await fetch(url, {
  //     method: 'POST',
  //     headers: {
  //       'Content-Type': 'application/json',
  //       // TODO(onboarding): confirm auth header name/scheme.
  //       Authorization: `Bearer ${config.empower.apiKey}`,
  //     },
  //     body: JSON.stringify(requestBody),
  //   });
  //   if (!res.ok) throw new Error(`Empower submit failed: ${res.status}`);
  //   return await res.json();
  // -------------------------------------------------------------------------

  logger.info('STUB: Empower submitPrescription', { url, orderId: order.id });
  void requestBody; // referenced for shape documentation; unused in stub

  // Placeholder response shape — pharmacy has accepted the Rx for compounding.
  return {
    pharmacyOrderId: `empower-stub-${order.id}`,
    status: 'ACCEPTED',
  };
}
