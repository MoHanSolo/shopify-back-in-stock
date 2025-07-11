require('dotenv').config();
const express   = require('express');
const bodyParser= require('body-parser');
const cors      = require('cors');
const crypto    = require('crypto');
const { MongoClient } = require('mongodb');
const nodemailer= require('nodemailer');

const app = express();
let subsColl;

// allow all origins (or lock it down to your shop domain)
app.use(cors({
  origin: '*',
  methods: ['POST','OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// connect to MongoDB
MongoClient.connect(process.env.MONGODB_URI, { useUnifiedTopology: true })
  .then(client => {
    subsColl = client.db(process.env.MONGODB_DB).collection('subscriptions');
    console.log('✔️ Connected to MongoDB');
  })
  .catch(err => {
    console.error('❌ Mongo connection error', err);
    process.exit(1);
  });

//
// 1) SUBSCRIBE end-point
//
app.post('/subscribe', bodyParser.json(), async (req, res) => {
  const { email, productId, variantId } = req.body;

  // we're only requiring email + variantId now
  if (!email || !variantId) {
    return res.status(400).send('Missing data');
  }

  try {
    await subsColl.insertOne({ email, productId, variantId });
    console.log(`→ New subscription: ${email} / variant ${variantId}`);
    return res.send('OK');
  } catch (e) {
    console.error('Insert error:', e);
    return res.status(500).send('Server error');
  }
});

//
// 2) WEBHOOK end-point (Inventory level update)
//
function verifyShopify(req, res, buf) {
  const hmac     = req.get('X-Shopify-Hmac-Sha256');
  const digest   = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
                         .update(buf)
                         .digest('base64');
  if (digest !== hmac) {
    throw new Error('❌ Invalid HMAC');
  }
}

app.post(
  '/webhook',
  // verify: verifyShopify,   // uncomment once you have your secret set
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    console.log('📬 webhook headers:', req.headers);
    console.log('📬 raw body:', req.body.toString());

    let data;
    try {
      data = JSON.parse(req.body.toString());
    } catch (e) {
      console.error('Invalid JSON:', e);
      return res.sendStatus(400);
    }

    // Shopify's InventoryLevel update payload uses `inventory_item_id` + `available`
    const { inventory_item_id: inventoryItemId, available } = data;

    if (available > 0) {
      // find any waiting subscribers for this variant
      const subs = await subsColl.find({ variantId: String(inventoryItemId) }).toArray();
      console.log(`→ found ${subs.length} subscriber(s) for ${inventoryItemId}`);

      if (subs.length) {
        // set up transporter
        const transporter = nodemailer.createTransport({
          host:   process.env.SMTP_HOST,
          port:   Number(process.env.SMTP_PORT),
          secure: process.env.SMTP_PORT == 465,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          }
        });

        // send emails in parallel
        await Promise.all(subs.map(s =>
          transporter.sendMail({
            from: process.env.SMTP_USER,
            to:   s.email,
            subject: `✅ Back in Stock!`,
            html: `
              <p>Good news! Your item is back in stock.</p>
              <p><a href="https://${process.env.SHOPIFY_SHOP_DOMAIN}/products/${s.productId}?variant=${s.variantId}">
                Click here to buy now
              </a></p>
            `
          })
        ));

        // clear them out
        await subsColl.deleteMany({ variantId: String(inventoryItemId) });
        console.log(`→ Cleared ${subs.length} subscription(s) for ${inventoryItemId}`);
      }
    }

    return res.sendStatus(200);
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});
