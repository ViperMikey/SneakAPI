const got = require('got');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.stadiumgoods.com';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
};

function normalize(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function findProduct(styleId) {
  if (!styleId) {
    throw new Error('Stadium Goods findProduct requires a style ID');
  }

  const searchResponse = await got(
    `${BASE_URL}/search?q=${encodeURIComponent(styleId)}`,
    { headers: HEADERS }
  );

  const $ = cheerio.load(searchResponse.body);

  const urls = [];
  const seen = new Set();

  $('a[href*="/products/"]').each((_, element) => {
    const href = $(element).attr('href');

    if (!href) return;

    const cleanHref = href.split('?')[0];

    if (
      cleanHref.includes('gift-card') ||
      seen.has(cleanHref)
    ) {
      return;
    }

    seen.add(cleanHref);
    urls.push(cleanHref);
  });

  const wantedStyleId = normalize(styleId);

  // Verify the actual SKU on the product page instead of
  // blindly trusting the search result text.
  for (const href of urls.slice(0, 12)) {
    try {
      const productUrl = `${BASE_URL}${href}`;

      const response = await got(productUrl, {
        headers: HEADERS
      });

      const productPage = cheerio.load(response.body);

      let matched = false;
      let productName = null;

      productPage('script[type="application/ld+json"]').each(
        (_, element) => {
          if (matched) return;

          try {
            const data = JSON.parse(productPage(element).html());

            if (data['@type'] !== 'Product') return;

            const sku = normalize(data.sku);

            if (sku.includes(wantedStyleId)) {
              matched = true;
              productName = data.name
                ? data.name.replace(/\s+[—-]\s+\d+(?:\.5)?\s*$/, '')
                : null;
            }
          } catch (_) {
            // Ignore unrelated JSON-LD.
          }
        }
      );

      if (matched) {
        return {
          marketplace: 'stadiumgoods',
          styleId,
          name: productName,
          productUrl
        };
      }

    } catch (_) {
      // If one candidate fails, try the next.
    }
  }

  return null;
}

async function getPrices(productUrl) {
  if (!productUrl) {
    throw new Error('Stadium Goods getPrices requires a product URL');
  }

  const response = await got(productUrl, {
    headers: HEADERS
  });

  const $ = cheerio.load(response.body);
  const prices = {};

  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const raw = $(element).html();

      if (!raw) return;

      const data = JSON.parse(raw);

      if (
        data['@type'] !== 'Product' ||
        !data.offers ||
        !data.sku
      ) {
        return;
      }

      const skuParts = String(data.sku).split('|');

      if (skuParts.length < 3) return;

      const size = skuParts[skuParts.length - 1].trim();
      const price = Number(data.offers.price);

      const available =
        String(data.offers.availability || '')
          .toLowerCase()
          .includes('instock');

      if (!Number.isNaN(price)) {
        prices[size] = {
          price,
          available,
          currency: data.offers.priceCurrency || 'USD',
          url: data.offers.url || productUrl
        };
      }
    } catch (_) {
      // Ignore unrelated JSON-LD.
    }
  });

  return prices;
}

async function getProductWithPrices(styleId) {
  const product = await findProduct(styleId);

  if (!product) return null;

  return {
    ...product,
    prices: await getPrices(product.productUrl)
  };
}

module.exports = {
  findProduct,
  getPrices,
  getProductWithPrices
};
