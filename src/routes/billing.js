const express = require('express');
const stripe = require('../config/stripe');

const router = express.Router();

let josePromise;
let remoteJwks;

async function getJose() {
  if (!josePromise) {
    josePromise = import('jose');
  }

  return josePromise;
}

async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return null;
  }

  const authSupabaseUrl = process.env.AUTH_SUPABASE_URL;

  if (!authSupabaseUrl) {
    throw new Error('Missing AUTH_SUPABASE_URL');
  }

  const baseUrl = authSupabaseUrl.replace(/\/+$/, '');
  const issuer = `${baseUrl}/auth/v1`;

  const { createRemoteJWKSet, jwtVerify } = await getJose();

  if (!remoteJwks) {
    remoteJwks = createRemoteJWKSet(
      new URL(`${issuer}/.well-known/jwks.json`)
    );
  }

  try {
    const { payload } = await jwtVerify(token, remoteJwks, {
      issuer,
      audience: 'authenticated'
    });

    if (!payload.sub) {
      return null;
    }

    return {
      id: payload.sub,
      email:
        typeof payload.email === 'string'
          ? payload.email
          : null
    };

  } catch (error) {
    console.error(
      'AUTH TOKEN VERIFICATION ERROR:',
      error.message
    );

    return null;
  }
}

router.post('/checkout', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user || !user.email) {
      return res.status(401).json({
        success: false,
        error: 'You must be signed in to start a subscription.'
      });
    }

    const frontendUrl = (
      process.env.FRONTEND_URL || 'https://sneaksnipe.com'
    ).replace(/\/+$/, '');

    const requestedSuccessUrl = req.body?.successUrl;
    const requestedCancelUrl = req.body?.cancelUrl;

    const isAllowedFrontendUrl = (value) => {
      if (typeof value !== 'string') {
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

    const successUrl = isAllowedFrontendUrl(
      requestedSuccessUrl
    )
      ? requestedSuccessUrl
      : `${frontendUrl}/scanner`;

    const cancelUrl = isAllowedFrontendUrl(
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
              process.env.STRIPE_INTRO_PRICE_ID,
            quantity: 1
          }
        ],

        payment_intent_data: {
          setup_future_usage: 'off_session'
        },

        success_url:
          `${successUrl}${
            successUrl.includes('?') ? '&' : '?'
          }checkout=success&session_id={CHECKOUT_SESSION_ID}`,

        cancel_url: cancelUrl,

        metadata: {
          plan: 'sneaksnipe_intro',
          intro_days: '7',
          supabase_user_id: user.id
        }
      });

    return res.json({
      success: true,
      url: session.url,
      checkoutUrl: session.url
    });

  } catch (error) {
    console.error(
      'STRIPE CHECKOUT ERROR:',
      error
    );

    return res.status(500).json({
      success: false,
      error: 'Unable to create checkout session.'
    });
  }
});

module.exports = router;