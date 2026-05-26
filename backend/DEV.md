# PepNationRX — Local Dev Story

One backend process serves the API **and** the static site (`/site`) on the
same port, so the whole flow works on your laptop with **no CORS dance**.

## 1. Prerequisites

- Node.js **>= 18** (tested on v20 and v22)
- The two sibling folders:
  ```
  pepnationrx/
    backend/   ← this repo
    site/      ← the static frontend (also in repo: Smarter-Poker/pepnationrx-site)
  ```

## 2. Install + configure

```bash
cd backend
npm install
cp .env.example .env
# Edit .env if you want a real STRIPE_PUBLISHABLE_KEY (pk_test_...). With no
# key, the intake flow completes without Stripe Elements and the order is
# marked needs_pm_capture = true (the dashboard surfaces this).
```

## 3. Run

```bash
npm run dev
```

That single command boots the server on **http://localhost:3000** with:

| Path | What it serves |
|---|---|
| `/`             | static homepage (`site/index.html`) |
| `/intake`       | dynamic 13-step intake |
| `/signin`       | sign-in / register card |
| `/dashboard`    | post-login dashboard |
| `/api/health`   | `{ ok: true, env: ... }` (used for backend detection) |
| `/api/auth/*`   | register / login / me / logout / password reset |
| `/api/intake/*` | questionnaire definition + intake submit |
| `/api/orders/*` | `/orders/me`, `/orders/:id` |
| `/api/billing/*`| `/setup-intent`, `/payment-method` |
| `/api/config/stripe` | `{ publishableKey }` |

## 4. Happy-path walkthrough

1. Open `http://localhost:3000/`.
2. Click **Sign in** → **Create an account**. Fill in any email +
   password (≥ 8 chars). You're auto-logged-in and forwarded to `/intake`.
3. Walk the 13-step questionnaire. Choose a program (e.g. *Weight
   management*) and answer each step.
4. On the final step:
   - if `STRIPE_PUBLISHABLE_KEY` is set, you'll see the Stripe Elements card
     step — confirm the card to save it (no charge).
   - if it's not set (default), the intake completes and the order is
     marked `needs_pm_capture = true`.
5. The success panel links to `/dashboard`, which now shows your real
   order (state: *Awaiting clinician review*).

## 5. Backend-only mode

If you want to run only the API (e.g. you serve the site from a Vite dev
server on a different port):

```bash
npm run dev:api-only
PNRX_CORS_ORIGIN=http://localhost:5173 npm run dev:api-only   # enables CORS
```

## 6. Run the tests

```bash
npm test                # 58 checks across intake, auth, stripe
```

## 7. Production posture (not weakened by dev)

- `NODE_ENV=production` switches the session cookie to **SameSite=Strict +
  Secure**. In dev (this guide) the cookie is **SameSite=Lax** so localhost
  flows aren't blocked. Prod stays Strict — see
  `src/services/authService.js:sessionCookieOptions`.
- Stripe is in **scaffold mode** until `STRIPE_SECRET_KEY` starts with
  `sk_` (then the live SDK engages — see
  `src/clients/stripeClient.js:isStripeScaffold`).
- Replace the in-memory stores (`patientService.js`, `orderService.js`,
  `stripeService.js`) with a HIPAA-eligible DB before go-live. The swap-in
  points are tagged `TODO(prod):`.
