// src/schema/intake.schema.js
// Zod schema for the patient intake payload submitted to POST /api/intake.
// TODO(onboarding): reconcile required questionnaire fields with the actual
// SteadyMD clinical intake spec — clinicians may require condition-specific items.
import { z } from 'zod';

const US_STATE = z
  .string()
  .length(2, 'State must be a 2-letter US code')
  .regex(/^[A-Z]{2}$/, 'State must be uppercase, e.g. "FL"');

const demographicsSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dateOfBirth must be YYYY-MM-DD'),
  email: z.string().email(),
  phone: z.string().min(7).max(20),
  sex: z.enum(['male', 'female', 'other']),
});

const questionnaireAnswerSchema = z.object({
  questionId: z.string().min(1),
  answer: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
});

const consentSchema = z.object({
  telehealthConsent: z.literal(true, {
    errorMap: () => ({ message: 'telehealthConsent must be accepted' }),
  }),
  compoundedMedConsent: z.literal(true, {
    errorMap: () => ({ message: 'compoundedMedConsent must be accepted' }),
  }),
});

export const intakeSchema = z.object({
  patient: demographicsSchema,
  // State of residence drives clinician licensing eligibility.
  stateOfResidence: US_STATE,
  // One or more selected catalog product ids.
  productIds: z.array(z.string().min(1)).min(1, 'Select at least one product'),
  questionnaire: z.array(questionnaireAnswerSchema).min(1),
  consent: consentSchema,
});

/**
 * Parses and validates a raw request body.
 * @returns {{ ok: true, data: object } | { ok: false, issues: object[] }}
 */
export function validateIntake(body) {
  const result = intakeSchema.safeParse(body);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  };
}
