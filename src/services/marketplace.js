const goat = require('../connectors/goat');
const flightclub = require('../connectors/flightclub');
const stadiumgoods = require('../connectors/stadiumgoods');

async function getMarketData(styleId) {
  if (!styleId) {
    throw new Error('getMarketData requires a style ID');
  }

  const results = await Promise.allSettled([
    goat.findProduct(styleId),
    flightclub.findProduct(styleId),
    stadiumgoods.getProductWithPrices(styleId)
  ]);

  const [goatResult, flightclubResult, stadiumResult] = results;

  return {
    styleId,

    marketplaces: {
      goat: {
        status:
          goatResult.status === 'fulfilled' && goatResult.value
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
          stadiumResult.value
            ? true
            : false
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
}

module.exports = {
  getMarketData
};
