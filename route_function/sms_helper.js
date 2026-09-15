const axios = require('axios');

/**
 * Normalizes phone numbers to start with '+' (useful for Telnyx and Twilio)
 */
function formatPhoneNumber(phone) {
    let clean = phone.trim();
    if (!clean.startsWith('+')) {
        // If it starts with country code without '+', prepended it.
        // If it's a raw 10 digit, we assume country prefix is already part of it if sent from app.
        clean = '+' + clean;
    }
    return clean;
}

/**
 * Sends SMS via a specific provider.
 */
async function sendSingleSMS(provider, phone, otp, settings) {
    const appName = settings.title || 'ZippyGo';
    const messageText = `Your ${appName} OTP is ${otp}`;

    switch (String(provider)) {
        case '1': { // MSG91
            if (!settings.msg_key || !settings.msg_token) throw new Error('MSG91 credentials missing');
            const url = `https://control.msg91.com/api/v5/otp?template_id=${settings.msg_token}&mobile=${phone}&otp=${otp}`;
            await axios.post(url, { Param1: 'value1' }, {
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                    authkey: settings.msg_key
                }
            });
            return true;
        }
        case '2': { // Twilio
            if (!settings.twilio_sid || !settings.twilio_token || !settings.twilio_phoneno) throw new Error('Twilio credentials missing');
            const client = require('twilio')(settings.twilio_sid, settings.twilio_token);
            await client.messages.create({
                body: messageText,
                from: settings.twilio_phoneno,
                to: formatPhoneNumber(phone)
            });
            return true;
        }
        case '3': { // 2Factor
            if (!settings.twofactor_key) throw new Error('2Factor API key missing');
            // Clean phone (remove '+' for 2Factor)
            const cleanPhone = phone.replace('+', '');
            const url = `https://2factor.in/API/V1/${settings.twofactor_key}/SMS/${cleanPhone}/${otp}/AUTOGEN`;
            await axios.get(url);
            return true;
        }
        case '4': // No Auth (Demo)
            return true;
        case '5': { // Plivo
            if (!settings.plivo_auth_id || !settings.plivo_auth_token || !settings.plivo_sender_id) throw new Error('Plivo credentials missing');
            const authHeader = 'Basic ' + Buffer.from(`${settings.plivo_auth_id}:${settings.plivo_auth_token}`).toString('base64');
            const url = `https://api.plivo.com/v1/Account/${settings.plivo_auth_id}/Message/`;
            await axios.post(url, {
                src: settings.plivo_sender_id,
                dst: phone,
                text: messageText
            }, {
                headers: {
                    Authorization: authHeader,
                    'Content-Type': 'application/json'
                }
            });
            return true;
        }
        case '6': { // Vonage (Nexmo)
            if (!settings.vonage_key || !settings.vonage_secret) throw new Error('Vonage credentials missing');
            const url = 'https://rest.nexmo.com/sms/json';
            const response = await axios.post(url, {
                api_key: settings.vonage_key,
                api_secret: settings.vonage_secret,
                to: phone.replace('+', ''), // Vonage prefers no '+' sign
                from: settings.vonage_sender_id || 'Vonage',
                text: messageText
            });
            if (response.data && response.data.messages && response.data.messages[0].status !== '0') {
                throw new Error(`Vonage failed: ${response.data.messages[0]['error-text']}`);
            }
            return true;
        }
        case '7': { // Telnyx
            if (!settings.telnyx_key || !settings.telnyx_phone) throw new Error('Telnyx credentials missing');
            const url = 'https://api.telnyx.com/v2/messages';
            await axios.post(url, {
                from: settings.telnyx_phone,
                to: formatPhoneNumber(phone),
                text: messageText
            }, {
                headers: {
                    Authorization: `Bearer ${settings.telnyx_key}`,
                    'Content-Type': 'application/json'
                }
            });
            return true;
        }
        default:
            throw new Error(`Unsupported SMS provider type: ${provider}`);
    }
}

/**
 * Sends OTP using configured SMS provider, with fallback support.
 */
async function sendOTP(phone, otp, settings) {
    const primaryProvider = String(settings.sms_type);
    
    // 1. Try primary provider first
    try {
        console.log(`[SMS HELPER] Attempting primary provider (${primaryProvider}) for phone ${phone}...`);
        await sendSingleSMS(primaryProvider, phone, otp, settings);
        return { success: true, provider: primaryProvider };
    } catch (err) {
        console.error(`[SMS HELPER] Primary provider (${primaryProvider}) failed: ${err.message}`);
        
        // 2. Define fallbacks queue (all other providers except No Auth)
        const providersQueue = ['1', '2', '3', '5', '6', '7'].filter(p => p !== primaryProvider);
        
        for (const fallbackProvider of providersQueue) {
            try {
                // Check if fallback credentials are populated
                let hasCreds = false;
                if (fallbackProvider === '1' && settings.msg_key && settings.msg_token) hasCreds = true;
                if (fallbackProvider === '2' && settings.twilio_sid && settings.twilio_token && settings.twilio_phoneno) hasCreds = true;
                if (fallbackProvider === '3' && settings.twofactor_key) hasCreds = true;
                if (fallbackProvider === '5' && settings.plivo_auth_id && settings.plivo_auth_token && settings.plivo_sender_id) hasCreds = true;
                if (fallbackProvider === '6' && settings.vonage_key && settings.vonage_secret) hasCreds = true;
                if (fallbackProvider === '7' && settings.telnyx_key && settings.telnyx_phone) hasCreds = true;
                
                if (hasCreds) {
                    console.log(`[SMS HELPER] Attempting fallback provider (${fallbackProvider}) for phone ${phone}...`);
                    await sendSingleSMS(fallbackProvider, phone, otp, settings);
                    return { success: true, provider: fallbackProvider };
                }
            } catch (fallbackErr) {
                console.error(`[SMS HELPER] Fallback provider (${fallbackProvider}) failed: ${fallbackErr.message}`);
            }
        }
    }
    
    return { success: false, error: 'All configured SMS providers failed to send the OTP' };
}

module.exports = { sendOTP };
