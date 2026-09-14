const {
  searchByStyleId,
  getProductVariants,
  getProductMarketData
} = require('../connectors/stockx');

const cache = require('./cache');
const persistentCache = require('./persistentCache');

/*
  Bump this whenever the normalized API response
  structure changes so old cached responses
  cannot leak into the frontend.
*/
const SCHEMA_VERSION = 4;

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
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

function toNumber(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

/*
  Get the most useful US-size value StockX
  provides for a variant.
*/
function getVariantSize(variant) {
  if (
    typeof variant?.variantValue === 'string' &&
    variant.variantValue.trim()
  ) {
    return variant.variantValue.trim();
  }

  const defaultSize =
    variant?.sizeChart
      ?.defaultConversion
      ?.size;

  if (
    defaultSize !== undefined &&
    defaultSize !== null
  ) {
    return String(defaultSize);
  }

  const firstConversion =
    variant?.sizeChart
      ?.availableConversions?.[0]
      ?.size;

  if (
    firstConversion !== undefined &&
    firstConversion !== null
  ) {
    return String(firstConversion);
  }

  return null;
}

/*
  StockX returns urlKey as part of its official
  catalog product response.

  Use that official key for the public StockX
  product page instead of trying to create a
  URL from the shoe title ourselves.
*/
function getStockXProductUrl(product) {
  const urlKey =
    typeof product?.urlKey === 'string'
      ? product.urlKey
          .trim()
          .replace(/^\/+|\/+$/g, '')
      : '';

  if (!urlKey) {
    return null;
  }

  return `https://stockx.com/${urlKey}`;
}

/*
  StockX's official product-level market-data
  endpoint returns one market-data row per variant.

  Normalize it into the structure SneakSnipe's
  frontend already understands:

  product.prices[size] = {
    price,
    available,
    currency,
    url
  }
*/
function normalizeStockXProduct(
  product,
  variants,
  marketData
) {
  const productUrl =
    getStockXProductUrl(product);

  const marketRows =
    Array.isArray(marketData)
      ? marketData
      : Array.isArray(marketData?.marketData)
        ? marketData.marketData
        : [];

  const marketByVariantId =
    new Map();

  for (const row of marketRows) {
    if (row?.variantId) {
      marketByVariantId.set(
        row.variantId,
        row
      );
    }
  }

  const prices = {};

  for (const variant of variants) {
    const variantId =
      variant?.variantId;

    if (!variantId) {
      continue;
    }

    const market =
      marketByVariantId.get(
        variantId
      );

    if (!market) {
      continue;
    }

    const size =
      getVariantSize(
        variant
      );

    if (!size) {
      continue;
    }

    /*
      Prefer StockX's top-level official
      lowestAskAmount.

      Keep standardMarketData.lowestAsk as a
      compatibility fallback.
    */
    const lowestAsk =
      toNumber(
        market.lowestAskAmount ??
        market.standardMarketData
          ?.lowestAsk
      );

    if (
      lowestAsk === null ||
      lowestAsk <= 0
    ) {
      continue;
    }

    /*
      The frontend only treats a size as
      actionable when it has an actual URL.
    */
    if (!productUrl) {
      continue;
    }

    const highestBid =
      toNumber(
        market.highestBidAmount ??
        market.standardMarketData
          ?.highestBidAmount
      );

    prices[size] = {
      price:
        lowestAsk,

      available:
        true,

      currency:
        typeof market.currencyCode ===
        'string'
          ? market.currencyCode
          : 'USD',

      url:
        productUrl,

      /*
        Extra official fields are retained for
        future SneakSnipe features. The current
        frontend can safely ignore them.
      */
      variantId,

      highestBid,

      sellFaster:
        toNumber(
          market.sellFasterAmount ??
          market.standardMarketData
            ?.sellFaster
        ),

      earnMore:
        toNumber(
          market.earnMoreAmount ??
          market.standardMarketData
            ?.earnMore
        )
    };
  }

  const livePrices =
    Object.values(prices)
      .map(item => item.price)
      .filter(
        price =>
          Number.isFinite(price) &&
          price > 0
      );

  const lowestPrice =
    livePrices.length
      ? Math.min(...livePrices)
      : null;

  return {
    productId:
      product?.productId ||
      null,

    styleId:
      product?.styleId ||
      null,

    name:
      product?.title ||
      null,

    title:
      product?.title ||
      null,

    brand:
      product?.brand ||
      null,

    productType:
      product?.productType ||
      null,

    productUrl,

    lowestPrice,

    prices
  };
}

async function getStockXData(styleId) {
  try {
    /*
      STEP 1:
      Search StockX's official catalog using
      the style ID.
    */
    const searchResult =
      await searchByStyleId(
        styleId
      );

    const products =
      Array.isArray(
        searchResult?.products
      )
        ? searchResult.products
        : [];

    if (!products.length) {
      return emptyMarketplace(
        'unavailable'
      );
    }

    /*
      Prefer the exact style-ID match.

      Only fall back to the first result if
      StockX does not return an exact match.
    */
    const product =
      products.find(
        item =>
          normalizeStyleId(
            item?.styleId
          ) === styleId
      ) ||
      products[0];

    const productId =
      product?.productId;

    if (!productId) {
      return {
        ...emptyMarketplace(
          'unavailable'
        ),

        error:
          'StockX product did not contain productId'
      };
    }

    /*
      Respect StockX request pacing.
    */
    await sleep(1100);

    /*
      STEP 2:
      Get every official StockX variant / size.
    */
    let variantsResponse = null;

    try {
      variantsResponse =
        await getProductVariants(
          productId
        );
    } catch (error) {
      console.error(
        'StockX variants failed:',
        error.response?.body ||
        error.message
      );
    }

    /*
      Current StockX V2 returns an array.

      Keep compatibility with a wrapped
      response as well.
    */
    const variants =
      Array.isArray(
        variantsResponse
      )
        ? variantsResponse
        : Array.isArray(
            variantsResponse?.variants
          )
          ? variantsResponse.variants
          : [];

    await sleep(1100);

    /*
      STEP 3:
      Retrieve official market data for all
      variants in one StockX API call.
    */
    let marketData = null;
    let marketError = null;

    try {
      marketData =
        await getProductMarketData(
          productId
        );
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

    const now =
      new Date().toISOString();

    const normalizedProduct =
      normalizeStockXProduct(
        product,
        variants,
        marketData
      );

    const hasLivePrices =
      Object.keys(
        normalizedProduct.prices
      ).length > 0;

    /*
      Official StockX pricing is available.

      This is the state the frontend can
      truthfully label LIVE.
    */
    if (hasLivePrices) {
      return {
        status:
          'live',

        product:
          normalizedProduct,

        sizes:
          variants,

        marketData,

        liveSizePricing:
          true,

        viewDealUrl:
          normalizedProduct
            .productUrl,

        lastUpdated:
          now
      };
    }

    /*
      StockX catalog / variants are connected,
      but there was no usable lowest-ask data.

      Do NOT pretend the prices are live.
    */
    return {
      status:
        'catalog_only',

      product:
        normalizedProduct,

      sizes:
        variants,

      marketData:
        marketData || null,

      liveSizePricing:
        false,

      viewDealUrl:
        normalizedProduct
          .productUrl,

      lastUpdated:
        now,

      marketError
    };

  } catch (error) {
    console.error(
      'StockX marketplace connector failed:',
      error.response?.body ||
      error.message
    );

    return {
      ...emptyMarketplace(
        'unavailable'
      ),

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
    normalizeStyleId(
      styleId
    );

  /*
    v4 prevents the old v3 StockX response
    shape from being returned from memory.
  */
  const cacheKey =
    `market:v${SCHEMA_VERSION}:${normalizedStyleId}`;

  /*
    1. Memory cache
  */
  const memoryResult =
    cache.get(
      cacheKey
    );

  if (
    memoryResult &&
    memoryResult.schemaVersion ===
      SCHEMA_VERSION
  ) {
    return {
      ...memoryResult,
      cache:
        'MEMORY_HIT'
    };
  }

  /*
    2. Supabase persistent cache
  */
  try {
    const persistentResult =
      await persistentCache.get(
        normalizedStyleId
      );

    if (
      persistentResult &&
      persistentResult.schemaVersion ===
        SCHEMA_VERSION
    ) {
      cache.set(
        cacheKey,
        persistentResult
      );

      return {
        ...persistentResult,
        cache:
          'SUPABASE_HIT'
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
    await getStockXData(
      normalizedStyleId
    );

  const fetchedAt =
    new Date().toISOString();

  const result = {
    schemaVersion:
      SCHEMA_VERSION,

    styleId:
      normalizedStyleId,

    marketplaces: {
      /*
        Official StockX API.

        The status becomes "live" ONLY when
        StockX returned usable official
        size-level market pricing.
      */
      stockx,

      /*
        These providers are intentionally
        marked pending until SneakSnipe has
        approved / licensed data access.

        The frontend should display:
        "Integration in progress"
      */
      goat:
        emptyMarketplace(
          'pending_api'
        ),

      flightclub:
        emptyMarketplace(
          'pending_api'
        ),

      stadiumgoods:
        emptyMarketplace(
          'pending_api'
        ),

      ebay:
        emptyMarketplace(
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
    Save to Supabase persistent cache.
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
    cache:
      'MISS'
  };
}

module.exports = {
  getMarketData
};