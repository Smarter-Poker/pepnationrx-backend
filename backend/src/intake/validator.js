// src/intake/validator.js
// Validates a submitted intake answer set against the dynamic 13-step
// questionnaire (src/intake/questionnaire.js).
//
// Validation is questionnaire-aware and branch-aware:
//   1. Resolve the program (drives which branches are active).
//   2. Walk every step/question; for each VISIBLE question (showIf met),
//      enforce `required` and the per-type `validation` rules.
//   3. Run red-flag screening — if any visible red-flag question's `when`
//      matches, the intake is marked ELIGIBLE = false. An ineligible intake
//      is rejected before it is ever submitted to a SteadyMD clinician.
//
// This complements the existing zod schema (src/schema/intake.schema.js),
// which validates the OUTER request envelope (patient demographics, consent
// container, types). This module validates the dynamic clinical CONTENT.

import { z } from 'zod';
import {
  STEPS,
  QUESTION_BY_ID,
  RED_FLAG_QUESTIONS,
  QUESTION_TYPE,
  CATEGORY_TO_PROGRAM,
  PROGRAM,
} from './questionnaire.js';
import {
  evaluateCondition,
  isStepVisible,
  isQuestionVisible,
} from './conditions.js';
import { getProduct } from '../data/catalog.js';

const {
  SINGLE_SELECT, MULTI_SELECT, NUMBER, TEXT, DATE, BOOLEAN, FILE_UPLOAD_REF,
} = QUESTION_TYPE;

/**
 * Outer zod schema for an intake-v2 submission. The clinical answer content is
 * validated separately and dynamically by validateIntakeAnswers() below, so
 * `answers` is intentionally a loose record here.
 */
export const intakeV2Schema = z.object({
  // Selected catalog product ids — drives pharmacy routing AND program.
  productIds: z.array(z.string().min(1)).min(1, 'Select at least one product'),
  // Flat map of questionId -> answer. Validated against the questionnaire.
  answers: z.record(
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  ),
  // Optional explicit program override; normally derived from productIds.
  program: z.string().optional(),
});

/**
 * Derive the intake program from selected product ids. If products span
 * multiple programs the first is used and a warning is surfaced — a single
 * intake should be one program.
 *
 * @returns {{ program: string|null, warnings: string[] }}
 */
export function deriveProgram(productIds) {
  const warnings = [];
  const programs = new Set();
  for (const id of productIds) {
    const product = getProduct(id);
    if (!product) continue;
    const program = CATEGORY_TO_PROGRAM[product.category];
    if (program) programs.add(program);
  }
  const list = [...programs];
  if (list.length > 1) {
    warnings.push(
      `Selected products span multiple programs (${list.join(', ')}); using "${list[0]}".`,
    );
  }
  return { program: list[0] || null, warnings };
}

/** Type-level + rule-level validation of a single answer for a question. */
function validateAnswerValue(question, value) {
  const errors = [];
  const v = question.validation || {};

  switch (question.type) {
    case SINGLE_SELECT: {
      const allowed = (question.options || []).map((o) => o.value);
      if (!allowed.includes(value)) {
        errors.push(`must be one of: ${allowed.join(', ')}`);
      }
      break;
    }
    case MULTI_SELECT: {
      if (!Array.isArray(value)) {
        errors.push('must be an array of selected values');
        break;
      }
      const allowed = new Set((question.options || []).map((o) => o.value));
      for (const item of value) {
        if (!allowed.has(item)) errors.push(`"${item}" is not a valid option`);
      }
      break;
    }
    case NUMBER: {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        errors.push('must be a number');
        break;
      }
      if (v.integer && !Number.isInteger(n)) errors.push('must be a whole number');
      if (v.min !== undefined && n < v.min) errors.push(`must be >= ${v.min}`);
      if (v.max !== undefined && n > v.max) errors.push(`must be <= ${v.max}`);
      break;
    }
    case TEXT: {
      if (typeof value !== 'string') {
        errors.push('must be text');
        break;
      }
      if (v.minLength !== undefined && value.length < v.minLength) {
        errors.push(`must be at least ${v.minLength} characters`);
      }
      if (v.maxLength !== undefined && value.length > v.maxLength) {
        errors.push(`must be at most ${v.maxLength} characters`);
      }
      if (v.pattern && !new RegExp(v.pattern).test(value)) {
        errors.push('has an invalid format');
      }
      break;
    }
    case DATE: {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        errors.push('must be a date in YYYY-MM-DD format');
      }
      break;
    }
    case BOOLEAN: {
      if (typeof value !== 'boolean') errors.push('must be true or false');
      break;
    }
    case FILE_UPLOAD_REF: {
      // The value is a reference id to a previously uploaded file. The actual
      // file lives in object storage; this module only checks a ref exists.
      // TODO(steadymd-onboarding): reconcile with real API docs — confirm how
      // SteadyMD expects Intake Files to be referenced/uploaded (the EMR
      // "Attach Intake Files" flow) and validate the ref against storage.
      if (typeof value !== 'string' || value.length === 0) {
        errors.push('must be an uploaded-file reference id');
      }
      break;
    }
    default:
      errors.push(`unknown question type "${question.type}"`);
  }
  return errors;
}

/** True if an answer counts as "provided". */
function hasValue(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/**
 * Validate a full intake submission against the 13-step questionnaire.
 *
 * @param {object} submission
 * @param {string[]} submission.productIds
 * @param {Record<string, any>} submission.answers
 * @param {string} [submission.program]   - optional override
 * @returns {{
 *   ok: boolean,
 *   program: string|null,
 *   eligible: boolean,
 *   redFlags: { questionId: string, reason: string }[],
 *   issues: { path: string, message: string }[],
 *   warnings: string[],
 *   visibleStepIds: string[],
 * }}
 */
export function validateIntakeAnswers(submission) {
  const issues = [];
  const warnings = [];

  // --- Outer envelope ------------------------------------------------------
  const parsed = intakeV2Schema.safeParse(submission);
  if (!parsed.success) {
    return {
      ok: false,
      program: null,
      eligible: false,
      redFlags: [],
      warnings,
      visibleStepIds: [],
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }
  const { productIds, answers } = parsed.data;

  // --- Resolve program (drives branching) ----------------------------------
  const derived = deriveProgram(productIds);
  warnings.push(...derived.warnings);
  const program = parsed.data.program || derived.program;
  if (!program || !Object.values(PROGRAM).includes(program)) {
    issues.push({
      path: 'program',
      message: 'Could not resolve a valid program from the selected products.',
    });
  }
  const context = { program };

  // --- Walk visible steps/questions ----------------------------------------
  const visibleStepIds = [];
  for (const step of STEPS) {
    if (!isStepVisible(step, answers, context)) continue;
    visibleStepIds.push(step.id);

    for (const question of step.questions) {
      if (!isQuestionVisible(question, answers, context)) {
        // A hidden question must not carry an answer (stale data from a
        // back-navigation); warn but do not hard-fail.
        if (hasValue(answers[question.id])) {
          warnings.push(
            `Answer for hidden question "${question.id}" was ignored.`,
          );
        }
        continue;
      }

      const value = answers[question.id];
      const provided = hasValue(value);

      if (!provided) {
        if (question.required) {
          issues.push({
            path: `answers.${question.id}`,
            message: `"${question.prompt}" is required.`,
          });
        }
        continue; // nothing more to validate for an absent optional answer
      }

      for (const err of validateAnswerValue(question, value)) {
        issues.push({ path: `answers.${question.id}`, message: err });
      }
    }
  }

  // --- Reject any answer for an unknown question id ------------------------
  for (const qid of Object.keys(answers)) {
    if (!QUESTION_BY_ID[qid]) {
      issues.push({
        path: `answers.${qid}`,
        message: `Unknown question id "${qid}" — not part of the questionnaire.`,
      });
    }
  }

  // --- Red-flag / contraindication screening -------------------------------
  // Only red flags on VISIBLE questions count (a hidden branch can't fire).
  const redFlags = [];
  for (const question of RED_FLAG_QUESTIONS) {
    if (!isQuestionVisible(question, answers, context)) continue;
    const step = STEPS.find((s) => s.id === question.stepId);
    if (step && !isStepVisible(step, answers, context)) continue;
    if (evaluateCondition(question.redFlag.when, answers, context)) {
      redFlags.push({
        questionId: question.id,
        reason: question.redFlag.reason,
      });
    }
  }

  const eligible = redFlags.length === 0;
  const ok = issues.length === 0;

  return { ok, program, eligible, redFlags, issues, warnings, visibleStepIds };
}
