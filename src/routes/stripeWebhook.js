const stripe = require('../config/stripe');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

async function stripeWebhook(req, res) {
  const signature = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error('WEBHOOK SIGNATURE ERROR:', error.message);

    return res.status(400).send(
      `Webhook Error: ${error.message}`
    );
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      if (
        session.mode === 'payment' &&
        session.payment_status === 'paid' &&
        session.metadata?.plan === 'sneaksnipe_intro'
      ) {
        const supabaseUserId =
          session.metadata?.supabase_user_id;

        if (!supabaseUserId) {
          console.error(
            'WEBHOOK ERROR: Checkout session is missing supabase_user_id'
          );

          return res.status(400).json({
            received: false,
            error: 'Missing Supabase user ID'
          });
        }

        const paymentIntent =
          await stripe.paymentIntents.retrieve(
            session.payment_intent
          );

        const paymentMethod =
          paymentIntent.payment_method;

        if (!paymentMethod) {
          throw new Error(
            'Checkout payment does not have a saved payment method.'
          );
        }

        await stripe.customers.update(
          session.customer,
          {
            invoice_settings: {
              default_payment_method: paymentMethod
            },

            metadata: {
              supabase_user_id: supabaseUserId
            }
          }
        );

        const subscription =
          await stripe.subscriptions.create(
            {
              customer: session.customer,

              items: [
                {
                  price:
                    process.env.STRIPE_MONTHLY_PRICE_ID
                }
              ],

              trial_period_days: 7,

              default_payment_method: paymentMethod,

              metadata: {
                intro_checkout_session_id: session.id,
                plan: 'sneaksnipe_membership',
                supabase_user_id: supabaseUserId
              }
            },
            {
              idempotencyKey:
                `sneaksnipe-intro-${session.id}`
            }
          );
const currentPeriodEnd =
  subscription.trial_end
    ? new Date(subscription.trial_end * 1000).toISOString()
    : null;

const { error: subscriptionError } =
  await supabase
    .from('subscriptions')
    .upsert(
      {
        user_id: supabaseUserId,
        stripe_customer_id: session.customer,
        stripe_subscription_id: subscription.id,
        status: subscription.status,
        current_period_end: currentPeriodEnd,
        cancel_at_period_end:
          subscription.cancel_at_period_end ?? false,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: 'user_id'
      }
    );

if (subscriptionError) {
  throw new Error(
    `Failed to save subscription to Supabase: ${subscriptionError.message}`
  );
}
        console.log(
          'SneakSnipe subscription created:',
          subscription.id
        );

        console.log(
          'Subscription linked to Supabase user:',
          supabaseUserId
        );
      }
    }

    return res.json({
      received: true
    });

  } catch (error) {
    console.error(
      'WEBHOOK PROCESSING ERROR:',
      error
    );

    return res.status(500).json({
      received: false
    });
  }
}

module.exports = stripeWebhook;