// src/routes/orderRoutes.js
// GET /api/orders/:id — patient dashboard reads order status + tracking.
//
// This route is PROTECTED: orders contain PHI, so an authenticated patient
// session is required (requireAuth). The handler also enforces ownership so a
// logged-in patient cannot read another patient's order.
import { Router } from 'express';
import { getOrder, toDashboardView } from '../services/orderService.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { AppError } from '../middleware/errorHandler.js';

export const orderRoutes = Router();

/**
 * GET /api/orders/:id   (requires an authenticated patient session)
 * Returns the dashboard-safe view: lifecycle state, pharmacy, tracking, and
 * the transition history. getOrder throws a 404 (handled by errorHandler)
 * when the id is unknown.
 *
 * Ownership: an order is owned by the patient whose id is stored on
 * `order.intake.patientId` (set when a logged-in patient submits an intake).
 * A mismatch returns 404 — never 403 — so the endpoint does not reveal that
 * an order id exists but belongs to someone else.
 */
orderRoutes.get('/orders/:id', requireAuth, (req, res, next) => {
  try {
    const order = getOrder(req.params.id);
    const ownerId = order.intake?.patientId || null;
    if (ownerId && ownerId !== req.patientId) {
      throw new AppError(`Order not found: ${req.params.id}`, 404);
    }
    res.json(toDashboardView(order));
  } catch (err) {
    next(err);
  }
});
