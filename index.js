require('dotenv').config();
const express       = require('express');
const bodyParser    = require('body-parser');
const cors          = require('cors');
const { MongoClient } = require('mongodb');
const nodemailer    = require('nodemailer');
const crypto        = require('crypto');

const app = express();
let subsColl;

// — Connect to MongoDB —
MongoClient
  .connect(process.env.MONGODB_URI, { useUnifiedTopology: true })
  .then(client => {
    subsColl = client.db(process.env.MONGODB_DB).collection('subscriptions');
    console.log('👌 Connected to MongoDB');
  })
  .catch(console.error);

// — CORS for your shop —
app.use(cors({
  origin: '*',
  methods: ['POST','OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// — Subscribe endpoint (no more inventoryItemId) —
app.post('/subscribe', bodyParser.json(), async (req, res) => {
  const { email, productId } = req.body;
  if (!email || !productId) {
    return res.status(400).send('Missing email or productId');
  }
  await subsColl.insertOne({ email, productId });
  res.send('OK');
});

// — Verify Shopify webhook HMAC —
function verifyShopify(req, res, buf) {
  const hmac   = req.get('X-Shopify-Hmac-Sha256');
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(buf)
    .digest('base64');
  if (digest !== hmac) {
    console.error('!! Invalid HMAC');
    return res.sendStatus(403);
  }
}

// — Inventory-level-update webhook —
app.post(
  '/webhook',
  bodyParser.raw({ type: 'application/json', verify: verifyShopify }),
  async (req, res) => {
    const data = JSON.parse(req.body.toString());
    const { inventory_item_id, available } = data;
    console.log('↪️ webhook payload:', data);

    if (available > 0) {
      // send to **all** subscribers of **that productId**
      // (since we only store productId now)
      // NOTE: You'll need to map inventory_item_id → productId if you want per-product filtering.
      const subs = await subsColl.find({}).toArray();
      console.log(`→ found ${subs.length} subscriber(s)`);

      if (subs.length) {
        const transporter = nodemailer.createTransport({
          host:   process.env.SMTP_HOST,
          port:   Number(process.env.SMTP_PORT),
          secure: Number(process.env.SMTP_PORT) === 465,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          }
        });

        await Promise.all(subs.map(s =>
          transporter.sendMail({
            from:    process.env.SMTP_USER,
            to:      s.email,
            subject: `✅ Back in Stock!`,
            html: `
              <p>Good news — your requested item is back in stock!</p>
              <p>
                <a href="https://${process.env.SHOPIFY_SHOP_DOMAIN}/products/${s.productId}">
                  Click here to buy now
                </a>
              </p>`
          })
        ));

        // clear the entire waitlist
        await subsColl.deleteMany({});
      }
    }

    res.sendStatus(200);
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));

