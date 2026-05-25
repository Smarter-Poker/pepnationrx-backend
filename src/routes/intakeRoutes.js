// src/routes/intakeRoutes.js
// POST /api/intake — patient submits an intake form.
import { Router } from 'express';
import { validateIntake } from '../schema/intake.schema.js';
import { allProductsExist } from '../data/catalog.js';
import { handleIntake } from '../services/orchestrator.js';
import { toDashboardView } from '../services/orderService.js';
import { AppError } from '../middleware/errorHandler.js';

export const intakeRoutes = Router();

/**
 * POST /api/intake
 * Validates the payload, confirms product ids exist, then hands off to the
 * orchestrator which creates the order and submits it to SteadyMD.
 */
intakeRoutes.post('/intake', async (req, res, next) => {
  try {
    const validation = validateIntake(req.body);
    if (!validation.ok) {
      throw new AppError('Intake validation failed', 422, validation.issues);
    }

    if (!allProductsExist(validation.data.productIds)) {
      throw new AppError('One or more product ids are not in the catalog', 422);
    }

    const order = await handleIntake(validation.data);

    res.status(201).json({
      message: 'Intake received and submitted for clinician review',
      order: toDashboardView(order),
    });
  } catch (err) {
    next(err);
  }
});
