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
  let stage = 'starting';

  try {
    const styleId = String(req.params.styleId)
      .trim()
      .toUpperCase();

    /*
      STEP 1 — Catalog search
    */
    stage = 'catalog-search';

    const searchResult = await searchByStyleId(styleId);

    const products = Array.isArray(searchResult?.products)
      ? searchResult.products
      : [];

    if (!products.length) {
      return res.status(404).json({
        success: false,
        failedAt: stage,
        error: 'No StockX product found',
        styleId
      });
    }

    const product =
      products.find(item =>
        String(item?.styleId || '')
          .trim()
          .toUpperCase() === styleId
      ) || products[0];

    const productId = product?.productId;

    if (!productId) {
      return res.status(500).json({
        success: false,
        failedAt: stage,
        error: 'StockX product did not contain productId',
        product
      });
    }

    await sleep(1100);

    /*
      STEP 2 — Sizes / variants
    */
    stage = 'product-variants';

    const variants = await getProductVariants(productId);

    await sleep(1100);

    /*
      STEP 3 — Market data
    */
    stage = 'product-market-data';

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
      `StockX test failed at ${stage}:`,
      error.response?.body || error
    );

    return res
      .status(error.response?.statusCode || 500)
      .json({
        success: false,
        failedAt: stage,
        error: 'Unable to retrieve StockX data',
        details:
          error.response?.body ||
          error.message ||
          'Unknown error'
      });
  }
});

module.exports = router;