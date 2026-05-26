// src/server.js
// PepNationRX backend — Express entry point.
// Mounts routes, wires the error handler, and starts the HTTP server.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, isScaffoldMode } from './config.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authRoutes } from './routes/authRoutes.js';
import { intakeRoutes } from './routes/intakeRoutes.js';
import { orderRoutes } from './routes/orderRoutes.js';
import { webhookRoutes } from './routes/webhookRoutes.js';
import { stripeWebhookRoutes } from './routes/stripeWebhookRoutes.js';
import { configRoutes } from './routes/configRoutes.js';
import { billingRoutes } from './routes/billingRoutes.js';

const app = express();
app.set('trust proxy', 1); // honour X-Forwarded-* in front of a reverse proxy

// --- Stripe webhook — MUST be mounted BEFORE express.json() ----------------
// Stripe signature verification requires the UNMODIFIED raw request body
// (https://docs.stripe.com/webhooks). stripeWebhookRoutes attaches its own
// express.raw() parser to POST /webhooks/stripe, so it has to see the request
// before the global JSON body-parser consumes the stream.
app.use('/webhooks', stripeWebhookRoutes);

// Parse JSON bodies for every other route.
app.use(express.json({ limit: '256kb' }));

// --- Optional CORS (only when explicitly enabled) --------------------------
// Not needed in the default same-origin dev setup. If you ever serve the
// frontend from a separate origin (e.g. a Vite dev server on :5173), enable
// it by setting PNRX_CORS_ORIGIN=http://localhost:5173.
const corsOrigin = process.env.PNRX_CORS_ORIGIN;
if (corsOrigin) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        req.headers['access-control-request-headers'] || 'content-type',
      );
      return res.status(204).end();
    }
    next();
  });
  logger.info(`CORS enabled for origin: ${corsOrigin}`);
}

// Legacy health check (kept for compatibility with older test scripts).
app.get('/health', (req, res) => {
  res.json({ status: 'ok', scaffoldMode: isScaffoldMode() });
});

// Public config + health probe used by the frontend to detect a live backend.
app.use('/api', configRoutes);

// Patient account / authentication API.
app.use('/api', authRoutes);

// Patient-facing API.
app.use('/api', intakeRoutes);
app.use('/api', orderRoutes);
app.use('/api', billingRoutes);

// Inbound vendor webhooks.
app.use('/webhooks', webhookRoutes);

// --- Static site (dev / single-port mode) ---------------------------------
// Serves the marketing/static site from `site/` so `npm run dev` boots a
// SINGLE server that hosts both the API and the HTML pages on the same
// origin. Disabled by default; enable via SERVE_STATIC=true (the
// `npm run dev` script sets this).
if (
  process.env.SERVE_STATIC === 'true' ||
  (process.env.NODE_ENV === 'development' && process.env.SERVE_STATIC !== 'false')
) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const staticDir = path.resolve(
    __dirname,
    '..',
    process.env.STATIC_DIR || '../site',
  );
  // Clean URLs (Vercel-equivalent): /intake -> /intake.html, etc.
  const CLEAN_PAGES = [
    '/intake', '/signin', '/dashboard', '/browse', '/product', '/legal',
    '/privacy', '/terms', '/telehealth-consent',
    '/notice-of-privacy-practices',
  ];
  app.get(CLEAN_PAGES, (req, res, next) => {
    res.sendFile(path.join(staticDir, req.path.slice(1) + '.html'), (err) => {
      if (err) next();
    });
  });
  app.use(express.static(staticDir, { extensions: ['html'] }));
  logger.info(`Serving static site from ${staticDir}`);
}

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
