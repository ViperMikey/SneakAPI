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

/*
 * Verify the Supabase access token sent by the SneakSnipe frontend.
 *
 * This keeps billing endpoints tied to the authenticated
 * SneakSnipe account instead of trusting user IDs from the browser.
 */
async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization;

  if (
    !authHeader ||
    !authHeader.startsWith('Bearer ')
  ) {
    console.error(
      'AUTH ERROR: Missing Authorization header'
    );

    return null;
  }

  const token = authHeader
    .slice(7)
    .trim();

  if (!token) {
    console.error(
      'AUTH ERROR: Empty bearer token'
    );

    return null;
  }

  /*
   * AUTH_SUPABASE_URL is supported for your existing
   * Render setup.
   *
   * Since SneakSnipe auth and backend data now use your
   * own Supabase project, SUPABASE_URL is also a safe fallback.
   */
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

  /*
   * Rebuild the remote JWKS helper if the issuer changes.
   */
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
 *
 * Returns the authoritative subscription record
 * associated with the authenticated Supabase user.
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
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) {
        throw new Error(
          `Unable to read subscription: ${error.message}`
        );
      }

      /*
       * No subscription is valid state.
       *
       * "available" is still effectively true because
       * the billing backend successfully answered.
       */
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
 * Creates the $1 SneakSnipe introductory checkout.
 *
 * The successful checkout webhook later creates
 * the recurring $30/month subscription with its
 * first recurring charge scheduled 7 days later.
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
       * Prevent somebody who already has an active
       * SneakSnipe membership from accidentally
       * creating another subscription.
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
        .eq('user_id', user.id)
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
          error:
            'This account already has a SneakSnipe subscription.'
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

          customer_creation: 'always',

          customer_email: user.email,

          line_items: [
            {
              price:
                process.env
                  .STRIPE_INTRO_PRICE_ID,

              quantity: 1
            }
          ],

          /*
           * Save the payment method so Stripe
           * can charge the recurring subscription
           * after the 7-day introduction.
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
        url: session.url,
        checkoutUrl: session.url
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
          ?.startsWith('sk_test_');

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
 *
 * Opens Stripe's secure Customer Portal.
 *
 * Customers can:
 * - update payment method
 * - view invoices
 * - manage/cancel their subscription
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
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) {
        throw new Error(
          `Unable to read subscription: ${error.message}`
        );
      }

      if (
        !subscription?.stripe_customer_id
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
           * Ignore invalid URL and use
           * the safe default.
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
        url: portalSession.url
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