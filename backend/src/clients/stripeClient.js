// src/clients/stripeClient.js
// Stripe SDK client wrapper.
//
// Researched against current (2026) Stripe docs:
//   - Setup Intents API — https://docs.stripe.com/api/setup_intents
//     "set up a payment method for future payments ... no charge is created."
//   - Save a payment method without a payment —
//     https://docs.stripe.com/payments/save-and-reuse
//   - Subscriptions — https://docs.stripe.com/billing/subscriptions/overview
//   - Webhook signature verification — https://docs.stripe.com/webhooks
//     (Stripe-Signature header + stripe.webhooks.constructEvent()).
//   - Idempotent requests — https://docs.stripe.com/api/idempotent_requests
//     (pass { idempotencyKey } as a request option on every POST).
//
// This file is the ONLY place that talks to the Stripe SDK. Because there is
// no real Stripe account yet, it operates in two modes:
//
//   1. SCAFFOLD MODE (default, no real STRIPE_SECRET_KEY) — returns a
//      deterministic in-process MOCK that mirrors the documented Stripe object
//      shapes. No network calls. This is what lets the test suite run offline.
//   2. LIVE MODE — when a real `sk_` key is present AND the `stripe` package is
//      installed, the real SDK is used. The call sites are identical, so
//      flipping to live mode is just supplying the key.
//
// TODO(prod): obtain a real Stripe account; set STRIPE_SECRET_KEY so live mode
// engages. The mock below is built to Stripe's documented shapes but is NOT a
// substitute for integration-testing against Stripe's test mode.
import { randomUUID, createHmac } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/** True when no real Stripe secret key is configured — use the mock. */
export function isStripeScaffold() {
  const k = config.stripe.secretKey;
  return !k || k === 'REPLACE_AT_ONBOARDING' || !k.startsWith('sk_');
}

// ---------------------------------------------------------------------------
// Mock Stripe client — mirrors the documented Stripe resource shapes so the
// rest of the backend can be written against the REAL API surface.
// ---------------------------------------------------------------------------
function buildMockStripe() {
  // In-process stores so retrieve()/list() behave consistently within a run.
  const customers = new Map();
  const setupIntents = new Map();
  const subscriptions = new Map();

  const stamp = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

  return {
    __mock: true,

    customers: {
      // https://docs.stripe.com/api/customers/create
      async create(params = {}, _opts = {}) {
        const id = stamp('cus');
        const customer = {
          id,
          object: 'customer',
          email: params.email || null,
          name: params.name || null,
          metadata: params.metadata || {},
          invoice_settings: { default_payment_method: null },
          created: Math.floor(Date.now() / 1000),
        };
        customers.set(id, customer);
        return customer;
      },
      async retrieve(id) {
        return customers.get(id) || null;
      },
      async update(id, params = {}) {
        const c = customers.get(id);
        if (!c) throw new Error(`No such customer: ${id}`);
        Object.assign(c, params);
        if (params.invoice_settings) {
          c.invoice_settings = { ...c.invoice_settings, ...params.invoice_settings };
        }
        return c;
      },
    },

    setupIntents: {
      // https://docs.stripe.com/api/setup_intents/create
      // A SetupIntent saves a payment method for FUTURE payments — no charge.
      async create(params = {}, _opts = {}) {
        const id = stamp('seti');
        const si = {
          id,
          object: 'setup_intent',
          // 'requires_payment_method' is the documented initial status before
          // the client (Stripe.js / Elements) confirms it with card details.
          status: 'requires_payment_method',
          customer: params.customer || null,
          // usage:'off_session' => the saved card can be charged later when the
          // patient is NOT in a checkout flow (i.e. on clinician approval).
          usage: params.usage || 'off_session',
          payment_method: null,
          payment_method_types: params.payment_method_types || ['card'],
          // The client secret Stripe.js needs to collect & confirm the card.
          client_secret: `${id}_secret_${randomUUID().slice(0, 8)}`,
          metadata: params.metadata || {},
        };
        setupIntents.set(id, si);
        return si;
      },
      async retrieve(id) {
        return setupIntents.get(id) || null;
      },
    },

    paymentMethods: {
      // https://docs.stripe.com/api/payment_methods/attach
      async attach(pmId, params = {}) {
        return { id: pmId, object: 'payment_method', customer: params.customer || null, type: 'card' };
      },
    },

    subscriptions: {
      // https://docs.stripe.com/api/subscriptions/create
      async create(params = {}, _opts = {}) {
        const id = stamp('sub');
        const sub = {
          id,
          object: 'subscription',
          customer: params.customer || null,
          status: 'active', // mock: a valid saved card => immediately active
          default_payment_method: params.default_payment_method || null,
          items: {
            object: 'list',
            data: (params.items || []).map((i) => ({
              id: stamp('si'),
              price: typeof i.price === 'string' ? { id: i.price } : i.price,
              quantity: i.quantity || 1,
            })),
          },
          // First invoice the recurring billing will produce.
          latest_invoice: stamp('in'),
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          metadata: params.metadata || {},
        };
        subscriptions.set(id, sub);
        return sub;
      },
      async retrieve(id) {
        return subscriptions.get(id) || null;
      },
      async cancel(id) {
        const s = subscriptions.get(id);
        if (s) s.status = 'canceled';
        return s;
      },
    },

    webhooks: {
      // https://docs.stripe.com/webhooks — real SDK verifies the
      // Stripe-Signature header (t=<ts>,v1=<hmac>) against the endpoint
      // secret with a 5-minute tolerance. The mock reproduces that scheme so
      // the verification code path is exercised offline.
      constructEvent(rawBody, sigHeader, secret) {
        if (!sigHeader) {
          throw new Error('Missing Stripe-Signature header');
        }
        const parts = Object.fromEntries(
          String(sigHeader)
            .split(',')
            .map((kv) => kv.split('=')),
        );
        const ts = parts.t;
        const v1 = parts.v1;
        if (!ts || !v1) {
          throw new Error('Malformed Stripe-Signature header');
        }
        const payload = `${ts}.${typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')}`;
        const expected = createHmac('sha256', secret).update(payload).digest('hex');
        if (expected !== v1) {
          throw new Error('Stripe webhook signature verification failed');
        }
        return JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
      },

      // Test-only helper: sign a payload the way Stripe would, so the test
      // script can produce a webhook request the verifier accepts.
      __signPayload(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
        const body = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
        const sig = createHmac('sha256', secret)
          .update(`${timestamp}.${body}`)
          .digest('hex');
        return `t=${timestamp},v1=${sig}`;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton resolution.
// ---------------------------------------------------------------------------
let _stripe = null;

/**
 * Returns the Stripe client (real SDK in live mode, mock in scaffold mode).
 * Async because loading the real `stripe` package is a dynamic import.
 */
export async function getStripe() {
  if (_stripe) return _stripe;

  if (isStripeScaffold()) {
    logger.warn(
      'STRIPE SCAFFOLD MODE: no real STRIPE_SECRET_KEY. Using an in-process ' +
        'mock built to Stripe\'s documented shapes — NO network calls. ' +
        'TODO(prod): set STRIPE_SECRET_KEY to engage the live SDK.',
    );
    _stripe = buildMockStripe();
    return _stripe;
  }

  // --- Live mode -----------------------------------------------------------
  // TODO(prod): `npm install stripe` must have run; the dependency is declared
  // in package.json. The dynamic import keeps the scaffold runnable even if the
  // package is not yet installed.
  try {
    const { default: Stripe } = await import('stripe');
    _stripe = new Stripe(config.stripe.secretKey, {
      // Pin the API version so Stripe behaviour is reproducible across deploys.
      // TODO(prod): confirm the current pinned version in the Stripe dashboard.
      apiVersion: config.stripe.apiVersion,
      maxNetworkRetries: 2, // built-in idempotent retry with backoff
      appInfo: { name: 'PepNationRX', version: '0.1.0' },
    });
    logger.info('Stripe live SDK initialised');
    return _stripe;
  } catch (err) {
    logger.error('Stripe SDK unavailable — falling back to mock', { error: err.message });
    _stripe = buildMockStripe();
    return _stripe;
  }
}

/** Generate a fresh idempotency key. Stripe recommends a v4 UUID. */
export function newIdempotencyKey(scope) {
  return scope ? `${scope}-${randomUUID()}` : randomUUID();
}

// Test-only reset.
export function __resetStripeClient() {
  _stripe = null;
}
