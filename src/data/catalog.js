// src/data/catalog.js
// Product catalog. Each product carries its routing target so the pharmacy
// router can resolve a destination without re-deriving business rules.
//
// Routing rule (see src/services/pharmacyRouter.js):
//   GLP-1 / weight-loss compounds  -> Hallandale Pharmacy
//   Everything else                -> Empower Pharmacy
//
// TODO(onboarding): confirm exact compound names, strengths, and which pharmacy
// actually carries each SKU once Empower + Hallandale formularies are received.

export const PHARMACY = Object.freeze({
  EMPOWER: 'empower',
  HALLANDALE: 'hallandale',
});

export const CATEGORY = Object.freeze({
  GLP1: 'glp1',
  PEPTIDE: 'peptide',
  HORMONE: 'hormone',
  AMINO_STACK: 'amino_stack',
  LONGEVITY: 'longevity',
});

export const catalog = [
  // --- GLP-1 / weight-loss -> Hallandale ---
  { id: 'glp1-semaglutide', name: 'Semaglutide', category: CATEGORY.GLP1, pharmacy: PHARMACY.HALLANDALE },
  { id: 'glp1-semaglutide-b12', name: 'Semaglutide + B12', category: CATEGORY.GLP1, pharmacy: PHARMACY.HALLANDALE },
  { id: 'glp1-tirzepatide', name: 'Tirzepatide', category: CATEGORY.GLP1, pharmacy: PHARMACY.HALLANDALE },
  { id: 'glp1-tirzepatide-b12', name: 'Tirzepatide + B12', category: CATEGORY.GLP1, pharmacy: PHARMACY.HALLANDALE },
  { id: 'glp1-liraglutide', name: 'Liraglutide', category: CATEGORY.GLP1, pharmacy: PHARMACY.HALLANDALE },
  { id: 'glp1-exenatide', name: 'Exenatide', category: CATEGORY.GLP1, pharmacy: PHARMACY.HALLANDALE },

  // --- Peptides -> Empower ---
  { id: 'pep-pt141', name: 'PT-141 (Bremelanotide)', category: CATEGORY.PEPTIDE, pharmacy: PHARMACY.EMPOWER },
  { id: 'pep-aod9604', name: 'AOD9604', category: CATEGORY.PEPTIDE, pharmacy: PHARMACY.EMPOWER },
  { id: 'pep-bpc157', name: 'BPC-157', category: CATEGORY.PEPTIDE, pharmacy: PHARMACY.EMPOWER },
  { id: 'pep-tb500', name: 'TB-500', category: CATEGORY.PEPTIDE, pharmacy: PHARMACY.EMPOWER },
  { id: 'pep-ghk-cu', name: 'GHK-Cu', category: CATEGORY.PEPTIDE, pharmacy: PHARMACY.EMPOWER },
  { id: 'pep-ipamorelin', name: 'Ipamorelin', category: CATEGORY.PEPTIDE, pharmacy: PHARMACY.EMPOWER },

  // --- Hormone / growth-axis -> Empower ---
  { id: 'hrm-sermorelin', name: 'Sermorelin', category: CATEGORY.HORMONE, pharmacy: PHARMACY.EMPOWER },
  { id: 'hrm-cjc1295', name: 'CJC-1295', category: CATEGORY.HORMONE, pharmacy: PHARMACY.EMPOWER },
  { id: 'hrm-tesamorelin', name: 'Tesamorelin', category: CATEGORY.HORMONE, pharmacy: PHARMACY.EMPOWER },
  { id: 'hrm-oxytocin', name: 'Oxytocin', category: CATEGORY.HORMONE, pharmacy: PHARMACY.EMPOWER },

  // --- Amino-acid stacks -> Empower ---
  { id: 'amn-gac-blend', name: 'GAC Blend (Glutamine / Arginine / Carnitine)', category: CATEGORY.AMINO_STACK, pharmacy: PHARMACY.EMPOWER },
  { id: 'amn-lipo-c', name: 'LIPO-C (Lipotropic Injection)', category: CATEGORY.AMINO_STACK, pharmacy: PHARMACY.EMPOWER },
  { id: 'amn-glutathione', name: 'Glutathione', category: CATEGORY.AMINO_STACK, pharmacy: PHARMACY.EMPOWER },
  { id: 'amn-amino-blend', name: 'Amino Blend', category: CATEGORY.AMINO_STACK, pharmacy: PHARMACY.EMPOWER },

  // --- Longevity / wellness -> Empower ---
  { id: 'lon-nad-plus', name: 'NAD+', category: CATEGORY.LONGEVITY, pharmacy: PHARMACY.EMPOWER },
  { id: 'lon-nad-plus-subq', name: 'NAD+ Subcutaneous', category: CATEGORY.LONGEVITY, pharmacy: PHARMACY.EMPOWER },
  { id: 'lon-methylene-blue', name: 'Methylene Blue', category: CATEGORY.LONGEVITY, pharmacy: PHARMACY.EMPOWER },
  { id: 'lon-b12', name: 'Vitamin B12 (Methylcobalamin)', category: CATEGORY.LONGEVITY, pharmacy: PHARMACY.EMPOWER },
];

/** Quick lookup map keyed by product id. */
const byId = new Map(catalog.map((p) => [p.id, p]));

/** Returns the product record for an id, or undefined if unknown. */
export function getProduct(productId) {
  return byId.get(productId);
}

/** Returns true if every supplied product id exists in the catalog. */
export function allProductsExist(productIds) {
  return productIds.every((id) => byId.has(id));
}
