const express = require('express');
const stripe = require('../config/stripe');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

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

// Get the real logged-in SneakSnipe user from their Supabase token.
async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return null;
  }

  const {
    data: { user },
    error
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    return null;
  }

  return user;
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

    // Lovable already sends these URLs.
    // We only allow them when they point back to the same frontend origin.
    const requestedSuccessUrl = req.body?.successUrl;
    const requestedCancelUrl = req.body?.cancelUrl;

    const isAllowedFrontendUrl = (value) => {
      if (typeof value !== 'string') return false;

      try {
        return new URL(value).origin === new URL(frontendUrl).origin;
      } catch {
        return false;
      }
    };

    const successUrl = isAllowedFrontendUrl(requestedSuccessUrl)
      ? requestedSuccessUrl
      : `${frontendUrl}/scanner`;

    const cancelUrl = isAllowedFrontendUrl(requestedCancelUrl)
      ? requestedCancelUrl
      : `${frontendUrl}/plans`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',

      customer_creation: 'always',
      customer_email: user.email,

      line_items: [
        {
          price: process.env.STRIPE_INTRO_PRICE_ID,
          quantity: 1
        }
      ],

      payment_intent_data: {
        setup_future_usage: 'off_session'
      },

      success_url:
        `${successUrl}${successUrl.includes('?') ? '&' : '?'}checkout=success&session_id={CHECKOUT_SESSION_ID}`,

      cancel_url: cancelUrl,

      metadata: {
        plan: 'sneaksnipe_intro',
        intro_days: '7',

        // This ties the Stripe Checkout Session to the real
        // authenticated Supabase account.
        supabase_user_id: user.id
      }
    });

    return res.json({
      success: true,

      // Lovable's billing.ts expects "url".
      url: session.url,

      // Keep this temporarily so our previous tests don't break.
      checkoutUrl: session.url
    });

  } catch (error) {
    console.error('STRIPE CHECKOUT ERROR:', error);

    return res.status(500).json({
      success: false,
      error: 'Unable to create checkout session.'
    });
  }
});

module.exports = router;