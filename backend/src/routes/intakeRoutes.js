// src/routes/intakeRoutes.js
// Intake endpoints - the dynamic 13-step clinical questionnaire flow.
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
import { toDashboardView } from '../services/orderService.js';
import { AppError } from '../middleware/errorHandler.js';

export const intakeRoutes = Router();

/**
 * GET /api/intake/questionnaire
 * Returns the full 13-step questionnaire definition (steps, questions,
 * options, validation rules, and `showIf` branching). The frontend renders
 * the dynamic flow generically from this payload - no flow logic is hard-coded
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
 */
intakeRoutes.post('/intake', async (req, res, next) => {
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

    const result = await handleIntakeV2({
      patient: body.patient,
      productIds: body.productIds,
      answers: body.answers,
      program: body.program,
    });

    const eligible = result.validation.eligible;
    res.status(201).json({
      message: eligible
        ? 'Intake received and submitted for clinician review'
        : 'Intake received but is not eligible for treatment',
      eligible,
      program: result.validation.program,
      redFlags: result.validation.redFlags,
      warnings: result.validation.warnings,
      order: toDashboardView(result.order),
    });
  } catch (err) {
    next(err);
  }
});
