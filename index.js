require('dotenv').config();
const express       = require('express');
const bodyParser    = require('body-parser');
const cors          = require('cors');
const crypto        = require('crypto');
const { MongoClient } = require('mongodb');
const nodemailer    = require('nodemailer');

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

// — CORS so your store can POST to /subscribe —
app.use(cors({
  origin: '*',
  methods: ['POST','OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// — Subscribe endpoint —
app.post('/subscribe', bodyParser.json(), async (req, res) => {
  const { email, productId, variantId, inventoryItemId } = req.body;
  if (!email || !variantId || !inventoryItemId) {
    return res.status(400).send('Missing email, variantId, or inventoryItemId');
  }
  await subsColl.insertOne({ email, productId, variantId, inventoryItemId });
  res.send('OK');
});

// — Shopify webhook HMAC verify —
function verifyShopify(req, res, buf) {
  const hmac   = req.get('X-Shopify-Hmac-Sha256');
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(buf)
    .digest('base64');

  if (digest !== hmac) throw new Error('Invalid HMAC');
}

// — Inventory-level update webhook handler —
app.post(
  '/webhook',
  bodyParser.raw({ type: 'application/json', verify: verifyShopify }),
  async (req, res) => {
    const data = JSON.parse(req.body.toString());
    const { inventory_item_id, available } = data;
    console.log('↪️ webhook payload:', data);

    if (available > 0) {
      const subs = await subsColl
        .find({ inventoryItemId: inventory_item_id.toString() })
        .toArray();

      if (subs.length) {
        // set up mailer
        const transporter = nodemailer.createTransport({
          host:   process.env.SMTP_HOST,
          port:   Number(process.env.SMTP_PORT),
          secure: Number(process.env.SMTP_PORT) === 465,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          }
        });

        // send everyone their notification
        await Promise.all(subs.map(s =>
          transporter.sendMail({
            from:    process.env.SMTP_USER,
            to:      s.email,
            subject: `✅ Back in Stock!`,
            html: `
              <p>Good news — the item you asked for is back in stock!</p>
              <p>
                <a href="https://${process.env.SHOPIFY_SHOP_DOMAIN}/products/${s.productId}?variant=${s.variantId}">
                  Click here to buy now
                </a>
              </p>`
          })
        ));

        // remove them from the queue
        await subsColl.deleteMany(
          { inventoryItemId: inventory_item_id.toString() }
        );
      }
    }

    res.sendStatus(200);
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
