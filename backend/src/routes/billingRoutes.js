// src/routes/billingRoutes.js
// Billing endpoints — the frontend uses these to mount Stripe Elements and
// collect a card (SetupIntent — NO charge) for an order that has just been
// submitted as an intake. The actual charge happens later via the subscription
// flow inside stripeService.startSubscriptionOnApproval(), driven by the
// clinician decision webhook.
import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  capturePaymentMethod,
  recordSavedPaymentMethod,
} from '../services/stripeService.js';
import { getOrder } from '../services/orderService.js';
import { config } from '../config.js';

export const billingRoutes = Router();

/**
 * POST /api/billing/setup-intent
 * Body: { orderId }
 * Auth: required.
 * Creates a SetupIntent on the patient's Stripe Customer (creating the
 * Customer if necessary) and returns the client_secret to the frontend so
 * Stripe.js can confirm card details without ever sending them through this
 * backend. NO charge is created.
 */
billingRoutes.post('/billing/setup-intent', requireAuth, async (req, res, next) => {
  try {
    const orderId = (req.body || {}).orderId;
    if (!orderId || typeof orderId !== 'string') {
      throw new AppError('orderId is required', 422);
    }

    // Ownership: only the patient who owns the order can create a
    // SetupIntent for it.
    const order = getOrder(orderId); // 404 if missing
    const ownerId = order.intake?.patientId || null;
    if (ownerId && ownerId !== req.patientId) {
      throw new AppError(`Order not found: ${orderId}`, 404);
    }

    const capture = await capturePaymentMethod({
      orderId,
      patientId: req.patientId,
    });

    res.json({
      setupIntentId: capture.setupIntentId,
      clientSecret: capture.clientSecret,
      stripeCustomerId: capture.stripeCustomerId,
      publishableKey: validPublishableKey(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/billing/payment-method
 * Body: { orderId, paymentMethodId }
 * Auth: required.
 * Called by the frontend AFTER Stripe.js confirms the SetupIntent. Persists
 * the pm_... reference against the order so the approval-time subscription
 * call has a payment method to attach. In production this is also driven by
 * the `setup_intent.succeeded` webhook; this endpoint is the client-side
 * companion so the dashboard updates immediately on success.
 */
billingRoutes.post('/billing/payment-method', requireAuth, async (req, res, next) => {
  try {
    const { orderId, paymentMethodId } = req.body || {};
    if (!orderId || typeof orderId !== 'string') {
      throw new AppError('orderId is required', 422);
    }
    if (!paymentMethodId || typeof paymentMethodId !== 'string') {
      throw new AppError('paymentMethodId is required', 422);
    }
    const order = getOrder(orderId);
    const ownerId = order.intake?.patientId || null;
    if (ownerId && ownerId !== req.patientId) {
      throw new AppError(`Order not found: ${orderId}`, 404);
    }
    await recordSavedPaymentMethod({ orderId, paymentMethodId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function validPublishableKey() {
  const raw = config.stripe.publishableKey;
  if (typeof raw !== 'string' || raw === '' || raw === 'REPLACE_AT_ONBOARDING') return null;
  return /^pk_(test|live)_/.test(raw) ? raw : null;
}
