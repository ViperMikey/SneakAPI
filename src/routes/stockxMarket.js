const express = require('express');

const {
  searchByStyleId,
  getProductVariants,
  getProductMarketData
} = require('../connectors/stockx');

const router = express.Router();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

router.get('/test/:styleId', async (req, res) => {
  try {
    const styleId = String(req.params.styleId)
      .trim()
      .toUpperCase();

    /*
      1. Search StockX catalog using the style ID.
    */
    const searchResult = await searchByStyleId(styleId);

    const products = Array.isArray(searchResult?.products)
      ? searchResult.products
      : [];

    if (!products.length) {
      return res.status(404).json({
        success: false,
        error: 'No StockX product found',
        styleId
      });
    }

    /*
      Prefer an exact style-ID match.
    */
    const product =
      products.find(item =>
        String(item?.styleId || '')
          .trim()
          .toUpperCase() === styleId
      ) || products[0];

    const productId = product.productId;

    if (!productId) {
      throw new Error(
        'StockX search result did not contain a productId'
      );
    }

    /*
      StockX currently limits requests to roughly
      one request per second.
    */
    await sleep(1100);

    /*
      2. Get every size / variant.
    */
    const variants = await getProductVariants(productId);

    await sleep(1100);

    /*
      3. Get lowest asks / highest bids.
    */
    const marketData = await getProductMarketData(productId);

    return res.json({
      success: true,
      styleId,
      product,
      variants,
      marketData
    });

  } catch (error) {
    console.error(
      'StockX market test error:',
      error.response?.body || error
    );

    return res.status(
      error.response?.statusCode || 500
    ).json({
      success: false,
      error: 'Unable to retrieve StockX market data',
      details:
        error.response?.body ||
        error.message ||
        'Unknown error'
    });
  }
});

module.exports = router;