// src/data/billingPlans.js
// Maps catalog products to Stripe recurring Prices.
//
// In Stripe's model (https://docs.stripe.com/billing/subscriptions/overview):
//   Product  — what the patient is treated with (the compound program).
//   Price    — a recurring price attached to a Product (e.g. $X / month).
//   Subscription — created on clinician approval; bills the Price on a cycle.
//
// A Subscription is created against a Price ID, so each billable plan needs a
// Stripe Price ID. Because there is no real Stripe account yet, every ID below
// is a PLACEHOLDER.
//
// TODO(prod): create the Products + recurring Prices in the Stripe dashboard
// (or via the API) and replace every `price_PLACEHOLDER_*` value with the real
// Price ID. The lookup_key column is what you'd actually search Stripe by.
import { catalog, CATEGORY } from './catalog.js';

// Per-category recurring plan definition. Real telehealth programs price per
// program tier; this scaffold uses one monthly plan per category. Amounts are
// indicative only and are NOT used to create charges in scaffold mode.
//
// TODO(prod): confirm the real plan structure, billing interval, and amounts
// with the business; create the matching Stripe Prices.
const PLAN_BY_CATEGORY = Object.freeze({
  [CATEGORY.GLP1]: {
    lookupKey: 'pnrx_glp1_monthly',
    // TODO(prod): replace with the real Stripe Price ID (price_...).
    stripePriceId: 'price_PLACEHOLDER_glp1_monthly',
    nickname: 'GLP-1 Weight Management — Monthly',
    interval: 'month',
    indicativeAmountUsd: 299,
  },
  [CATEGORY.PEPTIDE]: {
    lookupKey: 'pnrx_peptide_monthly',
    stripePriceId: 'price_PLACEHOLDER_peptide_monthly', // TODO(prod)
    nickname: 'Peptide Therapy — Monthly',
    interval: 'month',
    indicativeAmountUsd: 199,
  },
  [CATEGORY.HORMONE]: {
    lookupKey: 'pnrx_hormone_monthly',
    stripePriceId: 'price_PLACEHOLDER_hormone_monthly', // TODO(prod)
    nickname: 'Hormone / Growth-Axis Therapy — Monthly',
    interval: 'month',
    indicativeAmountUsd: 219,
  },
  [CATEGORY.AMINO_STACK]: {
    lookupKey: 'pnrx_amino_monthly',
    stripePriceId: 'price_PLACEHOLDER_amino_monthly', // TODO(prod)
    nickname: 'Amino-Acid Stack — Monthly',
    interval: 'month',
    indicativeAmountUsd: 149,
  },
  [CATEGORY.LONGEVITY]: {
    lookupKey: 'pnrx_longevity_monthly',
    stripePriceId: 'price_PLACEHOLDER_longevity_monthly', // TODO(prod)
    nickname: 'Longevity / Wellness — Monthly',
    interval: 'month',
    indicativeAmountUsd: 169,
  },
});

const byProductId = new Map(catalog.map((p) => [p.id, p]));

/**
 * Resolve the Stripe billing plan for an order's products.
 *
 * An order's products all belong to one program; we bill the plan for the
 * category of the first product. If products span categories the order should
 * have been split upstream — we still resolve a single plan and flag it.
 *
 * @param {string[]} productIds
 * @returns {{ stripePriceId: string, lookupKey: string, nickname: string,
 *             interval: string, category: string, indicativeAmountUsd: number,
 *             mixedCategories: boolean }}
 */
export function resolveBillingPlan(productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    throw new Error('resolveBillingPlan: productIds is required');
  }
  const products = productIds.map((id) => {
    const p = byProductId.get(id);
    if (!p) throw new Error(`resolveBillingPlan: unknown product id ${id}`);
    return p;
  });

  const categories = new Set(products.map((p) => p.category));
  const primaryCategory = products[0].category;
  const plan = PLAN_BY_CATEGORY[primaryCategory];
  if (!plan) {
    throw new Error(`resolveBillingPlan: no plan for category ${primaryCategory}`);
  }

  return {
    ...plan,
    category: primaryCategory,
    mixedCategories: categories.size > 1,
  };
}

export { PLAN_BY_CATEGORY };
