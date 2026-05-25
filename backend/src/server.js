// src/server.js
// PepNationRX backend — Express entry point.
// Mounts routes, wires the error handler, and starts the HTTP server.
import express from 'express';
import { config, isScaffoldMode } from './config.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authRoutes } from './routes/authRoutes.js';
import { intakeRoutes } from './routes/intakeRoutes.js';
import { orderRoutes } from './routes/orderRoutes.js';
import { webhookRoutes } from './routes/webhookRoutes.js';
import { stripeWebhookRoutes } from './routes/stripeWebhookRoutes.js';

const app = express();

// --- Stripe webhook — MUST be mounted BEFORE express.json() ----------------
// Stripe signature verification requires the UNMODIFIED raw request body
// (https://docs.stripe.com/webhooks). stripeWebhookRoutes attaches its own
// express.raw() parser to POST /webhooks/stripe, so it has to see the request
// before the global JSON body-parser consumes the stream.
app.use('/webhooks', stripeWebhookRoutes);

// Parse JSON bodies for every other route.
app.use(express.json({ limit: '256kb' }));

// Health check.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', scaffoldMode: isScaffoldMode() });
});

// Patient account / authentication API.
app.use('/api', authRoutes);

// Patient-facing API.
app.use('/api', intakeRoutes);
app.use('/api', orderRoutes);

// Inbound vendor webhooks.
app.use('/webhooks', webhookRoutes);

// 404 fallback.
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// Central error handler — must be last.
app.use(errorHandler);

// Only auto-start the HTTP listener when run as the main entry point.
// Test scripts (e.g. scripts/test-auth.js) import `app` and start their own
// listener on an ephemeral port, so importing this module must not bind 3000.
let server = null;
if (process.env.PNRX_NO_LISTEN !== '1') {
  server = app.listen(config.port, () => {
    logger.info(`PepNationRX backend listening on port ${config.port}`);
    if (isScaffoldMode()) {
      logger.warn(
        'SCAFFOLD MODE: vendor credentials are placeholders. ' +
          'Network calls to SteadyMD / Empower / Hallandale are stubbed. ' +
          'Replace .env values and resolve TODO(onboarding) markers before go-live.',
      );
    }
  });

  // Graceful shutdown.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      logger.info(`${signal} received — shutting down`);
      server.close(() => process.exit(0));
    });
  }
}

export { app, server };
