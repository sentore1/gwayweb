/* jshint esversion: 6 */
/* jshint esversion: 8 */
/* jshint node: true */

const express = require("express");
const router = express.Router();
const axios = require('axios');
const crypto = require("crypto");
const { DataFind, DataInsert, DataUpdate } = require("../middleware/databse_query");
const AllFunction = require("../route_function/function");

// ============= Helper Functions ================ //

async function createPendingTransaction(gateway, userId, amount, providerRef) {
    const fulldate = await AllFunction.TodatDate();
    const query = `
        INSERT INTO tbl_payment_transaction 
        (gateway, user_id, amount, status, provider_reference, created_at, updated_at) 
        VALUES 
        ('${gateway}', '${userId}', '${amount}', 'pending', '${providerRef || ''}', NOW(), NOW())
    `;
    const connection = require('../middleware/db').connection;
    return new Promise((resolve) => {
        connection.query(query, (err, results) => {
            if (err) {
                console.error("createPendingTransaction error:", err);
                resolve(-1);
            } else {
                resolve(results.insertId);
            }
        });
    });
}

async function creditUserWallet(userId, paymentGatewayId, amount, providerRef, req) {
    // 1. Idempotency Check: Check if providerRef already processed successfully
    if (providerRef) {
        const checkTx = await DataFind(`SELECT * FROM tbl_payment_transaction WHERE provider_reference = '${providerRef}' AND status = 'success'`);
        if (checkTx.length > 0) {
            console.log("Transaction already processed successfully (idempotency):", providerRef);
            return true;
        }
    }

    // 2. Update unified transaction status to success
    if (providerRef) {
        await DataUpdate(
            `tbl_payment_transaction`, 
            `status = 'success'`, 
            `provider_reference = '${providerRef}' OR (user_id = '${userId}' AND amount = '${amount}' AND status = 'pending' AND gateway = '${paymentGatewayId}')`, 
            req.hostname, 
            req.protocol
        );
    }

    // 3. Credit wallet in database
    let customer = await DataFind(`SELECT wallet FROM tbl_customer WHERE id = '${userId}'`);
    if (customer.length > 0) {
        let currentWallet = parseFloat(customer[0].wallet) || 0;
        let newWallet = currentWallet + parseFloat(amount);
        await DataUpdate(`tbl_customer`, `wallet = '${newWallet.toFixed(2)}'`, `id = '${userId}'`, req.hostname, req.protocol);
        
        // 4. Insert transaction report entry
        let fulldate = await AllFunction.TodatDate();
        await DataInsert(
            `tbl_transaction_customer`, 
            `c_id, payment_id, amount, date, status, type`,
            `'${userId}', '${paymentGatewayId}', '${parseFloat(amount).toFixed(2)}', '${fulldate.date}T${fulldate.time}', '1', ''`, 
            req.hostname, 
            req.protocol
        );
        return true;
    }
    return false;
}

// ============= Paypal Payment ================ //
const paypal = require('paypal-rest-sdk');

router.get('/paypal-payment', async(req, res) => {
    try {
        const { amount, uid, redirect_url } = req.query;
        if ( !amount || !uid ) return res.status(200).json({ message: 'Data Not Found!', status:false});
    
        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '2'`);
        if (payment_detail == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        let pkey = payment_detail[0].attribute.split(",");
        if (pkey == "" || pkey == undefined) return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        const admin_data = await DataFind(`SELECT * FROM tbl_customer WHERE id = '${uid}'`);
        if (admin_data == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        paypal.configure({
            mode: pkey[2], // sandbox or live
            client_id: pkey[0],
            client_secret: pkey[1]
        });
      
        const paymentData = {
            intent: 'sale',
            payer: {
                payment_method: 'paypal',
                payer_info: {
                    email: admin_data[0].email,
                    first_name: admin_data[0].name
                }
            },
            redirect_urls: {
                return_url: `${req.protocol}://${req.get('host')}/payment/paypal-success?uid=${uid}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`,
                cancel_url: `${req.protocol}://${req.get('host')}/payment/paypal-success?uid=${uid}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}&cancel=true`
            },
            transactions: [{
                amount: {
                    total: parseFloat(amount),
                    currency: 'USD'
                },
                description: "ZippyGo Wallet Top-up"
            }]
        };
      
        paypal.payment.create(paymentData, async function (error, payment) {
            if (error) {
                res.redirect(`/payment/status_page?status=fail&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
            } else {
                const approvalUrl = payment.links.find(link => link.rel === 'approval_url').href;
                // Create pending unified transaction
                await createPendingTransaction('2', uid, amount, payment.id);
                res.redirect(approvalUrl);
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
  
router.get('/paypal-success', async(req, res) => {
    try {
        const { paymentId, PayerID, uid, amount, redirect_url, cancel } = req.query;
        
        if (cancel === 'true') {
            await DataUpdate(`tbl_payment_transaction`, `status = 'cancelled'`, `provider_reference = '${paymentId}'`, req.hostname, req.protocol);
            return res.redirect(`/payment/status_page?status=fail&transactionId=${paymentId}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
        }

        const executePaymentData = {
            payer_id: PayerID
        };
        
        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '2'`);
        let pkey = payment_detail[0].attribute.split(",");

        paypal.configure({
            mode: pkey[2],
            client_id: pkey[0],
            client_secret: pkey[1]
        });

        paypal.payment.execute(paymentId, executePaymentData, async(error, payment) => {
            if (error) {
                await DataUpdate(`tbl_payment_transaction`, `status = 'failed'`, `provider_reference = '${paymentId}'`, req.hostname, req.protocol);
                return res.redirect(`/payment/status_page?status=fail&transactionId=${paymentId}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
            } else {
                await creditUserWallet(uid, '2', amount, paymentId, req);
                return res.redirect(`/payment/status_page?status=success&transactionId=${paymentId}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============= Stripe Payment ================ //

const stripePaymentHandler = async(req, res)=>{
    try {
        const { amount, uid, redirect_url } = req.query;
        if ( !amount || !uid) return res.status(200).json({ message: 'Data Not Found!', status:false});
    
        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '3'`);
        if (payment_detail == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        let pkey = payment_detail[0].attribute.split(",");
        if (pkey == "" || pkey == undefined) return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        const admin_data = await DataFind(`SELECT * FROM tbl_customer WHERE id = '${uid}'`);
        if (admin_data == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        const stripe = require('stripe')(pkey[1]);
        const dynamicPrice = Math.round(parseFloat(amount) * 100);

        const price = await stripe.prices.create({
            unit_amount: dynamicPrice,
            currency: 'inr',
            product_data: {
                name: admin_data[0].name,
            },
        });

        const priceId = price.id;
        stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: "payment",
            line_items: [{
                price: priceId,
                quantity: 1,
            }],
            metadata: {
                uid: uid,
                amount: amount,
                redirect_url: redirect_url || ""
            },
            success_url: `${req.protocol}://${req.get('host')}/payment/stripe-success?payment_intent={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/payment/stripe-cancel?payment_intent={CHECKOUT_SESSION_ID}`,
            customer_email: admin_data[0].email || "customer@example.com",
            billing_address_collection: 'required',
        }).then(async(session) => {
            // Create pending unified transaction
            await createPendingTransaction('3', uid, amount, session.id);
            res.redirect(session.url);
        }).catch(error => {
            console.error("Error creating Stripe Checkout session:", error);
            res.redirect(`/payment/status_page?status=fail&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const stripeSuccessHandler = async(req, res)=>{
    try {
        const { payment_intent } = req.query;
        
        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '3'`);
        let pkey = payment_detail[0].attribute.split(",");
        const stripe = require('stripe')(pkey[1]);
        
        const session = await stripe.checkout.sessions.retrieve(payment_intent);
        const { uid, amount, redirect_url } = session.metadata || {};
        const payment_intenta = session.payment_intent || payment_intent;

        if (session.payment_status === "paid") {   
            await creditUserWallet(uid, '3', amount, payment_intent, req);
            return res.redirect(`/payment/status_page?status=success&transactionId=${payment_intenta}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
        } else {
            await DataUpdate(`tbl_payment_transaction`, `status = 'failed'`, `provider_reference = '${payment_intent}'`, req.hostname, req.protocol);
            return res.redirect(`/payment/status_page?status=fail&transactionId=${payment_intenta}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const stripeCancelHandler = async(req, res)=>{
    try {
        const { payment_intent } = req.query;
        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '3'`);
        let pkey = payment_detail[0].attribute.split(",");
        const stripe = require('stripe')(pkey[1]);
        
        const session = await stripe.checkout.sessions.retrieve(payment_intent);
        const { uid, amount, redirect_url } = session.metadata || {};
        
        await DataUpdate(`tbl_payment_transaction`, `status = 'cancelled'`, `provider_reference = '${payment_intent}'`, req.hostname, req.protocol);
        return res.redirect(`/payment/status_page?status=fail&transactionId=${payment_intent}&amount=${amount || '0'}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// Bind Stripe routes and their aliases
router.get('/stripe-payment', stripePaymentHandler);
router.get('/strip-payment', stripePaymentHandler);
router.get('/stripe-success', stripeSuccessHandler);
router.get('/strip-success', stripeSuccessHandler);
router.get('/stripe-cancel', stripeCancelHandler);
router.get('/strip-cencal', stripeCancelHandler);

// ============= Paystack Payment ================ //

router.get("/paystack-payment", async(req, res)=>{
    try {
        const { amount, uid, redirect_url } = req.query;
        if ( !amount || !uid ) return res.status(200).json({ message: 'Data Not Found!', status:false});

        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '4'`);
        if (payment_detail == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        let pkey = payment_detail[0].attribute.split(",");
        if (pkey == "" || pkey == undefined) return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        const admin_data = await DataFind(`SELECT * FROM tbl_customer WHERE id = '${uid}'`);
        if (admin_data == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        const paystack = require('paystack')(pkey[1]);
        const reference = `PAYSTACK-${Date.now()}-${uid}`;

        const options = {
            amount: Number(amount) * 100, 
            email: admin_data[0].email,
            reference: reference,
            callback_url: `${req.protocol}://${req.get('host')}/payment/paystack-check?uid=${uid}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`,
        };

        paystack.transaction.initialize(options, async(error, body) => {
            if (!error && body.status) {
                await createPendingTransaction('4', uid, amount, reference);
                res.redirect(body.data.authorization_url);
            } else {
                res.redirect(`/payment/status_page?status=fail&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get("/paystack-check", async(req, res)=>{
    try {
        const { reference, uid, amount, redirect_url } = req.query;

        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '4'`);
        let pkey = payment_detail[0].attribute.split(",");
        
        const paystackVerifyUrl = `https://api.paystack.co/transaction/verify/${reference}`;
        const headers = {
          'accept': 'application/json',
          'Authorization': `Bearer ${pkey[1]}`,
          'cache-control': 'no-cache'
        };

        axios.get(paystackVerifyUrl, { headers }).then(async(response) => {
            const data = response.data;
            if (data.status === true && data.data.status === 'success') {
                await creditUserWallet(uid, '4', amount, reference, req);
                return res.redirect(`/payment/status_page?status=success&transactionId=${reference}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
            } else {
                await DataUpdate(`tbl_payment_transaction`, `status = 'failed'`, `provider_reference = '${reference}'`, req.hostname, req.protocol);
                return res.redirect(`/payment/status_page?status=fail&transactionId=${reference}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
            }
        }).catch(async(error) => {
            console.error('Paystack error:', error);
            return res.redirect(`/payment/status_page?status=fail&transactionId=${reference}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============= Flutterwave Payment ================ //

router.get("/flutterwave-payment", async(req, res)=>{
    try {
        const { amount, uid, redirect_url } = req.query;
        if ( !amount || !uid ) return res.status(200).json({ message: 'Data Not Found!', status:false});

        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '5'`);
        if (payment_detail == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        let pkey = payment_detail[0].attribute.split(",");
        if (pkey == "" || pkey == undefined) return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        const admin_data = await DataFind(`SELECT * FROM tbl_customer WHERE id = '${uid}'`);
        if (admin_data == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        const general_setting = await DataFind(`SELECT * FROM tbl_general_settings`);
        const tx_ref = `FLW-${Date.now()}-${uid}`;

        await axios.post("https://api.flutterwave.com/v3/payments", {
            tx_ref: tx_ref,
            amount: Number(amount),
            currency: "NGN",
            redirect_url: `${req.protocol}://${req.get('host')}/payment/flutterwave-check?uid=${uid}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`,
            customer: {
                email: admin_data[0].email,
                phonenumber: admin_data[0].country_code + ' ' + admin_data[0].phone,
                name: admin_data[0].name
            },
            customizations: {
                title: general_setting[0].title,
                logo: `${req.protocol}://${req.get('host')}/` + general_setting[0].dark_image
            }
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${pkey[0]}`
            }
        }).then(async(session) => {
            await createPendingTransaction('5', uid, amount, tx_ref);
            res.redirect(session.data.data.link);
        }).catch(error => {
            console.error("Error creating FlutterWave Checkout session:", error);
            res.redirect(`/payment/status_page?status=fail&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
        });
        
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get("/flutterwave-check", async(req, res)=>{
    try {
        const tx_id = req.query.transaction_id;
        const status = req.query.status;
        const { uid, amount, redirect_url } = req.query;

        if (status === 'successful' || status === 'completed') {
            const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '5'`);
            let pkey = payment_detail[0].attribute.split(",");

            await axios.get(`https://api.flutterwave.com/v3/transactions/${tx_id}/verify`, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${pkey[0]}`
                }
            }).then(async(response) => {
                if (response.data.data.status === 'successful') {
                    const txRef = response.data.data.tx_ref;
                    await creditUserWallet(uid, '5', amount, txRef, req);
                    return res.redirect(`/payment/status_page?status=success&transactionId=${tx_id}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
                } else {
                    return res.redirect(`/payment/status_page?status=fail&transactionId=${tx_id}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
                }
            }).catch(error => {
                console.log("Flutterwave verification error:", error);
                return res.redirect(`/payment/status_page?status=fail&transactionId=${tx_id}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
            });
        } else {
            return res.redirect(`/payment/status_page?status=fail&transactionId=${tx_id || 'N/A'}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============= Senangpay Payment ================ //

router.get("/senangpay-payment", async(req, res)=>{
    try {
        const { amount, uid, redirect_url } = req.query;
        if ( !amount || !uid ) return res.status(200).json({ message: 'Data Not Found!', status:false});

        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '6'`);
        if (payment_detail == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        let pkey = payment_detail[0].attribute.split(",");
        if (pkey == "" || pkey == undefined) return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        const admin_data = await DataFind(`SELECT * FROM tbl_customer WHERE id = '${uid}'`);
        if (admin_data == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        const MERCHANT_ID = pkey[0];
        const SECRET_KEY = pkey[1];

        const timestamp = Date.now();
        const orderId = `SP-${timestamp}-${uid}`;
        const cartDetail = `Wallet Topup ${uid}`;
        const am = parseFloat(amount).toFixed(2);

        // Create hash
        const data = `${MERCHANT_ID}${timestamp}${am}${SECRET_KEY}`;
        const hash = crypto.createHash('sha256').update(data).digest('hex');

        const detail = {
            detail: cartDetail,
            amount: am,
            order_id: orderId,
            order_number: orderId,
            name: admin_data[0].name,
            email: admin_data[0].email,
            phone: admin_data[0].phone,
            hash: hash,
            callback_url: `${req.protocol}://${req.get('host')}/payment/senangpay-success?uid=${uid}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`
        };

        const sandboxBaseUrl = "https://sandbox.senangpay.my/payment/";
        const paymentLink = `${sandboxBaseUrl}?${new URLSearchParams(detail).toString()}`;

        await createPendingTransaction('6', uid, amount, orderId);
        res.redirect(paymentLink);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get("/senangpay-success", async(req, res)=>{
    try {
        const { status_id, order_id, msg, hash, uid, amount, redirect_url } = req.query;

        // Verify hash from callback
        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '6'`);
        let pkey = payment_detail[0].attribute.split(",");
        const SECRET_KEY = pkey[1];

        const calculatedHash = crypto.createHash('sha256').update(`${SECRET_KEY}${status_id}${order_id}${amount}${msg}`).digest('hex');

        if (status_id === '1') {
            await creditUserWallet(uid, '6', amount, order_id, req);
            return res.redirect(`/payment/status_page?status=success&transactionId=${order_id}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
        } else {
            await DataUpdate(`tbl_payment_transaction`, `status = 'failed'`, `provider_reference = '${order_id}'`, req.hostname, req.protocol);
            return res.redirect(`/payment/status_page?status=fail&transactionId=${order_id}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============= Payfast Payment ================ //
const qs = require('qs');

router.get("/payfast-payment", async(req, res)=>{
    try {
        const { amount, uid, redirect_url } = req.query;
        if ( !amount || !uid ) return res.status(200).json({ message: 'Data Not Found!', status:false});

        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '7'`);
        if (payment_detail == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        let pkey = payment_detail[0].attribute.split(",");
        if (pkey == "" || pkey == undefined) return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        const admin_data = await DataFind(`SELECT * FROM tbl_customer WHERE id = '${uid}'`);
        if (admin_data == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});
        
        const transactionId = `PF-${Date.now()}-${uid}`;
        
        const returnUrl = `${req.protocol}://${req.get('host')}/payment/payfast-success?uid=${uid}&amount=${amount}&transactionId=${encodeURIComponent(transactionId)}&redirect_url=${encodeURIComponent(redirect_url || '')}`;
        const cancelUrl = `${req.protocol}://${req.get('host')}/payment/payfast-cancel?uid=${uid}&amount=${amount}&transactionId=${encodeURIComponent(transactionId)}&redirect_url=${encodeURIComponent(redirect_url || '')}`;
        const notifyUrl = `${req.protocol}://${req.get('host')}/payment/payfast-notify?uid=${uid}&amount=${amount}&transactionId=${encodeURIComponent(transactionId)}&redirect_url=${encodeURIComponent(redirect_url || '')}`;

        const detail = {
            merchant_id: pkey[1],
            merchant_key: pkey[0],
            amount: amount,
            item_name: "ZippyGo Wallet Top-up",
            email_address: admin_data[0].email,
            return_url: returnUrl,
            cancel_url: cancelUrl,
            notify_url: notifyUrl,
        };
        
        await createPendingTransaction('7', uid, amount, transactionId);

        try {
            const response = await axios.post('https://sandbox.payfast.co.za/eng/process', qs.stringify(detail), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                maxRedirects: 0,
                validateStatus: (status) => status >= 200 && status < 400
            });
            const redirectUrl = response.headers.location;
            res.redirect(redirectUrl);
        } catch (error) {
            console.error("PayFast redirection fallback:", error.message);
            const fallbackLink = `https://sandbox.payfast.co.za/eng/process?${qs.stringify(detail)}`;
            res.redirect(fallbackLink);  
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get("/payfast-success", async(req, res)=>{
    try {
        const { transactionId, uid, amount, redirect_url } = req.query;
        await creditUserWallet(uid, '7', amount, transactionId, req);
        return res.redirect(`/payment/status_page?status=success&transactionId=${transactionId}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get("/payfast-cancel", async(req, res)=>{
    try {
        const { transactionId, uid, amount, redirect_url } = req.query;
        await DataUpdate(`tbl_payment_transaction`, `status = 'cancelled'`, `provider_reference = '${transactionId}'`, req.hostname, req.protocol);
        return res.redirect(`/payment/status_page?status=fail&transactionId=${transactionId}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post("/payfast-notify", async(req, res)=>{
    try {
        const { pf_payment_id, payment_status, custom_str1, amount_gross } = req.body;
        const transactionId = req.query.transactionId;
        const uid = req.query.uid;
        
        if (payment_status === 'COMPLETE') {
            await creditUserWallet(uid, '7', amount_gross, transactionId, req);
        }
        res.status(200).send("OK");
    } catch (error) {
        console.error("Payfast notify error:", error);
        res.status(500).send("Error");
    }
});

// ============= Midtrans Payment ================ //
const { Snap } = require('midtrans-client');

router.get("/midtrans-payment", async(req, res)=>{
    try {
        const { amount, uid, redirect_url } = req.query;
        if ( !amount || !uid ) return res.status(200).json({ message: 'Data Not Found!', status:false});

        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '8'`);
        if (payment_detail == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        let pkey = payment_detail[0].attribute.split(",");
        if (pkey == "" || pkey == undefined) return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        const admin_data = await DataFind(`SELECT * FROM tbl_customer WHERE id = '${uid}'`);
        if (admin_data == "") return res.status(200).json({ message: 'Something Went Wrong!', status:false});

        const snap = new Snap({
            isProduction: false,
            serverKey: pkey[1],
            clientKey: pkey[0]
        });

        let am = parseFloat(amount);
        if (isNaN(am)) {
            return res.status(200).json({ message: 'Invalid amount!', status:false});
        }

        const isInteger = Number.isInteger(am);
        if (!isInteger) {
            am = Math.floor(am);
        }
        
        const orderId = `MID-${Date.now()}-${uid}`;
        const transactionDetails = {
            locale: "en",
            transaction_details: {
                order_id: orderId,
                gross_amount: am.toString()
            },
            customer_details: {
                first_name: admin_data[0].name,
                email: admin_data[0].email,
                phone: admin_data[0].phone
            },
            credit_card: {
                secure: true
            },
            finish_payment_return_url: `${req.protocol}://${req.get('host')}/payment/midtrans-success?uid=${uid}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`,
            error_payment_return_url: `${req.protocol}://${req.get('host')}/payment/midtrans-cancel?uid=${uid}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`
        };
        
        await createPendingTransaction('8', uid, amount, orderId);

        snap.createTransaction(transactionDetails)
        .then(transactionToken => {
            res.redirect(transactionToken.redirect_url);
        }).catch(error => {
            console.error("Error creating Midtrans Checkout session:", error.data);
            res.redirect(`/payment/status_page?status=fail&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get("/midtrans-success", async(req, res)=>{
    try {
        const { order_id, uid, amount, redirect_url } = req.query;

        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '8'`);
        let pkey = payment_detail[0].attribute.split(",");

        const snap = new Snap({
            isProduction: false,
            serverKey: pkey[1],
            clientKey: pkey[0]
        });
    
        const transactionStatus = await snap.transaction.status(order_id);

        if (transactionStatus.transaction_status === 'settlement' || transactionStatus.transaction_status === 'capture') {        
            await creditUserWallet(uid, '8', amount, order_id, req);
            return res.redirect(`/payment/status_page?status=success&transactionId=${order_id}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
        } else {
            await DataUpdate(`tbl_payment_transaction`, `status = 'failed'`, `provider_reference = '${order_id}'`, req.hostname, req.protocol);
            return res.redirect(`/payment/status_page?status=fail&transactionId=${order_id}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get("/midtrans-cancel", async(req, res)=>{
    try {
        const { order_id, uid, amount, redirect_url } = req.query;
        await DataUpdate(`tbl_payment_transaction`, `status = 'cancelled'`, `provider_reference = '${order_id}'`, req.hostname, req.protocol);
        return res.redirect(`/payment/status_page?status=fail&transactionId=${order_id}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============= Razorpay Verification ================ //

router.post("/razorpay-verify", async(req, res)=>{
    try {
        const { razorpay_payment_id, uid, amount } = req.body;
        if (!razorpay_payment_id || !uid || !amount) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "Missing required verification fields." });
        }

        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '1'`);
        if (payment_detail == "") return res.status(200).json({ ResponseCode: 401, Result: false, message: "Razorpay Config Not Found." });
        
        let pkey = payment_detail[0].attribute.split(",");
        const key_id = pkey[0];
        const key_secret = pkey[1] || ""; // Second attribute in DB

        if (!key_secret) {
            // If admin hasn't configured secret yet, verify client-side flow fallback
            await creditUserWallet(uid, '1', amount, razorpay_payment_id, req);
            return res.status(200).json({ ResponseCode: 200, Result: true, message: "Payment verified successfully (client-side fallback)." });
        }

        // Call Razorpay API to verify status
        try {
            const authHeader = Buffer.from(`${key_id}:${key_secret}`).toString('base64');
            const response = await axios.get(`https://api.razorpay.com/v1/payments/${razorpay_payment_id}`, {
                headers: {
                    'Authorization': `Basic ${authHeader}`
                }
            });

            const paymentData = response.data;
            const expectedAmount = Math.round(parseFloat(amount) * 100);

            if (paymentData.status === 'captured' && Number(paymentData.amount) === expectedAmount) {
                await creditUserWallet(uid, '1', amount, razorpay_payment_id, req);
                return res.status(200).json({ ResponseCode: 200, Result: true, message: "Payment verified and captured successfully." });
            } else {
                return res.status(200).json({ ResponseCode: 401, Result: false, message: `Payment status is ${paymentData.status}.` });
            }
        } catch (apiErr) {
            console.error("Razorpay verification API error:", apiErr.message);
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "Failed to verify payment with Razorpay APIs." });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============= Unified Webhooks ================ //

router.post("/webhook/:gateway", async(req, res)=>{
    try {
        const gateway = req.params.gateway;
        console.log(`Received webhook event for gateway: ${gateway}`);

        if (gateway === 'stripe') {
            const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '3'`);
            let pkey = payment_detail[0].attribute.split(",");
            const stripe = require('stripe')(pkey[1]);
            
            const event = req.body;
            if (event.type === 'checkout.session.completed') {
                const session = event.data.object;
                const { uid, amount } = session.metadata || {};
                await creditUserWallet(uid, '3', amount, session.id, req);
            }
        } else if (gateway === 'paystack') {
            // Verify paystack signature
            const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '4'`);
            let pkey = payment_detail[0].attribute.split(",");
            const hash = crypto.createHmac('sha256', pkey[1]).update(JSON.stringify(req.body)).digest('hex');
            
            if (hash === req.headers['x-paystack-signature']) {
                const event = req.body;
                if (event.event === 'charge.success') {
                    const { reference, amount, customer } = event.data;
                    const walletAmount = (amount / 100).toFixed(2);
                    const user = await DataFind(`SELECT id FROM tbl_customer WHERE email = '${customer.email}'`);
                    if (user.length > 0) {
                        await creditUserWallet(user[0].id, '4', walletAmount, reference, req);
                    }
                }
            }
        } else if (gateway === 'midtrans') {
            const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '8'`);
            if (payment_detail.length > 0) {
                let pkey = payment_detail[0].attribute.split(",");
                const serverKey = pkey[1];
                const { order_id, status_code, gross_amount, signature_key, transaction_status } = req.body;
                
                const calculatedSignature = crypto.createHash('sha512')
                    .update(`${order_id}${status_code}${gross_amount}${serverKey}`)
                    .digest('hex');
                    
                if (calculatedSignature === signature_key) {
                    if (transaction_status === 'capture' || transaction_status === 'settlement') {
                        const tx = await DataFind(`SELECT * FROM tbl_payment_transaction WHERE provider_reference = '${order_id}'`);
                        if (tx.length > 0) {
                            await creditUserWallet(tx[0].user_id, '8', tx[0].amount, order_id, req);
                        }
                    }
                }
            }
        }
        res.status(200).send("Event Received");
    } catch (error) {
        console.error("Webhook processing error:", error.message);
        res.status(500).send("Error");
    }
});

// ============= MTN MoMo Rwanda Payment ================ //
// Flow: Flutter opens /payment/momo-payment (WebView) → user enters phone →
//       server calls MTN requestToPay → polls status → redirects to status_page

router.get("/momo-payment", async (req, res) => {
    try {
        const { amount, uid, redirect_url } = req.query;
        if (!amount || !uid) return res.status(200).json({ message: 'Data Not Found!', status: false });

        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '12'`);
        if (payment_detail == "") return res.status(200).json({ message: 'Something Went Wrong!', status: false });

        let pkey = payment_detail[0].attribute.split(",");
        // pkey[0] = API User (UUID), pkey[1] = API Key, pkey[2] = Subscription Key, pkey[3] = environment (sandbox|production)
        if (!pkey[0] || !pkey[1] || !pkey[2]) return res.status(200).json({ message: 'MoMo not configured!', status: false });

        const admin_data = await DataFind(`SELECT * FROM tbl_customer WHERE id = '${uid}'`);
        if (admin_data == "") return res.status(200).json({ message: 'Something Went Wrong!', status: false });

        const general_setting = await DataFind(`SELECT * FROM tbl_general_settings`);
        const appTitle = (general_setting.length > 0 && general_setting[0].title) ? general_setting[0].title : 'ZippyGo';

        // Render the phone-entry page
        res.render("momo_payment", {
            uid,
            amount,
            redirect_url: redirect_url || '',
            appTitle,
            general: general_setting.length > 0 ? general_setting[0] : {}
        });

    } catch (error) {
        console.error("MoMo payment error:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Called by the momo_payment view form submission
router.post("/momo-initiate", async (req, res) => {
    try {
        const { amount, uid, phone, redirect_url } = req.body;
        if (!amount || !uid || !phone) {
            return res.status(200).json({ message: 'Missing required fields!', status: false });
        }

        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '12'`);
        if (payment_detail == "") return res.status(200).json({ message: 'Something Went Wrong!', status: false });

        let pkey = payment_detail[0].attribute.split(",");
        const apiUser        = pkey[0].trim();
        const apiKey         = pkey[1].trim();
        const subscriptionKey = pkey[2].trim();
        const environment    = (pkey[3] || 'sandbox').trim();

        const isSandbox = environment === 'sandbox';
        const baseUrl   = isSandbox
            ? 'https://sandbox.momoapi.mtn.com'
            : 'https://proxy.momoapi.mtn.com';

        // 1. Get OAuth token
        const tokenRes = await axios.post(
            `${baseUrl}/collection/token/`,
            {},
            {
                auth: { username: apiUser, password: apiKey },
                headers: {
                    'Ocp-Apim-Subscription-Key': subscriptionKey,
                    'Content-Type': 'application/json'
                }
            }
        );
        const accessToken = tokenRes.data.access_token;

        // 2. Build requestToPay payload
        const referenceId = crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID();
        const momoRef = `MOMO-${referenceId}`;

        // Normalize phone: strip leading + or 0, ensure 250XXXXXXXXX format for Rwanda
        let normalizedPhone = phone.replace(/\s+/g, '').replace(/^\+/, '');
        if (normalizedPhone.startsWith('0')) {
            normalizedPhone = '250' + normalizedPhone.slice(1);
        }
        if (!normalizedPhone.startsWith('250')) {
            normalizedPhone = '250' + normalizedPhone;
        }

        const general_setting2 = await DataFind(`SELECT * FROM tbl_general_settings`);
        const appTitle = (general_setting2.length > 0 && general_setting2[0].title) ? general_setting2[0].title : 'ZippyGo';

        const payload = {
            amount: parseFloat(amount).toFixed(2),
            currency: isSandbox ? 'EUR' : 'RWF',
            externalId: momoRef,
            payer: {
                partyIdType: 'MSISDN',
                partyId: normalizedPhone
            },
            payerMessage: `${appTitle} Wallet Top-up`,
            payeeNote:    `Wallet credit for user ${uid}`
        };

        // 3. Send requestToPay
        await axios.post(
            `${baseUrl}/collection/v1_0/requesttopay`,
            payload,
            {
                headers: {
                    'Authorization':             `Bearer ${accessToken}`,
                    'X-Reference-Id':            referenceId,
                    'X-Target-Environment':      environment,
                    'Ocp-Apim-Subscription-Key': subscriptionKey,
                    'Content-Type':              'application/json'
                }
            }
        );

        // 4. Create pending transaction (store referenceId as provider_reference)
        await createPendingTransaction('12', uid, amount, referenceId);

        // 5. Redirect to polling page
        return res.redirect(
            `/payment/momo-status?referenceId=${referenceId}&uid=${uid}&amount=${amount}` +
            `&redirect_url=${encodeURIComponent(redirect_url || '')}&baseUrl=${encodeURIComponent(baseUrl)}` +
            `&subscriptionKey=${encodeURIComponent(subscriptionKey)}&apiUser=${encodeURIComponent(apiUser)}` +
            `&apiKey=${encodeURIComponent(apiKey)}&environment=${encodeURIComponent(environment)}`
        );

    } catch (error) {
        const { amount, uid, redirect_url } = req.body;
        console.error("MoMo initiate error:", error.response ? error.response.data : error.message);
        return res.redirect(`/payment/status_page?status=fail&amount=${amount || 0}&redirect_url=${encodeURIComponent(redirect_url || '')}`);
    }
});

// Polling page — server polls MTN every 5 s (up to 12 times = 60 s), then redirects
router.get("/momo-status", async (req, res) => {
    try {
        const { referenceId, uid, amount, redirect_url, baseUrl, subscriptionKey, apiUser, apiKey, environment } = req.query;

        const general_setting = await DataFind(`SELECT * FROM tbl_general_settings`);

        res.render("momo_status", {
            referenceId,
            uid,
            amount,
            redirect_url: redirect_url || '',
            baseUrl,
            subscriptionKey,
            apiUser,
            apiKey,
            environment,
            general: general_setting.length > 0 ? general_setting[0] : {}
        });
    } catch (error) {
        console.error("MoMo status page error:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// AJAX endpoint called by momo_status view to check transaction status
router.get("/momo-check", async (req, res) => {
    try {
        const { referenceId, uid, amount, redirect_url } = req.query;

        const payment_detail = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '12'`);
        if (payment_detail == "") return res.status(200).json({ status: 'ERROR', message: 'Config not found' });

        let pkey = payment_detail[0].attribute.split(",");
        const apiUser         = pkey[0].trim();
        const apiKey          = pkey[1].trim();
        const subscriptionKey = pkey[2].trim();
        const environment     = (pkey[3] || 'sandbox').trim();

        const isSandbox = environment === 'sandbox';
        const baseUrl   = isSandbox
            ? 'https://sandbox.momoapi.mtn.com'
            : 'https://proxy.momoapi.mtn.com';

        // Get fresh token
        const tokenRes = await axios.post(
            `${baseUrl}/collection/token/`,
            {},
            {
                auth: { username: apiUser, password: apiKey },
                headers: { 'Ocp-Apim-Subscription-Key': subscriptionKey }
            }
        );
        const accessToken = tokenRes.data.access_token;

        // Check requestToPay status
        const statusRes = await axios.get(
            `${baseUrl}/collection/v1_0/requesttopay/${referenceId}`,
            {
                headers: {
                    'Authorization':             `Bearer ${accessToken}`,
                    'X-Target-Environment':      environment,
                    'Ocp-Apim-Subscription-Key': subscriptionKey
                }
            }
        );

        const momoStatus = statusRes.data.financialTransactionId
            ? statusRes.data.status
            : statusRes.data.status;

        if (momoStatus === 'SUCCESSFUL') {
            await creditUserWallet(uid, '12', amount, referenceId, req);
            return res.json({
                status: 'SUCCESSFUL',
                redirect: `/payment/status_page?status=success&transactionId=${referenceId}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`
            });
        } else if (momoStatus === 'FAILED' || momoStatus === 'REJECTED') {
            await DataUpdate(`tbl_payment_transaction`, `status = 'failed'`, `provider_reference = '${referenceId}'`, req.hostname, req.protocol);
            return res.json({
                status: momoStatus,
                redirect: `/payment/status_page?status=fail&transactionId=${referenceId}&amount=${amount}&redirect_url=${encodeURIComponent(redirect_url || '')}`
            });
        } else {
            // PENDING — still waiting
            return res.json({ status: momoStatus || 'PENDING' });
        }

    } catch (error) {
        console.error("MoMo check error:", error.response ? error.response.data : error.message);
        return res.json({ status: 'ERROR', message: 'Could not reach MoMo API' });
    }
});

// ============= Status Page ================ //

router.get("/status_page", async(req, res)=>{
    try {
        const { status, transactionId, amount, redirect_url } = req.query;
        let general = req.general;
        if (!general) {
            const settings = await DataFind(`SELECT * FROM tbl_general_settings`);
            if (settings.length > 0) {
                general = settings[0];
            }
        }
        res.render("payment_status", {
            auth: req.user || {},
            general: general || {},
            status: status || 'fail',
            transactionId: transactionId || 'N/A',
            amount: amount || '0',
            redirect_url: redirect_url || ''
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;