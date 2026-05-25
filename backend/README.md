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
  Order(INTAKE_SUBMITTED) --> steadymdClient.submitIntake() --> SteadyMD
    |                                                            |
  Order(CLINICIAN_REVIEW)                          clinician reviews async
    |                                                            |
    |  POST /webhooks/steadymd  <---------------------------------+
    v
  decision?
    +- declined --> Order(DECLINED)
    +- approved --> Order(APPROVED)
                     |
                     |  pharmacyRouter: GLP-1 -> Hallandale, else -> Empower
                     v
              empowerClient / hallandaleClient .submitPrescription()
                     |
              Order(ROUTED_TO_PHARMACY)
                     |
    POST /webhooks/empower | /webhooks/hallandale
                     v
       Order: COMPOUNDING --> SHIPPED (capture tracking #) --> DELIVERED
                     |
       GET /api/orders/:id  <-- patient dashboard reads state + tracking
```

### Order lifecycle state machine

```
DRAFT -> INTAKE_SUBMITTED -> CLINICIAN_REVIEW -> (APPROVED | DECLINED)
        -> ROUTED_TO_PHARMACY -> COMPOUNDING -> SHIPPED -> DELIVERED

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

| Method | Path                          | Purpose |
|--------|-------------------------------|---------|
| GET    | `/api/intake/questionnaire`   | The 13-step questionnaire definition (frontend renders the flow from this) |
| POST   | `/api/intake`                 | Submit a completed 13-step intake; creates an order |
| GET    | `/api/orders/:id`             | Dashboard read: status + tracking |
| POST   | `/webhooks/steadymd`          | Clinician decision (approved/declined) |
| POST   | `/webhooks/empower`           | Empower fulfillment update + tracking |
| POST   | `/webhooks/hallandale`        | Hallandale fulfillment update + tracking |
| GET    | `/health`                     | Liveness + scaffold-mode flag |

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
# Submit an intake (13-step flow: patient + productIds + answers map)
curl -X POST localhost:3000/api/intake -H 'Content-Type: application/json' -d '{
  "patient": { "firstName":"Jane","lastName":"Doe","dateOfBirth":"1990-01-01",
               "email":"jane@example.com","phone":"5550001111" },
  "productIds": ["glp1-semaglutide"],
  "answers": { "sex_at_birth":"female", "program":"weight_management" }
}'

# Fetch the questionnaire definition the frontend renders
curl localhost:3000/api/intake/questionnaire

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
- Dynamic 13-step intake questionnaire + branch-aware validation + red-flag screening
- Product catalog + conditional pharmacy router
- Order model + lifecycle state machine with valid-transition enforcement
- Orchestration wiring across intake -> SteadyMD -> pharmacy -> dashboard
- Webhook endpoints that advance order state

**Stubbed / placeholder (needs onboarding):**
- **Vendor network calls** — `steadymdClient`, `empowerClient`,
  `hallandaleClient` log a `STUB:` line and return placeholder responses
  instead of calling real APIs. Real `fetch()` code is commented in place.
- **Endpoint paths & payload shapes** — placeholders; real specs unknown
  until onboarding. Marked `TODO(onboarding)` / `TODO(steadymd-onboarding)`.
- **Auth schemes** — confirm per vendor (SteadyMD docs indicate `Token` prefix).
- **Webhook signature verification** — `verifySignature()` is a stub; real
  HMAC/timing-safe verification must replace it before production.
- **Persistence** — `orderService` uses an in-memory `Map`. Replace with a
  real database (`DATABASE_URL`).
- **Payments** — `STRIPE_SECRET_KEY` is wired into config but not yet used.

Search the codebase for `TODO(onboarding)` and `TODO(steadymd-onboarding)` to
find every reconciliation point.

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
|-- package.json
|-- .env.example
|-- .gitignore
|-- README.md
|-- src/
|   |-- server.js              Express app + bootstrap
|   |-- config.js              env loading + validation
|   |-- lib/
|   |   `-- logger.js          tiny structured logger
|   |-- data/
|   |   `-- catalog.js         product catalog + routing metadata
|   |-- schema/
|   |   `-- intake.schema.js   zod outer-envelope schema (legacy)
|   |-- intake/
|   |   |-- questionnaire.js   dynamic 13-step clinical flow definition
|   |   |-- conditions.js      declarative showIf/red-flag evaluator
|   |   |-- validator.js       branch-aware answer validation + red-flag screen
|   |   `-- steadymdPayload.js maps a validated intake -> SteadyMD async visit
|   |-- services/
|   |   |-- pharmacyRouter.js  GLP-1 -> Hallandale, else -> Empower
|   |   |-- orderService.js    order model + state machine (in-memory)
|   |   `-- orchestrator.js    end-to-end flow wiring (handleIntakeV2)
|   |-- clients/
|   |   |-- steadymdClient.js  SteadyMD clinical API (stubbed)
|   |   |-- empowerClient.js   Empower Pharmacy API (stubbed)
|   |   `-- hallandaleClient.js Hallandale / LifeFile API (stubbed)
|   |-- routes/
|   |   |-- intakeRoutes.js    GET /api/intake/questionnaire, POST /api/intake
|   |   |-- webhookRoutes.js   POST /webhooks/{steadymd,empower,hallandale}
|   |   `-- orderRoutes.js     GET /api/orders/:id
|   `-- middleware/
|       `-- errorHandler.js    central error handler + AppError
`-- scripts/
    `-- test-intake.js         runnable 13-step intake + SteadyMD payload demo
```
