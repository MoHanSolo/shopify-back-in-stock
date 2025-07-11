require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const cors       = require('cors');
const crypto     = require('crypto');
const { MongoClient } = require('mongodb');
const nodemailer = require('nodemailer');

const app = express();
let subsColl;

// CORS
app.use(cors({ origin: '*', methods: ['POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));

// -- Connect to MongoDB
MongoClient.connect(process.env.MONGODB_URI, { useUnifiedTopology: true })
  .then(client => {
    subsColl = client.db(process.env.MONGODB_DB).collection('subscriptions');
    console.log('✔️ Connected to MongoDB');
  })
  .catch(err => {
    console.error('❌ MongoDB error:', err);
    process.exit(1);
  });

// -- 1) SUBSCRIBE endpoint
app.post('/subscribe', bodyParser.json(), async (req, res) => {
  const { email, productId, variantId, inventoryItemId } = req.body;
  if (!email || !variantId || !inventoryItemId) {
    return res.status(400).send('Missing data');
  }
  try {
    await subsColl.insertOne({ email, productId, variantId, inventoryItemId });
    console.log(`→ New sub: ${email} / invItem ${inventoryItemId}`);
    return res.send('OK');
  } catch (e) {
    console.error('Insert error:', e);
    return res.status(500).send('Server error');
  }
});

// -- (optional) verifyShopify for real HMAC checking
function verifyShopify(req, res, buf) {
  const hmac   = req.get('X-Shopify-Hmac-Sha256');
  const digest = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
                       .update(buf).digest('base64');
  if (digest !== hmac) throw new Error('Invalid HMAC');
}

// -- 2) WEBHOOK endpoint (inventory level update)
app.post(
  '/webhook',
  // bodyParser.raw({ type: 'application/json', verify: verifyShopify }),
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    console.log('📬 Headers:', req.headers);
    console.log('📬 Body:', req.body.toString());

    let data;
    try {
      data = JSON.parse(req.body.toString());
    } catch (e) {
      console.error('Bad JSON:', e);
      return res.sendStatus(400);
    }

    const { inventory_item_id: invId, available } = data;
    if (available > 0) {
      const subs = await subsColl.find({ inventoryItemId: String(invId) }).toArray();
      console.log(`→ found ${subs.length} for invItem ${invId}`);
      if (subs.length) {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT),
          secure: process.env.SMTP_PORT == 465,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          }
        });
        await Promise.all(subs.map(s =>
          transporter.sendMail({
            from: process.env.SMTP_USER,
            to:   s.email,
            subject: '✅ Back in Stock!',
            html: `
              <p>Good news! Your item is back in stock.</p>
              <p>
                <a href="https://${process.env.SHOPIFY_SHOP_DOMAIN}/products/${s.productId}?variant=${s.variantId}">
                  Click here to buy now
                </a>
              </p>`
          })
        ));
        await subsColl.deleteMany({ inventoryItemId: String(invId) });
        console.log(`→ Cleared ${subs.length} subs for ${invId}`);
      }
    }

    res.sendStatus(200);
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
