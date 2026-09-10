const express = require('express');

const stripe = require('../config/stripe');
const supabase = require('../config/supabase');

const router = express.Router();

let josePromise = null;
let remoteJwks = null;
let remoteJwksIssuer = null;

async function getJose() {
  if (!josePromise) {
    josePromise = import('jose');
  }

  return josePromise;
}

async function getAuthenticatedUser(req) {
  const authHeader =
    req.headers.authorization;

  if (
    !authHeader ||
    !authHeader.startsWith('Bearer ')
  ) {
    console.error(
      'AUTH ERROR: Missing Authorization header'
    );

    return null;
  }

  const token =
    authHeader.slice(7).trim();

  if (!token) {
    console.error(
      'AUTH ERROR: Empty bearer token'
    );

    return null;
  }

  const authSupabaseUrl =
    process.env.AUTH_SUPABASE_URL ||
    process.env.SUPABASE_URL;

  if (!authSupabaseUrl) {
    throw new Error(
      'Missing AUTH_SUPABASE_URL / SUPABASE_URL'
    );
  }

  const baseUrl =
    authSupabaseUrl.replace(/\/+$/, '');

  const issuer =
    `${baseUrl}/auth/v1`;

  const {
    createRemoteJWKSet,
    jwtVerify
  } = await getJose();

  if (
    !remoteJwks ||
    remoteJwksIssuer !== issuer
  ) {
    remoteJwks =
      createRemoteJWKSet(
        new URL(
          `${issuer}/.well-known/jwks.json`
        ),
        {
          timeoutDuration: 15000,
          cooldownDuration: 30000,
          cacheMaxAge: 600000
        }
      );

    remoteJwksIssuer = issuer;
  }

  try {
    const { payload } =
      await jwtVerify(
        token,
        remoteJwks,
        {
          issuer,
          audience: 'authenticated'
        }
      );

    if (!payload.sub) {
      console.error(
        'AUTH ERROR: JWT has no user ID'
      );

      return null;
    }

    const email =
      typeof payload.email === 'string'
        ? payload.email
        : null;

    if (!email) {
      console.error(
        'AUTH ERROR: JWT has no email'
      );

      return null;
    }

    return {
      id: payload.sub,
      email
    };

  } catch (error) {
    console.error(
      'AUTH TOKEN VERIFICATION ERROR:',
      error instanceof Error
        ? error.message
        : String(error)
    );

    return null;
  }
}

/*
 * GET /api/billing/status
 */
router.get(
  '/status',
  async (req, res) => {
    try {
      const user =
        await getAuthenticatedUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          error:
            'You must be signed in to view subscription status.'
        });
      }

      const {
        data,
        error
      } = await supabase
        .from('subscriptions')
        .select(
          `
            status,
            current_period_end,
            cancel_at_period_end,
            stripe_customer_id,
            stripe_subscription_id
          `
        )
        .eq(
          'user_id',
          user.id
        )
        .maybeSingle();

      if (error) {
        throw new Error(
          `Unable to read subscription: ${error.message}`
        );
      }

      if (!data) {
        return res.json({
          success: true,
          data: {
            status: 'none',
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false
          }
        });
      }

      return res.json({
        success: true,
        data: {
          status:
            typeof data.status === 'string'
              ? data.status
              : 'none',

          currentPeriodEnd:
            data.current_period_end ||
            null,

          cancelAtPeriodEnd:
            data.cancel_at_period_end === true
        }
      });

    } catch (error) {
      console.error(
        'SUBSCRIPTION STATUS ERROR:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Unable to retrieve subscription status.'
      });
    }
  }
);

/*
 * POST /api/billing/checkout
 *
 * Creates the $1 / 7-day introductory checkout.
 *
 * Each Supabase account may redeem this
 * introductory offer only once.
 */
router.post(
  '/checkout',
  async (req, res) => {
    try {
      const user =
        await getAuthenticatedUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          error:
            'You must be signed in to start a subscription.'
        });
      }

      if (
        !process.env.STRIPE_INTRO_PRICE_ID
      ) {
        throw new Error(
          'Missing STRIPE_INTRO_PRICE_ID'
        );
      }

      if (
        !process.env.STRIPE_SECRET_KEY
      ) {
        throw new Error(
          'Missing STRIPE_SECRET_KEY'
        );
      }

      /*
       * First make sure the account doesn't
       * already have a live Stripe subscription.
       */
      const {
        data: existingSubscription,
        error: existingError
      } = await supabase
        .from('subscriptions')
        .select(
          `
            status,
            current_period_end,
            stripe_customer_id,
            stripe_subscription_id
          `
        )
        .eq(
          'user_id',
          user.id
        )
        .maybeSingle();

      if (existingError) {
        throw new Error(
          `Unable to check existing subscription: ${existingError.message}`
        );
      }

      const existingStatus =
        existingSubscription?.status;

      if (
        existingStatus === 'active' ||
        existingStatus === 'trialing' ||
        existingStatus === 'past_due' ||
        existingStatus === 'incomplete'
      ) {
        return res.status(409).json({
          success: false,
          code:
            'SUBSCRIPTION_ALREADY_EXISTS',
          error:
            'This account already has a SneakSnipe subscription.'
        });
      }

      /*
       * Permanent one-intro-per-account check.
       *
       * intro_usage.user_id is the primary key,
       * and the row is intentionally retained
       * after cancellation or conversion.
       */
      const {
        data: existingIntro,
        error: introError
      } = await supabase
        .from('intro_usage')
        .select(
          `
            user_id,
            intro_started_at,
            intro_ends_at
          `
        )
        .eq(
          'user_id',
          user.id
        )
        .maybeSingle();

      if (introError) {
        throw new Error(
          `Unable to check introductory offer history: ${introError.message}`
        );
      }

      if (existingIntro) {
        return res.status(409).json({
          success: false,
          code:
            'INTRO_ALREADY_USED',
          error:
            'This account has already used the $1 introductory offer.'
        });
      }

      const frontendUrl = (
        process.env.FRONTEND_URL ||
        'https://sneaksnipe.com'
      ).replace(/\/+$/, '');

      const requestedSuccessUrl =
        req.body?.successUrl;

      const requestedCancelUrl =
        req.body?.cancelUrl;

      const isAllowedFrontendUrl =
        (value) => {
          if (
            typeof value !== 'string'
          ) {
            return false;
          }

          try {
            return (
              new URL(value).origin ===
              new URL(frontendUrl).origin
            );
          } catch {
            return false;
          }
        };

      const successUrl =
        isAllowedFrontendUrl(
          requestedSuccessUrl
        )
          ? requestedSuccessUrl
          : `${frontendUrl}/feed`;

      const cancelUrl =
        isAllowedFrontendUrl(
          requestedCancelUrl
        )
          ? requestedCancelUrl
          : `${frontendUrl}/plans`;

      const session =
        await stripe.checkout.sessions.create({
          mode: 'payment',

          customer_creation:
            'always',

          customer_email:
            user.email,

          line_items: [
            {
              price:
                process.env
                  .STRIPE_INTRO_PRICE_ID,

              quantity: 1
            }
          ],

          /*
           * Store the payment method so the
           * $30/month subscription can charge
           * it after the 7-day intro.
           */
          payment_intent_data: {
            setup_future_usage:
              'off_session'
          },

          success_url:
            `${successUrl}${
              successUrl.includes('?')
                ? '&'
                : '?'
            }checkout=success&session_id={CHECKOUT_SESSION_ID}`,

          cancel_url:
            cancelUrl,

          metadata: {
            plan:
              'sneaksnipe_intro',

            intro_days:
              '7',

            supabase_user_id:
              user.id
          }
        });

      return res.json({
        success: true,
        url:
          session.url,
        checkoutUrl:
          session.url
      });

    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      const code =
        error &&
        typeof error === 'object' &&
        'code' in error
          ? error.code
          : null;

      const type =
        error &&
        typeof error === 'object' &&
        'type' in error
          ? error.type
          : null;

      console.error(
        'STRIPE CHECKOUT ERROR:',
        {
          message,
          code,
          type
        }
      );

      const sandbox =
        process.env
          .STRIPE_SECRET_KEY
          ?.startsWith(
            'sk_test_'
          );

      return res.status(500).json({
        success: false,
        error:
          'Unable to create checkout session.',

        ...(sandbox
          ? {
              debug: {
                message,
                code,
                type
              }
            }
          : {})
      });
    }
  }
);

/*
 * POST /api/billing/portal
 */
router.post(
  '/portal',
  async (req, res) => {
    try {
      const user =
        await getAuthenticatedUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          error:
            'You must be signed in to manage your subscription.'
        });
      }

      const {
        data: subscription,
        error
      } = await supabase
        .from('subscriptions')
        .select(
          `
            stripe_customer_id,
            stripe_subscription_id,
            status
          `
        )
        .eq(
          'user_id',
          user.id
        )
        .maybeSingle();

      if (error) {
        throw new Error(
          `Unable to read subscription: ${error.message}`
        );
      }

      if (
        !subscription
          ?.stripe_customer_id
      ) {
        return res.status(404).json({
          success: false,
          error:
            'No billing account was found for this SneakSnipe account.'
        });
      }

      const frontendUrl = (
        process.env.FRONTEND_URL ||
        'https://sneaksnipe.com'
      ).replace(/\/+$/, '');

      const requestedReturnUrl =
        req.body?.returnUrl;

      let returnUrl =
        `${frontendUrl}/account`;

      if (
        typeof requestedReturnUrl ===
        'string'
      ) {
        try {
          if (
            new URL(
              requestedReturnUrl
            ).origin ===
            new URL(
              frontendUrl
            ).origin
          ) {
            returnUrl =
              requestedReturnUrl;
          }
        } catch {
          /*
           * Invalid URL:
           * use safe default instead.
           */
        }
      }

      const portalSession =
        await stripe.billingPortal.sessions.create({
          customer:
            subscription
              .stripe_customer_id,

          return_url:
            returnUrl
        });

      return res.json({
        success: true,
        url:
          portalSession.url
      });

    } catch (error) {
      console.error(
        'STRIPE PORTAL ERROR:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Unable to open subscription management.'
      });
    }
  }
);

module.exports = router;