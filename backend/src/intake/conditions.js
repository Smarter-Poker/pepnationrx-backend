// src/intake/conditions.js
// Declarative condition evaluator for the dynamic intake questionnaire.
//
// Branching in src/intake/questionnaire.js is expressed as DATA (`showIf`
// objects and red-flag `when` objects), never as hard-coded logic. This module
// is the one place that interprets that data. The same evaluator powers:
//   - frontend conditional rendering (which steps/questions to show), and
//   - backend validation + red-flag screening (src/intake/validator.js).
//
// An `answers` object is a flat map of questionId -> answer value.
// `context` carries derived values the conditions can reference, e.g.
// { program: 'weight_management' }.

/** Computes whole-year age from a YYYY-MM-DD date string, or null if unparseable. */
export function ageFromDob(dob, now = new Date()) {
  if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [y, m, d] = dob.split('-').map(Number);
  let age = now.getFullYear() - y;
  const beforeBirthday =
    now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

/**
 * Computes BMI from height in inches and weight in lbs.
 * BMI = 703 * lbs / inches^2. Returns null if either input is missing/invalid.
 */
export function computeBmi(heightInches, weightLbs) {
  const h = Number(heightInches);
  const w = Number(weightLbs);
  if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0) return null;
  return (703 * w) / (h * h);
}

/** True if a multi-select answer (array) or scalar contains/equals `value`. */
function answerIncludes(answer, value) {
  if (Array.isArray(answer)) return answer.includes(value);
  return answer === value;
}

/** True if an answer is considered "answered" (present and non-empty). */
function isAnswered(answer) {
  if (answer === undefined || answer === null || answer === '') return false;
  if (Array.isArray(answer) && answer.length === 0) return false;
  return true;
}

/**
 * Evaluate a single declarative condition against an answer set + context.
 *
 * @param {object|undefined} cond - a condition object, or undefined (=> true)
 * @param {object} answers        - flat map of questionId -> answer
 * @param {object} [context]      - derived values: { program }
 * @returns {boolean}
 */
export function evaluateCondition(cond, answers, context = {}) {
  // No condition => always shown / always applies.
  if (cond == null) return true;

  // --- Logical combinators -------------------------------------------------
  if (Array.isArray(cond.all)) {
    return cond.all.every((c) => evaluateCondition(c, answers, context));
  }
  if (Array.isArray(cond.any)) {
    return cond.any.some((c) => evaluateCondition(c, answers, context));
  }
  if (cond.not !== undefined) {
    return !evaluateCondition(cond.not, answers, context);
  }

  // --- Program-scoped conditions ------------------------------------------
  if (cond.program !== undefined) {
    return context.program === cond.program;
  }
  if (Array.isArray(cond.programIn)) {
    return cond.programIn.includes(context.program);
  }

  // --- Answer-scoped conditions -------------------------------------------
  if (cond.questionId !== undefined) {
    const answer = answers ? answers[cond.questionId] : undefined;

    if (cond.isAnswered === true) return isAnswered(answer);
    if (cond.equals !== undefined) return answer === cond.equals;
    if (Array.isArray(cond.in)) return cond.in.includes(answer);
    if (cond.includes !== undefined) return answerIncludes(answer, cond.includes);

    // Derived numeric checks used by red-flag rules.
    if (cond.isUnder18 === true) {
      const age = ageFromDob(answer);
      return age !== null && age < 18;
    }
    if (cond.bmiUnder !== undefined) {
      const bmi = computeBmi(answers.height_inches, answers.weight_lbs);
      return bmi !== null && bmi < cond.bmiUnder;
    }
  }

  // Unknown / malformed condition shape — fail closed (treat as not-met) so a
  // typo can never silently expose a hidden step.
  return false;
}

/** Returns true if a step should be shown given the answers collected so far. */
export function isStepVisible(step, answers, context) {
  return evaluateCondition(step.showIf, answers, context);
}

/** Returns true if a question should be shown given the answers + context. */
export function isQuestionVisible(question, answers, context) {
  return evaluateCondition(question.showIf, answers, context);
}
