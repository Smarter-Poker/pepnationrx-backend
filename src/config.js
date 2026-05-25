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
  stripeSecretKey: env('STRIPE_SECRET_KEY'),
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
