const got = require('got');
const supabase = require('../config/supabase');

const STOCKX_API_BASE = 'https://api.stockx.com/v2';
const STOCKX_TOKEN_URL = 'https://accounts.stockx.com/oauth/token';
const STOCKX_AUDIENCE = 'gateway.stockx.com';

function getConfig() {
  const {
    STOCKX_API_KEY,
    STOCKX_CLIENT_ID,
    STOCKX_CLIENT_SECRET
  } = process.env;

  if (!STOCKX_API_KEY) {
    throw new Error('Missing STOCKX_API_KEY');
  }

  if (!STOCKX_CLIENT_ID) {
    throw new Error('Missing STOCKX_CLIENT_ID');
  }

  if (!STOCKX_CLIENT_SECRET) {
    throw new Error('Missing STOCKX_CLIENT_SECRET');
  }

  return {
    apiKey: STOCKX_API_KEY,
    clientId: STOCKX_CLIENT_ID,
    clientSecret: STOCKX_CLIENT_SECRET
  };
}

async function loadStoredTokens() {
  const { data, error } = await supabase
    .from('stockx_tokens')
    .select('*')
    .eq('id', 'main')
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error(
      'StockX has not been authorized yet. Visit /api/stockx/login first.'
    );
  }

  return data;
}

async function saveAccessToken(accessToken, expiresIn) {
  const expiresAt = new Date(
    Date.now() + Number(expiresIn || 43200) * 1000
  ).toISOString();

  const { error } = await supabase
    .from('stockx_tokens')
    .update({
      access_token: accessToken,
      expires_at: expiresAt,
      updated_at: new Date().toISOString()
    })
    .eq('id', 'main');

  if (error) {
    throw error;
  }

  return {
    accessToken,
    expiresAt
  };
}

async function refreshAccessToken(refreshToken) {
  if (!refreshToken) {
    throw new Error(
      'No StockX refresh token is stored. Re-authorize StockX.'
    );
  }

  const {
    clientId,
    clientSecret
  } = getConfig();

  const response = await got.post(STOCKX_TOKEN_URL, {
    form: {
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      audience: STOCKX_AUDIENCE,
      refresh_token: refreshToken
    },
    responseType: 'json'
  });

  const body = response.body;

  if (!body.access_token) {
    throw new Error(
      'StockX refresh response did not contain an access token.'
    );
  }

  await saveAccessToken(
    body.access_token,
    body.expires_in || 43200
  );

  return body.access_token;
}

async function getAccessToken() {
  const tokens = await loadStoredTokens();

  const expiresAt = tokens.expires_at
    ? new Date(tokens.expires_at).getTime()
    : 0;

  /*
    Refresh five minutes before expiration.
  */
  const refreshEarlyMs = 5 * 60 * 1000;

  if (
    tokens.access_token &&
    expiresAt > Date.now() + refreshEarlyMs
  ) {
    return tokens.access_token;
  }

  return refreshAccessToken(tokens.refresh_token);
}

async function stockxRequest(path, options = {}) {
  const {
    apiKey
  } = getConfig();

  let accessToken = await getAccessToken();

  try {
    return await got(`${STOCKX_API_BASE}${path}`, {
      ...options,

      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'x-api-key': apiKey,
        ...(options.headers || {})
      },

      responseType: 'json'
    }).json();

  } catch (error) {
    /*
      If StockX rejects the access token, refresh it once
      and retry the request.
    */
    if (error.response?.statusCode !== 401) {
      throw error;
    }

    const tokens = await loadStoredTokens();

    accessToken = await refreshAccessToken(
      tokens.refresh_token
    );

    return got(`${STOCKX_API_BASE}${path}`, {
      ...options,

      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'x-api-key': apiKey,
        ...(options.headers || {})
      },

      responseType: 'json'
    }).json();
  }
}

async function searchByStyleId(styleId) {
  const normalizedStyleId = String(styleId)
    .trim()
    .toUpperCase();

  return stockxRequest('/catalog/search', {
    searchParams: {
      query: normalizedStyleId
    }
  });
}

async function getProductVariants(productId) {
  return stockxRequest(
    `/catalog/products/${encodeURIComponent(productId)}/variants`
  );
}

async function getProductMarketData(productId) {
  return stockxRequest(
    `/catalog/products/${encodeURIComponent(productId)}/market-data`,
    {
      searchParams: {
        currencyCode: 'USD'
      }
    }
  );
}

module.exports = {
  stockxRequest,
  searchByStyleId,
  getProductVariants,
  getProductMarketData
};