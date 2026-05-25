// src/routes/stripeWebhookRoutes.js
// Inbound Stripe webhook:  POST /webhooks/stripe
//
// Handles recurring-billing events for subscriptions created on clinician
// approval:
//   - invoice.paid            — a recurring charge succeeded
//   - invoice.payment_failed  — a recurring charge failed (dunning)
//   - setup_intent.succeeded  — the patient's card finished saving (card on file)
//
// Researched against current (2026) Stripe docs:
//   - https://docs.stripe.com/webhooks — Stripe signs every event with the
//     `Stripe-Signature` header; verify with stripe.webhooks.constructEvent()
//     using the endpoint's signing secret. Verification needs the RAW request
//     body — a JSON-parsed body fails the signature check. This route is
//     therefore mounted with express.raw(), NOT express.json().
//   - https://docs.stripe.com/billing/subscriptions/webhooks — invoice.paid /
//     invoice.payment_failed are the events that drive subscription billing.
import { Router } from 'express';
import express from 'express';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { getStripe } from '../clients/stripeClient.js';
import {
  applyInvoicePaid,
  applyInvoicePaymentFailed,
  recordSavedPaymentMethod,
} from '../services/stripeService.js';

export const stripeWebhookRoutes = Router();

/**
 * Verify the Stripe-Signature header and return the parsed event.
 *
 * In scaffold mode (placeholder STRIPE_WEBHOOK_SECRET) the mock Stripe client's
 * constructEvent() still performs a real HMAC check against the placeholder
 * secret — the test script signs its payloads with that same secret, so the
 * verification CODE PATH is genuinely exercised offline.
 *
 * TODO(prod): once a real Stripe account exists, set STRIPE_WEBHOOK_SECRET to
 * the endpoint's signing secret (`whsec_...`) from the Stripe dashboard. No
 * code change is needed — the same constructEvent() call verifies live events.
 */
async function verifyStripeEvent(req) {
  const stripe = await getStripe();
  const signature = req.get('Stripe-Signature');
  const secret = config.stripe.webhookSecret;

  if (!secret) {
    // Should not happen — config falls back to a placeholder — but guard anyway.
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }

  // req.body is a Buffer here because this route is mounted with express.raw().
  // constructEvent() throws if the signature is missing/invalid/expired.
  return stripe.webhooks.constructEvent(req.body, signature, secret);
}

/**
 * POST /webhooks/stripe
 * Mounted with express.raw() so the raw body is available for signature
 * verification (Stripe's docs are explicit that a re-serialised body fails).
 */
stripeWebhookRoutes.post(
  '/stripe',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req, res, next) => {
    let event;
    try {
      event = await verifyStripeEvent(req);
    } catch (err) {
      // A failed signature check is a 400 per Stripe's guidance — do NOT 500,
      // or Stripe will retry a request that can never succeed.
      logger.warn('Stripe webhook signature verification failed', { error: err.message });
      return res.status(400).json({ error: `Webhook signature verification failed` });
    }

    try {
      switch (event.type) {
        case 'invoice.paid': {
          applyInvoicePaid(event.data.object);
          break;
        }
        case 'invoice.payment_failed': {
          applyInvoicePaymentFailed(event.data.object);
          break;
        }
        case 'setup_intent.succeeded': {
          // The patient's card finished saving. event.data.object.payment_method
          // is the resulting PaymentMethod; record it so approval can bill it.
          const si = event.data.object;
          const orderId = si?.metadata?.pnrx_order_id;
          if (orderId && si.payment_method) {
            await recordSavedPaymentMethod({
              orderId,
              paymentMethodId: si.payment_method,
            });
          }
          break;
        }
        default:
          // Acknowledge unhandled events with 200 so Stripe stops retrying.
          logger.info('Stripe webhook: unhandled event type', { type: event.type });
      }

      // Always 200 quickly once handled — Stripe expects a fast acknowledgement.
      res.json({ received: true, type: event.type });
    } catch (err) {
      next(err);
    }
  },
);
