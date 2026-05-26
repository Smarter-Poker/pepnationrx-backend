// src/routes/intakeRoutes.js
// Intake endpoints — the dynamic 13-step clinical questionnaire flow.
//
//   GET  /api/intake/questionnaire   - the 13-step questionnaire definition
//                                      (the frontend renders the flow from this)
//   POST /api/intake                 - submit a completed 13-step intake
//
// The POST handler validates the submitted answer set against the
// questionnaire (branch-aware + red-flag screening) and hands off to the
// orchestrator, which builds the SteadyMD payload and submits the async visit.
import { Router } from 'express';
import { questionnaire } from '../intake/questionnaire.js';
import { allProductsExist } from '../data/catalog.js';
import { handleIntakeV2 } from '../services/orchestrator.js';
import { toDashboardView, markNeedsPmCapture } from '../services/orderService.js';
import { AppError } from '../middleware/errorHandler.js';
import { attachPatient } from '../middleware/requireAuth.js';
import { capturePaymentMethod } from '../services/stripeService.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export const intakeRoutes = Router();

/**
 * GET /api/intake/questionnaire
 * Returns the full 13-step questionnaire definition (steps, questions,
 * options, validation rules, and `showIf` branching). The frontend renders
 * the dynamic flow generically from this payload — no flow logic is hard-coded
 * in the UI.
 */
intakeRoutes.get('/intake/questionnaire', (_req, res) => {
  res.json(questionnaire);
});

/**
 * POST /api/intake
 * Body: { patient, productIds, answers, program? }
 *   - `answers` is a flat map of questionId -> answer for the 13-step flow.
 *
 * Validates the answer set against the questionnaire, confirms product ids
 * exist, then hands off to the orchestrator (validate -> build SteadyMD
 * payload -> submit async visit). Intakes that trip a contraindication red
 * flag are recorded and declined without ever reaching a clinician.
 *
 * `attachPatient` is a SOFT auth middleware: intake works for guests, but when
 * a valid patient session is present the resulting order is associated with
 * that account (order.intake.patientId) so it shows on their dashboard and is
 * protected by the ownership check in orderRoutes.
 */
intakeRoutes.post('/intake', attachPatient, async (req, res, next) => {
  try {
    const body = req.body || {};

    if (!Array.isArray(body.productIds) || body.productIds.length === 0) {
      throw new AppError('productIds is required', 422);
    }
    if (!allProductsExist(body.productIds)) {
      throw new AppError('One or more product ids are not in the catalog', 422);
    }
    if (typeof body.answers !== 'object' || body.answers === null) {
      throw new AppError('answers object is required', 422);
    }

    // Associate the order with the logged-in patient when one is present.
    const patient = { ...(body.patient || {}) };
    if (req.patientId) {
      patient.patientId = req.patientId;
    }

    const result = await handleIntakeV2({
      patient,
      productIds: body.productIds,
      answers: body.answers,
      program: body.program,
    });

    const eligible = result.validation.eligible;

    // --- Payment-method capture (NO charge) --------------------------------
    // BUSINESS RULE: completing intake never charges the patient. For an
    // eligible intake submitted by a signed-in patient we create a Stripe
    // SetupIntent so a card can be SAVED now — the actual charge happens only
    // later, if a clinician approves (handleSteadyMDDecision -> subscription).
    //
    // Guests are not charged and have no patient record to attach a Stripe
    // Customer to, so the SetupIntent is skipped for them; the frontend can
    // prompt them to create an account before payment-method capture.
    let payment = null;
    if (eligible && req.patientId) {
      try {
        const capture = await capturePaymentMethod({
          orderId: result.order.id,
          patientId: req.patientId,
        });
        payment = {
          // Hand this client secret to Stripe.js/Elements to collect & save the
          // card. No charge is created by confirming a SetupIntent.
          setupIntentClientSecret: capture.clientSecret,
          stripeCustomerId: capture.stripeCustomerId,
          billingState: capture.billingState,
          // Publishable key the browser needs to initialise Stripe.js.
          // TODO(prod): replace the placeholder STRIPE_PUBLISHABLE_KEY.
          stripePublishableKey: config.stripe.publishableKey,
          note: 'Card is saved now; you are charged only if a clinician approves treatment.',
        };
      } catch (err) {
        // A payment-setup failure must not block the clinical intake from
        // being recorded — surface it without failing the whole request.
        logger.error('SetupIntent creation failed during intake', {
          orderId: result.order.id,
          error: err.message,
        });
      }
    }

    res.status(201).json({
      message: eligible
        ? 'Intake received and submitted for clinician review'
        : 'Intake received but is not eligible for treatment',
      eligible,
      program: result.validation.program,
      redFlags: result.validation.redFlags,
      warnings: result.validation.warnings,
      order: toDashboardView(result.order),
      payment,
    });
  } catch (err) {
    next(err);
  }
});
