require('dotenv').config();
const express         = require('express');
const bodyParser      = require('body-parser');
const cors            = require('cors');
const crypto          = require('crypto');
const { MongoClient } = require('mongodb');
const nodemailer      = require('nodemailer');
const fetch           = require('node-fetch'); // npm install node-fetch@2

const app = express();
let subsColl;

// — Connect to MongoDB —
MongoClient.connect(process.env.MONGODB_URI, { useUnifiedTopology: true })
  .then(client => {
    subsColl = client.db(process.env.MONGODB_DB).collection('subscriptions');
    console.log('👌 Connected to MongoDB');
  })
  .catch(console.error);

// — CORS —
app.use(cors({ origin: '*', methods: ['POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));

// — Subscribe endpoint — stores only productId
app.post('/subscribe', bodyParser.json(), async (req, res) => {
  const { email, productId } = req.body;
  if (!email || !productId) {
    return res.status(400).json({ message: 'Missing email or productId' });
  }
  await subsColl.insertOne({ email, productId });
  res.send('OK');
});

// — Shopify webhook HMAC verify —
function verifyShopify(req, res, buf) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(buf)
    .digest('base64');
  if (digest !== hmacHeader) throw new Error('⚠️ Invalid HMAC');
}

// — Inventory-level update webhook — map back to productId
app.post(
  '/webhook',
  bodyParser.raw({ type: 'application/json', verify: verifyShopify }),
  async (req, res) => {
    const data = JSON.parse(req.body.toString());
    const { inventory_item_id, available } = data;
    console.log('↪️ Received inventory webhook:', data);

    // only when stock > 0
    if (available > 0) {
      // we need the variantId to fetch productId
      // inventory_item_id → find the variant with that id via Shopify’s JSON variant endpoint
      // (the first variant that matches)
      let variant;
      try {
        const resp = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/variants/${inventory_item_id}.json`);
        const json = await resp.json();
        variant = json.variant;
      } catch (err) {
        console.error('❌ Could not fetch variant:', err);
        return res.sendStatus(500);
      }

      const productId = String(variant.product_id);

      // find all subscribers for that product
      const subs = await subsColl.find({ productId }).toArray();
      if (subs.length) {
        // send mail
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT),
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
              <p>Good news! The product you signed up for is back in stock.</p>
              <p>
                <a href="https://${process.env.SHOPIFY_SHOP_DOMAIN}/products/${s.productId}">
                  Click here to shop now →
                </a>
              </p>`
          })
        ));

        // clear them off the list
        await subsColl.deleteMany({ productId });
      }
    }

    res.sendStatus(200);
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));


