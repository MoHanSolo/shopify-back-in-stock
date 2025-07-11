require('dotenv').config()
console.log('SMTP_USER →', process.env.SMTP_USER);
console.log('SMTP_PASS →', process.env.SMTP_PASS ? '*** loaded ***' : process.env.SMTP_PASS);
console.log('→ MONGODB_URI:', process.env.MONGODB_URI);
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const crypto = require('crypto')
const { MongoClient } = require('mongodb')
const nodemailer = require('nodemailer') 

const app = express()
let subsColl;

// allow all origins (or lock it down to your shop domain)
app.use(cors({
  origin: '*',
  methods: ['POST','OPTIONS'],
  allowedHeaders: ['Content-Type']
}))

// - Connect to MongoDB Atlas
MongoClient.connect(process.env.MONGODB_URI, { useUnifiedTopology: true })
    .then(client => {
        subsColl = client.db(process.env.MONGODB_DB).collection('subscriptions')
        console.log('Woo! Connected to MongoDB!')
    })
    .catch(console.error)

// - Subscribe endpoint

app.post('/subscribe', bodyParser.json(), async (req, res) => {
  const { email, productId, variantId } = req.body;

  // require just email + variantId now
  if (!email || !variantId) {
    return res.status(400).send('Missing data');
  }

  await subsColl.insertOne({ email, productId, variantId });
  res.send('OK');
});

// - Shopify webhook verification
function verifyShopify(req, res, buf) {
    const hmac = req.get('X-Shopify-Hmac-Sha256')
    const digest = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
                .update(buf).digest('base64')
    
    
            console.log('-> SHOPIFY HEADER:', hmac)
            console.log('-> COMPUTED HMAC:', digest)
            if (digest !== hmac) throw new Error('Invalid HMAC')
}

// - Webhook endpoint
 app.post(
   '/webhook',
  bodyParser.raw({ type: 'application/json', /* verify: verifyShopify */ }),
  async (req, res) => {
    console.log('📬 Received webhook headers:', req.headers);
    console.log('📬 Raw body:', req.body.toString());

    // buffer → string → JSON
    const data = JSON.parse(req.body.toString());
    const { id: variantId, inventory_quantity } = data;

        if (inventory_quantity > 0) {
            const subs = await subsColl.find({ variantId: variantId.toString() }).toArray();
            if (subs.length) {
                // setup mailer
                const transporter = nodemailer.createTransport({
                    host: process.env.SMTP_HOST,
                    port: Number(process.env.SMTP_PORT),
                    secure: process.env.SMTP_PORT==465,
                    auth: {
                        user: process.env.SMTP_USER,
                        pass: process.env.SMTP_PASS
                    }
                })

                // send and clear
                await Promise.all(subs.map(s =>
                    transporter.sendMail({
                        from: process.env.SMTP_USER,
                        to: s.email,
                        subject: `✅ Back in Stock!`,
                        html: `
                        <div>
                            <p>Good news! The product you asked for is back in stock.</p>
                            <p>
                            <a href="https://${process.env.SHOPIFY_SHOP_DOMAIN}/products/${s.productId}?variant=${s.variantId}">
                                Click here to shop now
                            </a>
                            </p>
                        </div>
                        `
                    })
                ));
                await subsColl.deleteMany({ variantId: variantId.toString() })
            }
        }
        res.sendStatus(200)
    }
)

// - Launch
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Listening on ${PORT}`))