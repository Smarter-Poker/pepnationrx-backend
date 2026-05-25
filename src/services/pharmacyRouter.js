// src/services/pharmacyRouter.js
// Conditional pharmacy routing — core business logic.
//
// Rule:
//   GLP-1 / weight-loss drugs (Semaglutide, Tirzepatide, Liraglutide, Exenatide)
//     -> Hallandale Pharmacy
//   Everything else (NAD+, Sermorelin, PT-141, AOD9604, peptides, amino-acid
//     stacks, LIPO-C, longevity/wellness compounds)
//     -> Empower Pharmacy
import { getProduct, PHARMACY, CATEGORY } from '../data/catalog.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Resolve the destination pharmacy for a single product id.
 * GLP-1 category routes to Hallandale; all other categories route to Empower.
 */
export function routeProduct(productId) {
  const product = getProduct(productId);
  if (!product) {
    throw new AppError(`Unknown product id: ${productId}`, 422);
  }
  // The catalog already encodes the destination, but we re-derive from
  // category here so the business rule is explicit and auditable.
  return product.category === CATEGORY.GLP1
    ? PHARMACY.HALLANDALE
    : PHARMACY.EMPOWER;
}

/**
 * Resolve the destination pharmacy for an approved Rx that may contain
 * multiple products.
 *
 * A single Rx must ship from one pharmacy. If a multi-product order spans
 * both pharmacies it is split — this scaffold returns the split for the
 * orchestrator to act on.
 *
 * @param {string[]} productIds
 * @returns {{ single: string|null, split: Record<string,string[]> }}
 */
export function routeOrder(productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    throw new AppError('routeOrder requires at least one product id', 422);
  }

  const split = { [PHARMACY.EMPOWER]: [], [PHARMACY.HALLANDALE]: [] };
  for (const id of productIds) {
    split[routeProduct(id)].push(id);
  }

  const pharmaciesUsed = Object.keys(split).filter((p) => split[p].length > 0);
  return {
    // Set when the whole order routes to exactly one pharmacy.
    single: pharmaciesUsed.length === 1 ? pharmaciesUsed[0] : null,
    // Always present; orchestrator can submit one Rx per non-empty pharmacy.
    split,
  };
}
