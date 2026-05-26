# ARCHIVED -- This repository is superseded

**This repository is superseded by
[`Smarter-Software-PIQ/pepnationrx`](https://github.com/Smarter-Software-PIQ/pepnationrx)
(private).**

All canonical PepNationRX work has been migrated to the new monorepo as of
**2026-05-26**. This repo remains as historical reference and will receive
**no further updates**. The new monorepo has a more developed backend
(JWT auth with refresh-token rotation, full Triad service scaffolding,
medical-network / pharmacy / Stripe / messaging / insurance / membership
services, 17 SQL migrations, scheduled jobs, audit middleware, and a
working set of API routes).

## What was migrated

The high-value, design-agnostic deliverables from this repo were ported
into the new monorepo via a feature branch PR:

- 13-step intake questionnaire (data + conditions evaluator + validator)
- Product catalog (23 SKUs across 5 categories) with pharmacy routing
- Pharmacy routing rule documented (GLP-1 -> Hallandale, else -> Empower)
- SteadyMD EMR + Consult payload specification (with every
  `TODO(steadymd-onboarding)` marker preserved verbatim)
- Stripe charge-on-approval pattern (SetupIntent at intake, Subscription
  on APPROVED, idempotency-key recipe, webhook -> state map)
- Order state machine (DRAFT through DELIVERED, plus side states
  CANCELLED, ON_HOLD, NEEDS_PM_CAPTURE, NOT_BILLABLE)

## What was NOT migrated

- The Express server, routes, controllers, and middleware (the new
  monorepo already has a more developed equivalent).
- `authService.js` / `patientService.js` / `orchestrator.js` /
  `orderService.js` / `stripeService.js` -- the new monorepo's Phase 2
  auth and Phase 4 Triad services supersede these.
- The three vendor client stubs (`steadymdClient`, `empowerClient`,
  `hallandaleClient`) -- the new monorepo has scaffolds for these.
  The useful artifact is the **payload spec**, which was ported.
- The in-memory order store (the new monorepo uses PostgreSQL).

## What was in this repo

A Node.js/Express scaffold backend for the PepNationRX telehealth MSO
platform, coordinating a patient intake -> clinician review -> compounding
pharmacy fulfillment pipeline across three external vendors (SteadyMD,
Empower Pharmacy, Hallandale Pharmacy). The scaffold ran end-to-end in
SCAFFOLD MODE with placeholder credentials. 58/58 tests passed.

## Original README

The original README content from this repo is preserved in this commit's
history. See the diff for this commit on the main branch, or browse the
file at any earlier commit.

---

For all current development, go to
<https://github.com/Smarter-Software-PIQ/pepnationrx>.
