// src/intake/questionnaire.js
// Dynamic 13-step clinical intake questionnaire definition.
//
// This module is the SINGLE SOURCE OF TRUTH for the patient intake flow. It is
// pure data so that:
//   - the frontend (site/intake.html) can render each step generically, and
//   - the backend (src/intake/validator.js) can validate a submitted answer
//     set against the exact same definition.
//
// The flow maps onto SteadyMD's EMR "Intake Questionnaire" model
// (https://docs.steadymd.com/docs/intakes): a questionnaire, its potential
// answers, and the patient's responses. Step 1 ("biological sex at birth")
// matches the existing static intake.html which labels it "Step 1 of 13".
//
// TODO(steadymd-onboarding): reconcile with real API docs — SteadyMD's
// clinical leadership defines the required intake items per program in the
// clinical protocol. The question set below is built to async-telehealth
// best practice (Hims/Ro/Sesame-style screening) and must be reconciled with
// the agreed protocol before go-live.
//
// ---------------------------------------------------------------------------
// CONCEPTS
// ---------------------------------------------------------------------------
// Program     - the line of care a patient is enrolling in. Drives branching.
// Step        - one screen of the flow (13 total, ordered by `order`).
// Question    - one field within a step.
// showIf      - a declarative condition (NOT hard-coded logic). A step or
//               question is shown only when its showIf evaluates true against
//               answers collected so far. Absent showIf => always shown.
// redFlag     - a question whose specific answer can make an intake
//               ineligible BEFORE it ever reaches a clinician.
//
// A showIf condition is one of:
//   { all: [cond, ...] }                  - logical AND
//   { any: [cond, ...] }                  - logical OR
//   { not: cond }                         - logical NOT
//   { questionId, equals: value }         - answer === value
//   { questionId, in: [v, ...] }          - answer is one of
//   { questionId, includes: value }       - multi-select answer contains value
//   { questionId, isAnswered: true }      - answer is present / non-empty
//   { program: 'weight_management' }      - selected program equals
//   { programIn: ['trt', 'peptide'] }     - selected program is one of
// The evaluator lives in src/intake/conditions.js.

/** Program identifiers. Keep in sync with src/data/catalog.js categories. */
export const PROGRAM = Object.freeze({
  WEIGHT_MANAGEMENT: 'weight_management', // GLP-1: semaglutide / tirzepatide
  TRT: 'trt',                             // testosterone / hormone therapy
  PEPTIDE: 'peptide',                     // peptide therapy
  SEXUAL_HEALTH: 'sexual_health',         // PT-141, etc.
  WOMENS_WELLNESS: 'womens_wellness',     // women's hormone / wellness
  LONGEVITY: 'longevity',                 // NAD+, methylene blue, longevity
});

/** Maps a catalog CATEGORY (src/data/catalog.js) to an intake program. */
export const CATEGORY_TO_PROGRAM = Object.freeze({
  glp1: PROGRAM.WEIGHT_MANAGEMENT,
  hormone: PROGRAM.TRT,
  peptide: PROGRAM.PEPTIDE,
  amino_stack: PROGRAM.LONGEVITY,
  longevity: PROGRAM.LONGEVITY,
});

/** Question field types the frontend renderer + validator understand. */
export const QUESTION_TYPE = Object.freeze({
  SINGLE_SELECT: 'single-select',
  MULTI_SELECT: 'multi-select',
  NUMBER: 'number',
  TEXT: 'text',
  DATE: 'date',
  BOOLEAN: 'boolean',
  FILE_UPLOAD_REF: 'file-upload-ref', // value is a reference id to an upload
});

const { SINGLE_SELECT, MULTI_SELECT, NUMBER, TEXT, DATE, BOOLEAN, FILE_UPLOAD_REF } =
  QUESTION_TYPE;

// ---------------------------------------------------------------------------
// THE 13 STEPS
// ---------------------------------------------------------------------------
// Each step: { id, order, title, help, showIf?, questions: [...] }
// Each question: { id, type, prompt, help?, options?, required, showIf?,
//                  validation?, redFlag? }
// `options` entries: { value, label }
// `validation`: { min?, max?, minLength?, maxLength?, pattern?, integer? }
// `redFlag`: { when: condition, reason: string } — if `when` matches this
//            question's answer, the intake is flagged ineligible.

export const STEPS = [
  // -- STEP 1 — Biological sex at birth (drives the biggest branch) ----------
  {
    id: 'biological_sex',
    order: 1,
    title: 'Biological sex at birth',
    help: 'We ask this first because it determines which medical screening questions apply to you. This is your sex assigned at birth, which may differ from your gender identity.',
    questions: [
      {
        id: 'sex_at_birth',
        type: SINGLE_SELECT,
        prompt: 'What was your biological sex at birth?',
        required: true,
        options: [
          { value: 'female', label: 'Female' },
          { value: 'male', label: 'Male' },
          { value: 'intersex', label: 'Intersex' },
        ],
      },
      {
        id: 'gender_identity',
        type: SINGLE_SELECT,
        prompt: 'How do you describe your gender identity? (optional)',
        required: false,
        options: [
          { value: 'woman', label: 'Woman' },
          { value: 'man', label: 'Man' },
          { value: 'non_binary', label: 'Non-binary' },
          { value: 'prefer_not_to_say', label: 'Prefer not to say' },
        ],
      },
    ],
  },

  // -- STEP 2 — Program selection -------------------------------------------
  {
    id: 'program_selection',
    order: 2,
    title: 'What are you here for?',
    help: 'Choose the treatment area you are interested in. Your answers in later steps are tailored to this choice.',
    questions: [
      {
        id: 'program',
        type: SINGLE_SELECT,
        prompt: 'Select your treatment program',
        required: true,
        options: [
          { value: PROGRAM.WEIGHT_MANAGEMENT, label: 'Weight management (GLP-1)' },
          { value: PROGRAM.TRT, label: 'Testosterone / hormone therapy' },
          { value: PROGRAM.PEPTIDE, label: 'Peptide therapy' },
          { value: PROGRAM.SEXUAL_HEALTH, label: 'Sexual health' },
          { value: PROGRAM.WOMENS_WELLNESS, label: "Women's wellness" },
          { value: PROGRAM.LONGEVITY, label: 'Longevity & wellness' },
        ],
      },
      {
        id: 'program_goal',
        type: TEXT,
        prompt: 'In a sentence, what is your main goal with this treatment?',
        required: false,
        validation: { maxLength: 280 },
      },
    ],
  },

  // -- STEP 3 — Identity & contact / eligibility ----------------------------
  {
    id: 'identity_contact',
    order: 3,
    title: 'About you',
    help: 'Your legal name and date of birth must match your government-issued ID. We use this to verify your identity and confirm you are eligible for care.',
    questions: [
      {
        id: 'legal_first_name',
        type: TEXT,
        prompt: 'Legal first name',
        required: true,
        validation: { minLength: 1, maxLength: 80 },
      },
      {
        id: 'legal_last_name',
        type: TEXT,
        prompt: 'Legal last name',
        required: true,
        validation: { minLength: 1, maxLength: 80 },
      },
      {
        id: 'date_of_birth',
        type: DATE,
        prompt: 'Date of birth',
        required: true,
        // 18+ enforced by the validator (computed age) and the red flag below.
        redFlag: {
          when: { questionId: 'date_of_birth', isUnder18: true },
          reason: 'Patient is under 18 — these programs require adult patients.',
        },
      },
      {
        id: 'email',
        type: TEXT,
        prompt: 'Email address',
        required: true,
        validation: { pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
      },
      {
        id: 'phone',
        type: TEXT,
        prompt: 'Mobile phone number',
        help: 'Used for visit updates and shipping notifications.',
        required: true,
        validation: { minLength: 7, maxLength: 20 },
      },
    ],
  },

  // -- STEP 4 — Location / state of care ------------------------------------
  {
    id: 'location',
    order: 4,
    title: 'Where are you located?',
    help: 'A clinician can only treat you if they are licensed in the state where you are physically located at the time of your visit. This may differ from your home address.',
    questions: [
      {
        id: 'state_of_care',
        type: SINGLE_SELECT,
        prompt: 'State you are currently located in',
        required: true,
        // TODO(steadymd-onboarding): reconcile with real API docs — confirm
        // the partner program's licensed-state coverage list with SteadyMD.
        options: [
          { value: 'AL', label: 'Alabama' }, { value: 'AK', label: 'Alaska' },
          { value: 'AZ', label: 'Arizona' }, { value: 'AR', label: 'Arkansas' },
          { value: 'CA', label: 'California' }, { value: 'CO', label: 'Colorado' },
          { value: 'CT', label: 'Connecticut' }, { value: 'DE', label: 'Delaware' },
          { value: 'FL', label: 'Florida' }, { value: 'GA', label: 'Georgia' },
          { value: 'HI', label: 'Hawaii' }, { value: 'ID', label: 'Idaho' },
          { value: 'IL', label: 'Illinois' }, { value: 'IN', label: 'Indiana' },
          { value: 'IA', label: 'Iowa' }, { value: 'KS', label: 'Kansas' },
          { value: 'KY', label: 'Kentucky' }, { value: 'LA', label: 'Louisiana' },
          { value: 'ME', label: 'Maine' }, { value: 'MD', label: 'Maryland' },
          { value: 'MA', label: 'Massachusetts' }, { value: 'MI', label: 'Michigan' },
          { value: 'MN', label: 'Minnesota' }, { value: 'MS', label: 'Mississippi' },
          { value: 'MO', label: 'Missouri' }, { value: 'MT', label: 'Montana' },
          { value: 'NE', label: 'Nebraska' }, { value: 'NV', label: 'Nevada' },
          { value: 'NH', label: 'New Hampshire' }, { value: 'NJ', label: 'New Jersey' },
          { value: 'NM', label: 'New Mexico' }, { value: 'NY', label: 'New York' },
          { value: 'NC', label: 'North Carolina' }, { value: 'ND', label: 'North Dakota' },
          { value: 'OH', label: 'Ohio' }, { value: 'OK', label: 'Oklahoma' },
          { value: 'OR', label: 'Oregon' }, { value: 'PA', label: 'Pennsylvania' },
          { value: 'RI', label: 'Rhode Island' }, { value: 'SC', label: 'South Carolina' },
          { value: 'SD', label: 'South Dakota' }, { value: 'TN', label: 'Tennessee' },
          { value: 'TX', label: 'Texas' }, { value: 'UT', label: 'Utah' },
          { value: 'VT', label: 'Vermont' }, { value: 'VA', label: 'Virginia' },
          { value: 'WA', label: 'Washington' }, { value: 'WV', label: 'West Virginia' },
          { value: 'WI', label: 'Wisconsin' }, { value: 'WY', label: 'Wyoming' },
          { value: 'DC', label: 'District of Columbia' },
        ],
      },
      {
        id: 'shipping_address_line1',
        type: TEXT,
        prompt: 'Shipping address',
        required: true,
        validation: { minLength: 3, maxLength: 120 },
      },
      {
        id: 'shipping_address_line2',
        type: TEXT,
        prompt: 'Apartment / unit (optional)',
        required: false,
        validation: { maxLength: 60 },
      },
      {
        id: 'shipping_city',
        type: TEXT,
        prompt: 'City',
        required: true,
        validation: { minLength: 1, maxLength: 80 },
      },
      {
        id: 'shipping_zip',
        type: TEXT,
        prompt: 'ZIP code',
        required: true,
        validation: { pattern: '^\\d{5}(-\\d{4})?$' },
      },
    ],
  },

  // -- STEP 5 — Vitals: height / weight / BMI -------------------------------
  {
    id: 'vitals',
    order: 5,
    title: 'Your measurements',
    help: 'Height and weight let the clinician calculate your BMI, which is required for dosing and for confirming clinical appropriateness.',
    questions: [
      {
        id: 'height_inches',
        type: NUMBER,
        prompt: 'Height (total inches)',
        help: 'For example, 5 ft 8 in = 68 inches.',
        required: true,
        validation: { min: 36, max: 96, integer: true },
      },
      {
        id: 'weight_lbs',
        type: NUMBER,
        prompt: 'Current weight (lbs)',
        required: true,
        validation: { min: 60, max: 800 },
      },
      {
        id: 'goal_weight_lbs',
        type: NUMBER,
        prompt: 'Goal weight (lbs)',
        required: false,
        showIf: { program: PROGRAM.WEIGHT_MANAGEMENT },
        validation: { min: 60, max: 800 },
      },
      {
        // BMI < 18.5 on a weight-loss program is a clinical contraindication.
        id: 'bmi_acknowledgement',
        type: BOOLEAN,
        prompt: 'I understand my BMI will be calculated from the height and weight above.',
        required: true,
        showIf: { program: PROGRAM.WEIGHT_MANAGEMENT },
        redFlag: {
          when: { questionId: 'weight_lbs', bmiUnder: 18.5 },
          reason: 'Calculated BMI is below 18.5 — GLP-1 weight-management therapy is contraindicated for underweight patients.',
        },
      },
    ],
  },

  // -- STEP 6 — Medical history --------------------------------------------
  {
    id: 'medical_history',
    order: 6,
    title: 'Medical history',
    help: 'Select any conditions you have now or have had in the past. This helps the clinician treat you safely.',
    questions: [
      {
        id: 'conditions',
        type: MULTI_SELECT,
        prompt: 'Have you ever been diagnosed with any of the following?',
        required: false,
        options: [
          { value: 'none', label: 'None of these' },
          { value: 'type1_diabetes', label: 'Type 1 diabetes' },
          { value: 'type2_diabetes', label: 'Type 2 diabetes' },
          { value: 'thyroid_disorder', label: 'Thyroid disorder' },
          { value: 'pancreatitis', label: 'Pancreatitis' },
          { value: 'gallbladder_disease', label: 'Gallbladder disease' },
          { value: 'kidney_disease', label: 'Kidney disease' },
          { value: 'liver_disease', label: 'Liver disease' },
          { value: 'heart_disease', label: 'Heart disease' },
          { value: 'high_blood_pressure', label: 'High blood pressure' },
          { value: 'stroke', label: 'Stroke or TIA' },
          { value: 'cancer', label: 'Cancer (any type)' },
          { value: 'eating_disorder', label: 'Eating disorder' },
          { value: 'depression_anxiety', label: 'Depression or anxiety' },
          { value: 'seizure_disorder', label: 'Seizure disorder' },
        ],
      },
      {
        // Personal/family MTC or MEN2 history is a hard contraindication for
        // GLP-1 therapy (boxed warning).
        id: 'mtc_men2_history',
        type: SINGLE_SELECT,
        prompt: 'Do you or any family member have a history of medullary thyroid carcinoma (MTC) or Multiple Endocrine Neoplasia syndrome type 2 (MEN 2)?',
        required: true,
        showIf: { program: PROGRAM.WEIGHT_MANAGEMENT },
        options: [
          { value: 'no', label: 'No' },
          { value: 'yes', label: 'Yes' },
          { value: 'unsure', label: 'Not sure' },
        ],
        redFlag: {
          when: { questionId: 'mtc_men2_history', equals: 'yes' },
          reason: 'Personal or family history of MTC or MEN 2 — GLP-1 therapy carries a boxed warning and is contraindicated.',
        },
      },
      {
        id: 'surgeries',
        type: TEXT,
        prompt: 'List any major surgeries and approximate dates (optional)',
        required: false,
        validation: { maxLength: 500 },
      },
    ],
  },

  // -- STEP 7 — Current medications & allergies -----------------------------
  {
    id: 'medications_allergies',
    order: 7,
    title: 'Medications & allergies',
    help: 'Accurate medication and allergy information lets the clinician screen for dangerous interactions.',
    questions: [
      {
        id: 'takes_medications',
        type: BOOLEAN,
        prompt: 'Are you currently taking any prescription medications?',
        required: true,
      },
      {
        id: 'medication_list',
        type: TEXT,
        prompt: 'List all current medications, with doses if known',
        required: true,
        showIf: { questionId: 'takes_medications', equals: true },
        validation: { minLength: 2, maxLength: 800 },
      },
      {
        id: 'has_allergies',
        type: BOOLEAN,
        prompt: 'Do you have any drug or other allergies?',
        required: true,
      },
      {
        id: 'allergy_list',
        type: TEXT,
        prompt: 'List your allergies and the reaction each causes',
        required: true,
        showIf: { questionId: 'has_allergies', equals: true },
        validation: { minLength: 2, maxLength: 500 },
      },
      {
        // GLP-1 hypersensitivity is an absolute contraindication.
        id: 'glp1_allergy',
        type: SINGLE_SELECT,
        prompt: 'Have you ever had an allergic reaction to a GLP-1 medication (e.g. semaglutide, tirzepatide, liraglutide)?',
        required: true,
        showIf: { program: PROGRAM.WEIGHT_MANAGEMENT },
        options: [
          { value: 'no', label: 'No' },
          { value: 'yes', label: 'Yes' },
          { value: 'never_taken', label: 'I have never taken one' },
        ],
        redFlag: {
          when: { questionId: 'glp1_allergy', equals: 'yes' },
          reason: 'Prior allergic reaction to a GLP-1 medication — a known hypersensitivity contraindicates therapy.',
        },
      },
    ],
  },

  // -- STEP 8 — Pregnancy & breastfeeding (female branch only) --------------
  {
    id: 'pregnancy_screening',
    order: 8,
    title: 'Pregnancy & breastfeeding',
    help: 'Many of these treatments are not safe during pregnancy or while breastfeeding. These questions apply because you indicated female sex at birth.',
    // DYNAMIC BRANCH: shown only for female (or intersex) patients.
    showIf: { questionId: 'sex_at_birth', in: ['female', 'intersex'] },
    questions: [
      {
        id: 'is_pregnant',
        type: SINGLE_SELECT,
        prompt: 'Are you currently pregnant, or do you think you might be?',
        required: true,
        options: [
          { value: 'no', label: 'No' },
          { value: 'yes', label: 'Yes' },
          { value: 'unsure', label: 'Not sure' },
        ],
        redFlag: {
          when: { questionId: 'is_pregnant', in: ['yes', 'unsure'] },
          reason: 'Patient is or may be pregnant — GLP-1, hormone, and peptide therapies are contraindicated in pregnancy.',
        },
      },
      {
        id: 'is_breastfeeding',
        type: BOOLEAN,
        prompt: 'Are you currently breastfeeding?',
        required: true,
        redFlag: {
          when: { questionId: 'is_breastfeeding', equals: true },
          reason: 'Patient is breastfeeding — these therapies are contraindicated while breastfeeding.',
        },
      },
      {
        id: 'planning_pregnancy',
        type: BOOLEAN,
        prompt: 'Are you planning to become pregnant in the next 6 months?',
        required: true,
      },
      {
        id: 'contraception',
        type: SINGLE_SELECT,
        prompt: 'Are you using a reliable form of contraception?',
        required: true,
        showIf: { questionId: 'planning_pregnancy', equals: false },
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_applicable', label: 'Not applicable' },
        ],
      },
    ],
  },

  // -- STEP 9 — Condition-specific clinical questions (program branches) ----
  {
    id: 'condition_specific',
    order: 9,
    title: 'Program-specific questions',
    help: 'These questions are specific to the treatment you selected.',
    questions: [
      // --- Weight management ---
      {
        id: 'wm_prior_weight_methods',
        type: MULTI_SELECT,
        prompt: 'Which weight-loss methods have you tried before?',
        required: false,
        showIf: { program: PROGRAM.WEIGHT_MANAGEMENT },
        options: [
          { value: 'diet_exercise', label: 'Diet and exercise' },
          { value: 'commercial_program', label: 'Commercial program (e.g. WW)' },
          { value: 'prescription_meds', label: 'Prescription weight-loss medication' },
          { value: 'glp1', label: 'GLP-1 medication' },
          { value: 'bariatric_surgery', label: 'Bariatric surgery' },
          { value: 'none', label: 'None' },
        ],
      },
      {
        id: 'wm_diabetic_retinopathy',
        type: BOOLEAN,
        prompt: 'Have you been diagnosed with diabetic retinopathy?',
        required: true,
        showIf: { program: PROGRAM.WEIGHT_MANAGEMENT },
      },
      // --- TRT / hormone ---
      {
        id: 'trt_symptoms',
        type: MULTI_SELECT,
        prompt: 'Which symptoms are you experiencing?',
        required: true,
        showIf: { program: PROGRAM.TRT },
        options: [
          { value: 'low_energy', label: 'Low energy / fatigue' },
          { value: 'low_libido', label: 'Low libido' },
          { value: 'mood_changes', label: 'Mood changes / irritability' },
          { value: 'loss_of_muscle', label: 'Loss of muscle mass' },
          { value: 'difficulty_concentrating', label: 'Difficulty concentrating' },
          { value: 'sleep_problems', label: 'Sleep problems' },
        ],
      },
      {
        id: 'trt_recent_testosterone_lab',
        type: SINGLE_SELECT,
        prompt: 'Have you had a blood test for testosterone in the last 12 months?',
        required: true,
        showIf: { program: PROGRAM.TRT },
        options: [
          { value: 'yes_will_upload', label: 'Yes — I can upload the results' },
          { value: 'yes_no_results', label: 'Yes — but I do not have the results' },
          { value: 'no', label: 'No' },
        ],
      },
      {
        id: 'trt_prostate_history',
        type: SINGLE_SELECT,
        prompt: 'Have you ever been diagnosed with prostate or breast cancer?',
        required: true,
        showIf: { program: PROGRAM.TRT },
        options: [
          { value: 'no', label: 'No' },
          { value: 'yes', label: 'Yes' },
        ],
        redFlag: {
          when: { questionId: 'trt_prostate_history', equals: 'yes' },
          reason: 'History of prostate or breast cancer — testosterone therapy is contraindicated.',
        },
      },
      {
        id: 'trt_fertility_plans',
        type: BOOLEAN,
        prompt: 'Are you currently trying to conceive a child?',
        required: true,
        showIf: { program: PROGRAM.TRT },
      },
      // --- Peptide therapy ---
      {
        id: 'pep_goals',
        type: MULTI_SELECT,
        prompt: 'What are your goals with peptide therapy?',
        required: true,
        showIf: { program: PROGRAM.PEPTIDE },
        options: [
          { value: 'recovery', label: 'Injury recovery / tissue repair' },
          { value: 'body_composition', label: 'Body composition' },
          { value: 'sleep', label: 'Sleep quality' },
          { value: 'energy', label: 'Energy / vitality' },
          { value: 'skin', label: 'Skin / hair' },
        ],
      },
      {
        id: 'pep_active_cancer',
        type: BOOLEAN,
        prompt: 'Do you currently have an active cancer diagnosis or are in active cancer treatment?',
        required: true,
        showIf: { programIn: [PROGRAM.PEPTIDE, PROGRAM.LONGEVITY] },
        redFlag: {
          when: { questionId: 'pep_active_cancer', equals: true },
          reason: 'Active cancer — growth-factor and peptide therapies are contraindicated during active malignancy.',
        },
      },
      // --- Sexual health ---
      {
        id: 'sh_cardiovascular',
        type: SINGLE_SELECT,
        prompt: 'Have you had a heart attack, stroke, or chest pain with exertion in the last 6 months?',
        required: true,
        showIf: { program: PROGRAM.SEXUAL_HEALTH },
        options: [
          { value: 'no', label: 'No' },
          { value: 'yes', label: 'Yes' },
        ],
        redFlag: {
          when: { questionId: 'sh_cardiovascular', equals: 'yes' },
          reason: 'Recent cardiovascular event — sexual-health therapies require in-person cardiac clearance first.',
        },
      },
      {
        id: 'sh_nitrate_use',
        type: BOOLEAN,
        prompt: 'Do you take any nitrate medication (e.g. nitroglycerin, isosorbide)?',
        required: true,
        showIf: { program: PROGRAM.SEXUAL_HEALTH },
        redFlag: {
          when: { questionId: 'sh_nitrate_use', equals: true },
          reason: 'Concurrent nitrate use — a dangerous interaction contraindicates ED therapy.',
        },
      },
      // --- Women's wellness ---
      {
        id: 'ww_focus',
        type: MULTI_SELECT,
        prompt: 'What would you like to focus on?',
        required: true,
        showIf: { program: PROGRAM.WOMENS_WELLNESS },
        options: [
          { value: 'menopause', label: 'Menopause / perimenopause symptoms' },
          { value: 'libido', label: 'Libido' },
          { value: 'energy', label: 'Energy' },
          { value: 'mood', label: 'Mood' },
          { value: 'skin_hair', label: 'Skin / hair' },
        ],
      },
      {
        id: 'ww_hormone_sensitive_history',
        type: SINGLE_SELECT,
        prompt: 'Have you ever had a hormone-sensitive cancer (breast, ovarian, or uterine)?',
        required: true,
        showIf: { program: PROGRAM.WOMENS_WELLNESS },
        options: [
          { value: 'no', label: 'No' },
          { value: 'yes', label: 'Yes' },
        ],
        redFlag: {
          when: { questionId: 'ww_hormone_sensitive_history', equals: 'yes' },
          reason: 'History of hormone-sensitive cancer — hormone therapy is contraindicated.',
        },
      },
      // --- Longevity ---
      {
        id: 'lon_goals',
        type: MULTI_SELECT,
        prompt: 'What are your longevity & wellness goals?',
        required: true,
        showIf: { program: PROGRAM.LONGEVITY },
        options: [
          { value: 'energy', label: 'Energy / cellular health' },
          { value: 'cognition', label: 'Cognition / focus' },
          { value: 'recovery', label: 'Recovery' },
          { value: 'general', label: 'General wellness' },
        ],
      },
    ],
  },

  // -- STEP 10 — Prior treatment history (program-aware) --------------------
  {
    id: 'prior_treatment',
    order: 10,
    title: 'Prior treatment with this medication',
    help: 'If you have used this type of treatment before, the clinician needs the details to dose you safely.',
    questions: [
      {
        id: 'used_before',
        type: BOOLEAN,
        prompt: 'Have you previously used a medication in this program?',
        required: true,
      },
      {
        id: 'last_dose',
        type: TEXT,
        prompt: 'What medication and dose did you last take, and when?',
        required: true,
        showIf: { questionId: 'used_before', equals: true },
        validation: { minLength: 2, maxLength: 300 },
      },
      {
        id: 'prior_side_effects',
        type: TEXT,
        prompt: 'Did you experience any side effects? Describe them (optional)',
        required: false,
        showIf: { questionId: 'used_before', equals: true },
        validation: { maxLength: 500 },
      },
      {
        id: 'wm_current_glp1_dose',
        type: SINGLE_SELECT,
        prompt: 'Are you currently on a GLP-1 and looking to continue or increase your dose?',
        required: true,
        showIf: {
          all: [
            { program: PROGRAM.WEIGHT_MANAGEMENT },
            { questionId: 'used_before', equals: true },
          ],
        },
        options: [
          { value: 'continue_same', label: 'Continue the same dose' },
          { value: 'increase', label: 'Increase / titrate up' },
          { value: 'restart', label: 'Restarting after a break' },
        ],
      },
    ],
  },

  // -- STEP 11 — Pharmacy & shipping preferences ----------------------------
  {
    id: 'pharmacy_preferences',
    order: 11,
    title: 'Pharmacy & shipping',
    help: 'Your medication is compounded and shipped directly to you. Confirm how you would like to receive it.',
    questions: [
      {
        id: 'shipping_speed',
        type: SINGLE_SELECT,
        prompt: 'Preferred shipping speed',
        required: true,
        options: [
          { value: 'standard', label: 'Standard (3-5 business days)' },
          { value: 'expedited', label: 'Expedited (1-2 business days)' },
        ],
      },
      {
        id: 'temperature_sensitive_ack',
        type: BOOLEAN,
        prompt: 'I understand some medications ship cold and require prompt refrigeration on arrival.',
        required: true,
      },
      {
        id: 'delivery_notes',
        type: TEXT,
        prompt: 'Delivery instructions (optional)',
        required: false,
        validation: { maxLength: 200 },
      },
    ],
  },

  // -- STEP 12 — Identity verification --------------------------------------
  {
    id: 'id_verification',
    order: 12,
    title: 'Identity verification',
    help: 'State and federal rules require us to verify your identity before a clinician can prescribe. Upload a clear photo of your government-issued ID.',
    questions: [
      {
        id: 'gov_id_upload',
        type: FILE_UPLOAD_REF,
        prompt: 'Government-issued photo ID (front)',
        help: "Driver's license, state ID, or passport. The name must match your legal name above.",
        required: true,
      },
      {
        id: 'selfie_upload',
        type: FILE_UPLOAD_REF,
        prompt: 'Photo of yourself holding your ID',
        required: true,
      },
      {
        id: 'id_name_matches',
        type: BOOLEAN,
        prompt: 'I confirm the name on my ID matches the legal name I entered.',
        required: true,
        redFlag: {
          when: { questionId: 'id_name_matches', equals: false },
          reason: 'Patient indicates ID name does not match legal name — identity cannot be verified for prescribing.',
        },
      },
      {
        id: 'lab_upload',
        type: FILE_UPLOAD_REF,
        prompt: 'Recent testosterone lab results (optional)',
        required: false,
        showIf: {
          all: [
            { program: PROGRAM.TRT },
            { questionId: 'trt_recent_testosterone_lab', equals: 'yes_will_upload' },
          ],
        },
      },
    ],
  },

  // -- STEP 13 — Consents & attestations ------------------------------------
  {
    id: 'consents',
    order: 13,
    title: 'Consent & review',
    help: 'Please review and agree to the following before submitting your intake for clinician review.',
    questions: [
      {
        id: 'telehealth_consent',
        type: BOOLEAN,
        prompt: 'I consent to receive care via telehealth and understand its limitations.',
        required: true,
        redFlag: {
          when: { questionId: 'telehealth_consent', equals: false },
          reason: 'Telehealth consent not given — care cannot be delivered.',
        },
      },
      {
        id: 'compounded_med_consent',
        type: BOOLEAN,
        prompt: 'I understand my medication may be a compounded preparation that is not FDA-approved.',
        required: true,
        redFlag: {
          when: { questionId: 'compounded_med_consent', equals: false },
          reason: 'Compounded-medication consent not given — these programs dispense compounded preparations.',
        },
      },
      {
        id: 'accuracy_attestation',
        type: BOOLEAN,
        prompt: 'I attest that the information in this intake is true and complete to the best of my knowledge.',
        required: true,
        redFlag: {
          when: { questionId: 'accuracy_attestation', equals: false },
          reason: 'Patient did not attest to accuracy — a clinician cannot rely on the intake.',
        },
      },
      {
        id: 'privacy_consent',
        type: BOOLEAN,
        prompt: 'I have read the Privacy Policy and consent to the processing of my health information.',
        required: true,
      },
      {
        id: 'marketing_opt_in',
        type: BOOLEAN,
        prompt: 'I would like to receive product news and offers (optional).',
        required: false,
      },
    ],
  },
];

if (STEPS.length !== 13) {
  // Guard rail: the flow is contractually a 13-step flow (intake.html says so).
  throw new Error(`questionnaire.js must define exactly 13 steps, found ${STEPS.length}`);
}

/** All steps keyed by id. */
export const STEP_BY_ID = Object.freeze(
  Object.fromEntries(STEPS.map((s) => [s.id, s])),
);

/** Flat list of every question across all steps, each tagged with stepId. */
export const ALL_QUESTIONS = STEPS.flatMap((step) =>
  step.questions.map((q) => ({ ...q, stepId: step.id })),
);

/** All questions keyed by question id. */
export const QUESTION_BY_ID = Object.freeze(
  Object.fromEntries(ALL_QUESTIONS.map((q) => [q.id, q])),
);

/** Every question that carries a red-flag rule. */
export const RED_FLAG_QUESTIONS = ALL_QUESTIONS.filter((q) => q.redFlag);

/**
 * The questionnaire as a single serializable object — this is what the
 * frontend fetches to render the flow, and what GET /api/intake/questionnaire
 * returns.
 */
export const questionnaire = Object.freeze({
  version: '1.0.0',
  totalSteps: STEPS.length,
  steps: STEPS,
});
