const goat = require('../connectors/goat');
const flightclub = require('../connectors/flightclub');
const stadiumgoods = require('../connectors/stadiumgoods');

const cache = require('./cache');
const persistentCache = require('./persistentCache');

async function getMarketData(styleId) {
  if (!styleId) {
    throw new Error('getMarketData requires a style ID');
  }

  const normalizedStyleId = styleId.toUpperCase();
  const cacheKey = `market:${normalizedStyleId}`;

  // Fastest: current server memory.
  const memoryResult = cache.get(cacheKey);

  if (memoryResult) {
    return {
      ...memoryResult,
      cache: 'MEMORY_HIT'
    };
  }

  // Next: persistent Supabase cache.
  try {
    const persistentResult =
      await persistentCache.get(normalizedStyleId);

    if (persistentResult) {
      cache.set(cacheKey, persistentResult);

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

  // Nothing cached: get fresh marketplace data.
  const results = await Promise.allSettled([
    goat.findProduct(normalizedStyleId),
    flightclub.findProduct(normalizedStyleId),
    stadiumgoods.getProductWithPrices(normalizedStyleId)
  ]);

  const [
    goatResult,
    flightclubResult,
    stadiumResult
  ] = results;

  const result = {
    styleId: normalizedStyleId,

    marketplaces: {
      goat: {
        status:
          goatResult.status === 'fulfilled' &&
          goatResult.value
            ? 'catalog_only'
            : 'unavailable',

        product:
          goatResult.status === 'fulfilled'
            ? goatResult.value
            : null,

        liveSizePricing: false
      },

      flightclub: {
        status:
          flightclubResult.status === 'fulfilled' &&
          flightclubResult.value
            ? 'catalog_only'
            : 'unavailable',

        product:
          flightclubResult.status === 'fulfilled'
            ? flightclubResult.value
            : null,

        liveSizePricing: false
      },

      stadiumgoods: {
        status:
          stadiumResult.status === 'fulfilled' &&
          stadiumResult.value
            ? 'live'
            : 'unavailable',

        product:
          stadiumResult.status === 'fulfilled'
            ? stadiumResult.value
            : null,

        liveSizePricing:
          stadiumResult.status === 'fulfilled' &&
          Boolean(stadiumResult.value)
      },

      stockx: {
        status: 'pending_api',
        product: null,
        liveSizePricing: false
      },

      ebay: {
        status: 'pending_api',
        product: null,
        liveSizePricing: false
      }
    },

    fetchedAt: new Date().toISOString()
  };

  cache.set(cacheKey, result);

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
