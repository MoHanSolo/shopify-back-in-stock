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

// — CORS for your shop —
app.use(cors({
  origin: '*',
  methods: ['POST','OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// — Subscribe endpoint —
app.post('/subscribe', bodyParser.json(), async (req, res) => {
  const { email, productId, variantId } = req.body;
  if (!email || !productId || !variantId) {
    return res.status(400).send('Missing email, productId or variantId');
  }
  await subsColl.insertOne({
    email,
    productId:  productId.toString(),
    variantId:  variantId.toString()
  });
  res.send('OK');
});

// — Shopify webhook HMAC verification —
function verifyShopify(req, res, buf) {
  const hmac   = req.get('X-Shopify-Hmac-Sha256');
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(buf)
    .digest('base64');
  if (digest !== hmac) {
    console.error('❌ Invalid HMAC, rejecting webhook');
    return res.sendStatus(403);
  }
}

// — Variant Update webhook handler —
app.post(
  '/webhook',
  bodyParser.raw({ type: 'application/json', verify: verifyShopify }),
  async (req, res) => {
    const data = JSON.parse(req.body.toString());
    const { id: variantId, product_id: productId, inventory_quantity } = data;
    console.log('↪️ Variant Update payload:', data);

    // When stock returns above zero
    if (inventory_quantity > 0) {
      const subs = await subsColl.find({
        productId: productId.toString(),
        variantId: variantId.toString()
      }).toArray();

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

        // send emails in parallel
        await Promise.all(subs.map(s =>
          transporter.sendMail({
            from:    process.env.SMTP_USER,
            to:      s.email,
            subject: `✅ Back in Stock!`,
            html: `
              <p>Good news — the variant you asked about is back in stock!</p>
              <p>
                <a href="https://${process.env.SHOPIFY_SHOP_DOMAIN}/products/${s.productId}?variant=${s.variantId}">
                  Click here to buy now
                </a>
              </p>`
          })
        ));

        // remove only those subscribers for this product+variant
        await subsColl.deleteMany({
          productId: productId.toString(),
          variantId: variantId.toString()
        });
      }
    }

    res.sendStatus(200);
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));


