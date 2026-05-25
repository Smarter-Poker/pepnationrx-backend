// src/clients/hallandaleClient.js
// Hallandale Pharmacy API client (compounding pharmacy, LifeFile-based system).
//
// Described behavior: receives an approved prescription, compounds it, ships
// direct-to-patient, and fires a webhook to /webhooks/hallandale with tracking
// once shipped. Hallandale runs on a LifeFile-based platform.
//
// Built to that DESCRIBED behavior with placeholder credentials. Endpoint
// path and request/response shapes are STUBS.
// TODO(onboarding): reconcile with real Hallandale / LifeFile API spec.
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// TODO(onboarding): reconcile with real Hallandale / LifeFile API spec —
// LifeFile typically exposes an order-submission endpoint; confirm the real
// path and whether it is XML or JSON. Placeholder JSON path used for now.
const SUBMIT_PATH = '/lifefile/v1/orders';

/**
 * Submit an approved prescription to Hallandale for compounding + DTP
 * fulfillment. Hallandale is the routing target for GLP-1 / weight-loss drugs.
 *
 * @param {object} order - approved order (contains intake PHI + SteadyMD case)
 * @param {string[]} [productIds] - subset routed to Hallandale; defaults to all
 * @returns {Promise<{ pharmacyOrderId: string, status: string }>}
 */
export async function submitPrescription(order, productIds = order.productIds) {
  // TODO(onboarding): reconcile with real Hallandale / LifeFile API spec —
  // request body is a placeholder mapping to LifeFile's order model.
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

  const url = `${config.hallandale.baseUrl}${SUBMIT_PATH}`;

  // --- Stubbed network call ------------------------------------------------
  // TODO(onboarding): reconcile with real Hallandale / LifeFile API spec —
  // replace with a real fetch() once base URL + auth scheme are confirmed.
  //
  //   const res = await fetch(url, {
  //     method: 'POST',
  //     headers: {
  //       'Content-Type': 'application/json',
  //       // TODO(onboarding): confirm LifeFile auth (vendor/location id + key?).
  //       Authorization: `Bearer ${config.hallandale.apiKey}`,
  //     },
  //     body: JSON.stringify(requestBody),
  //   });
  //   if (!res.ok) throw new Error(`Hallandale submit failed: ${res.status}`);
  //   return await res.json();
  // -------------------------------------------------------------------------

  logger.info('STUB: Hallandale submitPrescription', { url, orderId: order.id });
  void requestBody; // referenced for shape documentation; unused in stub

  // Placeholder response shape — pharmacy has accepted the Rx for compounding.
  return {
    pharmacyOrderId: `hallandale-stub-${order.id}`,
    status: 'ACCEPTED',
  };
}
