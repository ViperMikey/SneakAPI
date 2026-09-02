const got = require('got');

const ALGOLIA_URL =
  'https://2fwotdvm2o-dsn.algolia.net/1/indexes/*/queries' +
  '?x-algolia-agent=Algolia%20for%20vanilla%20JavaScript%20(lite)%203.32.0%3Breact-instantsearch%205.4.0%3BJS%20Helper%202.26.1' +
  '&x-algolia-application-id=2FWOTDVM2O' +
  '&x-algolia-api-key=ac96de6fef0e02bb95d433d8d5c7038a';

async function findProduct(styleId) {
  if (!styleId) {
    throw new Error('Flight Club findProduct requires a style ID');
  }

  const body = {
    requests: [
      {
        indexName: 'product_variants_v2_flight_club',
        params:
          'query=' + encodeURIComponent(styleId) +
          '&hitsPerPage=1' +
          '&maxValuesPerFacet=1' +
          '&filters=' +
          '&facets=%5B%22lowest_price_cents_usd%22%5D' +
          '&tagFilters='
      }
    ]
  };

  const response = await got.post(ALGOLIA_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    http2: true
  });

  const data = JSON.parse(response.body);
  const hit = data?.results?.[0]?.hits?.[0];

  if (!hit) {
    return null;
  }

  return {
    marketplace: 'flightclub',
    styleId,
    productId: hit.product_template_id ?? null,
    slug: hit.slug ?? null,
    name: hit.name ?? hit.product_template_name ?? null,
    lowestPrice:
      typeof hit.lowest_price_cents_usd === 'number'
        ? hit.lowest_price_cents_usd / 100
        : null,
    productUrl: hit.slug
      ? `https://www.flightclub.com/${hit.slug}`
      : null
  };
}

module.exports = {
  findProduct
};
