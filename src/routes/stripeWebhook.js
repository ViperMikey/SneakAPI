const stripe = require('../config/stripe');
const supabase = require('../config/supabase');

/*
 * Stripe can return IDs either as strings
 * or expanded objects.
 */
function getStripeId(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (
    typeof value === 'object' &&
    typeof value.id === 'string'
  ) {
    return value.id;
  }

  return null;
}

function unixToIso(value) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value)
  ) {
    return null;
  }

  return new Date(
    value * 1000
  ).toISOString();
}

/*
 * Stripe moved current_period_end from the
 * Subscription itself to Subscription Items
 * in newer API versions.
 *
 * This supports both old and new Stripe versions.
 */
function getSubscriptionPeriodEnd(subscription) {
  /*
   * While the $1 intro is running, trial_end
   * is the date the $30/month billing begins.
   */
  if (
    subscription.status === 'trialing' &&
    typeof subscription.trial_end === 'number'
  ) {
    return unixToIso(
      subscription.trial_end
    );
  }

  /*
   * If Stripe has fully canceled/deleted the
   * subscription, access should end when Stripe
   * says the subscription ended.
   */
  if (
    subscription.status === 'canceled' &&
    typeof subscription.ended_at === 'number'
  ) {
    return unixToIso(
      subscription.ended_at
    );
  }

  /*
   * Newer Stripe API versions store billing
   * periods on each subscription item.
   *
   * SneakSnipe currently has one monthly item,
   * but using the earliest ending item also
   * behaves safely if that ever changes.
   */
  const itemPeriodEnds =
    subscription.items?.data
      ?.map(
        (item) =>
          item.current_period_end
      )
      .filter(
        (value) =>
          typeof value === 'number'
      ) ?? [];

  if (itemPeriodEnds.length > 0) {
    return unixToIso(
      Math.min(...itemPeriodEnds)
    );
  }

  /*
   * Compatibility with older Stripe
   * API versions.
   */
  if (
    typeof subscription.current_period_end ===
    'number'
  ) {
    return unixToIso(
      subscription.current_period_end
    );
  }

  /*
   * Last fallback for canceled subscriptions.
   */
  if (
    typeof subscription.cancel_at === 'number'
  ) {
    return unixToIso(
      subscription.cancel_at
    );
  }

  return null;
}

/*
 * Finds the SneakSnipe account that owns
 * a Stripe subscription.
 */
async function resolveSupabaseUserId(
  subscription,
  fallbackUserId = null
) {
  if (
    typeof subscription.metadata
      ?.supabase_user_id === 'string' &&
    subscription.metadata
      .supabase_user_id
  ) {
    return subscription.metadata
      .supabase_user_id;
  }

  if (fallbackUserId) {
    return fallbackUserId;
  }

  const subscriptionId =
    getStripeId(subscription.id);

  if (subscriptionId) {
    const {
      data,
      error
    } = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq(
        'stripe_subscription_id',
        subscriptionId
      )
      .maybeSingle();

    if (error) {
      throw new Error(
        `Unable to find subscription owner: ${error.message}`
      );
    }

    if (data?.user_id) {
      return data.user_id;
    }
  }

  const customerId =
    getStripeId(
      subscription.customer
    );

  if (customerId) {
    const {
      data,
      error
    } = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq(
        'stripe_customer_id',
        customerId
      )
      .maybeSingle();

    if (error) {
      throw new Error(
        `Unable to find customer owner: ${error.message}`
      );
    }

    if (data?.user_id) {
      return data.user_id;
    }
  }

  return null;
}

/*
 * Synchronizes the current Stripe subscription
 * state into SneakSnipe's subscriptions table.
 *
 * Stripe remains the billing source of truth.
 */
async function syncSubscription(
  subscription,
  fallbackUserId = null
) {
  const supabaseUserId =
    await resolveSupabaseUserId(
      subscription,
      fallbackUserId
    );

  if (!supabaseUserId) {
    throw new Error(
      `Unable to determine SneakSnipe user for Stripe subscription ${subscription.id}`
    );
  }

  const customerId =
    getStripeId(
      subscription.customer
    );

  if (!customerId) {
    throw new Error(
      `Subscription ${subscription.id} has no Stripe customer ID.`
    );
  }

  const currentPeriodEnd =
    getSubscriptionPeriodEnd(
      subscription
    );

  const {
    error
  } = await supabase
    .from('subscriptions')
    .upsert(
      {
        user_id:
          supabaseUserId,

        stripe_customer_id:
          customerId,

        stripe_subscription_id:
          subscription.id,

        status:
          subscription.status,

        current_period_end:
          currentPeriodEnd,

        cancel_at_period_end:
          subscription
            .cancel_at_period_end === true,

        updated_at:
          new Date().toISOString()
      },
      {
        onConflict: 'user_id'
      }
    );

  if (error) {
    throw new Error(
      `Failed to sync subscription to Supabase: ${error.message}`
    );
  }

  console.log(
    'SUBSCRIPTION SYNCED:',
    {
      userId: supabaseUserId,
      subscriptionId:
        subscription.id,
      status:
        subscription.status,
      currentPeriodEnd,
      cancelAtPeriodEnd:
        subscription
          .cancel_at_period_end === true
    }
  );
}

/*
 * Newer Stripe Invoice objects store the
 * subscription reference under:
 *
 * invoice.parent.subscription_details.subscription
 *
 * Older Stripe API versions used:
 *
 * invoice.subscription
 *
 * Support both.
 */
function getInvoiceSubscriptionId(
  invoice
) {
  const parentSubscription =
    invoice.parent
      ?.subscription_details
      ?.subscription;

  const parentId =
    getStripeId(
      parentSubscription
    );

  if (parentId) {
    return parentId;
  }

  return getStripeId(
    invoice.subscription
  );
}

/*
 * After the $1 Checkout completes:
 *
 * 1. Get the card used for the $1 payment.
 * 2. Save it as the Stripe customer's default.
 * 3. Create the $30/month subscription.
 * 4. Give that subscription a 7-day trial.
 *
 * Because the customer already paid $1 separately,
 * this Stripe "trial" represents the remainder
 * of SneakSnipe's 7-Day Intro Access.
 */
async function handleIntroCheckout(
  session
) {
  if (
    session.mode !== 'payment' ||
    session.payment_status !== 'paid' ||
    session.metadata?.plan !==
      'sneaksnipe_intro'
  ) {
    return;
  }

  const supabaseUserId =
    session.metadata
      ?.supabase_user_id;

  if (!supabaseUserId) {
    throw new Error(
      'Checkout session is missing supabase_user_id.'
    );
  }

  if (
    !process.env
      .STRIPE_MONTHLY_PRICE_ID
  ) {
    throw new Error(
      'Missing STRIPE_MONTHLY_PRICE_ID'
    );
  }

  const customerId =
    getStripeId(
      session.customer
    );

  if (!customerId) {
    throw new Error(
      'Checkout session has no Stripe customer.'
    );
  }

  const paymentIntentId =
    getStripeId(
      session.payment_intent
    );

  if (!paymentIntentId) {
    throw new Error(
      'Checkout session has no PaymentIntent.'
    );
  }

  const paymentIntent =
    await stripe.paymentIntents.retrieve(
      paymentIntentId
    );

  const paymentMethodId =
    getStripeId(
      paymentIntent.payment_method
    );

  if (!paymentMethodId) {
    throw new Error(
      'Checkout payment does not have a saved payment method.'
    );
  }

  /*
   * Make the $1 checkout card the default
   * card for future subscription invoices.
   */
  await stripe.customers.update(
    customerId,
    {
      invoice_settings: {
        default_payment_method:
          paymentMethodId
      },

      metadata: {
        supabase_user_id:
          supabaseUserId
      }
    }
  );

  /*
   * This call is protected by a stable
   * idempotency key.
   *
   * If Stripe retries checkout.session.completed,
   * it will not create a second subscription.
   */
  const subscription =
    await stripe.subscriptions.create(
      {
        customer:
          customerId,

        items: [
          {
            price:
              process.env
                .STRIPE_MONTHLY_PRICE_ID
          }
        ],

        trial_period_days: 7,

        default_payment_method:
          paymentMethodId,

        metadata: {
          intro_checkout_session_id:
            session.id,

          plan:
            'sneaksnipe_membership',

          supabase_user_id:
            supabaseUserId
        }
      },
      {
        idempotencyKey:
          `sneaksnipe-intro-${session.id}`
      }
    );

  await syncSubscription(
    subscription,
    supabaseUserId
  );

  console.log(
    'SNEAKSNIPE INTRO STARTED:',
    {
      userId:
        supabaseUserId,
      checkoutSessionId:
        session.id,
      subscriptionId:
        subscription.id,
      trialEnd:
        subscription.trial_end
    }
  );
}

/*
 * For invoice events, retrieve the current
 * Subscription from Stripe instead of trying
 * to guess access state from the Invoice alone.
 */
async function syncInvoiceSubscription(
  invoice
) {
  const subscriptionId =
    getInvoiceSubscriptionId(
      invoice
    );

  /*
   * Not every Stripe invoice necessarily belongs
   * to a subscription.
   */
  if (!subscriptionId) {
    return;
  }

  const subscription =
    await stripe.subscriptions.retrieve(
      subscriptionId
    );

  await syncSubscription(
    subscription
  );
}

async function stripeWebhook(
  req,
  res
) {
  const signature =
    req.headers[
      'stripe-signature'
    ];

  if (!signature) {
    return res.status(400).send(
      'Missing Stripe signature.'
    );
  }

  if (
    !process.env
      .STRIPE_WEBHOOK_SECRET
  ) {
    console.error(
      'WEBHOOK ERROR: Missing STRIPE_WEBHOOK_SECRET'
    );

    return res.status(500).json({
      received: false
    });
  }

  let event;

  /*
   * server.js already sends this route
   * the raw request body.
   */
  try {
    event =
      stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env
          .STRIPE_WEBHOOK_SECRET
      );
  } catch (error) {
    console.error(
      'WEBHOOK SIGNATURE ERROR:',
      error instanceof Error
        ? error.message
        : String(error)
    );

    return res.status(400).send(
      `Webhook Error: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }

  try {
    switch (event.type) {
      /*
       * $1 successfully paid.
       *
       * Create the recurring $30/month subscription
       * with billing beginning after seven days.
       */
      case 'checkout.session.completed': {
        await handleIntroCheckout(
          event.data.object
        );

        break;
      }

      /*
       * These events keep SneakSnipe synchronized
       * whenever Stripe creates or changes the
       * subscription.
       */
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await syncSubscription(
          event.data.object
        );

        break;
      }

      /*
       * When a recurring invoice succeeds,
       * retrieve the authoritative current
       * Subscription and sync it.
       */
      case 'invoice.paid': {
        await syncInvoiceSubscription(
          event.data.object
        );

        break;
      }

      /*
       * When billing fails, retrieve Stripe's
       * resulting subscription status.
       *
       * If Stripe changes it to past_due,
       * SneakSnipe will receive that status and
       * the frontend will stop granting premium
       * access.
       */
      case 'invoice.payment_failed': {
        await syncInvoiceSubscription(
          event.data.object
        );

        break;
      }

      default: {
        console.log(
          'UNHANDLED STRIPE EVENT:',
          event.type
        );
      }
    }

    return res.json({
      received: true
    });

  } catch (error) {
    console.error(
      'WEBHOOK PROCESSING ERROR:',
      {
        eventId:
          event.id,
        eventType:
          event.type,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      }
    );

    /*
     * Returning 500 tells Stripe that processing
     * failed so Stripe can retry the webhook.
     */
    return res.status(500).json({
      received: false
    });
  }
}

module.exports =
  stripeWebhook;