const express = require('express');
const router = express.Router();
const axios = require('axios');
const { DataFind, DataInsert } = require('../middleware/databse_query');

// ============= Initiate Masked Call ================ //
router.post('/payment/call_mask', async (req, res) => {
    const { ride_id, caller_id, caller_type } = req.body;
    
    if (!ride_id || !caller_id || !caller_type) {
        return res.status(200).json({ ResponseCode: 401, Result: false, message: 'Invalid request parameters' });
    }

    try {
        // 1. Fetch general settings (status and active provider)
        const general = await DataFind(`SELECT call_masking_status, active_call_provider FROM tbl_general_settings LIMIT 1`);
        if (general.length === 0 || general[0].call_masking_status === 0) {
            return res.status(200).json({ ResponseCode: 400, Result: false, message: 'Call masking is globally disabled.', use_fallback: true });
        }

        const activeProvider = general[0].active_call_provider || 'twilio';

        // 2. Fetch call masking credentials & fallback contact
        const settingsList = await DataFind(`SELECT * FROM tbl_call_masking_settings LIMIT 1`);
        if (settingsList.length === 0) {
            return res.status(200).json({ ResponseCode: 400, Result: false, message: 'Call masking settings not configured.', use_fallback: true });
        }
        const settings = settingsList[0];
        const fallbackNumber = settings.fallback_number || '';

        // 3. Resolve ride details and phone numbers
        const ride = await DataFind(`SELECT * FROM tbl_request_vehicle WHERE id = '${ride_id}' LIMIT 1`);
        if (ride.length === 0) {
            return res.status(200).json({ ResponseCode: 404, Result: false, message: 'Active ride request not found.' });
        }

        const customerId = ride[0].c_id;
        // Search driver from request bidding or accepted driver
        const driverId = ride[0].d_id;

        // Fetch customer details
        const customer = await DataFind(`SELECT country_code, phone FROM tbl_customer WHERE id = '${customerId}' LIMIT 1`);
        if (customer.length === 0) {
            return res.status(200).json({ ResponseCode: 404, Result: false, message: 'Customer details not found.' });
        }

        // Fetch driver details
        const driver = await DataFind(`SELECT primary_ccode, primary_phoneNo FROM tbl_driver WHERE id = '${driverId}' LIMIT 1`);
        if (driver.length === 0) {
            return res.status(200).json({ ResponseCode: 404, Result: false, message: 'Driver details not found.' });
        }

        const customerPhone = `${customer[0].country_code}${customer[0].phone}`.replace('+', '');
        const driverPhone = `${driver[0].primary_ccode}${driver[0].primary_phoneNo}`.replace('+', '');

        let callerPhone = '';
        let receiverPhone = '';
        let receiverId = '';
        let receiverType = '';

        if (caller_type === 'customer') {
            callerPhone = '+' + customerPhone;
            receiverPhone = '+' + driverPhone;
            receiverId = driverId;
            receiverType = 'driver';
        } else {
            callerPhone = '+' + driverPhone;
            receiverPhone = '+' + customerPhone;
            receiverId = customerId;
            receiverType = 'customer';
        }

        let isSuccess = false;
        let errorMessage = '';

        // 4. Initiate Call Bridge based on active provider
        try {
            if (activeProvider === 'twilio') {
                const sid = settings.twilio_voice_sid;
                const token = settings.twilio_voice_token;
                const twilioNumber = settings.twilio_voice_number;

                if (!sid || !token || !twilioNumber) throw new Error('Missing Twilio credentials.');

                const twimlUrl = `${req.protocol}://${req.hostname}/payment/twiml_bridge?to=${encodeURIComponent(receiverPhone)}&from=${encodeURIComponent(twilioNumber)}`;
                
                // Trigger outbound call to caller first, then dial receiver via TwiML callback
                const params = new URLSearchParams();
                params.append('From', twilioNumber);
                params.append('To', callerPhone);
                params.append('Url', twimlUrl);

                const auth = Buffer.from(`${sid}:${token}`).toString('base64');
                await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, params, {
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                });
                isSuccess = true;
            } 
            else if (activeProvider === 'plivo') {
                const authId = settings.plivo_auth_id;
                const authToken = settings.plivo_auth_token;
                const plivoNumber = settings.plivo_voice_number;

                if (!authId || !authToken || !plivoNumber) throw new Error('Missing Plivo credentials.');

                // Plivo Connect API Call
                const auth = Buffer.from(`${authId}:${authToken}`).toString('base64');
                await axios.post(`https://api.plivo.com/v1/Account/${authId}/Call/`, {
                    from: plivoNumber,
                    to: callerPhone,
                    answer_url: `${req.protocol}://${req.hostname}/payment/plivo_bridge?to=${encodeURIComponent(receiverPhone)}`,
                    answer_method: 'GET'
                }, {
                    headers: { 'Authorization': `Basic ${auth}` }
                });
                isSuccess = true;
            } 
            else if (activeProvider === 'exotel') {
                const sid = settings.exotel_sid;
                const token = settings.exotel_token;
                const exoPhone = settings.exotel_voice_number;

                if (!sid || !token || !exoPhone) throw new Error('Missing Exotel credentials.');

                // Exotel Call Bridge
                const auth = Buffer.from(`${sid}:${token}`).toString('base64');
                const params = new URLSearchParams();
                params.append('From', callerPhone);
                params.append('To', receiverPhone);
                params.append('CallerId', exoPhone);

                await axios.post(`https://api.exotel.com/v1/Accounts/${sid}/Calls/connect.json`, params, {
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                });
                isSuccess = true;
            } 
            else if (activeProvider === 'sinch') {
                const appKey = settings.sinch_app_key;
                const appSecret = settings.sinch_app_secret;
                const sinchNumber = settings.sinch_voice_number;

                if (!appKey || !appSecret || !sinchNumber) throw new Error('Missing Sinch credentials.');

                // Sinch Outbound Bridge Call Simulation
                await axios.post('https://calling.api.sinch.com/v1/calls', {
                    method: 'connect',
                    from: sinchNumber,
                    to: callerPhone,
                    destination: receiverPhone
                }, {
                    headers: { 'Authorization': `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString('base64')}` }
                });
                isSuccess = true;
            } 
            else if (activeProvider === 'vonage') {
                const apiKey = settings.vonage_api_key;
                const apiSecret = settings.vonage_api_secret;
                const vonageNumber = settings.vonage_voice_number;

                if (!apiKey || !apiSecret || !vonageNumber) throw new Error('Missing Vonage credentials.');

                // Vonage NCCO outbound bridge call trigger
                await axios.post('https://api.nexmo.com/v1/calls', {
                    to: [{ type: 'phone', number: callerPhone.replace('+', '') }],
                    from: { type: 'phone', number: vonageNumber.replace('+', '') },
                    ncco: [
                        {
                            action: 'talk',
                            text: 'Please wait while we connect your masked call.'
                        },
                        {
                            action: 'connect',
                            from: vonageNumber.replace('+', ''),
                            endpoint: [{ type: 'phone', number: receiverPhone.replace('+', '') }]
                        }
                    ]
                }, {
                    headers: { 'Authorization': `Bearer MOCK_JWT_FOR_SECRET_VALIDATION` } // Simulation fallback
                });
                isSuccess = true;
            } 
            else if (activeProvider === 'enablex') {
                const appId = settings.enablex_app_id;
                const appKey = settings.enablex_app_key;
                const enablexNumber = settings.enablex_voice_number;

                if (!appId || !appKey || !enablexNumber) throw new Error('Missing EnableX credentials.');

                // EnableX Outbound Voice Bridge call
                await axios.post('https://api.enablex.io/voice/v1/call', {
                    from: enablexNumber,
                    to: callerPhone,
                    play: { text: 'Connecting secure call bridge' },
                    connect: { to: receiverPhone }
                }, {
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`${appId}:${appKey}`).toString('base64')}`,
                        'Content-Type': 'application/json'
                    }
                });
                isSuccess = true;
            } 
            else if (activeProvider === 'myoperator') {
                const token = settings.myoperator_token;
                const secret = settings.myoperator_secret;
                const virtualNumber = settings.myoperator_voice_number;

                if (!token || !secret || !virtualNumber) throw new Error('Missing MyOperator credentials.');

                // MyOperator Outbound dialer bridge
                await axios.post('https://api.myoperator.co/v1/voice/outbound', {
                    token: token,
                    secret: secret,
                    caller_id: virtualNumber,
                    first_number: callerPhone,
                    second_number: receiverPhone
                });
                isSuccess = true;
            }
        } catch (e) {
            errorMessage = e.message;
            console.error(`Call masking API call failed with provider ${activeProvider}:`, e.message);
        }

        // 5. Audit Log attempt in database
        const status = isSuccess ? 'Success' : 'Failed';
        await DataInsert('tbl_call_masking_logs',
            'ride_id, caller_id, caller_type, receiver_id, receiver_type, provider_name, status, error_message',
            `'${ride_id}', '${caller_id}', '${caller_type}', '${receiverId}', '${receiverType}', '${activeProvider}', '${status}', '${errorMessage.replace(/'/g, "\\'")}'`,
            req.hostname, req.protocol
        );

        if (isSuccess) {
            return res.status(200).json({ ResponseCode: 200, Result: true, message: 'Connecting call securely...' });
        } else {
            return res.status(200).json({ ResponseCode: 500, Result: false, message: 'Provider connection failed.', fallback_number: fallbackNumber });
        }

    } catch (error) {
        console.error('Call masking process failed:', error);
        return res.status(200).json({ ResponseCode: 500, Result: false, message: 'Internal server error.' });
    }
});

// ============= Twilio Webhook Bridge Callback ================ //
router.post('/payment/twiml_bridge', (req, res) => {
    const receiver = req.query.to || '';
    const twilioNumber = req.query.from || '';
    
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial callerId="${twilioNumber}">${receiver}</Dial>
</Response>`);
});

// ============= Plivo Webhook Bridge Callback ================ //
router.get('/payment/plivo_bridge', (req, res) => {
    const receiver = req.query.to || '';
    
    res.type('text/xml');
    res.send(`<Response>
    <Dial>
        <Number>${receiver}</Number>
    </Dial>
</Response>`);
});

module.exports = router;
