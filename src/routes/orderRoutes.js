// src/routes/orderRoutes.js
// GET /api/orders/:id — patient dashboard reads order status + tracking.
import { Router } from 'express';
import { getOrder, toDashboardView } from '../services/orderService.js';

export const orderRoutes = Router();

/**
 * GET /api/orders/:id
 * Returns the dashboard-safe view: lifecycle state, pharmacy, tracking, and
 * the transition history. getOrder throws a 404 (handled by errorHandler)
 * when the id is unknown.
 */
orderRoutes.get('/orders/:id', (req, res, next) => {
  try {
    const order = getOrder(req.params.id);
    res.json(toDashboardView(order));
  } catch (err) {
    next(err);
  }
});
