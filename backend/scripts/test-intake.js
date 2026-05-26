// scripts/test-intake.js
// Runnable end-to-end exercise of the dynamic 13-step intake questionnaire and
// the SteadyMD async-visit payload builder.
//
// Run:  node scripts/test-intake.js   (or: npm test)
//
// It submits three sample intakes through the real orchestrator path
// (validate -> red-flag screen -> build SteadyMD payload -> submit async visit
// stub):
//   1. Weight management — female patient (exercises the pregnancy-screening
//      branch that only shows for female sex at birth).
//   2. TRT — male patient (exercises the TRT condition-specific branch; the
//      pregnancy step is correctly skipped).
//   3. Weight management — female patient who IS pregnant (exercises the
//      red-flag / contraindication gate — declined before reaching a clinician).
//
// No real network calls are made; steadymdClient is stubbed.

import { handleIntakeV2 } from '../src/services/orchestrator.js';
import { questionnaire } from '../src/intake/questionnaire.js';

function hr(label) {
  console.log('\n' + '='.repeat(72));
  console.log(label);
  console.log('='.repeat(72));
}

function show(payloadResult) {
  const { order, validation, steadymdPayload } = payloadResult;
  console.log('order.state        :', order.state);
  console.log('program            :', validation.program);
  console.log('eligible           :', validation.eligible);
  console.log('visible steps      :', validation.visibleStepIds.join(', '));
  if (validation.warnings.length) {
    console.log('warnings           :', validation.warnings);
  }
  if (validation.redFlags.length) {
    console.log('RED FLAGS          :');
    for (const f of validation.redFlags) {
      console.log(`  - [${f.questionId}] ${f.reason}`);
    }
  }
  if (steadymdPayload) {
    console.log('\n--- SteadyMD async-visit payload ---');
    console.log(JSON.stringify(steadymdPayload, null, 2));
  } else {
    console.log('\n(no SteadyMD payload — intake was ineligible and declined)');
  }
}

async function main() {
  hr(`Questionnaire definition — v${questionnaire.version}, ${questionnaire.totalSteps} steps`);
  for (const step of questionnaire.steps) {
    const branch = step.showIf ? '  [conditional]' : '';
    console.log(`  ${String(step.order).padStart(2)}. ${step.title}${branch}`);
  }

  // --- Case 1: Weight management, female (pregnancy branch active) ---------
  hr('CASE 1 — Weight management, FEMALE patient (pregnancy branch shown)');
  const case1 = await handleIntakeV2({
    patient: {
      firstName: 'Jane',
      lastName: 'Doe',
      dateOfBirth: '1990-04-12',
      email: 'jane.doe@example.com',
      phone: '5550100001',
    },
    productIds: ['glp1-semaglutide'],
    answers: {
      sex_at_birth: 'female',
      gender_identity: 'woman',
      program: 'weight_management',
      legal_first_name: 'Jane',
      legal_last_name: 'Doe',
      date_of_birth: '1990-04-12',
      email: 'jane.doe@example.com',
      phone: '5550100001',
      state_of_care: 'FL',
      shipping_address_line1: '100 Palm Ave',
      shipping_city: 'Miami',
      shipping_zip: '33101',
      height_inches: 65,
      weight_lbs: 198,
      goal_weight_lbs: 150,
      bmi_acknowledgement: true,
      conditions: ['high_blood_pressure'],
      mtc_men2_history: 'no',
      takes_medications: true,
      medication_list: 'Lisinopril 10mg daily',
      has_allergies: false,
      glp1_allergy: 'never_taken',
      is_pregnant: 'no',
      is_breastfeeding: false,
      planning_pregnancy: false,
      contraception: 'yes',
      wm_prior_weight_methods: ['diet_exercise', 'commercial_program'],
      wm_diabetic_retinopathy: false,
      used_before: false,
      shipping_speed: 'standard',
      temperature_sensitive_ack: true,
      gov_id_upload: 'upload-ref-id-aaaa1111',
      selfie_upload: 'upload-ref-id-bbbb2222',
      id_name_matches: true,
      telehealth_consent: true,
      compounded_med_consent: true,
      accuracy_attestation: true,
      privacy_consent: true,
    },
  });
  show(case1);

  // --- Case 2: TRT, male (pregnancy branch correctly skipped) --------------
  hr('CASE 2 — TRT, MALE patient (pregnancy branch skipped, TRT branch shown)');
  const case2 = await handleIntakeV2({
    patient: {
      firstName: 'John',
      lastName: 'Smith',
      dateOfBirth: '1985-09-30',
      email: 'john.smith@example.com',
      phone: '5550100002',
    },
    productIds: ['hrm-sermorelin'],
    answers: {
      sex_at_birth: 'male',
      gender_identity: 'man',
      program: 'trt',
      legal_first_name: 'John',
      legal_last_name: 'Smith',
      date_of_birth: '1985-09-30',
      email: 'john.smith@example.com',
      phone: '5550100002',
      state_of_care: 'TX',
      shipping_address_line1: '42 Oak Street',
      shipping_city: 'Austin',
      shipping_zip: '78701',
      height_inches: 71,
      weight_lbs: 205,
      conditions: ['none'],
      takes_medications: false,
      has_allergies: false,
      trt_symptoms: ['low_energy', 'low_libido', 'loss_of_muscle'],
      trt_recent_testosterone_lab: 'yes_will_upload',
      trt_prostate_history: 'no',
      trt_fertility_plans: false,
      used_before: false,
      shipping_speed: 'expedited',
      temperature_sensitive_ack: true,
      gov_id_upload: 'upload-ref-id-cccc3333',
      selfie_upload: 'upload-ref-id-dddd4444',
      id_name_matches: true,
      lab_upload: 'upload-ref-id-eeee5555',
      telehealth_consent: true,
      compounded_med_consent: true,
      accuracy_attestation: true,
      privacy_consent: true,
    },
  });
  show(case2);

  // --- Case 3: Weight management, pregnant (red-flag gate) -----------------
  hr('CASE 3 — Weight management, FEMALE + PREGNANT (red-flag: declined)');
  const case3 = await handleIntakeV2({
    patient: {
      firstName: 'Mary',
      lastName: 'Jones',
      dateOfBirth: '1992-02-02',
      email: 'mary.jones@example.com',
      phone: '5550100003',
    },
    productIds: ['glp1-tirzepatide'],
    answers: {
      sex_at_birth: 'female',
      program: 'weight_management',
      legal_first_name: 'Mary',
      legal_last_name: 'Jones',
      date_of_birth: '1992-02-02',
      email: 'mary.jones@example.com',
      phone: '5550100003',
      state_of_care: 'CA',
      shipping_address_line1: '7 Sunset Blvd',
      shipping_city: 'Los Angeles',
      shipping_zip: '90001',
      height_inches: 64,
      weight_lbs: 185,
      bmi_acknowledgement: true,
      conditions: ['none'],
      mtc_men2_history: 'no',
      takes_medications: false,
      has_allergies: false,
      glp1_allergy: 'never_taken',
      is_pregnant: 'yes', // <-- contraindication red flag
      is_breastfeeding: false,
      planning_pregnancy: true,
      wm_prior_weight_methods: ['none'],
      wm_diabetic_retinopathy: false,
      used_before: false,
      shipping_speed: 'standard',
      temperature_sensitive_ack: true,
      gov_id_upload: 'upload-ref-id-ffff6666',
      selfie_upload: 'upload-ref-id-gggg7777',
      id_name_matches: true,
      telehealth_consent: true,
      compounded_med_consent: true,
      accuracy_attestation: true,
      privacy_consent: true,
    },
  });
  show(case3);

  // --- Assertions ----------------------------------------------------------
  hr('RESULTS');
  const checks = [
    ['Case 1 eligible + submitted', case1.validation.eligible && case1.order.state === 'CLINICIAN_REVIEW'],
    ['Case 1 pregnancy step visible (female)', case1.validation.visibleStepIds.includes('pregnancy_screening')],
    ['Case 1 SteadyMD payload built', !!case1.steadymdPayload],
    ['Case 1 consultType resolved', case1.steadymdPayload?.consult?.consultType === 'async_weight_management'],
    ['Case 2 eligible + submitted', case2.validation.eligible && case2.order.state === 'CLINICIAN_REVIEW'],
    ['Case 2 pregnancy step skipped (male)', !case2.validation.visibleStepIds.includes('pregnancy_screening')],
    ['Case 2 TRT consultType resolved', case2.steadymdPayload?.consult?.consultType === 'async_hormone_therapy'],
    ['Case 3 ineligible (red flag)', !case3.validation.eligible],
    ['Case 3 declined, no clinician', case3.order.state === 'DECLINED' && case3.steadymdPayload === null],
    ['Case 3 red flag is pregnancy', case3.validation.redFlags.some((f) => f.questionId === 'is_pregnant')],
  ];
  let pass = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (ok) pass += 1;
  }
  console.log(`\n${pass}/${checks.length} checks passed.`);
  if (pass !== checks.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('test-intake.js failed:', err);
  process.exitCode = 1;
});
