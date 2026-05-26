# PepNationRX Backend

Scaffolded Node.js backend for **PepNationRX**, a telehealth MSO (Management
Services Organization) platform. It coordinates a patient intake -> clinician
review -> compounding pharmacy fulfillment pipeline across three external
vendors.

> **Status: working scaffold.** All three vendor integrations are built to
> *described* behavior with **placeholder credentials**. Every place that needs
> reconciliation with real vendor documentation is marked with:
>
> ```js
> // TODO(onboarding): reconcile with real <vendor> API spec
> ```

---

## The three vendors

| Vendor                | Role                                   | Integration |
|-----------------------|----------------------------------------|-------------|
| **SteadyMD**          | Clinical API — async clinician review  | Submit intake; receive approve/decline webhook |
| **Empower Pharmacy**  | Compounding pharmacy (REST/JSON)       | Receive Rx; DTP ship; tracking webhook |
| **Hallandale Pharmacy** | Compounding pharmacy (LifeFile-based) | Receive Rx; DTP ship; tracking webhook |

---

## Architecture / end-to-end flow

```
  Patient
    |
    |  POST /api/intake   (validate payload)
    v
  Order(INTAKE_SUBMITTED) ──► steadymdClient.submitIntake() ──► SteadyMD
    |                                                            |
  Order(CLINICIAN_REVIEW)                          clinician reviews async
    |                                                            |
    |  POST /webhooks/steadymd  ◄────────────────────────────────┘
    v
  decision?
    ├─ declined ─► Order(DECLINED)
    └─ approved ─► Order(APPROVED)
                     |
                     |  pharmacyRouter: GLP-1 -> Hallandale, else -> Empower
                     v
              empowerClient / hallandaleClient .submitPrescription()
                     |
              Order(ROUTED_TO_PHARMACY)
                     |
    POST /webhooks/empower | /webhooks/hallandale
                     v
       Order: COMPOUNDING ─► SHIPPED (capture tracking #) ─► DELIVERED
                     |
       GET /api/orders/:id  ◄── patient dashboard reads state + tracking
```

### Order lifecycle state machine

```
DRAFT → INTAKE_SUBMITTED → CLINICIAN_REVIEW → (APPROVED | DECLINED)
        → ROUTED_TO_PHARMACY → COMPOUNDING → SHIPPED → DELIVERED

Plus CANCELLED and ON_HOLD (reachable from any non-terminal state).
```

Transitions are enforced in `src/services/orderService.js`; invalid jumps
return HTTP 409.

---

## Conditional pharmacy routing

Core business rule (`src/services/pharmacyRouter.js` + `src/data/catalog.js`):

| Product category                                                   | Routed to            |
|---------------------------------------------------------------------|----------------------|
| GLP-1 / weight-loss — Semaglutide, Tirzepatide, Liraglutide, Exenatide | **Hallandale Pharmacy** |
| Peptides — PT-141, AOD9604, BPC-157, TB-500, GHK-Cu, Ipamorelin     | **Empower Pharmacy** |
| Hormone / growth-axis — Sermorelin, CJC-1295, Tesamorelin, Oxytocin | **Empower Pharmacy** |
| Amino-acid stacks — GAC blend, LIPO-C, Glutathione, Amino blend     | **Empower Pharmacy** |
| Longevity / wellness — NAD+, Methylene Blue, B12                    | **Empower Pharmacy** |

Rule of thumb: **GLP-1 -> Hallandale, everything else -> Empower.**

---

## API surface

| Method | Path                          | Auth | Purpose |
|--------|-------------------------------|------|---------|
| POST   | `/api/auth/register`          | —    | Create a patient account; sends an email-verification link |
| POST   | `/api/auth/login`             | —    | Verify password; issue a session cookie |
| POST   | `/api/auth/logout`            | —    | Destroy the session |
| GET    | `/api/auth/me`                | yes  | Current authenticated patient |
| POST   | `/api/auth/verify-email`      | —    | Confirm an email-verification token |
| POST   | `/api/auth/password/forgot`   | —    | Request a password-reset email |
| POST   | `/api/auth/password/reset`    | —    | Confirm a reset token + set a new password |
| GET    | `/api/intake/questionnaire`   | —    | The 13-step questionnaire definition (frontend renders the flow from this) |
| POST   | `/api/intake`                 | soft | Submit a completed 13-step intake; creates an order (associated with the patient when signed in) |
| GET    | `/api/orders/:id`             | yes  | Dashboard read: status + tracking (owner-only) |
| POST   | `/webhooks/steadymd`          | —    | Clinician decision (approved/declined) |
| POST   | `/webhooks/empower`           | —    | Empower fulfillment update + tracking |
| POST   | `/webhooks/hallandale`        | —    | Hallandale fulfillment update + tracking |
| POST   | `/webhooks/stripe`            | sig  | Stripe billing events (`invoice.paid`, `invoice.payment_failed`); Stripe-Signature verified |
| GET    | `/health`                     | —    | Liveness + scaffold-mode flag |

---

## Authentication

The patient account / auth layer (`src/services/patientService.js`,
`src/services/authService.js`, `src/routes/authRoutes.js`,
`src/middleware/requireAuth.js`, `src/lib/authAudit.js`) was built
**research-first** against current (2026) OWASP, NIST 800-63B, and HIPAA
guidance — see the design notes below.

### Design decisions (and why)

**Password hashing — argon2id, bcrypt fallback.**
OWASP's Password Storage Cheat Sheet names **argon2id** the gold standard:
memory-hard, resistant to GPU cracking and side-channel timing analysis. We use
the OWASP minimum parameters (19 MiB memory, 2 iterations, parallelism 1).
`bcrypt` (cost factor 12) is wired as a documented fallback for environments
without the argon2 native binding. The hash string is self-describing, so
`verifyPassword()` routes to the right algorithm automatically — which also
makes a future re-hash-on-login migration trivial.
*Scaffold note:* if neither native module is installed the layer degrades to a
Node `scrypt` fallback so the demo still runs; **install `argon2` before
production** (`npm install`).

**Sessions — signed httpOnly cookie over a server-side session, NOT a JWT.**
OWASP and Curity both caution that JWTs were not designed for session
management and using them as one can *lower* security. A patient portal touching
ePHI needs three things a stateless JWT cannot cleanly give: **immediate
revocation** (logout, password reset, lockout), a **true sliding inactivity
timeout**, and **zero PHI in anything handed to the client**. So we keep a
server-side session record (random id) and deliver only a signed session id in
a cookie. The cookie carries no patient data at all.

**Secure cookie flags.** The session cookie is `httpOnly` (not readable by JS —
mitigates XSS token theft), `Secure` (HTTPS-only; on in `NODE_ENV=production`),
and `SameSite=Strict` (mitigates CSRF). The cookie value is `sessionId.HMAC`,
so a tampered id is rejected by signature check before any store lookup.

**HIPAA considerations.**
- *Auditable auth events* — every register / login / login-failure / lockout /
  logout / password-reset / email-verify event is written to an audit trail
  (`src/lib/authAudit.js`) with who / when / from where. No PHI or secrets are
  ever logged.
- *Automatic logoff* — sessions enforce a **30-minute sliding inactivity
  timeout** and a **12-hour absolute cap**; both are configurable.
- *No PHI in tokens* — session cookies, verification tokens, and reset tokens
  contain only opaque random values.

**Email verification & password reset.** Tokens are cryptographically random
(32 bytes). The **raw** token is emailed; only its **SHA-256 hash** is stored.
Tokens are **single-use** (cleared on success) and **short-lived** (reset link
15 min, verification link 24 h). A new reset request invalidates the previous
token, and a completed reset **revokes every active session** for that patient.

**Brute-force / rate-limit protection.**
- *Per-account lockout* — 5 failed logins locks the account for 15 minutes.
- *Per-IP rate limit* — 20 login attempts per IP per 15-minute window (429).
- *No user enumeration* — register, login, and forgot-password return the same
  generic message whether or not the email exists, and login runs a decoy hash
  verify on unknown accounts so response timing does not leak existence.

### Production TODOs

Every secret / DB / email dependency is marked `// TODO(prod): ...`. Before
real patients:
- **`SESSION_COOKIE_SECRET`** — a long random value from a secrets manager (not
  the placeholder, not committed).
- **Persistence** — `patientService` and the session store are in-memory
  `Map`s; replace with a HIPAA-eligible DB (and a shared session store such as
  Redis) covered by a signed BAA.
- **Email** — `sendEmailStub()` only logs; integrate a HIPAA-eligible
  transactional email provider under a BAA.
- **`argon2`** — install the native module so hashing is not on the scrypt
  fallback.

### Try it

```bash
npm run test:auth   # boots the app, runs register -> login -> protected
                    # route -> logout end to end, plus a rejected
                    # bad-password case, the unauthenticated 401, the
                    # no-enumeration check, and the password-reset flow.
                    # `npm test` runs the intake suite + this auth suite.
```

---

## Payments (Stripe)

PepNationRX uses a **capture-now / charge-on-approval** billing model, built
research-first against current (2026) Stripe docs.

### The business rule

> A patient completes intake and is **NOT charged**. Billing begins **only when
> a clinician APPROVES** the treatment — at that point a recurring subscription
> for the chosen plan starts. If the clinician **declines**, the patient is
> **never charged**.

### How that maps to Stripe primitives (and why)

| Step | Stripe primitive | Why |
|------|------------------|-----|
| Patient submits intake / checks out | **SetupIntent** + **Customer** | A SetupIntent ([docs](https://docs.stripe.com/api/setup_intents)) *saves a card for future payments and creates NO charge*. We create-or-get a Stripe **Customer** linked to the patient record, then a SetupIntent with `usage: 'off_session'` so the saved card can be charged later when the patient is not present. |
| Clinician **approves** | **Subscription** | On the `APPROVED` transition we create a recurring **Subscription** ([docs](https://docs.stripe.com/api/subscriptions/create)) against the saved payment method. **This is the first time money moves.** |
| Clinician **declines** | *(nothing)* | No Subscription, no charge — the order is marked `NOT_BILLABLE`. |
| Recurring billing | **Webhooks** | `invoice.paid` / `invoice.payment_failed` ([docs](https://docs.stripe.com/billing/subscriptions/webhooks)) update billing state. The endpoint verifies the `Stripe-Signature` header ([docs](https://docs.stripe.com/webhooks)). |

Every Stripe `POST` is sent with an **idempotency key**
([docs](https://docs.stripe.com/api/idempotent_requests)) derived from a stable
id (`customer-<patientId>`, `setupintent-<orderId>`, `subscription-<orderId>`)
so a retry never creates duplicate Customers, SetupIntents, or Subscriptions.

### Where it lives

```
src/clients/stripeClient.js       Stripe SDK wrapper. Live SDK when a real sk_
                                  key is set; otherwise an in-process MOCK
                                  built to Stripe's documented shapes.
src/services/stripeService.js     Billing business layer — ensureStripeCustomer,
                                  capturePaymentMethod (SetupIntent),
                                  startSubscriptionOnApproval, markNotBillable,
                                  invoice.paid / payment_failed handlers.
src/data/billingPlans.js          Maps catalog categories -> Stripe Price IDs.
src/routes/stripeWebhookRoutes.js POST /webhooks/stripe (raw-body + signature).
```

Wiring: `POST /api/intake` (signed-in patient) -> `capturePaymentMethod()`
creates a SetupIntent. The orchestrator's `handleSteadyMDDecision()` calls
`startSubscriptionOnApproval()` on `APPROVED` and `markNotBillable()` on
`DECLINED` — billing is driven entirely off the existing order state machine.

### Scaffold mode — there is no real Stripe account yet

The integration cannot hit the real Stripe API (no account, no keys). When
`STRIPE_SECRET_KEY` is a placeholder, `stripeClient.js` resolves to an
**in-process mock** that mirrors Stripe's documented object shapes — no network
calls. Supplying a real `sk_` key engages the live Stripe SDK with **no code
change**.

### Production TODOs (`TODO(prod)`)

Search the codebase for `TODO(prod)`. The account-dependent items are:

- **`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PUBLISHABLE_KEY`** —
  placeholders in `.env.example`; copy real values from the Stripe dashboard.
- **`STRIPE_API_VERSION`** — confirm the current pinned version.
- **Stripe Price IDs** — `src/data/billingPlans.js` uses `price_PLACEHOLDER_*`
  values; create the real Products + recurring Prices in Stripe.
- **`npm install stripe`** — the dependency is declared in `package.json`;
  install it so live mode can load the SDK.
- **Persistence** — the billing store is an in-memory `Map`; replace with the
  HIPAA-eligible DB (Stripe itself is the system of record for card data — no
  card numbers ever touch this server).

### Try it

```bash
npm run test:stripe   # offline end-to-end proof against the Stripe mock:
                      #  - intake/checkout -> SetupIntent created, NO charge
                      #  - order APPROVED  -> Subscription created
                      #  - order DECLINED  -> NO subscription, NO charge
                      #  - idempotency, signed-webhook verification
                      # `npm test` runs the intake + auth + Stripe suites.
```

---

## The dynamic 13-step intake questionnaire

The patient intake is a **data-driven, dynamically branching 13-step clinical
flow**. The entire flow lives in `src/intake/` and is the single source of
truth for both the frontend renderer and the backend validator.

### The 13 steps

| # | Step | Notes |
|---|------|-------|
| 1 | Biological sex at birth | Drives the largest branch (pregnancy screening) |
| 2 | Program selection | Weight mgmt / TRT / peptide / sexual health / women's wellness / longevity — drives program branches |
| 3 | Identity & contact | Legal name, DOB (18+ enforced), email, phone |
| 4 | Location | State of care (clinician licensing) + shipping address |
| 5 | Vitals | Height / weight; BMI computed; goal weight for weight mgmt |
| 6 | Medical history | Conditions; MTC/MEN2 screen for GLP-1 |
| 7 | Medications & allergies | Med list, allergy list, GLP-1 hypersensitivity screen |
| 8 | Pregnancy & breastfeeding | **Conditional** — shown only for female / intersex sex at birth |
| 9 | Program-specific questions | Branches per selected program |
| 10 | Prior treatment history | Prior dose / side effects; GLP-1 titration |
| 11 | Pharmacy & shipping | Shipping speed, cold-chain acknowledgement |
| 12 | Identity verification | Government ID + selfie file-upload refs |
| 13 | Consents & attestations | Telehealth, compounded-med, accuracy, privacy |

### Dynamic branching

Branching is expressed as **data, not code**. Every step and question may carry
a `showIf` condition; `src/intake/conditions.js` is the one place that
interprets it. Conditions support `all` / `any` / `not`, answer matchers
(`equals`, `in`, `includes`, `isAnswered`), program matchers (`program`,
`programIn`), and derived checks (`isUnder18`, `bmiUnder`). Examples:

- The **pregnancy & breastfeeding** step shows only when `sex_at_birth` is
  `female` or `intersex`.
- **MTC/MEN2**, **GLP-1 allergy**, and **diabetic-retinopathy** questions show
  only for the weight-management program; **TRT symptom / prostate-history**
  questions only for TRT; and so on.

### Red-flag / contraindication screening

Certain questions carry a `redFlag` rule. If a visible red-flag question's
`when` condition matches, the intake is marked **ineligible** and is recorded
and **declined before it ever reaches a SteadyMD clinician** (e.g. patient is
pregnant on a GLP-1 program, history of MTC/MEN2, nitrate use with a
sexual-health request, BMI < 18.5 on weight management).

### Validation

`src/intake/validator.js` validates a submitted answer set against the
questionnaire — branch-aware (only visible questions are required/validated),
type-checked per question type, and red-flag screened. It extends the existing
zod approach; the outer envelope uses a zod schema and the dynamic clinical
content is validated against the questionnaire definition.

### Try it

```bash
npm test     # runs scripts/test-intake.js — submits 3 sample intakes
             # (weight-mgmt female w/ pregnancy branch, TRT male,
             #  and a pregnant-on-GLP-1 red-flag decline) and prints
             # the resulting SteadyMD payloads + a pass/fail summary
```

---

## SteadyMD submission payload

`src/intake/steadymdPayload.js` maps a validated intake into the request body
for submitting an **asynchronous visit** to SteadyMD.

### Researched against SteadyMD's public docs

SteadyMD's public docs (<https://docs.steadymd.com/>) describe the Partner API
as two sections:

- **EMR endpoints** — send patient + chart info: an **Episode of Care**, an
  **Intake Questionnaire** (the questionnaire, its potential answers, and the
  patient's responses), **Intake Observations** (structured clinical values),
  **Intake Files** (ID verification / supporting docs), and a **Preferred
  Pharmacy**.
- **Consult endpoints** — request clinician time. An **async consult** carries
  a `consult_type`, a Reason for Visit, the patient's location (State), and a
  link to the Episode of Care. Async consults have no direct patient/provider
  communication; the clinician reviews the intake and the decision returns
  asynchronously as a **Platform Event** (AWS SNS -> SQS/HTTPS).

The payload builder produces sub-payloads modelled on that documented
structure: `episodeOfCare` (patient + EMR intake), `consult` (the async
request), plus a flattened `legacyCase` shape and a `meta` block.

### Where the onboarding TODOs are

The **exact JSON field names** and the per-program **`consult_type`** values
are **not** in the public docs — the API Reference and the OpenAPI schema sit
behind a partner login, and SteadyMD assigns consult-type values per program
after the workflow is defined. Every field whose exact name/shape is not
confirmed is marked:

```js
// TODO(steadymd-onboarding): reconcile with real API docs
```

Search the codebase for `TODO(steadymd-onboarding)` to find every
reconciliation point (consult-type strings, EMR/Consult endpoint paths, auth
header, file-upload mechanism, observation code vocabulary, licensed-state
list).

### Wiring

`POST /api/intake` -> `orchestrator.handleIntakeV2()`:
**validate intake** (`validator.js`) -> red-flag gate -> **build SteadyMD
payload** (`steadymdPayload.js`) -> **submit async visit**
(`steadymdClient.submitAsyncVisit()` — EMR + Consult, stubbed).

---

## Setup

```bash
# 1. Install dependencies (Node 18+)
npm install

# 2. Create your env file from the template
cp .env.example .env
#    Every value is "REPLACE_AT_ONBOARDING" — the server still boots in
#    SCAFFOLD MODE so the flow is testable end-to-end.

# 3. Start the server
npm start          # or: npm run dev   (watch mode)
```

Then exercise the flow:

```bash
# Submit an intake
curl -X POST localhost:3000/api/intake -H 'Content-Type: application/json' -d '{
  "patient": { "firstName":"Jane","lastName":"Doe","dateOfBirth":"1990-01-01",
               "email":"jane@example.com","phone":"5550001111","sex":"female" },
  "stateOfResidence": "FL",
  "productIds": ["glp1-semaglutide"],
  "questionnaire": [{ "questionId":"q1","answer":"no" }],
  "consent": { "telehealthConsent": true, "compoundedMedConsent": true }
}'

# Simulate the SteadyMD approval webhook (use the orderId returned above)
curl -X POST localhost:3000/webhooks/steadymd -H 'Content-Type: application/json' \
  -d '{ "orderId":"<ORDER_ID>","decision":"approved" }'

# Simulate the pharmacy shipping webhook
curl -X POST localhost:3000/webhooks/hallandale -H 'Content-Type: application/json' \
  -d '{ "orderId":"<ORDER_ID>","event":"shipped","carrier":"FedEx","trackingNumber":"123" }'

# Read the order
curl localhost:3000/api/orders/<ORDER_ID>
```

---

## What is stubbed vs. real

**Real (works today):**
- Express server, routing, JSON parsing, error handling
- Intake validation (zod schema)
- Product catalog + conditional pharmacy router
- Order model + lifecycle state machine with valid-transition enforcement
- Orchestration wiring across intake -> SteadyMD -> pharmacy -> dashboard
- Webhook endpoints that advance order state

**Stubbed / placeholder (needs onboarding):**
- **Vendor network calls** — `steadymdClient`, `empowerClient`,
  `hallandaleClient` log a `STUB:` line and return placeholder responses
  instead of calling real APIs. Real `fetch()` code is commented in place.
- **Endpoint paths & payload shapes** — placeholders; real specs unknown
  until onboarding. Marked `TODO(onboarding)`.
- **Auth schemes** — Bearer tokens assumed; confirm per vendor.
- **Webhook signature verification** — `verifySignature()` is a stub; real
  HMAC/timing-safe verification must replace it before production.
- **Persistence** — `orderService` uses an in-memory `Map`. Replace with a
  real database (`DATABASE_URL`).
- **Payments** — fully wired (capture-now / charge-on-approval; see the
  **Payments (Stripe)** section). Runs against an in-process Stripe mock until
  a real `STRIPE_SECRET_KEY` is supplied — no real Stripe account exists yet.

Search the codebase for `TODO(onboarding)` to find every reconciliation point.

---

## HIPAA / compliance note

This backend handles **Protected Health Information (PHI)** — patient
demographics, clinical questionnaire answers, and prescription data.

**Before handling any real PHI:**
- The site and this backend MUST run on **HIPAA-eligible hosting**.
- **Signed Business Associate Agreements (BAAs)** must be in place with the
  hosting provider, the database provider, SteadyMD, Empower, Hallandale, and
  any other subprocessor that touches PHI.
- The in-memory store MUST be replaced with an encrypted, access-controlled,
  HIPAA-eligible database, and all vendor traffic must be over TLS with
  audited access logging.

Do not point this scaffold at real patients until those controls are live.

---

## Project layout

```
backend/
├── package.json
├── .env.example
├── .gitignore
├── README.md
└── src/
    ├── server.js              Express app + bootstrap
    ├── config.js              env loading + validation
    ├── lib/
    │   ├── logger.js          tiny structured logger
    │   └── authAudit.js       HIPAA auth audit trail
    ├── data/
    │   ├── catalog.js         product catalog + routing metadata
    │   └── billingPlans.js    catalog category -> Stripe Price ID mapping
    ├── schema/
    │   └── intake.schema.js   zod outer-envelope schema (legacy)
    ├── intake/
    │   ├── questionnaire.js   dynamic 13-step clinical flow definition
    │   ├── conditions.js      declarative showIf/red-flag evaluator
    │   ├── validator.js       branch-aware answer validation + red-flag screen
    │   └── steadymdPayload.js maps a validated intake -> SteadyMD async visit
    ├── services/
    │   ├── pharmacyRouter.js  GLP-1 -> Hallandale, else -> Empower
    │   ├── orderService.js    order model + state machine (in-memory)
    │   ├── patientService.js  patient account model + store (in-memory)
    │   ├── authService.js     password hashing, sessions, tokens, lockout
    │   ├── stripeService.js   billing — SetupIntent capture + charge-on-approval
    │   └── orchestrator.js    end-to-end flow wiring
    ├── clients/
    │   ├── steadymdClient.js  SteadyMD clinical API (stubbed)
    │   ├── empowerClient.js   Empower Pharmacy API (stubbed)
    │   ├── hallandaleClient.js Hallandale / LifeFile API (stubbed)
    │   └── stripeClient.js    Stripe SDK wrapper (live SDK or offline mock)
    ├── routes/
    │   ├── authRoutes.js      POST /api/auth/{register,login,logout,...}
    │   ├── intakeRoutes.js    POST /api/intake
    │   ├── webhookRoutes.js   POST /webhooks/{steadymd,empower,hallandale}
    │   ├── stripeWebhookRoutes.js POST /webhooks/stripe (raw body + signature)
    │   └── orderRoutes.js     GET /api/orders/:id (protected)
    └── middleware/
        ├── errorHandler.js    central error handler + AppError
        └── requireAuth.js     session-cookie auth guard (+ soft attachPatient)

scripts/
├── test-intake.js            runnable 13-step intake + SteadyMD payload demo
├── test-auth.js              runnable register -> login -> protected -> logout demo
└── test-stripe.js            runnable capture-now / charge-on-approval demo
```
