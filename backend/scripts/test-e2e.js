// scripts/test-e2e.js
// End-to-end smoke test that boots `npm run dev`, walks the full happy
// path (register -> intake -> dashboard) with a headless browser, then
// kills the server cleanly. Exits 0 on success.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_DIR = path.resolve(__dirname, '..');

const PORT = process.env.PORT || '4566';
const BASE = `http://127.0.0.1:${PORT}`;

const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ||
  '/sessions/bold-sleepy-gates/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.mjs';
const CHROMIUM =
  process.env.CHROMIUM ||
  '/sessions/bold-sleepy-gates/.cache/ms-playwright/chromium_headless_shell-1223/chrome-linux/headless_shell';

let server = null;
let exitCode = 1;

function log(...args) { console.log('[e2e]', ...args); }

async function waitForHealth(maxMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Backend did not become healthy in time');
}

async function startServer() {
  log(`spawning server on port ${PORT}`);
  server = spawn('node', ['src/server.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, NODE_ENV: 'development', SERVE_STATIC: 'true', PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));
  await waitForHealth();
  log('backend healthy');
}

function stopServer() {
  if (!server) return Promise.resolve();
  try { server.kill('SIGTERM'); } catch (e) {}
  return sleep(250);
}

async function run() {
  const { chromium } = await import(PLAYWRIGHT_CORE);
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });

  const email = `e2e+${Date.now()}@pnrx.test`;
  const password = 'TestPass-1234';

  // ---- 1. Visit the homepage -------------------------------------------
  log('open homepage');
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  // The homepage is unwired; api.js is only loaded on signin/intake/dashboard.

  // ---- 2. Register a new account ---------------------------------------
  log('register a new account', email);
  await page.goto(`${BASE}/signin?mode=register`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.pnrx && window.pnrx.backend === true, null, { timeout: 5000 });
  await page.fill('#auth-email', email);
  await page.fill('#auth-pw', password);
  await Promise.all([
    page.waitForURL(/\/intake/, { timeout: 10000 }),
    page.click('#auth-submit'),
  ]);
  log('registration complete; on intake page');

  // ---- 3. Confirm session via /api/auth/me -----------------------------
  const meResp = await page.evaluate(async () => {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  if (meResp.status !== 200) throw new Error(`auth/me expected 200, got ${meResp.status}`);
  log('me ok:', meResp.body && meResp.body.patient && meResp.body.patient.email);

  // ---- 4. Submit a happy-path intake via the live API ------------------
  // (The 13-step renderer has its own unit tests + visual audit; what we
  // need here is the contract: a real authenticated POST that produces a
  // real order the dashboard then renders.)
  log('post a happy-path intake');
  const intake = await page.evaluate(async () => {
    const dob = new Date(new Date().getFullYear() - 35, 0, 1).toISOString().slice(0, 10);
    const answers = {
      // step 1 — biological sex
      sex_at_birth: 'male',
      // step 2 — program
      program: 'weight_management',
      program_goal: 'lose_weight',
      // step 3 — identity & contact
      legal_first_name: 'E2E',
      legal_last_name: 'Tester',
      date_of_birth: dob,
      email: 'e2e+intake@pnrx.test',
      phone: '+15555550123',
      // step 4 — location
      state_of_care: 'CA',
      shipping_address_line1: '123 Test St',
      shipping_city: 'San Francisco',
      shipping_zip: '94105',
      // step 5 — vitals
      height_inches: 70,
      weight_lbs: 230,
      goal_weight_lbs: 200,
      bmi_acknowledgement: true,
      // step 6 — medical history
      conditions: ['none'],
      mtc_men2_history: 'no',
      // step 7 — medications & allergies
      takes_medications: false,
      has_allergies: false,
      glp1_allergy: 'never_taken',
      // step 9 — condition specific (weight management)
      wm_diabetic_retinopathy: false,
      // step 10 — prior treatment
      used_before: false,
      // step 11 — pharmacy preferences
      shipping_speed: 'standard',
      temperature_sensitive_ack: true,
      // step 12 — id verification (the validator requires the field present)
      gov_id_upload: 'uploaded:gov_id.png',
      selfie_upload: 'uploaded:selfie.png',
      id_name_matches: true,
      // step 13 — consents
      telehealth_consent: true,
      compounded_med_consent: true,
      accuracy_attestation: true,
      privacy_consent: true,
    };
    const payload = {
      program: 'weight_management',
      productIds: ['glp1-semaglutide'],
      answers,
      patient: { firstName: 'E2E', lastName: 'Tester', email: 'e2e+intake@pnrx.test', dateOfBirth: dob },
      questionnaireVersion: '1.0.0',
    };
    const r = await fetch('/api/intake', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json() };
  });
  log('intake response:', intake.status, intake.body && intake.body.message);
  if (intake.status >= 400) throw new Error(`intake failed: ${JSON.stringify(intake.body)}`);

  // No publishable key configured -> SetupIntent step is skipped on the
  // frontend; the order is recorded and the dashboard should show it.

  // ---- 5. Visit the dashboard and confirm orders render ----------------
  log('open dashboard');
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => /Welcome back/i.test(document.body.innerText) &&
          /Awaiting clinician review|Latest order/i.test(document.body.innerText),
    null, { timeout: 8000 },
  );
  log('dashboard shows the new order');

  // ---- 6. Sign out and confirm /api/auth/me returns 401 ----------------
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }));
  const meAfter = await page.evaluate(async () => {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    return r.status;
  });
  if (meAfter !== 401) throw new Error(`auth/me after logout expected 401, got ${meAfter}`);

  await browser.close();

  if (errors.length) {
    log('non-fatal page errors observed:');
    errors.slice(0, 10).forEach((e) => log(' •', e));
  }
  log('PASS — full happy-path verified');
  exitCode = 0;
}

(async () => {
  try {
    await startServer();
    await run();
  } catch (err) {
    console.error('[e2e] FAIL:', err && err.stack || err);
  } finally {
    await stopServer();
    process.exit(exitCode);
  }
})();
