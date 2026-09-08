const express = require('express');
const crypto = require('crypto');
const got = require('got');

const supabase = require('../config/supabase');

const router = express.Router();

const STOCKX_AUTH_URL = 'https://accounts.stockx.com/authorize';
const STOCKX_TOKEN_URL = 'https://accounts.stockx.com/oauth/token';
const STOCKX_AUDIENCE = 'gateway.stockx.com';

function getConfig() {
  const {
    STOCKX_CLIENT_ID,
    STOCKX_CLIENT_SECRET,
    STOCKX_REDIRECT_URI
  } = process.env;

  if (!STOCKX_CLIENT_ID) {
    throw new Error('Missing STOCKX_CLIENT_ID');
  }

  if (!STOCKX_CLIENT_SECRET) {
    throw new Error('Missing STOCKX_CLIENT_SECRET');
  }

  if (!STOCKX_REDIRECT_URI) {
    throw new Error('Missing STOCKX_REDIRECT_URI');
  }

  return {
    clientId: STOCKX_CLIENT_ID,
    clientSecret: STOCKX_CLIENT_SECRET,
    redirectUri: STOCKX_REDIRECT_URI
  };
}

/*
  Creates a signed OAuth state value.

  This helps make sure the callback belongs to an authorization
  request started by SneakSnipe.
*/
function createState() {
  const { clientSecret } = getConfig();

  const timestamp = Date.now().toString();
  const random = crypto.randomBytes(16).toString('hex');

  const payload = `${timestamp}.${random}`;

  const signature = crypto
    .createHmac('sha256', clientSecret)
    .update(payload)
    .digest('hex');

  return `${payload}.${signature}`;
}

function verifyState(state) {
  if (!state || typeof state !== 'string') {
    return false;
  }

  const parts = state.split('.');

  if (parts.length !== 3) {
    return false;
  }

  const [timestamp, random, signature] = parts;

  const { clientSecret } = getConfig();

  const payload = `${timestamp}.${random}`;

  const expectedSignature = crypto
    .createHmac('sha256', clientSecret)
    .update(payload)
    .digest('hex');

  const provided = Buffer.from(signature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');

  if (provided.length !== expected.length) {
    return false;
  }

  if (!crypto.timingSafeEqual(provided, expected)) {
    return false;
  }

  /*
    Authorization must finish within 15 minutes.
  */
  const age = Date.now() - Number(timestamp);

  if (!Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000) {
    return false;
  }

  return true;
}

/*
  STEP 1:
  Redirect the browser to StockX authorization.
*/
router.get('/login', (req, res) => {
  try {
    const {
      clientId,
      redirectUri
    } = getConfig();

    const state = createState();

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      audience: STOCKX_AUDIENCE,
      scope: 'openid offline_access',
      state
    });

    const authorizationUrl =
      `${STOCKX_AUTH_URL}?${params.toString()}`;

    return res.redirect(authorizationUrl);

  } catch (error) {
    console.error('StockX login error:', error);

    return res.status(500).json({
      success: false,
      error: 'Unable to start StockX authorization'
    });
  }
});

/*
  STEP 2:
  StockX redirects here after authorization.

  Exchange the authorization code for:
  - access token
  - refresh token

  Then securely store them in Supabase.
*/
router.get('/callback', async (req, res) => {
  try {
    const {
      code,
      state,
      error,
      error_description: errorDescription
    } = req.query;

    if (error) {
      console.error(
        'StockX authorization denied:',
        error,
        errorDescription
      );

      return res.status(400).send(
        `StockX authorization failed: ${errorDescription || error}`
      );
    }

    if (!code) {
      return res.status(400).send(
        'StockX callback did not contain an authorization code.'
      );
    }

    if (!verifyState(state)) {
      return res.status(400).send(
        'Invalid or expired StockX OAuth state.'
      );
    }

    const {
      clientId,
      clientSecret,
      redirectUri
    } = getConfig();

    const tokenResponse = await got
      .post(STOCKX_TOKEN_URL, {
        form: {
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code: String(code),
          redirect_uri: redirectUri,
          audience: STOCKX_AUDIENCE
        },
        responseType: 'json'
      });

    const tokenData = tokenResponse.body;

    if (!tokenData.access_token) {
      throw new Error(
        'StockX token response did not contain an access token'
      );
    }

    const expiresIn =
      Number(tokenData.expires_in) || 43200;

    const expiresAt = new Date(
      Date.now() + expiresIn * 1000
    ).toISOString();

    /*
      Keep an existing refresh token if StockX does not
      return a new one for some reason.
    */
    let refreshToken = tokenData.refresh_token || null;

    if (!refreshToken) {
      const { data: existing } = await supabase
        .from('stockx_tokens')
        .select('refresh_token')
        .eq('id', 'main')
        .maybeSingle();

      refreshToken = existing?.refresh_token || null;
    }

    const { error: databaseError } = await supabase
      .from('stockx_tokens')
      .upsert(
        {
          id: 'main',
          access_token: tokenData.access_token,
          refresh_token: refreshToken,
          expires_at: expiresAt,
          updated_at: new Date().toISOString()
        },
        {
          onConflict: 'id'
        }
      );

    if (databaseError) {
      throw databaseError;
    }

    console.log('StockX authorization completed successfully.');

    return res.send(`
      <!doctype html>
      <html>
        <head>
          <title>StockX Connected</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </head>

        <body
          style="
            margin:0;
            min-height:100vh;
            display:flex;
            align-items:center;
            justify-content:center;
            background:#0b0b0b;
            color:#ffffff;
            font-family:Arial,sans-serif;
          "
        >
          <div style="text-align:center;padding:32px;">
            <h1>StockX Connected</h1>
            <p>
              SneakSnipe is now authorized to use the StockX API.
            </p>
            <p style="color:#999;">
              You can close this window.
            </p>
          </div>
        </body>
      </html>
    `);

  } catch (error) {
    console.error(
      'StockX callback error:',
      error.response?.body || error
    );

    return res.status(500).send(
      'Unable to complete StockX authorization.'
    );
  }
});

module.exports = router;