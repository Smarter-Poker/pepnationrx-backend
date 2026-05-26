// src/intake/steadymdPayload.js
// Maps a validated 13-step intake answer set + patient demographics into the
// request body for submitting an ASYNCHRONOUS visit to SteadyMD.
//
// ---------------------------------------------------------------------------
// RESEARCH BASIS (https://docs.steadymd.com/)
// ---------------------------------------------------------------------------
// SteadyMD's public docs describe the Platform/Partner API as two sections:
//   * EMR endpoints     — send patient + chart info: an Episode of Care, an
//                         Intake Questionnaire (the questionnaire, its
//                         potential answers, and the patient's responses),
//                         Intake Observations (structured clinical values),
//                         Intake Files (ID-verification / supporting docs),
//                         and a Preferred Pharmacy.
//   * Consult endpoints — request clinician time. For async care a partner
//                         creates a Consult with a `consult_type`, a Reason
//                         for Visit, the patient's location (State), and a
//                         link to the Episode of Care.
// Async consults have NO direct patient<->provider communication: the patient
// completes an intake, the clinician reviews it, and a decision/Rx comes back
// via Platform Events (AWS SNS -> SQS/HTTPS; events carry a GUID, no PHI).
//
// The exact JSON field names and the per-program `consult_type` strings are
// NOT in the public docs — the API Reference and the OpenAPI schema
// (steadymd-partner-api-schema.json) sit behind a partner login, and SteadyMD
// assigns consult-type values per program after the workflow is defined.
//
// Therefore: this builder produces a payload modelled on the DOCUMENTED
// structure above. Every field whose exact name/shape is not confirmed from
// real SteadyMD docs is marked with:
//   // TODO(steadymd-onboarding): reconcile with real API docs
//
// The builder returns sub-payloads matching the documented EMR + Consult
// split, plus a flat `legacyCase` shape kept for the existing
// steadymdClient.submitIntake() stub. An onboarding engineer swaps field
// names in ONE place here once the real schema is in hand.

import { STEPS, PROGRAM } from './questionnaire.js';
import { isStepVisible, isQuestionVisible, computeBmi, ageFromDob } from './conditions.js';

// TODO(steadymd-onboarding): reconcile with real API docs — these consult_type
// strings are placeholders. SteadyMD assigns the real values per program once
// the clinical workflow is defined. All are async-review workflows.
export const CONSULT_TYPE = Object.freeze({
  [PROGRAM.WEIGHT_MANAGEMENT]: 'async_weight_management',
  [PROGRAM.TRT]: 'async_hormone_therapy',
  [PROGRAM.PEPTIDE]: 'async_peptide_therapy',
  [PROGRAM.SEXUAL_HEALTH]: 'async_sexual_health',
  [PROGRAM.WOMENS_WELLNESS]: 'async_womens_wellness',
  [PROGRAM.LONGEVITY]: 'async_longevity',
});

// TODO(steadymd-onboarding): reconcile with real API docs — "Reason for Visit"
// is a documented field but its allowed value list is program-specific and
// configured by SteadyMD.
const REASON_FOR_VISIT = Object.freeze({
  [PROGRAM.WEIGHT_MANAGEMENT]: 'Weight management consultation',
  [PROGRAM.TRT]: 'Hormone therapy consultation',
  [PROGRAM.PEPTIDE]: 'Peptide therapy consultation',
  [PROGRAM.SEXUAL_HEALTH]: 'Sexual health consultation',
  [PROGRAM.WOMENS_WELLNESS]: "Women's wellness consultation",
  [PROGRAM.LONGEVITY]: 'Longevity & wellness consultation',
});

/**
 * Build the EMR "Intake Questionnaire" object — the questionnaire structure,
 * potential answers, and the patient's responses, exactly as SteadyMD's docs
 * describe it. Only VISIBLE (branch-active) questions are included so the
 * clinician sees precisely what the patient was asked.
 */
function buildIntakeQuestionnaire(answers, context) {
  const items = [];
  for (const step of STEPS) {
    if (!isStepVisible(step, answers, context)) continue;
    for (const question of step.questions) {
      if (!isQuestionVisible(question, answers, context)) continue;
      const raw = answers[question.id];
      if (raw === undefined) continue;
      items.push({
        // TODO(steadymd-onboarding): reconcile with real API docs — confirm
        // the field names SteadyMD expects for each questionnaire item.
        questionId: question.id,
        stepId: step.id,
        prompt: question.prompt,
        type: question.type,
        // Potential answers, per the docs ("the questionnaire, potential
        // answers, and the patient's responses").
        options: question.options ? question.options.map((o) => o.value) : null,
        response: raw,
      });
    }
  }
  return {
    // TODO(steadymd-onboarding): reconcile with real API docs.
    questionnaireVersion: '1.0.0',
    items,
  };
}

/**
 * Build "Intake Observations" — the structured clinical values SteadyMD needs
 * to deliver care safely (documented as a distinct concept from the free-form
 * questionnaire). We surface the high-value structured vitals here.
 */
function buildIntakeObservations(answers) {
  const bmi = computeBmi(answers.height_inches, answers.weight_lbs);
  const observations = [];
  // TODO(steadymd-onboarding): reconcile with real API docs — confirm the
  // observation `code` vocabulary (LOINC? a SteadyMD enum?) and value units.
  if (answers.height_inches !== undefined) {
    observations.push({ code: 'height_in', value: answers.height_inches, unit: 'in' });
  }
  if (answers.weight_lbs !== undefined) {
    observations.push({ code: 'weight_lb', value: answers.weight_lbs, unit: 'lb' });
  }
  if (bmi !== null) {
    observations.push({ code: 'bmi', value: Number(bmi.toFixed(1)), unit: 'kg/m2' });
  }
  return observations;
}

/**
 * Collect Intake File references (ID verification + supporting docs). The
 * documented EMR flow is "Attach Intake Files for patient identity
 * verification or to support the case for treatment."
 */
function buildIntakeFiles(answers, context) {
  const files = [];
  for (const step of STEPS) {
    if (!isStepVisible(step, answers, context)) continue;
    for (const question of step.questions) {
      if (question.type !== 'file-upload-ref') continue;
      if (!isQuestionVisible(question, answers, context)) continue;
      const ref = answers[question.id];
      if (!ref) continue;
      files.push({
        // TODO(steadymd-onboarding): reconcile with real API docs — confirm
        // how file refs are passed (pre-signed upload? multipart? a file id
        // returned by an upload endpoint?) and the `purpose` vocabulary.
        questionId: question.id,
        purpose:
          question.id === 'gov_id_upload' || question.id === 'selfie_upload'
            ? 'identity_verification'
            : 'clinical_support',
        uploadRef: ref,
      });
    }
  }
  return files;
}

/**
 * Build the full SteadyMD asynchronous-visit submission.
 *
 * @param {object} args
 * @param {object} args.patient        - demographics (validated)
 * @param {string} args.program        - PROGRAM.* value
 * @param {Record<string,any>} args.answers - validated 13-step answer set
 * @param {string} [args.externalOrderId]   - our order id, for correlation
 * @returns {{ episodeOfCare: object, consult: object, legacyCase: object, meta: object }}
 */
export function buildSteadyMDPayload({ patient, program, answers, externalOrderId }) {
  const context = { program };
  const pt = patient || {};

  // --- Patient demographics ------------------------------------------------
  // TODO(steadymd-onboarding): reconcile with real API docs — confirm the
  // EMR "Patient" object field names (camelCase vs snake_case, required set).
  const patientObject = {
    externalPatientId: pt.externalPatientId || externalOrderId || null,
    firstName: pt.firstName || answers.legal_first_name || null,
    lastName: pt.lastName || answers.legal_last_name || null,
    dateOfBirth: pt.dateOfBirth || answers.date_of_birth || null, // YYYY-MM-DD
    biologicalSex: answers.sex_at_birth || pt.sex || null,
    genderIdentity: answers.gender_identity || null,
    email: pt.email || answers.email || null,
    phone: pt.phone || answers.phone || null,
    address: {
      line1: answers.shipping_address_line1 || null,
      line2: answers.shipping_address_line2 || null,
      city: answers.shipping_city || null,
      // State of care drives clinician licensing — see Key Terms ("Patient's
      // Location (State)").
      state: answers.state_of_care || null,
      postalCode: answers.shipping_zip || null,
      country: 'US',
    },
  };

  // --- EMR sub-payloads ----------------------------------------------------
  const episodeOfCare = {
    // TODO(steadymd-onboarding): reconcile with real API docs — an Episode of
    // Care groups the intake, observations, files, pharmacy, and consult.
    externalEpisodeId: externalOrderId || null,
    program,
    patient: patientObject,
    preferredPharmacy: {
      // TODO(steadymd-onboarding): reconcile with real API docs — SteadyMD has
      // a documented Preferred Pharmacy endpoint + Pharmacy Search. PepNation's
      // routing (GLP-1 -> Hallandale, else -> Empower) is applied AFTER the
      // clinician decision, so this is left null for the partner workflow.
      ncpdpId: null,
      note: 'Pharmacy assigned by PepNationRX routing after clinician approval.',
    },
    intakeQuestionnaire: buildIntakeQuestionnaire(answers, context),
    intakeObservations: buildIntakeObservations(answers),
    intakeFiles: buildIntakeFiles(answers, context),
  };

  // --- Consult request -----------------------------------------------------
  const consult = {
    // TODO(steadymd-onboarding): reconcile with real API docs — `consultType`
    // and `reasonForVisit` are documented Consult fields; the VALUES are
    // assigned by SteadyMD per program (see CONSULT_TYPE above).
    consultType: CONSULT_TYPE[program] || null,
    modality: 'async', // documented modality: async, no direct communication
    reasonForVisit: REASON_FOR_VISIT[program] || null,
    // Patient's location at time of visit — documented Consult field.
    patientStateOfCare: answers.state_of_care || null,
    // Link to the Episode of Care — documented Consult field.
    externalEpisodeId: externalOrderId || null,
  };

  // --- Derived metadata (not sent; useful for our own logs/audit) ----------
  const meta = {
    patientAge: ageFromDob(patientObject.dateOfBirth),
    bmi: (() => {
      const b = computeBmi(answers.height_inches, answers.weight_lbs);
      return b === null ? null : Number(b.toFixed(1));
    })(),
    questionnaireItemCount: episodeOfCare.intakeQuestionnaire.items.length,
    fileCount: episodeOfCare.intakeFiles.length,
  };

  // --- Flat "legacy case" shape -------------------------------------------
  // The existing steadymdClient.submitIntake() stub posts a single flat case
  // object. Until that client is migrated to the EMR+Consult split, we also
  // expose this flattened view so nothing breaks.
  // TODO(steadymd-onboarding): reconcile with real API docs — then delete this
  // legacy shape and submit `episodeOfCare` + `consult` directly.
  const legacyCase = {
    externalOrderId: externalOrderId || null,
    patient: patientObject,
    stateOfResidence: answers.state_of_care || null,
    program,
    consultType: consult.consultType,
    questionnaire: episodeOfCare.intakeQuestionnaire,
    observations: episodeOfCare.intakeObservations,
    files: episodeOfCare.intakeFiles,
  };

  return { episodeOfCare, consult, legacyCase, meta };
}
