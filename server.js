require('dotenv').config();

const billingRoutes = require('./src/routes/billing');
const stripeWebhook = require('./src/routes/stripeWebhook');
const stockxRoutes = require('./src/routes/stockx');
const stockxMarketRoutes = require('./src/routes/stockxMarket');

const express = require('express');
const cors = require('cors');

const {
  getMarketData
} = require('./src/services/marketplace');

const app = express();

app.use(cors());

app.post(
  '/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhook
);

app.use(express.json());

app.use('/api/billing', billingRoutes);
app.use('/api/stockx', stockxRoutes);
app.use('/api/stockx', stockxMarketRoutes);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'SneakSnipe API'
  });
});

app.get('/api/market/:styleId', async (req, res) => {
  try {
    const styleId = req.params.styleId
      .trim()
      .toUpperCase();

    const data = await getMarketData(styleId);

    res.json({
      success: true,
      data
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: 'Unable to retrieve marketplace data'
    });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`SneakSnipe API running on port ${PORT}`);
});