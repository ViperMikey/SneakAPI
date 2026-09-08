const {
  searchByStyleId,
  getProductVariants,
  getProductMarketData
} = require('../connectors/stockx');

const cache = require('./cache');
const persistentCache = require('./persistentCache');

const SCHEMA_VERSION = 2;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeStyleId(styleId) {
  return String(styleId || '')
    .trim()
    .toUpperCase();
}

function emptyMarketplace(status) {
  return {
    status,
    product: null,
    sizes: [],
    marketData: null,
    liveSizePricing: false,
    viewDealUrl: null,
    lastUpdated: null
  };
}

async function getStockXData(styleId) {
  try {
    /*
      STEP 1:
      Find the StockX product by style ID.
    */
    const searchResult = await searchByStyleId(styleId);

    const products = Array.isArray(searchResult?.products)
      ? searchResult.products
      : [];

    if (!products.length) {
      return emptyMarketplace('unavailable');
    }

    const product =
      products.find(item =>
        normalizeStyleId(item?.styleId) === styleId
      ) || products[0];

    const productId = product?.productId;

    if (!productId) {
      return {
        ...emptyMarketplace('unavailable'),
        error: 'StockX product did not contain productId'
      };
    }

    /*
      Respect StockX request pacing.
    */
    await sleep(1100);

    /*
      STEP 2:
      Retrieve sizes / variants.
    */
    let variants = null;

    try {
      variants = await getProductVariants(productId);
    } catch (error) {
      console.error(
        'StockX variants failed:',
        error.response?.body || error.message
      );
    }

    const sizes = Array.isArray(variants?.variants)
      ? variants.variants
      : Array.isArray(variants)
        ? variants
        : [];

    await sleep(1100);

    /*
      STEP 3:
      Retrieve official market data.

      Right now your StockX account may return a billing/shipping
      setup error here. We keep the catalog + sizes instead of
      failing the entire marketplace response.
    */
    let marketData = null;
    let marketError = null;

    try {
      marketData = await getProductMarketData(productId);
    } catch (error) {
      marketError =
        error.response?.body ||
        error.message ||
        'Unknown StockX market-data error';

      console.error(
        'StockX market data failed:',
        marketError
      );
    }

    const now = new Date().toISOString();

    /*
      Do not guess a StockX URL.
      Only use one if StockX returned one.
    */
    const viewDealUrl =
      product?.url ||
      product?.productUrl ||
      product?.webUrl ||
      null;

    if (marketData) {
      return {
        status: 'live',
        product,
        sizes,
        marketData,
        liveSizePricing: true,
        viewDealUrl,
        lastUpdated: now
      };
    }

    /*
      Catalog and sizes work, but live market data is not
      currently available for this account.
    */
    return {
      status: 'catalog_only',
      product,
      sizes,
      marketData: null,
      liveSizePricing: false,
      viewDealUrl,
      lastUpdated: now,
      marketError
    };

  } catch (error) {
    console.error(
      'StockX marketplace connector failed:',
      error.response?.body || error.message
    );

    return {
      ...emptyMarketplace('unavailable'),
      error:
        error.response?.body ||
        error.message ||
        'Unknown StockX error'
    };
  }
}

async function getMarketData(styleId) {
  if (!styleId) {
    throw new Error(
      'getMarketData requires a style ID'
    );
  }

  const normalizedStyleId =
    normalizeStyleId(styleId);

  /*
    Version the memory key so old cached response formats
    are not mixed with the new unified structure.
  */
  const cacheKey =
    `market:v${SCHEMA_VERSION}:${normalizedStyleId}`;

  /*
    1. Memory cache
  */
  const memoryResult = cache.get(cacheKey);

  if (
    memoryResult &&
    memoryResult.schemaVersion === SCHEMA_VERSION
  ) {
    return {
      ...memoryResult,
      cache: 'MEMORY_HIT'
    };
  }

  /*
    2. Supabase persistent cache
  */
  try {
    const persistentResult =
      await persistentCache.get(normalizedStyleId);

    if (
      persistentResult &&
      persistentResult.schemaVersion === SCHEMA_VERSION
    ) {
      cache.set(
        cacheKey,
        persistentResult
      );

      return {
        ...persistentResult,
        cache: 'SUPABASE_HIT'
      };
    }

  } catch (error) {
    console.error(
      'Supabase cache read failed:',
      error.message
    );
  }

  /*
    3. Fresh official marketplace data
  */
  const stockx =
    await getStockXData(normalizedStyleId);

  const fetchedAt =
    new Date().toISOString();

  const result = {
    schemaVersion: SCHEMA_VERSION,

    styleId: normalizedStyleId,

    marketplaces: {
      /*
        Official StockX API.
      */
      stockx,

      /*
        Keep these slots in the response so the frontend
        architecture does not need to change later.

        We will connect them to an authorized/licensed
        source rather than the old direct-site scraping.
      */
      goat: emptyMarketplace(
        'awaiting_licensed_source'
      ),

      flightclub: emptyMarketplace(
        'awaiting_licensed_source'
      ),

      stadiumgoods: emptyMarketplace(
        'awaiting_licensed_source'
      ),

      /*
        Official eBay integration comes later.
      */
      ebay: emptyMarketplace(
        'pending_api'
      )
    },

    fetchedAt
  };

  /*
    Save to memory.
  */
  cache.set(
    cacheKey,
    result
  );

  /*
    Save to Supabase.
  */
  try {
    await persistentCache.set(
      normalizedStyleId,
      result
    );
  } catch (error) {
    console.error(
      'Supabase cache write failed:',
      error.message
    );
  }

  return {
    ...result,
    cache: 'MISS'
  };
}

module.exports = {
  getMarketData
};