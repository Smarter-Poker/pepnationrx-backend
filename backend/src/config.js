// src/config.js
// Loads and validates environment variables. Imported by server.js and all vendor clients.
import dotenv from 'dotenv';

dotenv.config();

/**
 * Read an env var, falling back to a placeholder so the scaffold boots
 * even before onboarding credentials exist.
 */
function env(key, fallback = 'REPLACE_AT_ONBOARDING') {
  const value = process.env[key];
  if (value === undefined || value === '') {
    return fallback;
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT || 3000),

  steadymd: {
    baseUrl: env('STEADYMD_API_BASE_URL'),
    apiKey: env('STEADYMD_API_KEY'),
    webhookSecret: env('STEADYMD_WEBHOOK_SECRET'),
  },

  empower: {
    baseUrl: env('EMPOWER_API_BASE_URL'),
    apiKey: env('EMPOWER_API_KEY'),
    webhookSecret: env('EMPOWER_WEBHOOK_SECRET'),
  },

  hallandale: {
    baseUrl: env('HALLANDALE_API_BASE_URL'),
    apiKey: env('HALLANDALE_API_KEY'),
    webhookSecret: env('HALLANDALE_WEBHOOK_SECRET'),
  },

  databaseUrl: env('DATABASE_URL'),

  // --- Payments (Stripe) ---------------------------------------------------
  // TODO(prod): there is no real Stripe account yet. All four values below are
  // placeholders. Obtain them from the Stripe dashboard before go-live:
  //   secretKey      — the API secret key (sk_live_... / sk_test_...).
  //   webhookSecret  — the signing secret for the /webhooks/stripe endpoint
  //                    (whsec_...); used to verify the Stripe-Signature header.
  //   publishableKey — the publishable key (pk_live_... / pk_test_...); shipped
  //                    to the browser so Stripe.js/Elements can collect a card.
  // When `secretKey` is a real `sk_` value the live Stripe SDK engages; until
  // then the backend uses an in-process mock built to Stripe's documented
  // shapes (see src/clients/stripeClient.js).
  stripe: {
    secretKey: env('STRIPE_SECRET_KEY'),
    webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
    publishableKey: env('STRIPE_PUBLISHABLE_KEY'),
    // Pin the Stripe API version for reproducible behaviour across deploys.
    // TODO(prod): confirm the current version shown in the Stripe dashboard.
    apiVersion: env('STRIPE_API_VERSION', '2025-03-31.basil'),
  },
  // Back-compat alias — earlier scaffold code referenced config.stripeSecretKey.
  stripeSecretKey: env('STRIPE_SECRET_KEY'),

  // --- Authentication ------------------------------------------------------
  // TODO(prod): SESSION_COOKIE_SECRET must be a long, random value loaded
  // from a secrets manager (not committed, not the placeholder below). It
  // signs the session cookie; rotating it invalidates all live sessions.
  auth: {
    cookieSecret: env('SESSION_COOKIE_SECRET'),
    cookieName: 'pnrx_session',
    // Sliding inactivity timeout — HIPAA requires automatic logoff. The
    // session is also capped by an absolute lifetime (see authService.js).
    idleTimeoutMs: Number(process.env.SESSION_IDLE_TIMEOUT_MS || 30 * 60 * 1000), // 30 min
    absoluteTimeoutMs: Number(
      process.env.SESSION_ABSOLUTE_TIMEOUT_MS || 12 * 60 * 60 * 1000, // 12 h
    ),
    // Set Secure cookie flag off only for local HTTP dev.
    cookieSecure: process.env.NODE_ENV === 'production',
    // Brute-force protection.
    maxFailedLogins: Number(process.env.AUTH_MAX_FAILED_LOGINS || 5),
    lockoutMs: Number(process.env.AUTH_LOCKOUT_MS || 15 * 60 * 1000), // 15 min
    // Reset / verification token lifetimes.
    resetTokenTtlMs: Number(process.env.AUTH_RESET_TTL_MS || 15 * 60 * 1000), // 15 min
    verifyTokenTtlMs: Number(process.env.AUTH_VERIFY_TTL_MS || 24 * 60 * 60 * 1000), // 24 h
  },
};

/**
 * Returns true when every credential is still a placeholder.
 * Used to log a loud warning that the backend is running in scaffold mode.
 */
export function isScaffoldMode() {
  const creds = [
    config.steadymd.apiKey,
    config.empower.apiKey,
    config.hallandale.apiKey,
  ];
  return creds.every((c) => c === 'REPLACE_AT_ONBOARDING');
}
