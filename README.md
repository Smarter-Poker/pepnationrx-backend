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
    |  POST /webhooks/steadymd  ◄────────────────────────────┘
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

| Method | Path                   | Purpose |
|--------|------------------------|---------|
| POST   | `/api/intake`          | Submit patient intake; creates an order |
| GET    | `/api/orders/:id`      | Dashboard read: status + tracking |
| POST   | `/webhooks/steadymd`   | Clinician decision (approved/declined) |
| POST   | `/webhooks/empower`    | Empower fulfillment update + tracking |
| POST   | `/webhooks/hallandale` | Hallandale fulfillment update + tracking |
| GET    | `/health`              | Liveness + scaffold-mode flag |

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
- **Payments** — `STRIPE_SECRET_KEY` is wired into config but not yet used.

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
    │   └── logger.js          tiny structured logger
    ├── data/
    │   └── catalog.js         product catalog + routing metadata
    ├── schema/
    │   └── intake.schema.js   zod intake-payload schema
    ├── services/
    │   ├── pharmacyRouter.js  GLP-1 -> Hallandale, else -> Empower
    │   ├── orderService.js    order model + state machine (in-memory)
    │   └── orchestrator.js    end-to-end flow wiring
    ├── clients/
    │   ├── steadymdClient.js  SteadyMD clinical API (stubbed)
    │   ├── empowerClient.js   Empower Pharmacy API (stubbed)
    │   └── hallandaleClient.js Hallandale / LifeFile API (stubbed)
    ├── routes/
    │   ├── intakeRoutes.js    POST /api/intake
    │   ├── webhookRoutes.js   POST /webhooks/{steadymd,empower,hallandale}
    │   └── orderRoutes.js     GET /api/orders/:id
    └── middleware/
        └── errorHandler.js    central error handler + AppError
```
