require('dotenv').config();

const billingRoutes = require('./src/routes/billing');
const stripeWebhook = require('./src/routes/stripeWebhook');
const stockxRoutes = require('./src/routes/stockx');
const stockxMarketRoutes = require('./src/routes/stockxMarket');
const supabase = require('./src/config/supabase');

const express = require('express');
const cors = require('cors');

const {
  getMarketData
} = require('./src/services/marketplace');

const app = express();

app.use(cors());

/*
 * Stripe webhook MUST receive the raw request body.
 * Keep this before express.json().
 */
app.post(
  '/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhook
);

app.use(express.json());

app.use('/api/billing', billingRoutes);
app.use('/api/stockx', stockxRoutes);
app.use('/api/stockx', stockxMarketRoutes);

/*
 * Supabase JWT verification.
 */
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
    return null;
  }

  const token =
    authHeader.slice(7).trim();

  if (!token) {
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
    const {
      payload
    } = await jwtVerify(
      token,
      remoteJwks,
      {
        issuer,
        audience: 'authenticated'
      }
    );

    if (
      typeof payload.sub !== 'string' ||
      !payload.sub
    ) {
      return null;
    }

    return {
      id: payload.sub
    };

  } catch (error) {
    console.error(
      'MARKET AUTH ERROR:',
      error instanceof Error
        ? error.message
        : String(error)
    );

    return null;
  }
}

/*
 * Read the user's current SneakSnipe
 * subscription from our billing table.
 */
async function getSubscriptionAccess(
  userId
) {
  const {
    data,
    error
  } = await supabase
    .from('subscriptions')
    .select(
      `
        status,
        current_period_end,
        cancel_at_period_end
      `
    )
    .eq(
      'user_id',
      userId
    )
    .maybeSingle();

  if (error) {
    throw new Error(
      `Unable to check subscription: ${error.message}`
    );
  }

  if (!data) {
    return {
      hasAccess: false,
      status: 'none',
      currentPeriodEnd: null
    };
  }

  const status =
    typeof data.status === 'string'
      ? data.status
      : 'none';

  const currentPeriodEnd =
    data.current_period_end ||
    null;

  const periodStillValid =
    currentPeriodEnd
      ? new Date(
          currentPeriodEnd
        ).getTime() > Date.now()
      : false;

  /*
   * Normal paid users are unlimited.
   *
   * Trialing users have access, but will
   * be subject to the intro usage caps.
   *
   * A canceled subscription may retain
   * access until its paid/access period ends.
   */
  const hasAccess =
    status === 'active' ||
    status === 'trialing' ||
    (
      status === 'canceled' &&
      periodStillValid
    );

  return {
    hasAccess,
    status,
    currentPeriodEnd
  };
}

/*
 * Atomically consume one Flip Analyzer run.
 *
 * The Supabase function handles:
 *
 * - max 10 runs during intro
 * - simultaneous requests
 * - unlimited use once intro period is over
 */
async function consumeAnalyzerRun(
  userId
) {
  const {
    data,
    error
  } = await supabase.rpc(
    'consume_intro_analyzer',
    {
      p_user_id:
        userId,

      p_limit:
        10
    }
  );

  if (error) {
    throw new Error(
      `Unable to consume Analyzer usage: ${error.message}`
    );
  }

  const result =
    Array.isArray(data)
      ? data[0]
      : data;

  if (!result) {
    throw new Error(
      'Analyzer usage function returned no result.'
    );
  }

  return {
    allowed:
      result.allowed === true,

    used:
      Number(
        result.runs_used ?? 0
      ),

    limit:
      Number(
        result.run_limit ?? 10
      ),

    introEndsAt:
      result.intro_ends_at ||
      null
  };
}

app.get(
  '/health',
  (_req, res) => {
    res.json({
      ok: true,
      service: 'SneakSnipe API'
    });
  }
);

/*
 * Flip Analyzer marketplace lookup.
 *
 * This endpoint now requires:
 *
 * 1. A real logged-in Supabase account.
 * 2. A valid SneakSnipe subscription.
 * 3. During the $1 intro, fewer than
 *    10 Analyzer runs already consumed.
 */
app.get(
  '/api/market/:styleId',
  async (req, res) => {
    try {
      /*
       * Authenticate BEFORE making any
       * marketplace/API calls.
       */
      const user =
        await getAuthenticatedUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          code: 'UNAUTHORIZED',
          error:
            'Your login session has expired. Please sign in again.'
        });
      }

      /*
       * Verify premium access.
       */
      const subscription =
        await getSubscriptionAccess(
          user.id
        );

      if (!subscription.hasAccess) {
        return res.status(403).json({
          success: false,
          code:
            'SUBSCRIPTION_REQUIRED',
          error:
            'An active SneakSnipe subscription is required to use the Flip Analyzer.'
        });
      }

      const styleId =
        req.params.styleId
          .trim()
          .toUpperCase();

      if (!styleId) {
        return res.status(400).json({
          success: false,
          error:
            'A sneaker style code is required.'
        });
      }

      /*
       * Retrieve the marketplace data first.
       *
       * This means a backend/provider failure
       * does NOT waste one of the user's
       * Analyzer runs.
       */
      const data =
        await getMarketData(
          styleId
        );

      let usage = null;

      /*
       * Active $30/month subscribers are
       * unlimited.
       *
       * Trialing users use the intro counter.
       *
       * We also check canceled-but-still-valid
       * subscriptions so an intro cancellation
       * cannot bypass the usage cap.
       */
      if (
        subscription.status ===
          'trialing' ||
        subscription.status ===
          'canceled'
      ) {
        usage =
          await consumeAnalyzerRun(
            user.id
          );

        if (!usage.allowed) {
          return res.status(429).json({
            success: false,
            code:
              'INTRO_ANALYZER_LIMIT_REACHED',

            error:
              'You’ve reached the 10 Flip Analyzer runs included with your $1 introductory access.',

            usage: {
              used:
                usage.used,

              limit:
                usage.limit,

              remaining:
                0,

              introEndsAt:
                usage.introEndsAt
            }
          });
        }
      }

      return res.json({
        success: true,

        data,

        usage:
          usage
            ? {
                used:
                  usage.used,

                limit:
                  usage.limit,

                remaining:
                  Math.max(
                    0,
                    usage.limit -
                      usage.used
                  ),

                introEndsAt:
                  usage.introEndsAt
              }
            : {
                unlimited: true
              }
      });

    } catch (error) {
      console.error(
        'MARKETPLACE ERROR:',
        error instanceof Error
          ? error.message
          : String(error)
      );

      return res.status(500).json({
        success: false,
        error:
          'Unable to retrieve marketplace data'
      });
    }
  }
);

const PORT =
  process.env.PORT || 3001;

app.listen(
  PORT,
  () => {
    console.log(
      `SneakSnipe API running on port ${PORT}`
    );
  }
);