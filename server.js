require('dotenv').config();

const express = require('express');
const cors = require('cors');

const {
  getMarketData
} = require('./src/services/marketplace');

const app = express();

app.use(cors());
app.use(express.json());

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
