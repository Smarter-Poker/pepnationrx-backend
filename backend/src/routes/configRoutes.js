// src/routes/configRoutes.js
// Small public-config + health endpoints used by the frontend to:
//   * detect a reachable backend (`/api/health`); when this fails the static
//     site falls back to its mocked behavior so pepnationrx.com keeps working
//     even when no backend is deployed.
//   * mount Stripe Elements with the right publishable key.
import { Router } from 'express';
import { config } from '../config.js';

export const configRoutes = Router();

/**
 * GET /api/health
 * Tiny no-PII endpoint. The frontend hits this on every page that wires up
 * live behavior; if it 200s the page upgrades from mock to live mode.
 */
configRoutes.get('/health', (_req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'development' });
});

/**
 * GET /api/config/stripe
 * Returns the publishable key (pk_test_... / pk_live_...) so the frontend
 * can initialise Stripe.js. Returns `null` when no key is configured — the
 * frontend then runs the intake in "card capture deferred" dev mode and
 * marks the order needs_pm_capture = true.
 */
configRoutes.get('/config/stripe', (_req, res) => {
  const raw = config.stripe.publishableKey;
  const valid =
    typeof raw === 'string' &&
    raw !== '' &&
    raw !== 'REPLACE_AT_ONBOARDING' &&
    /^pk_(test|live)_/.test(raw);
  res.json({ publishableKey: valid ? raw : null });
});
