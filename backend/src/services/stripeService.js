// src/services/stripeService.js
// Payment / billing service — the business layer for Stripe.
//
// THE BUSINESS RULE
//   A patient completes intake and is NOT charged. Billing begins ONLY when a
//   clinician APPROVES the treatment. If the clinician declines, the patient
//   is never charged.
//
// HOW THAT MAPS TO STRIPE (researched against current docs, 2026):
//   1. At intake/checkout — create-or-get a Stripe Customer for the patient
//      and create a SetupIntent (https://docs.stripe.com/api/setup_intents).
//      A SetupIntent saves a card for FUTURE payments and creates NO charge.
//      The frontend confirms it with Stripe.js/Elements; the resulting
//      PaymentMethod is attached to the Customer.
//   2. On clinician APPROVAL — create a Stripe Subscription
//      (https://docs.stripe.com/api/subscriptions/create) for the patient's
//      plan, billed against the saved PaymentMethod. THIS is the first time
//      money moves.
//   3. On DECLINE — do nothing. No Subscription, no charge.
//   4. Recurring invoices fire `invoice.paid` / `invoice.payment_failed`
//      webhooks (https://docs.stripe.com/billing/subscriptions/webhooks),
//      handled in routes/stripeWebhookRoutes.js.
//
// Every Stripe POST is sent with an idempotency key
// (https://docs.stripe.com/api/idempotent_requests) so retries never create
// duplicate Customers / SetupIntents / Subscriptions.
//
// TODO(prod): the billing store below is an in-memory Map, mirroring
// orderService.js / patientService.js. Replace with a HIPAA-eligible DB. Note
// that Stripe is itself the system of record for payment data — this store
// only holds the cross-reference IDs (no card numbers ever touch this server).
import { logger } from '../lib/logger.js';
import { getStripe } from '../clients/stripeClient.js';
import { resolveBillingPlan } from '../data/billingPlans.js';
import { getPatientById, updatePatient } from './patientService.js';
import { getOrder } from './orderService.js';

// --- In-memory billing store ----------------------------------------------
// TODO(prod): replace with a DB-backed repository. Keyed by orderId; holds
// only Stripe reference IDs + derived status — never PHI, never card data.
const billingStore = new Map(); // orderId -> billing record

/** Canonical billing-side states for an order. */
export const BILLING_STATE = Object.freeze({
  PENDING_PAYMENT_METHOD: 'PENDING_PAYMENT_METHOD', // SetupIntent created, card not yet saved
  PAYMENT_METHOD_SAVED: 'PAYMENT_METHOD_SAVED', // card on file, not yet billed
  SUBSCRIPTION_ACTIVE: 'SUBSCRIPTION_ACTIVE', // approved -> subscription created
  PAYMENT_FAILED: 'PAYMENT_FAILED', // an invoice failed
  NOT_BILLABLE: 'NOT_BILLABLE', // declined — never charged
});

function nowIso() {
  return new Date().toISOString();
}

function getOrCreateBillingRecord(orderId) {
  let rec = billingStore.get(orderId);
  if (!rec) {
    rec = {
      orderId,
      state: BILLING_STATE.PENDING_PAYMENT_METHOD,
      stripeCustomerId: null,
      setupIntentId: null,
      paymentMethodId: null,
      subscriptionId: null,
      subscriptionStatus: null,
      stripePriceId: null,
      lastInvoice: null, // { id, status, at }
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    billingStore.set(orderId, rec);
  }
  return rec;
}

function patchBilling(orderId, patch) {
  const rec = getOrCreateBillingRecord(orderId);
  Object.assign(rec, patch, { updatedAt: nowIso() });
  return rec;
}

/** Read-only billing snapshot for an order (e.g. for the dashboard). */
export function getBillingForOrder(orderId) {
  return billingStore.get(orderId) || null;
}

// ---------------------------------------------------------------------------
// 1. Create-or-get the Stripe Customer for a patient.
// ---------------------------------------------------------------------------
/**
 * Returns the Stripe Customer id for a patient, creating one if needed and
 * caching it on the patient record so we never create duplicates.
 *
 * @param {string} patientId  - id from the auth-layer patient record
 * @returns {Promise<string>} the Stripe Customer id (cus_...)
 */
export async function ensureStripeCustomer(patientId) {
  const patient = getPatientById(patientId);
  if (!patient) {
    throw new Error(`ensureStripeCustomer: unknown patient ${patientId}`);
  }
  if (patient.stripeCustomerId) {
    return patient.stripeCustomerId;
  }

  const stripe = await getStripe();
  // Idempotency key derived from the stable patient id — a retry of "create the
  // customer for patient X" returns the SAME customer instead of a duplicate.
  const customer = await stripe.customers.create(
    {
      email: patient.email,
      name: [patient.firstName, patient.lastName].filter(Boolean).join(' ') || undefined,
      // metadata links Stripe back to our patient record for support/audit.
      metadata: { pnrx_patient_id: patientId },
    },
    { idempotencyKey: `customer-${patientId}` },
  );

  updatePatient(patientId, { stripeCustomerId: customer.id });
  logger.info('Stripe customer ensured', { patientId, stripeCustomerId: customer.id });
  return customer.id;
}

// ---------------------------------------------------------------------------
// 2. Capture a payment method at intake/checkout — NO CHARGE.
// ---------------------------------------------------------------------------
/**
 * Create a SetupIntent so the patient can save a card at intake time. This
 * does NOT charge anything — it only sets up a payment method for a future
 * charge that happens if/when a clinician approves the treatment.
 *
 * @param {object} args
 * @param {string} args.orderId   - the order this intake produced
 * @param {string} args.patientId - the authenticated patient
 * @returns {Promise<{ setupIntentId: string, clientSecret: string,
 *                      stripeCustomerId: string, billingState: string }>}
 */
export async function capturePaymentMethod({ orderId, patientId }) {
  if (!orderId || !patientId) {
    throw new Error('capturePaymentMethod: orderId and patientId are required');
  }
  // Confirm the order exists (throws 404 if not).
  getOrder(orderId);

  const stripeCustomerId = await ensureStripeCustomer(patientId);
  const stripe = await getStripe();

  const setupIntent = await stripe.setupIntents.create(
    {
      customer: stripeCustomerId,
      // 'off_session' => the saved card may be charged later when the patient
      // is NOT present (i.e. when the clinician approves). This is the key
      // flag for the capture-now / charge-later model.
      usage: 'off_session',
      payment_method_types: ['card'],
      metadata: { pnrx_order_id: orderId, pnrx_patient_id: patientId },
    },
    // Idempotency: one SetupIntent per order, even if checkout is retried.
    { idempotencyKey: `setupintent-${orderId}` },
  );

  const rec = patchBilling(orderId, {
    stripeCustomerId,
    setupIntentId: setupIntent.id,
    stripePriceId: null,
    state: BILLING_STATE.PENDING_PAYMENT_METHOD,
  });

  logger.info('SetupIntent created — payment method capture started, NO charge', {
    orderId,
    setupIntentId: setupIntent.id,
  });

  return {
    setupIntentId: setupIntent.id,
    // The frontend hands this to Stripe.js/Elements to collect & confirm the
    // card. The card itself NEVER touches this backend.
    clientSecret: setupIntent.client_secret,
    stripeCustomerId,
    billingState: rec.state,
  };
}

/**
 * Mark a payment method as saved. In a real integration this is driven by the
 * `setup_intent.succeeded` webhook (or a client confirmation callback) which
 * carries the resulting PaymentMethod id. Recorded so the approval step knows
 * a card is on file.
 *
 * @param {object} args
 * @param {string} args.orderId
 * @param {string} args.paymentMethodId - pm_... from the confirmed SetupIntent
 */
export async function recordSavedPaymentMethod({ orderId, paymentMethodId }) {
  const rec = getBillingForOrder(orderId);
  if (!rec) {
    throw new Error(`recordSavedPaymentMethod: no billing record for ${orderId}`);
  }
  const stripe = await getStripe();

  // Make the saved card the customer's default for invoices, so the
  // Subscription created on approval bills it without any further input.
  if (rec.stripeCustomerId) {
    await stripe.customers.update(rec.stripeCustomerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }

  patchBilling(orderId, {
    paymentMethodId,
    state: BILLING_STATE.PAYMENT_METHOD_SAVED,
  });
  logger.info('Payment method saved for order — still NO charge', {
    orderId,
    paymentMethodId,
  });
  return getBillingForOrder(orderId);
}

// ---------------------------------------------------------------------------
// 3. Begin billing on clinician APPROVAL — create the Subscription.
// ---------------------------------------------------------------------------
/**
 * Called by the orchestrator when an order transitions to APPROVED. Creates
 * the recurring Stripe Subscription for the patient's plan. THIS is the point
 * the patient starts being charged.
 *
 * Safe to call without a saved payment method (scaffold demo / declined card):
 * it logs and records the gap rather than throwing, so an approval is never
 * lost just because billing setup is incomplete.
 *
 * @param {string} orderId
 * @returns {Promise<{ created: boolean, subscriptionId: string|null,
 *                      reason?: string, billingState: string }>}
 */
export async function startSubscriptionOnApproval(orderId) {
  const order = getOrder(orderId);
  const rec = getBillingForOrder(orderId);

  // No card on file — cannot bill. Record it; the order still advanced.
  if (!rec || !rec.stripeCustomerId) {
    logger.warn('Approval with no Stripe customer — subscription not created', { orderId });
    patchBilling(orderId, { state: BILLING_STATE.PENDING_PAYMENT_METHOD });
    return {
      created: false,
      subscriptionId: null,
      reason: 'no_payment_method_on_file',
      billingState: BILLING_STATE.PENDING_PAYMENT_METHOD,
    };
  }

  // Idempotency: if a subscription already exists for this order, return it.
  if (rec.subscriptionId) {
    logger.info('Subscription already exists for order — skipping', {
      orderId,
      subscriptionId: rec.subscriptionId,
    });
    return {
      created: false,
      subscriptionId: rec.subscriptionId,
      reason: 'already_subscribed',
      billingState: rec.state,
    };
  }

  const plan = resolveBillingPlan(order.productIds);
  if (plan.mixedCategories) {
    // TODO(prod): an order spanning categories may need multiple subscription
    // items or split subscriptions — confirm the billing model with the
    // business. The scaffold bills the primary category's plan.
    logger.warn('Order spans multiple plan categories — billing primary plan only', {
      orderId,
      category: plan.category,
    });
  }

  const stripe = await getStripe();
  const subscription = await stripe.subscriptions.create(
    {
      customer: rec.stripeCustomerId,
      items: [{ price: plan.stripePriceId }],
      // Bill the card saved via the SetupIntent. If null, Stripe falls back to
      // the customer's invoice_settings.default_payment_method (set above).
      default_payment_method: rec.paymentMethodId || undefined,
      metadata: {
        pnrx_order_id: orderId,
        pnrx_patient_id: order.intake?.patientId || '',
        pnrx_plan: plan.lookupKey,
      },
    },
    // Idempotency: "create the subscription for order X" never duplicates.
    { idempotencyKey: `subscription-${orderId}` },
  );

  patchBilling(orderId, {
    subscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    stripePriceId: plan.stripePriceId,
    state: BILLING_STATE.SUBSCRIPTION_ACTIVE,
  });

  logger.info('Subscription created on clinician approval — billing has begun', {
    orderId,
    subscriptionId: subscription.id,
    plan: plan.lookupKey,
    status: subscription.status,
  });

  return {
    created: true,
    subscriptionId: subscription.id,
    billingState: BILLING_STATE.SUBSCRIPTION_ACTIVE,
  };
}

// ---------------------------------------------------------------------------
// On DECLINE — explicitly do nothing billable.
// ---------------------------------------------------------------------------
/**
 * Called by the orchestrator when an order is DECLINED. Per the business rule
 * a declined patient is NEVER charged. No Subscription is created. We only
 * record that the order is not billable for audit clarity.
 *
 * @param {string} orderId
 */
export function markNotBillable(orderId) {
  const rec = getBillingForOrder(orderId);
  if (rec && rec.subscriptionId) {
    // Defensive: a declined order should never already be subscribed.
    logger.error('DECLINED order has a subscription — investigate', {
      orderId,
      subscriptionId: rec.subscriptionId,
    });
    return rec;
  }
  patchBilling(orderId, { state: BILLING_STATE.NOT_BILLABLE });
  logger.info('Order declined — marked NOT_BILLABLE, no charge will ever occur', {
    orderId,
  });
  return getBillingForOrder(orderId);
}

// ---------------------------------------------------------------------------
// 4. Recurring-invoice webhook outcomes.
// ---------------------------------------------------------------------------
/**
 * Apply an invoice.paid event to the billing record for an order.
 * @param {object} invoice - Stripe Invoice object from the event
 */
export function applyInvoicePaid(invoice) {
  const orderId = invoice?.metadata?.pnrx_order_id || findOrderBySubscription(invoice?.subscription);
  if (!orderId) {
    logger.warn('invoice.paid: could not map invoice to an order', { invoiceId: invoice?.id });
    return null;
  }
  const rec = patchBilling(orderId, {
    state: BILLING_STATE.SUBSCRIPTION_ACTIVE,
    subscriptionStatus: 'active',
    lastInvoice: { id: invoice.id, status: 'paid', at: nowIso() },
  });
  logger.info('invoice.paid applied', { orderId, invoiceId: invoice.id });
  return rec;
}

/**
 * Apply an invoice.payment_failed event to the billing record for an order.
 * @param {object} invoice - Stripe Invoice object from the event
 */
export function applyInvoicePaymentFailed(invoice) {
  const orderId = invoice?.metadata?.pnrx_order_id || findOrderBySubscription(invoice?.subscription);
  if (!orderId) {
    logger.warn('invoice.payment_failed: could not map invoice to an order', {
      invoiceId: invoice?.id,
    });
    return null;
  }
  const rec = patchBilling(orderId, {
    state: BILLING_STATE.PAYMENT_FAILED,
    subscriptionStatus: 'past_due',
    lastInvoice: { id: invoice.id, status: 'payment_failed', at: nowIso() },
  });
  logger.warn('invoice.payment_failed applied', { orderId, invoiceId: invoice.id });
  // TODO(prod): trigger dunning — notify the patient to update their card; the
  // pharmacy fulfillment should pause until the invoice clears.
  return rec;
}

/** Reverse-lookup an order id from a subscription id (in-memory scan). */
function findOrderBySubscription(subscriptionId) {
  if (!subscriptionId) return null;
  for (const rec of billingStore.values()) {
    if (rec.subscriptionId === subscriptionId) return rec.orderId;
  }
  return null;
}

// Test-only: reset the billing store between runs.
export function __resetBillingStore() {
  billingStore.clear();
}
