// scripts/test-stripe.js
// Runnable end-to-end exercise of the Stripe payment-on-approval integration.
//
// Run:  node scripts/test-stripe.js   (or: npm run test:stripe)
//
// THE BUSINESS RULE under test:
//   - Completing intake / checkout creates a SetupIntent — NO charge.
//   - Order -> APPROVED  => a Stripe Subscription is created (billing begins).
//   - Order -> DECLINED  => NO subscription is ever created.
//
// It runs entirely OFFLINE: there is no Stripe account and no credentials, so
// the Stripe client resolves to an in-process MOCK built to Stripe's
// documented object shapes (src/clients/stripeClient.js). No network calls
// leave the process. This proves the integration WIRING and the business
// rule, not Stripe's own behaviour — that needs Stripe test mode at onboarding.
import {
  capturePaymentMethod,
  recordSavedPaymentMethod,
  startSubscriptionOnApproval,
  getBillingForOrder,
  BILLING_STATE,
  __resetBillingStore,
} from '../src/services/stripeService.js';
import {
  handleSteadyMDDecision,
} from '../src/services/orchestrator.js';
import { createOrder, ORDER_STATE, transitionOrder } from '../src/services/orderService.js';
import { createPatient, __resetPatientStore } from '../src/services/patientService.js';
import { getStripe, isStripeScaffold, __resetStripeClient } from '../src/clients/stripeClient.js';

function hr(label) {
  console.log('\n' + '='.repeat(72));
  console.log(label);
  console.log('='.repeat(72));
}

const checks = [];
function check(label, ok) {
  checks.push([label, !!ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

// Build a minimal order in CLINICIAN_REVIEW (the state from which a SteadyMD
// decision is processed), owned by a patient.
function seedOrderInReview(patientId, productIds) {
  const order = createOrder({
    intake: {
      patient: { patientId, firstName: 'Test', lastName: 'Patient', email: 'x@example.com' },
      patientId,
      productIds,
      program: 'weight_management',
      answers: {},
    },
  });
  // INTAKE_SUBMITTED -> CLINICIAN_REVIEW so the decision handler can run.
  transitionOrder(order.id, ORDER_STATE.CLINICIAN_REVIEW, {});
  return order;
}

async function main() {
  __resetStripeClient();
  __resetBillingStore();
  __resetPatientStore();

  hr('SETUP');
  console.log('  Stripe scaffold mode :', isStripeScaffold(), '(no real account — using mock)');
  check('running against the offline Stripe mock', isStripeScaffold() === true);

  const stripe = await getStripe();
  check('Stripe client is the mock', stripe.__mock === true);

  // A patient (from the auth layer) — needed for a Stripe Customer.
  const patient = createPatient({
    email: `stripe-test+${Date.now()}@example.com`,
    passwordHash: 'argon2id$placeholder',
    firstName: 'Pat',
    lastName: 'Ient',
  });

  // ========================================================================
  // SCENARIO A — intake / checkout: SetupIntent created, NO charge.
  // ========================================================================
  hr('SCENARIO A — intake/checkout creates a SetupIntent, NO charge');
  const orderA = seedOrderInReview(patient.id, ['glp1-semaglutide']);

  const capture = await capturePaymentMethod({ orderId: orderA.id, patientId: patient.id });
  console.log('  setupIntentId   :', capture.setupIntentId);
  console.log('  stripeCustomer  :', capture.stripeCustomerId);
  console.log('  billingState    :', capture.billingState);

  check('a SetupIntent was created', /^seti_/.test(capture.setupIntentId));
  check('a Stripe Customer was created', /^cus_/.test(capture.stripeCustomerId));
  check('a client secret is returned for Stripe.js', typeof capture.clientSecret === 'string' && capture.clientSecret.length > 0);

  const billingA1 = getBillingForOrder(orderA.id);
  check('billing state is PENDING_PAYMENT_METHOD', billingA1.state === BILLING_STATE.PENDING_PAYMENT_METHOD);
  check('NO subscription exists after intake', billingA1.subscriptionId === null);
  check('NO charge: no invoice recorded after intake', billingA1.lastInvoice === null);

  // SetupIntent itself: status is a SETUP status, never a paid/charge status.
  const si = await stripe.setupIntents.retrieve(capture.setupIntentId);
  check('SetupIntent.object is "setup_intent" (not a charge)', si.object === 'setup_intent');
  check('SetupIntent.usage is "off_session" (chargeable later)', si.usage === 'off_session');

  // Patient confirms the card on the client; we record the saved PaymentMethod.
  await recordSavedPaymentMethod({ orderId: orderA.id, paymentMethodId: 'pm_test_visa_offsession' });
  const billingA2 = getBillingForOrder(orderA.id);
  check('after card saved, state is PAYMENT_METHOD_SAVED', billingA2.state === BILLING_STATE.PAYMENT_METHOD_SAVED);
  check('still NO subscription after card saved', billingA2.subscriptionId === null);

  // ========================================================================
  // SCENARIO B — order APPROVED => Subscription created (billing begins).
  // ========================================================================
  hr('SCENARIO B — clinician APPROVES => Stripe Subscription is created');
  const approved = await handleSteadyMDDecision({
    orderId: orderA.id,
    decision: 'approved',
    caseId: 'case-approve-1',
  });
  check('order transitioned past APPROVED', approved.state === ORDER_STATE.APPROVED || approved.state === ORDER_STATE.ROUTED_TO_PHARMACY);

  const billingB = getBillingForOrder(orderA.id);
  console.log('  subscriptionId  :', billingB.subscriptionId);
  console.log('  billingState    :', billingB.state);
  console.log('  stripePriceId   :', billingB.stripePriceId);

  check('a Subscription WAS created on approval', /^sub_/.test(billingB.subscriptionId || ''));
  check('billing state is SUBSCRIPTION_ACTIVE', billingB.state === BILLING_STATE.SUBSCRIPTION_ACTIVE);
  check('subscription is billed against a Price id', /^price_/.test(billingB.stripePriceId || ''));

  const sub = await stripe.subscriptions.retrieve(billingB.subscriptionId);
  check('Subscription.object is "subscription"', sub.object === 'subscription');
  check('Subscription is on the patient\'s Customer', sub.customer === capture.stripeCustomerId);

  // Idempotency: re-running approval must NOT create a second subscription.
  const billingBefore = billingB.subscriptionId;
  const reapprove = await startSubscriptionOnApproval(orderA.id);
  check('re-approval is idempotent — no duplicate subscription', reapprove.subscriptionId === billingBefore && reapprove.created === false);

  // ========================================================================
  // SCENARIO C — order DECLINED => NO Subscription, NO charge, ever.
  // ========================================================================
  hr('SCENARIO C — clinician DECLINES => NO subscription, NO charge');
  const orderC = seedOrderInReview(patient.id, ['glp1-tirzepatide']);
  // The patient saved a card at intake even though they end up declined.
  await capturePaymentMethod({ orderId: orderC.id, patientId: patient.id });
  await recordSavedPaymentMethod({ orderId: orderC.id, paymentMethodId: 'pm_test_visa_offsession' });

  const declined = await handleSteadyMDDecision({
    orderId: orderC.id,
    decision: 'declined',
    caseId: 'case-decline-1',
  });
  check('order transitioned to DECLINED', declined.state === ORDER_STATE.DECLINED);

  const billingC = getBillingForOrder(orderC.id);
  console.log('  billingState    :', billingC.state);
  console.log('  subscriptionId  :', billingC.subscriptionId);

  check('NO subscription created for a declined order', billingC.subscriptionId === null);
  check('declined order is marked NOT_BILLABLE', billingC.state === BILLING_STATE.NOT_BILLABLE);
  check('NO charge: no invoice on a declined order', billingC.lastInvoice === null);

  // ========================================================================
  // SCENARIO D — recurring-invoice webhook updates billing state.
  // ========================================================================
  hr('SCENARIO D — Stripe webhook signature verification + invoice events');
  const { config } = await import('../src/config.js');
  const { applyInvoicePaid, applyInvoicePaymentFailed } = await import('../src/services/stripeService.js');

  // Build an invoice.paid event the way Stripe would, and verify the signature.
  const eventPaid = {
    id: 'evt_test_paid',
    type: 'invoice.paid',
    data: { object: { id: 'in_test_1', subscription: billingB.subscriptionId, metadata: { pnrx_order_id: orderA.id } } },
  };
  const rawPaid = JSON.stringify(eventPaid);
  const goodSig = stripe.webhooks.__signPayload(rawPaid, config.stripe.webhookSecret);
  let verified = null;
  try {
    verified = stripe.webhooks.constructEvent(rawPaid, goodSig, config.stripe.webhookSecret);
  } catch (e) {
    verified = null;
  }
  check('a correctly-signed webhook passes verification', verified && verified.type === 'invoice.paid');

  // A tampered / wrong signature must be rejected.
  let rejected = false;
  try {
    stripe.webhooks.constructEvent(rawPaid, 't=1,v1=deadbeef', config.stripe.webhookSecret);
  } catch (e) {
    rejected = true;
  }
  check('a bad webhook signature is rejected', rejected === true);

  applyInvoicePaid(verified.data.object);
  const billingD1 = getBillingForOrder(orderA.id);
  check('invoice.paid keeps subscription SUBSCRIPTION_ACTIVE', billingD1.state === BILLING_STATE.SUBSCRIPTION_ACTIVE);
  check('invoice.paid records the paid invoice', billingD1.lastInvoice && billingD1.lastInvoice.status === 'paid');

  applyInvoicePaymentFailed({ id: 'in_test_2', subscription: billingB.subscriptionId, metadata: { pnrx_order_id: orderA.id } });
  const billingD2 = getBillingForOrder(orderA.id);
  check('invoice.payment_failed moves billing to PAYMENT_FAILED', billingD2.state === BILLING_STATE.PAYMENT_FAILED);

  // --- Results -------------------------------------------------------------
  hr('RESULTS');
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed.`);
  console.log('\nProven offline against the documented Stripe shapes:');
  console.log('  - intake/checkout      -> SetupIntent created, NO charge');
  console.log('  - order APPROVED       -> Subscription created (billing begins)');
  console.log('  - order DECLINED       -> NO subscription, NO charge, ever');
  console.log('  - idempotency, signed-webhook verification, invoice events');
  if (passed !== checks.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('test-stripe.js failed:', err);
  process.exitCode = 1;
});
