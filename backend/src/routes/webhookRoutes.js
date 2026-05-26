// src/routes/webhookRoutes.js
// Inbound vendor webhooks:
//   POST /webhooks/steadymd   — clinician decision (approved | declined)
//   POST /webhooks/empower    — Empower fulfillment update + FedEx tracking
//   POST /webhooks/hallandale — Hallandale fulfillment update + tracking
import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  handleSteadyMDDecision,
  handlePharmacyUpdate,
} from '../services/orchestrator.js';

export const webhookRoutes = Router();

/**
 * Placeholder signature verification.
 *
 * TODO(onboarding): reconcile with each vendor's real webhook signing scheme.
 * Typical pattern: vendor sends an HMAC of the raw request body in a header
 * (e.g. X-Signature); verify it against the shared webhook secret using a
 * timing-safe comparison. Until the real scheme is known this stub only
 * checks that a secret is configured and logs the attempt.
 *
 * @param {import('express').Request} req
 * @param {string} secret - the configured webhook secret for this vendor
 * @param {string} vendor
 */
function verifySignature(req, secret, vendor) {
  // TODO(onboarding): replace with real HMAC verification, e.g.
  //   const sig = req.get('X-Signature');
  //   const expected = crypto.createHmac('sha256', secret)
  //                          .update(req.rawBody).digest('hex');
  //   if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) ...
  if (!secret || secret === 'REPLACE_AT_ONBOARDING') {
    logger.warn(`${vendor} webhook secret not configured — signature check skipped (scaffold mode)`);
    return; // allow through in scaffold mode so the flow is testable
  }
  const provided = req.get('X-Signature');
  if (!provided) {
    throw new AppError(`Missing ${vendor} webhook signature`, 401);
  }
  // TODO(onboarding): perform the real timing-safe HMAC comparison here.
  logger.info(`STUB: ${vendor} signature present — verification not yet implemented`);
}

/**
 * POST /webhooks/steadymd
 * Expected (placeholder) body: { orderId, decision: 'approved'|'declined', caseId }
 * TODO(onboarding): reconcile with real SteadyMD webhook payload.
 */
webhookRoutes.post('/steadymd', async (req, res, next) => {
  try {
    verifySignature(req, config.steadymd.webhookSecret, 'SteadyMD');
    const { orderId, decision, caseId } = req.body || {};
    if (!orderId || !decision) {
      throw new AppError('Webhook body requires orderId and decision', 422);
    }
    const order = await handleSteadyMDDecision({ orderId, decision, caseId });
    res.json({ received: true, orderId: order.id, state: order.state });
  } catch (err) {
    next(err);
  }
});

/**
 * Shared handler for pharmacy fulfillment webhooks.
 * Expected (placeholder) body:
 *   { orderId, event: 'compounding'|'shipped'|'delivered', carrier, trackingNumber }
 * TODO(onboarding): reconcile with each pharmacy's real webhook payload.
 */
function makePharmacyWebhook(vendor, secretGetter) {
  return (req, res, next) => {
    try {
      verifySignature(req, secretGetter(), vendor);
      const { orderId, event, carrier, trackingNumber } = req.body || {};
      if (!orderId || !event) {
        throw new AppError('Webhook body requires orderId and event', 422);
      }
      const order = handlePharmacyUpdate({ orderId, event, carrier, trackingNumber });
      res.json({ received: true, orderId: order.id, state: order.state });
    } catch (err) {
      next(err);
    }
  };
}

// POST /webhooks/empower
webhookRoutes.post(
  '/empower',
  makePharmacyWebhook('Empower', () => config.empower.webhookSecret),
);

// POST /webhooks/hallandale
webhookRoutes.post(
  '/hallandale',
  makePharmacyWebhook('Hallandale', () => config.hallandale.webhookSecret),
);
