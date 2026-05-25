// scripts/test-auth.js
// Runnable end-to-end exercise of the patient account / authentication layer.
//
// Run:  node scripts/test-auth.js   (or: npm run test:auth)
//
// It boots the real Express app on an ephemeral port and drives the HTTP API
// with fetch — the same path a browser would take — proving:
//   register -> login -> access a protected route -> logout works,
// plus a rejected bad-password case, the unauthenticated 401, the no-user-
// enumeration behaviour, and the password-reset flow.
//
// No real network calls leave the process; vendor clients are stubbed and the
// stores are in-memory.
import { app } from '../src/server.js';

function hr(label) {
  console.log('\n' + '='.repeat(72));
  console.log(label);
  console.log('='.repeat(72));
}

// --- Tiny test harness -----------------------------------------------------
const checks = [];
function check(label, ok) {
  checks.push([label, !!ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

// Pull a Set-Cookie header into a `name=value` Cookie string.
function cookieFrom(res) {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return null;
  return setCookie.split(';')[0]; // first pair = pnrx_session=...
}

async function main() {
  // Boot the app on an ephemeral port.
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = (path, body, cookie) =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body || {}),
    });
  const get = (path, cookie) =>
    fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });

  const email = `testpatient+${Date.now()}@example.com`;
  const password = 'Str0ng-Passphrase!';
  const wrongPassword = 'definitely-the-wrong-one-1';

  try {
    // --- 1. Register -------------------------------------------------------
    hr('STEP 1 — POST /api/auth/register');
    const reg = await post('/api/auth/register', { email, password });
    const regBody = await reg.json();
    console.log('  status:', reg.status, '-', regBody.message);
    check('register returns 201', reg.status === 201);

    // Weak password is rejected.
    const weak = await post('/api/auth/register', {
      email: `weak+${Date.now()}@example.com`,
      password: 'short',
    });
    check('weak password rejected (422)', weak.status === 422);

    // --- 2. Login with the WRONG password (must be rejected) ---------------
    hr('STEP 2 — POST /api/auth/login  (wrong password — must reject)');
    const badLogin = await post('/api/auth/login', { email, password: wrongPassword });
    const badBody = await badLogin.json();
    console.log('  status:', badLogin.status, '-', badBody.error);
    check('bad password rejected (401)', badLogin.status === 401);
    check('bad-password error is generic', badBody.error === 'Invalid email or password');
    check('no session cookie issued on bad login', cookieFrom(badLogin) === null);

    // Unknown account returns the SAME generic error (no enumeration).
    const unknown = await post('/api/auth/login', {
      email: 'nobody-here@example.com',
      password,
    });
    const unknownBody = await unknown.json();
    check(
      'unknown account gives identical generic error',
      unknown.status === 401 && unknownBody.error === 'Invalid email or password',
    );

    // --- 3. Login with the CORRECT password --------------------------------
    hr('STEP 3 — POST /api/auth/login  (correct password)');
    const login = await post('/api/auth/login', { email, password });
    const loginBody = await login.json();
    const cookie = cookieFrom(login);
    console.log('  status:', login.status, '-', loginBody.message);
    console.log('  patientId:', loginBody.patient?.patientId);
    check('login returns 200', login.status === 200);
    check('login issues a session cookie', !!cookie);
    check(
      'session cookie is httpOnly',
      /httponly/i.test(login.headers.get('set-cookie') || ''),
    );
    check(
      'session cookie is SameSite=Strict',
      /samesite=strict/i.test(login.headers.get('set-cookie') || ''),
    );
    check('login response carries no password hash', !JSON.stringify(loginBody).includes('argon2'));

    // --- 4. Access a PROTECTED route ---------------------------------------
    hr('STEP 4 — GET /api/auth/me  (protected route)');
    // Without the cookie -> 401.
    const meAnon = await get('/api/auth/me');
    check('protected route rejects anonymous (401)', meAnon.status === 401);

    // With the cookie -> 200.
    const me = await get('/api/auth/me', cookie);
    const meBody = await me.json();
    console.log('  status:', me.status, '- patient:', meBody.patient?.email);
    check('protected route allows the session (200)', me.status === 200);
    check('protected route returns the right patient', meBody.patient?.email === email);

    // Order route is also protected.
    const orderAnon = await get('/api/orders/some-id');
    check('GET /api/orders/:id rejects anonymous (401)', orderAnon.status === 401);

    // --- 5. Logout ---------------------------------------------------------
    hr('STEP 5 — POST /api/auth/logout');
    const logout = await post('/api/auth/logout', {}, cookie);
    console.log('  status:', logout.status);
    check('logout returns 200', logout.status === 200);

    // The session is dead — the old cookie no longer works.
    const meAfter = await get('/api/auth/me', cookie);
    check('session invalid after logout (401)', meAfter.status === 401);

    // --- 6. Password-reset flow -------------------------------------------
    hr('STEP 6 — password reset (forgot -> reset)');
    const forgot = await post('/api/auth/password/forgot', { email });
    check('forgot-password returns 200 generic', forgot.status === 200);
    const forgotUnknown = await post('/api/auth/password/forgot', {
      email: 'nobody-here@example.com',
    });
    const fb1 = await forgot.json();
    const fb2 = await forgotUnknown.json();
    check('forgot-password gives identical response for unknown email', fb1.message === fb2.message);

    // Reset with a bogus token must fail.
    const badReset = await post('/api/auth/password/reset', {
      token: 'not-a-real-token',
      password: 'An0ther-Strong-Pass!',
    });
    check('reset with bad token rejected (400)', badReset.status === 400);

    console.log('\n  (a valid reset requires the emailed token — see EMAIL_STUB');
    console.log('   log lines above; the raw token is never returned in an API response.)');
  } finally {
    server.close();
  }

  // --- Results -------------------------------------------------------------
  hr('RESULTS');
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed.`);
  if (passed !== checks.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('test-auth.js failed:', err);
  process.exitCode = 1;
});
