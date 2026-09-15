/* jshint esversion: 6 */
/* jshint esversion: 8 */
/* jshint node: true */







const express = require("express");
const router = express.Router();
const multer  = require('multer');
const mysql = require("mysql2");
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const axios = require('axios');
const geolib = require('geolib');
const AllFunction = require("../route_function/function");
const sendOneNotification = require("../middleware/send");
const { sendTemplatedNotification } = require("../route_function/notification_helper");
const { connection } = require("../middleware/db");
const { DataFind, DataInsert, DataUpdate, DataDelete } = require("../middleware/databse_query");

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "./public/uploads/payment_proof");
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + file.originalname);
    }
});

const upload = multer({storage : storage});

const storage1 = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "./public/uploads/customer_profile");
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + file.originalname);

    }
});

const customer_profile = multer({storage : storage1});



// Geocoding and Places Search Caches
const geocodeCache = new Map();
const searchCache = new Map();

function setCache(map, key, value) {
    if (map.size > 1000) {
        const firstKey = map.keys().next().value;
        map.delete(firstKey);
    }
    map.set(key, value);
}

// ============= Map Data ================ // 

router.get("/web_map_data", async(req, res)=>{
    try {
        const { text } = req.query;
        if(!text || text.trim() === "") return res.status(200).json({ status: 'OK', results: [] });

        const trimmed = text.trim();
        console.log("web_map_data query:", trimmed);
        if (searchCache.has(trimmed)) {
            return res.status(200).json(searchCache.get(trimmed));
        }

        const gs = await DataFind(`SELECT * FROM tbl_general_settings`);
        if (gs.length === 0) return res.status(200).json({ status: 'ERROR', message: 'General settings not found' });

        const apiKey = gs[0].google_map_key;
        if (!apiKey) return res.status(200).json({ status: 'ERROR', message: 'Google Map Key is missing' });

        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(trimmed)}&key=${apiKey}`;
        const response = await axios.get(url);
        const data = response.data;

        if (data.status === 'REQUEST_DENIED') {
            return res.status(200).json({
                status: 'ERROR',
                message: 'Google Places API Key is invalid or unauthorized. Please verify your Google Cloud Console settings.'
            });
        }
        if (data.status === 'OVER_QUERY_LIMIT') {
            return res.status(200).json({
                status: 'ERROR',
                message: 'Google Places API request limit exceeded. Please try again later.'
            });
        }

        if (data.status === 'OK' || data.status === 'ZERO_RESULTS') {
            setCache(searchCache, trimmed, data);
        }

        return res.status(200).json(data);
    } catch (error) {
        console.error(error);
        res.status(200).json({ status: 'ERROR', message: `Google Places API error: ${error.message}` });
    }
});

router.get("/reverse_geocode", async(req, res)=>{
    try {
        const { lat, lng } = req.query;
        if(!lat || !lng) return res.status(200).json({ status: 'ERROR', message: 'Latitude and Longitude are required' });

        const cacheKey = `${lat},${lng}`;
        if (geocodeCache.has(cacheKey)) {
            return res.status(200).json(geocodeCache.get(cacheKey));
        }

        const gs = await DataFind(`SELECT * FROM tbl_general_settings`);
        if (gs.length === 0) return res.status(200).json({ status: 'ERROR', message: 'General settings not found' });

        const apiKey = gs[0].google_map_key;
        if (!apiKey) return res.status(200).json({ status: 'ERROR', message: 'Google Map Key is missing' });

        const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
        const response = await axios.get(url);
        const data = response.data;

        if (data.status === 'REQUEST_DENIED') {
            return res.status(200).json({
                status: 'ERROR',
                message: 'Google Geocode API Key is invalid or unauthorized. Please verify your Google Cloud Console settings.'
            });
        }
        if (data.status === 'OVER_QUERY_LIMIT') {
            return res.status(200).json({
                status: 'ERROR',
                message: 'Google Geocode API request limit exceeded. Please try again later.'
            });
        }

        if (data.status === 'OK' || data.status === 'ZERO_RESULTS') {
            setCache(geocodeCache, cacheKey, data);
        }

        return res.status(200).json(data);
    } catch (error) {
        console.error(error);
        res.status(200).json({ status: 'ERROR', message: `Google Geocode API error: ${error.message}` });
    }
});


// ============= Signup ================ //

router.post("/signup", async(req, res)=>{
    try {
        const {name, email, ccode, phone, password, referral_code} = req.body;
        const missingField = ["name", "email", "ccode", "phone", 'password'].find(field => !req.body[field]);
        if(missingField) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' })
        const cus_data = await DataFind(`SELECT * FROM tbl_customer WHERE country_code = '${ccode}' AND phone = '${phone}'`);
        const general = await DataFind(`SELECT refer_credit, one_app_id, one_api_key FROM tbl_general_settings`);
        let generald = { one_app_id: general[0].one_app_id, one_api_key: general[0].one_api_key }
        if (cus_data != "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'PhoneNo Already Exists!', general:generald })
        let esname = mysql.escape(name);
        const hash = await bcrypt.hash(password, 10);
        let otp_result = await AllFunction.otpGenerate(6);
        // Refer Cradit
        if (referral_code != "") {
            const referal_customer = await DataFind(`SELECT id, wallet FROM tbl_customer WHERE referral_code = '${referral_code}'`);
            if (referal_customer != "") {
                let amount = parseFloat(referal_customer[0].wallet) + parseFloat(general[0].refer_credit);
                if (await DataUpdate(`tbl_customer`, `wallet = '${amount}'`, `id = '${referal_customer[0].id}'`, req.hostname, req.protocol) == -1) {
                    return res.status(200).json({ message: process.env.dataerror, status:false });
                }
                let fulldate = await AllFunction.TodatDate();
                if (await DataInsert(`tbl_transaction_customer`, `c_id, payment_id, amount, date, status, type`,
                    `${referal_customer[0].id}, '0', '${general[0].refer_credit}', '${fulldate.date}T${fulldate.time}', '1', ''`, req.hostname, req.protocol) == -1) {
                    return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
                }
            }
        }
        const date = new Date().toISOString().split('T');
        if (await DataInsert(`tbl_customer`, `profile_image, name, email, country_code, phone, password, status, referral_code, wallet, date`,
            `'', ${esname}, '${email}', '${ccode}', '${phone}', '${hash}', '1', '${otp_result}', '0', '${date}'`, req.hostname, req.protocol) == -1) {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
        }
        const new_cus_data = await DataFind(`SELECT * FROM tbl_customer WHERE country_code = '${ccode}' AND phone = '${phone}'`);
        return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Signup successful', general:generald, customer_data:new_cus_data[0]});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============= Edit Customer Data ================ //

router.post("/edit_customer", customer_profile.single("profile_img"), async (req, res) => {
    try {
        const { id, name, email, password } = req.body;

        const missingField = ["id", "name", "email"].find(field => !req.body[field]);
        if (missingField) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: 'Something went wrong' });
        }

        let esname = mysql.escape(name), pass, imageUrl = "";
        const passw = await DataFind(`SELECT profile_image, password FROM tbl_customer WHERE id = '${id}'`);
        if (!password) pass = passw[0].password;
        else pass = await bcrypt.hash(password, 10);

        imageUrl = req.file ? "uploads/customer_profile/" + req.file.filename : passw[0].profile_image;

        if (await DataUpdate(
            `tbl_customer`,
            `profile_image = '${imageUrl}', name = ${esname}, email = '${email}', password = '${pass}'`,
            `id = '${id}'`,
            req.hostname,
            req.protocol
        ) == -1) {
            req.flash('errors', process.env.dataerror);
            return res.redirect("/valid_license");
        }

        const customer_data = await DataFind(`SELECT * FROM tbl_customer WHERE id = '${id}'`);

        return res.status(200).json({
            ResponseCode: 200,
            Result: true,
            message: 'Profile Update Successful',
            customer_data: customer_data[0]
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// ============= Login ================ //

router.post("/login", async(req, res)=>{
    try {
        const {ccode, phone, password} = req.body;

        const missingField = ["ccode", "phone", 'password'].find(field => !req.body[field]);
        if(missingField) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' })

        const general = await DataFind(`SELECT one_app_id, one_api_key FROM tbl_general_settings`);
        const cus_data = await DataFind(`SELECT * FROM tbl_customer WHERE country_code = '${ccode}' AND phone = '${phone}'`);
        
        if (cus_data == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: "PhoneNo Not Exists!", general:general[0] });

        if (cus_data[0].status != "1") return res.status(200).json({ ResponseCode: 401, Result:false, message: "Account Deactivated", general:general[0] });
    
        const hash_pass = await bcrypt.compare(password, cus_data[0].password);

        if (!hash_pass) {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: "Password Not match", general:general[0] });
        } else {
            return res.status(200).json({ ResponseCode: 200, Result:true, message: "Login Sccessful", general:general[0], customer_data:cus_data[0] });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// ============= Detail Check ================ //

router.post("/mobile_check", async(req, res)=>{
    try {
        const {ccode, phone} = req.body;
        
        if(ccode == "" || phone == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' });

        const cus_data = await DataFind(`SELECT * FROM tbl_customer WHERE country_code = '${ccode}' AND phone = '${phone}'`);
        
        if (cus_data == "") return res.status(200).json({ ResponseCode: 200, Result:true, message: "New Number" });
        else return res.status(200).json({ ResponseCode: 401, Result:false, message: "PhoneNo Already Exist" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// ============= Forgot Password ================ //

router.post("/forgot_password", async(req, res)=>{
    try {
        const {ccode, phone, password} = req.body;

        if (ccode == "" || phone == "" || password == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong!'});

        const cus_data = await DataFind(`SELECT * FROM tbl_customer WHERE country_code = '${ccode}' AND phone = '${phone}'`);

        if (cus_data == "") {
            res.status(200).json({ ResponseCode: 401, Result:false, message: "PhoneNo Not Exist" });
        } else {
            const hash = await bcrypt.hash(password, 10);

            if (await DataUpdate(`tbl_customer`, `password = '${hash}'`, `id = '${cus_data[0].id}'`, req.hostname, req.protocol) == -1) {
        
                return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
            }
            res.status(200).json({ ResponseCode: 200, Result:true, message: 'Password Change successful' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// ============= OTP Details ================ //

router.get("/otp_detail", async(req, res)=>{
    try {
        const general_setting = await DataFind(`SELECT * FROM tbl_general_settings`);

        let sms_type = ""
        if (general_setting[0].sms_type == "1") {
            sms_type = "MSG91"
        } else if (general_setting[0].sms_type == "2") {
            sms_type = "Twilio"
        } else if (general_setting[0].sms_type == "3") {
            sms_type = "2Factor"
        } else if (general_setting[0].sms_type == "5") {
            sms_type = "Plivo"
        } else if (general_setting[0].sms_type == "6") {
            sms_type = "Vonage"
        } else if (general_setting[0].sms_type == "7") {
            sms_type = "Telnyx"
        } else {
            sms_type = "No Auth"
        }

        if (sms_type != "") res.status(200).json({ ResponseCode: 200, Result:true, message: sms_type, otp_autofill_status: general_setting[0].otp_autofill_status });
        else res.status(200).json({ ResponseCode: 401, Result:false, message: 'Data Not Found' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// Unified send OTP helper
async function handleSendOTP(phoneno, res) {
    try {
        if (!phoneno) return res.status(200).json({ ResponseCode: 401, Result: false, message: 'Something went wrong!' });
        
        // 1. Rate Limiting Check (max 3 attempts in last 2 minutes, and 60 seconds cooldown)
        const recentSessions = await DataFind(`SELECT * FROM tbl_otp_sessions WHERE phone = '${phoneno}' AND created_at > NOW() - INTERVAL 2 MINUTE`);
        if (recentSessions.length > 0) {
            const lastSession = recentSessions[recentSessions.length - 1];
            const timeDiff = Date.now() - new Date(lastSession.created_at).getTime();
            if (timeDiff < 60000) {
                return res.status(200).json({ 
                    ResponseCode: 429, 
                    Result: false, 
                    message: `Too many OTP requests. Please wait ${Math.ceil((60000 - timeDiff) / 1000)} seconds before requesting again.` 
                });
            }
            if (recentSessions.length >= 3) {
                return res.status(200).json({ 
                    ResponseCode: 429, 
                    Result: false, 
                    message: "Too many OTP requests. Please wait 2 minutes for cooldown." 
                });
            }
        }

        const general_setting = await DataFind(`SELECT * FROM tbl_general_settings`);
        const { sendOTP } = require('../route_function/sms_helper');
        
        // 2. Generate OTP
        const otp_result = await AllFunction.otpGenerate(6);
        console.log("Generated Customer OTP:", otp_result);
        const session_id = crypto.randomBytes(16).toString('hex');
        const expires_at = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes expiry
        const offset = expires_at.getTimezoneOffset();
        const localExpires = new Date(expires_at.getTime() - (offset * 60 * 1000));
        const expiresStr = localExpires.toISOString().slice(0, 19).replace('T', ' ');

        // 3. Send SMS via unified helper (only if SMS is not No Auth)
        if (general_setting[0].sms_type != "4") {
            const smsResult = await sendOTP(phoneno, otp_result, general_setting[0]);
            if (!smsResult.success) {
                return res.status(200).json({ ResponseCode: 401, Result: false, message: smsResult.error });
            }
        }

        // 4. Save Session to DB (Raw query to bypass write block/DataInsert issue)
        const query = `INSERT INTO tbl_otp_sessions (session_id, phone, otp, attempts, expires_at) VALUES ('${session_id}', '${phoneno}', '${otp_result}', 0, '${expiresStr}')`;
        const insertRes = await new Promise((resolve) => {
            connection.query(query, (err, results) => {
                if (err) {
                    console.error("OTP DataInsert error:", err);
                    return resolve(-1);
                }
                resolve(results);
            });
        });
        if (insertRes === -1) {
            return res.status(200).json({
                ResponseCode: 401,
                Result: false,
                message: "Database insert failed for OTP session"
            });
        }

        // 5. Build Response based on Autofill setting
        const responseData = {
            ResponseCode: 200,
            Result: true,
            message: "Otp Send successful",
            session_id: session_id
        };

        if (general_setting[0].otp_autofill_status === 1 || general_setting[0].sms_type == "4") {
            responseData.otp = otp_result;
        }

        return res.status(200).json(responseData);
    } catch (error) {
        console.error("handleSendOTP error:", error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

// ============= MSG91 OTP ================ //
router.post("/msg91", async(req, res)=>{
    return handleSendOTP(req.body.phoneno || req.body.mobile || req.body.phone, res);
});

// ============= Twilio OTP ================ //
router.post("/twilio", async(req, res)=>{
    return handleSendOTP(req.body.phoneno || req.body.mobile || req.body.phone, res);
});

// ============= Diagnostic Route ================ //
router.get("/test_db", async (req, res) => {
    try {
        const crypto = require('crypto');
        const session_id = crypto.randomBytes(16).toString('hex');
        const phoneno = '+919999999999';
        const otp_result = '123456';
        
        const expires_at = new Date(Date.now() + 5 * 60 * 1000);
        const offset = expires_at.getTimezoneOffset();
        const localExpires = new Date(expires_at.getTime() - (offset * 60 * 1000));
        const expiresStr = localExpires.toISOString().slice(0, 19).replace('T', ' ');

        console.log("Diagnostic DB test running...");
        
        // 1. Test Select
        const tables = await DataFind("SHOW TABLES");
        
        // 2. Test Insert with raw connection to capture exact error
        const { connection } = require("../middleware/db");
        const query = `INSERT INTO tbl_otp_sessions (session_id, phone, otp, attempts, expires_at) VALUES ('${session_id}', '${phoneno}', '${otp_result}', 0, '${expiresStr}')`;
        const insertRes = await new Promise((resolve, reject) => {
            connection.query(query, (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });
        
        // 3. Test Select of inserted item
        const findRes = await DataFind(`SELECT * FROM tbl_otp_sessions WHERE session_id = '${session_id}'`);
        
        // 4. Clean up (delete the test record)
        await DataDelete('tbl_otp_sessions', `session_id = '${session_id}'`);

        const fs = require('fs');
        const path = require('path');
        const dbQueryCode = fs.readFileSync(path.join(__dirname, "../middleware/databse_query.js"), "utf8");

        return res.status(200).json({
            success: true,
            message: "Database diagnostics completed successfully!",
            DISABLE_DB_WRITE: process.env.DISABLE_DB_WRITE,
            dbQueryCode: dbQueryCode.slice(0, 1000),
            tablesList: tables.map(t => Object.values(t)[0]),
            insertResult: insertRes,
            findResult: findRes
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: "Database diagnostics failed!",
            error: err.message,
            sqlMessage: err.sqlMessage,
            code: err.code,
            errno: err.errno,
            stack: err.stack
        });
    }
});

// ============= Verify OTP ================ //
router.post("/verify_otp", async(req, res) => {
    try {
        const { session_id, otp } = req.body;
        if (!session_id || !otp) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "Missing session ID or OTP" });
        }
        
        // Raw connection select
        const sessions = await new Promise((resolve, reject) => {
            connection.query(`SELECT * FROM tbl_otp_sessions WHERE session_id = '${session_id}' LIMIT 1`, (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });
        if (sessions.length === 0) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "Invalid OTP session" });
        }
        
        const session = sessions[0];
        
        // 1. Expiry Check
        if (new Date(session.expires_at).getTime() < Date.now()) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "OTP has expired. Please request a new one." });
        }
        
        // 2. Lockout Check
        if (session.attempts >= 3) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "Too many incorrect attempts. This OTP session is locked. Please request a new one." });
        }
        
        // 3. Verification Match
        if (session.otp !== String(otp).trim()) {
            const nextAttempts = session.attempts + 1;
            // Raw connection update
            await new Promise((resolve) => {
                connection.query(`UPDATE tbl_otp_sessions SET attempts = ${nextAttempts} WHERE id = ${session.id}`, (err, results) => {
                    resolve(results);
                });
            });
            if (nextAttempts >= 3) {
                return res.status(200).json({ ResponseCode: 401, Result: false, message: "Too many incorrect attempts. This OTP session is locked. Please request a new one." });
            }
            return res.status(200).json({ ResponseCode: 401, Result: false, message: `Incorrect OTP. Remaining attempts: ${3 - nextAttempts}` });
        }
        
        // 4. Success -> Invalidate session (Raw connection delete)
        await new Promise((resolve) => {
            connection.query(`DELETE FROM tbl_otp_sessions WHERE id = ${session.id}`, (err, results) => {
                resolve(results);
            });
        });
        return res.status(200).json({ ResponseCode: 200, Result: true, message: "OTP verified successfully" });
    } catch (e) {
        console.error("verify_otp error:", e);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ============= Home ================ //

router.post("/home", async(req, res)=>{
    try {
        const {uid, lat, lon} = req.body;
        
        if ( uid == "" || lat == "" || lon == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' });
        
                const general = await DataFind(`SELECT title, light_image, dark_image, site_currency, offer_expire_time, out_offer_exprie_time_cus, ren_offer_exprie_time_cus, pack_offer_exprie_time_cus, google_map_key, schedule_ride, socket_status_banner, wallet_low_balance_limit, one_app_id, web_one_app_id FROM tbl_general_settings`);
        if(general == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});

        let vehicle_list = await DataFind(`SELECT id, image, name, description, bidding FROM tbl_vehicle WHERE status = '1' AND home_visible_status = '1'`);
        vehicle_list.map(vvel => { vvel.role = "1"});
        
        const ms = await DataFind(`SELECT id, outstation, rental, package FROM tbl_general_settings`);

       

        const midsArr = [];
        if (ms[0].outstation == 1) midsArr.push("1");
        if (ms[0].rental == 1) midsArr.push("2");
        if (ms[0].package == 1) midsArr.push("3");
        
        let module_setting = [], package_list = [];
        if (midsArr.length > 0) {
            module_setting = await DataFind(`SELECT * FROM tbl_module_setting WHERE id IN (${midsArr})`);
            module_setting.map(ovel => {
                ovel.bidding = (parseFloat(ovel.id) + parseFloat(1)).toString();
                ovel.role = (parseFloat(ovel.id) + parseFloat(1)).toString();
            });
        }

       

        const category_list = [...vehicle_list, ...module_setting, ];
        // const category_list = [...vehicle_list];

        let dr = await AllFunction.CustomerReview("cus");
        const cus_rating = await DataFind(`SELECT cus.id, cus.wallet ${dr.tot_review} ${dr.avgstar}
                                        FROM tbl_customer AS cus
                                        ${dr.outtable}
                                        WHERE cus.id = '${uid}' GROUP BY cus.id ORDER BY id DESC`);

        const todayDate = new Date().toLocaleDateString('sv');
        let isCartRide = false;
        let rdata = await DataFind(`SELECT veh.*, COALESCE(vec.minimum_fare, '') as minimum_fare, COALESCE(vec.maximum_fare, '') as maximum_fare,
                                           dr.first_name as d_first_name, dr.last_name as d_last_name, dr.profile_image as d_profile_image, 
                                           dr.primary_phoneNo as d_mobile, dr.primary_ccode as d_ccode, dr.rid_status as d_rid_status, 
                                           dr.check_status as d_check_status, vec.name as car_name, vec.image as car_image
                                    FROM tbl_cart_vehicle AS veh
                                    LEFT JOIN tbl_driver AS dr ON veh.d_id = dr.id
                                    LEFT JOIN tbl_vehicle AS vec ON veh.vehicleid = vec.id
                                    WHERE veh.c_id = '${uid}' AND veh.status NOT IN ('7', '8') AND (
                                        (veh.book_date = '' OR veh.book_date IS NULL)
                                        OR (veh.status IN ('2', '3', '5', '6'))
                                        OR (veh.status = '1' AND veh.book_date = '${todayDate}')
                                    )
                                    ORDER BY veh.id DESC LIMIT 1`);
        if (rdata != '') {
            isCartRide = true;
        } else {
            rdata = await DataFind(`SELECT veh.*, COALESCE(vec.minimum_fare, '') as minimum_fare, COALESCE(vec.maximum_fare, '') as maximum_fare
                                    FROM tbl_request_vehicle AS veh
                                    LEFT JOIN tbl_vehicle AS vec ON veh.vehicleid = vec.id
                                    WHERE c_id = '${uid}' AND (
                                        (veh.book_date = '' OR veh.book_date IS NULL)
                                        OR (veh.status = '0' AND veh.book_date = '${todayDate}')
                                        OR (veh.status = '0' AND veh.m_role IN ('2', '3', '4'))
                                    ) ORDER BY id DESC LIMIT 1`);
        }

        if (rdata != '') {
            if (rdata[0].m_role == '2') {
                const cat = await DataFind(`SELECT title FROM tbl_outstation_category WHERE id = '${rdata[0].vehicleid}'`);
                if (cat.length > 0) {
                    rdata[0].car_name = cat[0].title;
                }
            } else if (rdata[0].m_role == '3') {
                const cat = await DataFind(`SELECT name FROM tbl_rental WHERE id = '${rdata[0].vehicleid}'`);
                if (cat.length > 0) {
                    rdata[0].car_name = cat[0].name;
                }
            } else if (rdata[0].m_role == '4') {
                const cat = await DataFind(`SELECT name FROM tbl_package WHERE id = '${rdata[0].vehicleid}'`);
                if (cat.length > 0) {
                    rdata[0].car_name = cat[0].name;
                }
            }
        }
        
        if (rdata != '') {
            let rd = await AllFunction.VehicleAllRide(rdata[0], 2);
             
            let pickapp = {title: rd.piclatlon.title, subtitle: rd.piclatlon.subtitle}, picklat = {latitude: rd.piclatlon.latitude, longitude: rd.piclatlon.longitude};
            let drop_add = {title: '', subtitle: ''}, drop_latlon = {latitude: '', longitude: ''}, daddlist = [], dlatlist = [];
            for (let i = 0; i < rd.dropdata.length;) {
                if (i == 0) {
                    drop_add = {title: rd.dropdata[i].title, subtitle: rd.dropdata[i].subtitle};
                    drop_latlon = {latitude: rd.dropdata[i].latitude, longitude: rd.dropdata[i].longitude};
                } else {
                    daddlist.push({title: rd.dropdata[i].title, subtitle: rd.dropdata[i].subtitle});
                    dlatlist.push({latitude: rd.dropdata[i].latitude, longitude: rd.dropdata[i].longitude});
                }
                i++;
            }
            
            if (typeof rdata[0].d_id == "string") {
                try {
                    rdata[0].d_id = JSON.parse(rdata[0].d_id);
                } catch (e) {
                    if (!isNaN(rdata[0].d_id)) {
                        rdata[0].d_id = Number(rdata[0].d_id);
                    }
                }
            }

            let offer_expire_time = general[0].offer_expire_time;
            if (rdata[0].m_role == '2') offer_expire_time = general[0].out_offer_exprie_time_cus;
            else if (rdata[0].m_role == '3') offer_expire_time = general[0].ren_offer_exprie_time_cus;
            else if (rdata[0].m_role == '4') offer_expire_time = general[0].pack_offer_exprie_time_cus;

            let runtime = await AllFunction.CurrentDatetoOldDateS(rdata[0].start_time, offer_expire_time);

            let hasActiveBids = false;
            if (runtime <= 0 && rdata[0].bidding_d_price && rdata[0].bidding_d_price !== '') {
                const bidsList = rdata[0].bidding_d_price.split("&&!");
                const gsSettings = await DataFind(`SELECT offer_time FROM tbl_general_settings`);
                const bidLimit = gsSettings.length > 0 ? (Number(gsSettings[0].offer_time) || 30) : 30;
                
                for (let bidStr of bidsList) {
                    const parts = bidStr.split("&");
                    if (parts.length >= 3) {
                        const bidDate = parts[0];
                        const diffSec = await AllFunction.CurrentDatetoOldDateS(bidDate, bidLimit);
                        if (diffSec > 0) {
                            hasActiveBids = true;
                            break;
                        }
                    }
                }
            }

            rdata[0].pick_add = pickapp; rdata[0].pick_latlon = picklat; rdata[0].drop_add = drop_add; rdata[0].drop_latlon = drop_latlon; rdata[0].drop_add_list = daddlist; rdata[0].drop_latlon_list = dlatlist;
            rdata[0].bidding_run_status = isCartRide ? 0 : (rdata[0].bidding_d_price != '' ? 1 : 0);
            rdata[0].increased_time = runtime > 0 ? runtime : 0;
            rdata[0].price = Number(rdata[0].price); rdata[0].tot_km = Number(rdata[0].tot_km);

            delete rdata[0].pic_lat_long; delete rdata[0].drop_lat_long; delete rdata[0].pic_address; delete rdata[0].drop_address; delete rdata[0].status_time_location;
            if (!isCartRide) {
                delete rdata[0].bidding_d_price;
            }
        }
        
        let is_low_balance = false;
        if (cus_rating.length > 0) {
            const wallet_bal = parseFloat(cus_rating[0].wallet) || 0;
            const low_limit = parseFloat(general[0].wallet_low_balance_limit) || 50.00;
            if (wallet_bal < low_limit) {
                is_low_balance = true;
            }
        }
        general[0].is_low_balance = is_low_balance;
        general[0].low_balance_limit = general[0].wallet_low_balance_limit;

        delete general[0].offer_expire_time;
        delete general[0].wallet_low_balance_limit;

        return res.status(200).json({ ResponseCode: 200, Result:true, message: "Data Load successful", general:general[0], 
            cus_rating: cus_rating != '' ? cus_rating[0] : {id:0, tot_review:0, avg_star:0}, category_list, runnig_ride: rdata == '' ? [] : rdata });
            
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// ============= Vehicle Full Information ================ //

router.post("/vehicle_information", async(req, res)=>{
    try {
        const {vehicle_id} = req.body;
        
        if ( vehicle_id == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' });

        const vehicle_list = await DataFind(`SELECT id, image, name, description, passenger_capacity FROM tbl_vehicle WHERE id = '${vehicle_id}' AND status = '1'`);

        if (vehicle_list != "") return res.status(200).json({ ResponseCode: 200, Result:true, message: "Data Load successful", vehicle: vehicle_list[0] });
        else return res.status(200).json({ ResponseCode: 401, Result:false, message: "Vehicle Not Found!" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// ============= Home Wallet ================ //

router.post("/home_wallet", async(req, res)=>{
    try {
        const {uid} = req.body;
        if ( uid == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' });

        const driver = await DataFind(`SELECT wallet FROM tbl_customer WHERE id = '${uid}'`);
        if(driver == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Driver Not Found!'});

        const general = await DataFind(`SELECT wallet_low_balance_limit FROM tbl_general_settings`);
        const low_limit = parseFloat(general[0].wallet_low_balance_limit) || 50.00;
        const wallet_bal = parseFloat(driver[0].wallet) || 0;
        const is_low_balance = wallet_bal < low_limit;

        return res.status(200).json({ ResponseCode: 200, Result:true, message: "Data Load successful", wallet_amount:driver[0].wallet, is_low_balance, low_balance_limit: general[0].wallet_low_balance_limit });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

router.post("/home_mape", async(req, res)=>{
    try {
        const {mid, lat, lon} = req.body;
        
        if ( !lat || !lon) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' });

        const general = await DataFind(`SELECT site_currency, vehicle_radius FROM tbl_general_settings`);

        let convertzone = [{ latitude: Number(lat), longitude: Number(lon) }];
        // let dzone = await AllFunction.ZoneData();
        let zonecheck = await AllFunction.CheckZone(convertzone);
        
        if (zonecheck[1].zc != "0") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Location is not in the zone!'});

        let v_id;
        if (mid == "") {
            let vehicle_list = await DataFind(`SELECT id, image, name, description, bidding FROM tbl_vehicle WHERE status = '1' AND home_visible_status = '1'`);
            v_id = vehicle_list[0].id;
        } else v_id = mid;
        
        console.log(zonecheck[2].zid);
        
        const driver = await DataFind(`SELECT dr.id, COALESCE(ve.map_img, '') AS image, COALESCE(ve.name, '') AS name, COALESCE(ve.description, '') AS description, 
                                        COALESCE(dr.latitude, '') AS latitude, COALESCE(dr.longitude, '') AS longitude 
                                        FROM tbl_driver AS dr
                                        JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id AND ve.id = '${v_id}'
                                        WHERE 
                                        (6371 * ACOS(
                                            COS(RADIANS(dr.latitude)) * COS(RADIANS(${Number(lat)})) *
                                            COS(RADIANS(${Number(lon)}) - RADIANS(dr.longitude)) +
                                            SIN(RADIANS(dr.latitude)) * SIN(RADIANS(${Number(lat)}))
                                        )) <= ${Number(general[0].vehicle_radius)}
                                        AND JSON_CONTAINS(dr.zone, '${JSON.stringify(zonecheck[2].zid[0])}', '$') AND dr.fstatus = '1' AND dr.status = '1' AND dr.approval_status = '1' AND COALESCE(dr.break_mode, 0) = 0 AND dr.latitude NOT IN ('') AND dr.longitude NOT IN ('')`);
        
        // Old
        // const driver = await DataFind(`SELECT dr.id, COALESCE(ve.map_img, '') AS image, COALESCE(ve.name, '') AS name, COALESCE(ve.description, '') AS description, 
        //                                 COALESCE(dr.latitude, '') AS latitude, COALESCE(dr.longitude, '') AS longitude 
        //                                 FROM tbl_driver AS dr
        //                                 JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id AND ve.id = '${v_id}'
        //                                 WHERE dr.zone IN (${zonecheck[2].zid}) AND dr.fstatus = '1' AND dr.status = '1' AND dr.approval_status = '1' AND dr.latitude NOT IN ('') AND dr.longitude NOT IN ('')`);



        // const driver = await DataFind(`
        //     SELECT dr.id, COALESCE(ve.image, '') AS image, COALESCE(ve.name, '') AS name, COALESCE(ve.description, '') AS description, COALESCE(dr.latitude, '') AS latitude, 
        //         COALESCE(dr.longitude, '') AS longitude,
        //         (6371 * acos(cos(radians(${lat})) * cos(radians(dr.latitude)) * cos(radians(dr.longitude) - radians(${lon})) + sin(radians(${lat})) * sin(radians(dr.latitude)))) AS distance 
        //     FROM tbl_driver AS dr 
        //     JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id
        //     WHERE dr.fstatus = '1' AND dr.status = '1' AND dr.approval_status = '1' AND dr.zone IN (${zonecheck[2].zid}) AND dr.latitude IS NOT NULL AND dr.longitude IS NOT NULL 
        //         AND dr.latitude <> '' AND dr.longitude <> '' 
        //     HAVING distance <= ${general[0].radius}
        //     ORDER BY distance ASC
        // `);

        // const driver = await DataFind(`
        //     SELECT *, 
        //         (6371 * acos(cos(radians(${lat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${lon})) + sin(radians(${lat})) * sin(radians(latitude)))) AS distance 
        //     FROM tbl_driver AS dr 
        //     JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id
        //     WHERE fstatus = '1' 
        //         AND status = '1' AND approval_status = '1' AND zone IN (${zonecheck[2].zid}) AND latitude IS NOT NULL AND longitude IS NOT NULL 
        //     HAVING distance <= ${general[0].radius}
        //     ORDER BY distance ASC
        // `);
        
        // const driver = await DataFind(`SELECT dr.id, COALESCE(ve.image, '') AS image, COALESCE(ve.name, '') AS name, COALESCE(ve.description, '') AS description, 
        //                                 COALESCE(dr.latitude, '') AS latitude, COALESCE(dr.longitude, '') AS longitude 
        //                                 FROM tbl_driver AS dr
        //                                 JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id
        //                                 WHERE dr.vehicle = '${mid}' AND dr.zone IN (${zonecheck[2].zid}) AND dr.fstatus = '1' AND dr.status = '1' AND dr.approval_status = '1' 
        //                                 AND dr.latitude NOT IN ('') AND dr.longitude NOT IN ('')`);

        if (driver == "") return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Driver not found!', driverid: [], list: []});

        let list = [], point = { latitude: Number(lat), longitude: Number(lon) }, driverid = [];
        for (let i = 0; i < driver.length;) {
            driverid.push(driver[i].id);
            list.push(driver[i]);

            // let dlotlon = { latitude: Number(driver[i].latitude), longitude: Number(driver[i].longitude) };
            // let distance = await AllFunction.RadiusCheck(point, dlotlon, Number(parseFloat(general[0].vehicle_radius) * parseFloat(1000)));
            
            // if (distance == 1) {
            //     driverid.push(driver[i].id);
            //     list.push(driver[i]);
            // }
            i++;
        }

        return res.status(200).json({ ResponseCode: 200, Result:true, message: "Data Load successful", zone_id: zonecheck[2].zid[0], driverid, list });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})





// ============= Home Location Calculate ================ //

router.post("/calculate", async(req, res)=>{
    try {
        const {uid, mid, mrole, pickup_lat_lon, drop_lat_lon, drop_lat_lon_list} = req.body;

        const missingField = ["uid", 'mid', 'mrole', 'pickup_lat_lon', 'drop_lat_lon'].find(field => !req.body[field]);
        if(missingField) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});

        console.log("calculate");

        if (mrole == "1") {
            let vehicle = await DataFind(`SELECT * FROM tbl_vehicle WHERE status = '1' AND id = '${mid}'`);
            if(vehicle == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Vehicle Not Found!'});

            const coordValid = AllFunction.ValidateCoordinates(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
            if (!coordValid.status) return res.status(200).json({ ResponseCode: 401, Result: false, message: coordValid.message });

            const sameValid = AllFunction.ValidateSameLocations(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
            if (!sameValid.status) return res.status(200).json({ ResponseCode: 401, Result: false, message: sameValid.message });

            let convertzone = await AllFunction.ZoneLatlon(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
            let travelRoute = convertzone;

            let zonecheck = await AllFunction.CheckZone(travelRoute);
            
            const general = await DataFind(`SELECT * FROM tbl_general_settings`);
            if(general == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
            
            if (zonecheck[1].zc != 0) return res.status(200).json({ ResponseCode: 401, Result: false, message: AllFunction.GetOutsideZoneMessage(zonecheck) });
            let zoneresult = zonecheck[0].zr;
          

            let cal = 0, hour = 0, time = 0, totmin = 0;
            for (let c = 1; c < zoneresult.length;) {

                if (zoneresult[c].status == "1") {
                    
                    let pickup = `${travelRoute[c-1].latitude},${travelRoute[c-1].longitude}`;
                    let drop = `${travelRoute[c].latitude},${travelRoute[c].longitude}`;
                    let distance = await AllFunction.GetDistance(pickup, drop, general[0].google_map_key);

                    if (distance.status == 0) {
                        if (general[0].socket_status_banner == 1) {
                            let msg = "Something went wrong with map key";
                            if (distance.error_code === 'REQUEST_DENIED') {
                                msg = "Google Maps API Key is invalid or unauthorized. Please verify your Google Cloud Console project and API key settings.";
                            } else if (distance.error_code === 'ZERO_RESULTS') {
                                msg = "No route path could be found. Please ensure that Directions API and Distance Matrix API are enabled in your Google Maps API Cloud Settings.";
                            } else {
                                msg = `Google Maps API error: ${distance.error_code}. Please check your Google Maps Cloud settings and billing status.`;
                            }
                            return res.status(200).json({ ResponseCode: 401, Result: false, message: msg });
                        }
                    }

                    // let distancec = geolib.getDistance(convertzone[0], convertzone[c]);
                    // let kmdata = (distancec / 1000).toFixed(2);
                    cal += parseFloat(distance.dis);

                    // Time
                    let spltime = distance.dur.split(" ");
                    if (spltime.length == "2") {
                        totmin += parseFloat(spltime[0]);
                    } else if (spltime.length == "4") {
                        totmin += parseFloat(spltime[0]) * 60 + parseFloat(spltime[2]);
                    }

                }
                c++;
            }
             
            if (cal == "0") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});

            let roundkm = cal, add_distance = 0, tot_price = 0, km_charge = 0, extra_charge = 0, weather_charge = 0, extra_person_charge = 0, site_commission = 0;

           
            if (roundkm <= vehicle[0].min_km_distance) {
                km_charge = parseFloat(roundkm) * parseFloat(vehicle[0].min_km_price);

            } else {
                add_distance = parseFloat(roundkm) - parseFloat(Number(vehicle[0].min_km_distance));
                km_charge = (parseFloat(vehicle[0].min_km_distance) * parseFloat(vehicle[0].min_km_price) + (parseFloat(add_distance) * parseFloat(vehicle[0].after_km_price)));
            }
            tot_price += km_charge;

            if (Number(vehicle[0].extra_charge) > 0) {
                tot_price = tot_price + Number(vehicle[0].extra_charge);
                extra_charge = Number(vehicle[0].extra_charge);
            }

            if (vehicle[0].whether_charge == "1") {
                if (general[0].weather_type == 'fix') {
                    tot_price = tot_price + Number(general[0].weather_price);
                    weather_charge = Number(general[0].weather_price);
                } else {
                    const weatherp = Number(((tot_price / 100) * Number(general[0].weather_price)).toFixed(2));
                    tot_price = tot_price + weatherp; weather_charge = weatherp;
                }
            }

            if (vehicle[0].comission_type && vehicle[0].comission_type.toLowerCase() == 'fix') {
                tot_price = tot_price + Number(vehicle[0].comission_rate);
                site_commission = Number(vehicle[0].comission_rate);
            } else {
                const scom = Number(((tot_price / 100) * Number(vehicle[0].comission_rate)).toFixed(2));
                tot_price = tot_price + scom; site_commission = scom;
            }

            let hou_min = await AllFunction.MinuteToHour(totmin), dr_price = Number((tot_price).toFixed(2));

            let cpickup = `${convertzone[0].latitude},${convertzone[0].longitude}`;
            let veh = 0, addtime = "";
            const driver = await DataFind(`SELECT dr.id, COALESCE(ve.map_img, '') AS image, COALESCE(ve.name, '') AS name, COALESCE(ve.description, '') AS description,
                                            COALESCE(dr.latitude, '') AS latitude, COALESCE(dr.longitude, '') AS longitude,
                                            (
                                                6371 * ACOS(
                                                    COS(RADIANS(${Number(convertzone[0].latitude)})) * COS(RADIANS(dr.latitude)) *
                                                    COS(RADIANS(dr.longitude) - RADIANS(${Number(convertzone[0].longitude)})) +
                                                    SIN(RADIANS(${Number(convertzone[0].latitude)})) * SIN(RADIANS(dr.latitude))
                                                )
                                            ) AS distance
                                            FROM tbl_driver AS dr
                                            JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id
                                            WHERE dr.vehicle = '${vehicle[0].id}' AND JSON_CONTAINS(dr.zone, '${JSON.stringify(Number(zonecheck[2].zid[0]))}', '$')
                                            AND dr.fstatus = '1' AND dr.status = '1' AND dr.approval_status = '1' AND COALESCE(dr.break_mode, 0) = 0 AND dr.latitude NOT IN ('') AND dr.longitude NOT IN ('')
                                            HAVING distance <= ${Number(general[0].vehicle_radius)}
                                            ORDER BY distance ASC LIMIT 1`);
            if (driver.length > 0) {
                let driverl = `${driver[0].latitude},${driver[0].longitude}`;
                let dstance = await AllFunction.GetDistance(driverl, cpickup, general[0].google_map_key);
                let spltime = dstance.dur.split(" ");
                let dtime = 0;
                if (spltime.length == "2") dtime = parseFloat(spltime[0]);
                else dtime = (parseFloat(spltime[0]) * 60) + parseFloat(spltime[2]);
                addtime = await AllFunction.AddDateMinute(parseFloat(dtime) + parseFloat(totmin));
                veh = dtime;
            }

            vehicle[0].dri_pic_time = veh;
            vehicle[0].dri_pic_drop = addtime;
            if (vehicle[0].bidding == 0) {
                return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Address calculate successful', offer_expire_time: general[0].offer_expire_time, zoneresult, 
                zone: zonecheck[2].zid, tot_km:Number(parseFloat(roundkm).toFixed(2)), tot_hour: hou_min.hour, tot_minute: hou_min.minute, tot_second: 0, 
                drop_price:dr_price, km_charge, extra_charge, weather_charge, extra_person_charge, site_commission, vehicle:vehicle[0],
                weather_price: general[0].weather_price, weather_type: general[0].weather_type, extra_charge_rate: vehicle[0].extra_charge,
                comission_rate: vehicle[0].comission_rate, comission_type: vehicle[0].comission_type });

            } else {

                if (Number(vehicle[0].minimum_fare) > Number(tot_price)) {
    
                    return res.status(200).json({ ResponseCode: 401, Result: false, message: `The fare in this city exceeds our minimum limit of ${general[0].site_currency}${vehicle[0].minimum_fare}.` });
    
                } else if (Number(vehicle[0].maximum_fare) < Number(tot_price)) {
    
                    return res.status(200).json({ ResponseCode: 401, Result: false, message: `The fare in this city exceeds our maximum limit of ${general[0].site_currency}${vehicle[0].maximum_fare}.` });
    
                } else {
                   
    
                    return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Address calculate successful', offer_expire_time: general[0].offer_expire_time, zoneresult, 
                    zone: zonecheck[2].zid, tot_km:Number(parseFloat(roundkm).toFixed(2)), tot_hour: hou_min.hour, tot_minute: hou_min.minute, tot_second: 0, 
                    drop_price:dr_price, km_charge, extra_charge, weather_charge, extra_person_charge, site_commission, vehicle:vehicle[0],
                    weather_price: general[0].weather_price, weather_type: general[0].weather_type, extra_charge_rate: vehicle[0].extra_charge,
                    comission_rate: vehicle[0].comission_rate, comission_type: vehicle[0].comission_type });
                }
            }

            
        }

       

        return res.status(200).json({ ResponseCode: 401, Result: false, message: "Please try different type vehicle.!" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
})

// ============= Vehicle Module Calculate ================ //

router.post("/module_calculate", async(req, res)=>{
    try {
        const {uid, mid, mrole, pickup_lat_lon, drop_lat_lon, drop_lat_lon_list} = req.body;
        const missingField = ["uid", 'mid', 'mrole', 'pickup_lat_lon', 'drop_lat_lon'].find(field => !req.body[field]);
        if(missingField) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
        const coordValid = AllFunction.ValidateCoordinates(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
        if (!coordValid.status) return res.status(200).json({ ResponseCode: 401, Result: false, message: coordValid.message });

        const sameValid = AllFunction.ValidateSameLocations(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
        if (!sameValid.status) return res.status(200).json({ ResponseCode: 401, Result: false, message: sameValid.message });

        let convertzone = await AllFunction.ZoneLatlon(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
        let travelRoute = convertzone;

        let zonecheck = await AllFunction.CheckZone(travelRoute);
        if (zonecheck[1].zc != "0") return res.status(200).json({ ResponseCode: 401, Result:false, message: AllFunction.GetOutsideZoneMessage(zonecheck)});
        const vehicle = await DataFind(`SELECT * FROM tbl_vehicle WHERE status = '1' AND bidding = '0' AND home_visible_status = '1'`);
        if(vehicle == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Vehicle Not Found!'});
        let zoneresult = zonecheck[0].zr, dhour = 0, dtime = 0;
        const general = await DataFind(`SELECT * FROM tbl_general_settings`);
        if(general == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
        let cal = 0, hour = 0, time = 0, totmin = 0;
        for (let a = 1; a < zoneresult.length;) {
            let pickup = `${travelRoute[a-1].latitude},${travelRoute[a-1].longitude}`;
            let drop = `${travelRoute[a].latitude},${travelRoute[a].longitude}`;
            let distance = await AllFunction.GetDistance(pickup, drop, general[0].google_map_key);

            if (distance.status == 0) {
                if (general[0].socket_status_banner == 1) {
                    let msg = "Something went wrong with map key";
                    if (distance.error_code === 'REQUEST_DENIED') {
                        msg = "Google Maps API Key is invalid or unauthorized. Please verify your Google Cloud Console project and API key settings.";
                    } else if (distance.error_code === 'ZERO_RESULTS') {
                        msg = "No route path could be found. Please ensure that Directions API and Distance Matrix API are enabled in your Google Maps API Cloud Settings.";
                    } else {
                        msg = `Google Maps API error: ${distance.error_code}. Please check your Google Maps Cloud settings and billing status.`;
                    }
                    return res.status(200).json({ ResponseCode: 401, Result: false, message: msg });
                }
            }

            // KM
            cal += parseFloat(distance.dis)
            // Time
            let spltime = distance.dur.split(" ");
            if (spltime.length == "2") {
                dhour = 0; dtime = parseFloat(spltime[0]);
            } else if (spltime.length == "4") {
                dhour = parseFloat(spltime[0]); dtime = parseFloat(spltime[2]);
            }
            totmin +=  parseFloat(dhour) * 60 + parseFloat(dtime);
            hour += parseFloat(dhour); time += dtime;
            a++;
        }
        if (cal == "0") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
        let hou_min = await AllFunction.MinuteToHour(totmin);
        let caldriver = [], cpickup = `${convertzone[0].latitude},${convertzone[0].longitude}`;
        for (let c = 0; c < vehicle.length;) {
            let veh = 0, add_distance = 0, tot_price = 0, km_charge = 0, extra_charge = 0, weather_charge = 0, extra_person_charge = 0, site_commission = 0, addtime = "";
            // get nearest driver
            const driver = await DataFind(`SELECT dr.id, COALESCE(ve.map_img, '') AS image, COALESCE(ve.name, '') AS name, COALESCE(ve.description, '') AS description,
                                            COALESCE(dr.latitude, '') AS latitude, COALESCE(dr.longitude, '') AS longitude,
                                            (
                                                6371 * ACOS(
                                                    COS(RADIANS(${Number(convertzone[0].latitude)})) * COS(RADIANS(dr.latitude)) *
                                                    COS(RADIANS(dr.longitude) - RADIANS(${Number(convertzone[0].longitude)})) +
                                                    SIN(RADIANS(${Number(convertzone[0].latitude)})) * SIN(RADIANS(dr.latitude))
                                                )
                                            ) AS distance
                                            FROM tbl_driver AS dr
                                            JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id
                                            WHERE dr.vehicle = '${vehicle[c].id}' AND JSON_CONTAINS(dr.zone, '${JSON.stringify(zonecheck[2].zid.map(Number))}', '$')
                                            AND dr.fstatus = '1' AND dr.status = '1' AND dr.approval_status = '1' AND COALESCE(dr.break_mode, 0) = 0 AND dr.latitude NOT IN ('') AND dr.longitude NOT IN ('')
                                            HAVING distance <= ${Number(general[0].vehicle_radius)}
                                            ORDER BY distance ASC LIMIT 1`);
            if (driver.length > 0) {
                let driverl = `${driver[0].latitude},${driver[0].longitude}`;
                let dstance = await AllFunction.GetDistance(driverl, cpickup, general[0].google_map_key);
                // dkm = (Math.round(parseFloat(dstance.dis)));
                // time
                let spltime = dstance.dur.split(" ");
                if (spltime.length == "2") dtime = parseFloat(spltime[0]);
                else dtime = (parseFloat(spltime[0]) * 60) + parseFloat(spltime[2]);
                addtime = await AllFunction.AddDateMinute(parseFloat(dtime) + parseFloat(totmin)); veh = dtime;
            }
            if (cal <= vehicle[c].min_km_distance) {
                km_charge = parseFloat(cal) * parseFloat(vehicle[c].min_km_price);
            } else {
                add_distance = parseFloat(cal) - parseFloat(Number(vehicle[c].min_km_distance));
                km_charge = (parseFloat(vehicle[c].min_km_distance) * parseFloat(vehicle[c].min_km_price) + (parseFloat(add_distance) * parseFloat(vehicle[c].after_km_price)));
            }
            tot_price += km_charge;
            if (Number(vehicle[c].extra_charge) > 0) {
                tot_price = tot_price + Number(vehicle[c].extra_charge);
                extra_charge = Number(vehicle[c].extra_charge);
            }
            if (vehicle[c].whether_charge == "1") {
                if (general[0].weather_type == 'fix') {
                    tot_price = tot_price + Number(general[0].weather_price);
                    weather_charge = Number(general[0].weather_price);
                } else {
                    const weatherp = Number(((tot_price / 100) * Number(general[0].weather_price)).toFixed(2));
                    tot_price = tot_price + weatherp; weather_charge = weatherp
                }
            }
            if (vehicle[c].comission_type && vehicle[c].comission_type.toLowerCase() == 'fix') {
                tot_price = tot_price + Number(vehicle[c].comission_rate);
                site_commission = Number(vehicle[c].comission_rate);
            } else {
                const scom = Number(((tot_price / 100) * Number(vehicle[c].comission_rate)).toFixed(2));
                tot_price = tot_price + scom; site_commission = scom;
            }
            // roundkm = cal, add_distance = 0, tot_price = 0, km_charge = 0, extra_charge = 0, weather_charge = 0, extra_person_charge = 0, site_commission = 0, addtime = "";
            caldriver.push({...vehicle[c], m_role: mrole, dri_pic_time: veh, dri_pic_drop: addtime, drop_hour:hou_min.hour, drop_time:hou_min.minute,
                drop_km:Number(Number(cal).toFixed(2)), drop_price:Number(Number(tot_price).toFixed(2)), km_charge, extra_charge, weather_charge, extra_person_charge, site_commission,
                zone: zonecheck[2].zid, weather_price: general[0].weather_price, weather_type: general[0].weather_type, extra_charge_rate: vehicle[c].extra_charge });
            c++;
        }
        return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Address calculate successful', caldriver});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// ============= One Vehicle Calculate ================ //

async function Vehicle_calculate(uid, mid, pickup_lat_lon, drop_lat_lon, drop_lat_lon_list, status, czone, zcheck, vid) {
    let convertzone, zonecheck, v_id;
    // console.log(status);
    
    if (status == 1) {
        convertzone = await AllFunction.ZoneLatlon(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
        
        // let dzone = await AllFunction.ZoneData();
        
        zonecheck = await AllFunction.CheckZone(convertzone);
        // console.log(zonecheck);
        if (zonecheck[1].zc != "0") return 1;

        if (mid == "") {
            let vehicle_list = await DataFind(`SELECT id, image, name, description, bidding FROM tbl_vehicle WHERE status = '1'`);
            v_id = vehicle_list[0].id;
        } else v_id = mid;

    } else {
        convertzone = czone; zonecheck = zcheck; v_id = vid;
    }
    // console.log(zonecheck[2].zid);
    
    const general = await DataFind(`SELECT * FROM tbl_general_settings`);
    if(general == "") return 2;
    
    // const driver = await DataFind(`SELECT dr.id, COALESCE(ve.map_img, '') AS image, COALESCE(ve.name, '') AS name, COALESCE(ve.description, '') AS description, 
    //                                 COALESCE(dr.latitude, '') AS latitude, COALESCE(dr.longitude, '') AS longitude 
    //                                 FROM tbl_driver AS dr
    //                                 JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id
    //                                 WHERE dr.vehicle = '${v_id}'
    //                                 AND dr.latitude NOT IN ('') AND dr.longitude NOT IN ('')`);
    
    // // new
    const driver = await DataFind(`SELECT dr.id, COALESCE(ve.map_img, '') AS image, COALESCE(ve.name, '') AS name, COALESCE(ve.description, '') AS description, 
                                    COALESCE(dr.latitude, '') AS latitude, COALESCE(dr.longitude, '') AS longitude 
                                    FROM tbl_driver AS dr
                                    JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id
                                    WHERE 
                                    (6371 * ACOS(
                                        COS(RADIANS(dr.latitude)) * COS(RADIANS(${Number(convertzone[0].latitude)})) *
                                        COS(RADIANS(${Number(convertzone[0].longitude)}) - RADIANS(dr.longitude)) +
                                        SIN(RADIANS(dr.latitude)) * SIN(RADIANS(${Number(convertzone[0].latitude)}))
                                    )) <= ${Number(general[0].vehicle_radius)}
                                    AND dr.vehicle = '${v_id}' AND dr.zone IN (${zonecheck[2].zid}) AND dr.fstatus = '1' AND dr.status = '1' AND dr.approval_status = '1' AND COALESCE(dr.break_mode, 0) = 0
                                    AND dr.latitude NOT IN ('') AND dr.longitude NOT IN ('')`);
    
    // console.log(driver);
    
    // // 
    // const driver = await DataFind(`SELECT dr.id, COALESCE(ve.map_img, '') AS image, COALESCE(ve.name, '') AS name, COALESCE(ve.description, '') AS description, 
    //                                 COALESCE(dr.latitude, '') AS latitude, COALESCE(dr.longitude, '') AS longitude 
    //                                 FROM tbl_driver AS dr
    //                                 JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id
    //                                 WHERE dr.vehicle = '${v_id}' AND dr.zone IN (${zonecheck[2].zid}) AND dr.fstatus = '1' AND dr.status = '1' AND dr.approval_status = '1'
    //                                 AND dr.rid_status = '0' AND dr.latitude NOT IN ('') AND dr.longitude NOT IN ('')`);
    
    if (driver == "") return 3;

    let dkm = 0, dtime = 0;
    let cpickup = `${convertzone[0].latitude},${convertzone[0].longitude}`;
    let caldriver = [], driver_id =  [], minkm = 0, point = { latitude: Number(convertzone[0].latitude), longitude: Number(convertzone[0].longitude) };
    for (let i = 0; i < driver.length;) {
        
        // let dlotlon = { latitude: Number(driver[i].latitude), longitude: Number(driver[i].longitude) };
        // let distance = await AllFunction.RadiusCheck(point, dlotlon, Number(parseFloat(general[0].vehicle_radius) * parseFloat(1000)));
        
        // if (distance == 1) {

            if (status == "2") {

                // get distance and time
                let driverl = `${driver[i].latitude},${driver[i].longitude}`;
                let dstance = await AllFunction.GetDistance(driverl, cpickup, general[0].google_map_key);
                dkm = (Math.round(parseFloat(dstance.dis)));
        
                // time
                let spltime = dstance.dur.split(" ");
                if (spltime.length == "2") dtime = parseFloat(spltime[0]);
                else dtime = (parseFloat(spltime[0]) * 60) + parseFloat(spltime[2]);
    
                if (minkm == 0) minkm = dtime; 
                if (parseFloat(minkm) > parseFloat(dtime)) minkm = dtime;

            } else caldriver.push({id:driver[i].id, image:driver[i].image, name:driver[i].name, description:driver[i].description, latitude:driver[i].latitude, longitude:driver[i].longitude});

            driver_id.push(driver[i].id);

        // }
        i++;
    }
    
    if (status == "1") return {driver_id, caldriver};
    else return {minkm: minkm, driver_id:driver_id};
}



router.post("/vehicle_calculate", async(req, res)=>{
    try {
        const {uid, mid, pickup_lat_lon, drop_lat_lon, drop_lat_lon_list} = req.body;

        const missingField = ["uid", 'mid', 'pickup_lat_lon', 'drop_lat_lon'].find(field => !req.body[field]);
        if(missingField) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});

        console.log("vehicle_calculate");

        const coordValid = AllFunction.ValidateCoordinates(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
        if (!coordValid.status) return res.status(200).json({ ResponseCode: 401, Result: false, message: coordValid.message });

        const sameValid = AllFunction.ValidateSameLocations(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
        if (!sameValid.status) return res.status(200).json({ ResponseCode: 401, Result: false, message: sameValid.message });

        let convertzone = await AllFunction.ZoneLatlon(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
        // let dzone = await AllFunction.ZoneData();
        let zonecheck = await AllFunction.CheckZone(convertzone);
        if (zonecheck[1].zc != "0") return res.status(200).json({ ResponseCode: 401, Result:false, message: AllFunction.GetOutsideZoneMessage(zonecheck)});
        
        const vehicle = await DataFind(`SELECT * FROM tbl_vehicle WHERE id = '${mid}' AND status = '1'`);
        if(vehicle == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Vehicle Not Found!'});

        // let zoneresult = zonecheck[0].zr, dhour = 0, dtime = 0;
    
        const general = await DataFind(`SELECT vehicle_radius FROM tbl_general_settings`);
        if(general == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});

        const driver = await DataFind(`SELECT dr.id, COALESCE(ve.map_img, '') AS image, COALESCE(ve.name, '') AS name, COALESCE(ve.description, '') AS description,
                                        COALESCE(dr.latitude, '') AS latitude, COALESCE(dr.longitude, '') AS longitude
                                        FROM tbl_driver AS dr
                                        JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id
                                        WHERE
                                        (6371 * ACOS(
                                            COS(RADIANS(dr.latitude)) * COS(RADIANS(${Number(convertzone[0].latitude)})) *
                                            COS(RADIANS(${Number(convertzone[0].longitude)}) - RADIANS(dr.longitude)) +
                                            SIN(RADIANS(dr.latitude)) * SIN(RADIANS(${Number(convertzone[0].latitude)}))
                                        )) <= ${Number(general[0].vehicle_radius)}
                                        AND dr.vehicle = '${vehicle[0].id}' AND JSON_CONTAINS(dr.zone, '${JSON.stringify(Number(zonecheck[2].zid[0]))}', '$') AND dr.fstatus = '1' AND dr.status = '1'
                                        AND dr.approval_status = '1' AND COALESCE(dr.break_mode, 0) = 0 AND dr.latitude NOT IN ('') AND dr.longitude NOT IN ('')`);

        return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Address calculate successful', caldriver: driver});

        // let caldata = await Vehicle_calculate(uid, mid, pickup_lat_lon, drop_lat_lon, drop_lat_lon_list, 1)
        // if (caldata == "1") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Address is not in the zone!'});
        // if (caldata == "2") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
        // if (caldata == "3") return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Driver not found!', driver_id: [], caldriver: []});
        // if (caldata == "4") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Vehicle Not Found!'});
        // if (caldata == "5") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
        
        // return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Address calculate successful', driver_id:caldata.driver_id, caldriver:caldata.caldriver});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


router.post("/add_vehicle_request", async(req, res)=>{
    try {
        let {uid, vehicle_id, tot_km, tot_hour, tot_minute, bidding, bidd_auto_status, drop_price, bid_addjust_amount, km_charge, extra_charge, weather_charge, extra_person_charge, 
            site_commission, coupon_id, payment_id, zone, pickup, drop, droplist, pickupadd, dropadd, droplistadd, book_date, book_time} = req.body;
        
        const missingField = await AllFunction.BodyNumberDataCheck(["uid", "vehicle_id", "tot_km", "tot_hour", "tot_minute", "bidding", "bidd_auto_status", "drop_price", 
            "bid_addjust_amount", "km_charge", "extra_charge", "weather_charge", "extra_person_charge", "site_commission", "zone", "pickup", "drop", "droplist", "pickupadd", 
            "dropadd", "droplistadd"], req.body);
            
        if (missingField.status == false) return res.status(200).json({ ResponseCode: 401, Result:false, message: missingField.message });

            
        const coordValid = AllFunction.ValidateCoordinates(pickup, drop, droplist);
        if (!coordValid.status) return res.status(200).json({ ResponseCode: 401, Result: false, message: coordValid.message });

        const sameValid = AllFunction.ValidateSameLocations(pickup, drop, droplist);
        if (!sameValid.status) return res.status(200).json({ ResponseCode: 401, Result: false, message: sameValid.message });

        let convertz = await AllFunction.ZoneLatlon(pickup, drop, droplist), bid_d = [], coupon_price = 0;
        
        // Geodesic distance limit check using geolib
        let geodesic_dist_m = 0;
        for (let i = 1; i < convertz.length; i++) {
            geodesic_dist_m += geolib.getDistance(convertz[i-1], convertz[i]);
        }
        let geodesic_dist_km = geodesic_dist_m / 1000;
        if (Number(tot_km) < geodesic_dist_km * 0.8) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: 'Invalid route distance!' });
        }

        // Server-side price recalculation check
        const vehicle = await DataFind(`SELECT * FROM tbl_vehicle WHERE status = '1' AND id = '${vehicle_id}'`);
        if (vehicle.length === 0) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: 'Vehicle details not found!' });
        }

        let server_km_charge = 0;
        if (Number(tot_km) <= vehicle[0].min_km_distance) {
            server_km_charge = parseFloat(Number(tot_km).toFixed(2)) * parseFloat(vehicle[0].min_km_price);
        } else {
            let server_add_distance = parseFloat(Number(tot_km).toFixed(2)) - parseFloat(Number(vehicle[0].min_km_distance));
            server_km_charge = (parseFloat(vehicle[0].min_km_distance) * parseFloat(vehicle[0].min_km_price) + (parseFloat(server_add_distance) * parseFloat(vehicle[0].after_km_price)));
        }
        server_km_charge = parseFloat(server_km_charge.toFixed(2));

        let server_extra_charge = Number(vehicle[0].extra_charge) > 0 ? Number(vehicle[0].extra_charge) : 0;
        
        let server_weather_charge = 0;
        if (vehicle[0].whether_charge == "1") {
            const gen_weather = await DataFind(`SELECT weather_type, weather_price FROM tbl_general_settings`);
            if (gen_weather.length > 0) {
                if (gen_weather[0].weather_type == 'fix') {
                    server_weather_charge = Number(gen_weather[0].weather_price);
                } else {
                    let temp_price = server_km_charge + server_extra_charge;
                    server_weather_charge = Number(((temp_price / 100) * Number(gen_weather[0].weather_price)).toFixed(2));
                }
            }
        }

        let server_base_price = server_km_charge + server_extra_charge + server_weather_charge;
        
        let server_site_commission = 0;
        if (vehicle[0].comission_type && vehicle[0].comission_type.toLowerCase() == 'fix') {
            server_site_commission = Number(vehicle[0].comission_rate);
        } else {
            server_site_commission = Number(((server_base_price / 100) * Number(vehicle[0].comission_rate)).toFixed(2));
        }

        let server_total_price = Number((server_base_price + server_site_commission).toFixed(2));

        if (Math.abs(Number(drop_price) - server_total_price) > 0.5) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: 'Pricing validation failed!' });
        }

        // console.log(driverid);

        const general = await DataFind(`SELECT default_payment, vehicle_radius FROM tbl_general_settings`);
        let payment = payment_id == "0" ? general[0].default_payment : payment_id;
        
        let caldata;
        if (book_date && book_date !== '') {
            caldata = { status: true, idlist: [] };
        } else {
            caldata = await AllFunction.AvailableDriverGet(convertz[0].latitude, convertz[0].longitude, general[0].vehicle_radius, `vehicle = '${vehicle_id}'`, zone, 1);
            if (caldata.status == false) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'No drivers found nearby. Please try again shortly.!'});
        }

        let pic = "", dropdata = "", picadd = "", dropad = "", alcount = 0, drocount = 2, tkm = parseFloat(parseFloat(tot_km).toFixed(2));

        for (let i = 0; i < convertz.length;) {
            if (i == "0") pic = convertz[i].latitude + "&!" + convertz[i].longitude
            else dropdata += dropdata == "" ? convertz[i].latitude + "&!" + convertz[i].longitude : "&!!" + convertz[i].latitude + "&!" + convertz[i].longitude;
            alcount++;
            i++;
        }

        picadd = pickupadd.title + "&!" + pickupadd.subt;
        dropad = "";
        if (droplistadd && droplistadd != "") {
            for (let a = 0; a < droplistadd.length;) {
                dropad += dropad == "" ? droplistadd[a].title + "&!" + droplistadd[a].subt : "&!!" + droplistadd[a].title + "&!" + droplistadd[a].subt;
                drocount++;
                a++;
            }
        }
        dropad += dropad == "" ? dropadd.title + "&!" + dropadd.subt : "&!!" + dropadd.title + "&!" + dropadd.subt;
        if(alcount != drocount) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Location details are incomplete.'});

        // const vehicle_list = await DataFind(`SELECT * FROM tbl_vehicle WHERE id = '${vehicle_id}' AND status = '1'`);

        // // // // // Send Notification
        for (let  i = 0; i < caldata.idlist.length; ) {
            sendTemplatedNotification('new_ride_request', 'driver', caldata.idlist[i]);
            i++;
        }
        
        let date = new Date().toISOString(), bidd_auto_st = bidd_auto_status == "true" ? '1' : '0';
        let checkDate = book_date && book_date !== '' ? book_date : date;

        if (coupon_id != '') {
            const cl = await DataFind(`SELECT * FROM tbl_coupon WHERE id = '${coupon_id}'`);
            if (cl.length > 0) {
                const today = new Date(checkDate);
                const startDate = new Date(cl[0].start_date);
                const endDate = new Date(cl[0].end_date);
                if (today > endDate) {
                    return res.status(200).json({ ResponseCode: 401, Result: false, message: `Expired coupon` });
                }
                if (today < startDate) {
                    return res.status(200).json({ ResponseCode: 401, Result: false, message: `Coupon not active yet` });
                }

                // Check service type restriction
                const restrictions = (cl[0].sub_title || "").split("||")[1] || "";
                if (restrictions.split(",").map(r => r.trim()).includes("regular")) {
                    return res.status(200).json({ ResponseCode: 401, Result: false, message: `Not valid for this service` });
                }

                // Check already used
                const usedRequest = await DataFind(`SELECT * FROM tbl_request_vehicle WHERE c_id = '${uid}' AND coupon_id = '${coupon_id}' AND status != '4'`);
                const usedCart = await DataFind(`SELECT * FROM tbl_cart_vehicle WHERE c_id = '${uid}' AND coupon_id = '${coupon_id}' AND status != '4'`);
                if (usedRequest.length > 0 || usedCart.length > 0) {
                    return res.status(200).json({ ResponseCode: 401, Result: false, message: `Already used` });
                }

                let totpc = drop_price - site_commission;
                if (totpc < Number(cl[0].min_amount)) {
                    return res.status(200).json({ ResponseCode: 401, Result: false, message: `Minimum ride amount not met` });
                }

                drop_price -= Number(cl[0].discount_amount); coupon_price = Number(cl[0].discount_amount);
            } else return res.status(200).json({ ResponseCode: 401, Result: false, message: `Coupon not found!` });
        }

        let bidd_amount_dif = '', fnala = 0

        const dropa = Number(drop_price);
        const bidAdjust = Number(bid_addjust_amount);

        if (bidding == 1 && dropa !== bidAdjust) {
            const diff = Number((Math.abs(dropa - bidAdjust)).toFixed(2));
            
            if (dropa < bidAdjust) {
                console.log('111');
                
                fnala = Number((bidAdjust - diff).toFixed(2));
                bidd_amount_dif = `+ ${diff}`;
            } else {
                console.log('222');

                fnala = Number((dropa - diff).toFixed(2));
                bidd_amount_dif = `- ${diff}`;
            }
        } else {
            fnala = dropa; bidd_amount_dif = '';
        }
        
        let formattedBookTime = book_time && book_time !== '' ? await AllFunction.convertTo12HourFormat(book_time) : '';

        let id = await DataInsert(`tbl_request_vehicle`, `c_id, d_id, vehicleid, bidding_d_price, bidding_status, bidd_auto_status, status, m_role, price, paid_amount, 
            bid_addjust_amount, km_charge, extra_charge, weather_charge, platform_fee, extra_person_charge, day_charge, rent_hour, rental_hour_charge, rental_per_hour_discount, 
            rental_extra_km, rental_extra_km_charge, tot_kg, kg_charge, coupon_id, coupon_price, payment_id, tot_km, tot_hour, tot_minute, package_details, zone, status_time_location, 
            start_time, pic_lat_long, drop_lat_long, pic_address, drop_address, outs_category_id, mod_cate_id, num_passenger, book_date, book_time`,
            `'${uid}', '${JSON.stringify(caldata.idlist)}', '${vehicle_id}', '', '${bidding}', '${bidd_auto_st}', '0', '1', '${bid_addjust_amount == '0' ? drop_price : bid_addjust_amount }', 
            '0', '${bidd_amount_dif}', '${km_charge}', '${extra_charge}', '${weather_charge}', '${site_commission}', '${extra_person_charge}', '0', '0', '0', '0', '0', '0', '0', '0', 
            '${coupon_id}', '${coupon_price}', '${payment}', '${tot_km}', '${tot_hour}', '${tot_minute}', '[]', '${JSON.stringify(zone)}', '', '${date}', '${pic}', '${dropdata}', 
            ${mysql.escape(picadd)}, ${mysql.escape(dropad)}, '', '', '0', '${book_date || ''}', '${formattedBookTime}'`, req.hostname, req.protocol);
            
        if (id == -1) return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });

        let responseMessage = book_date && book_date !== '' 
            ? 'Ride scheduled successfully!' 
            : `We’ve sent ${caldata.idlist.length} captain requests; they’ll confirm shortly.`;

        return res.status(200).json({ ResponseCode: 200, Result:true, message: responseMessage, id:id.insertId,
            driver_id: caldata.idlist});

        // if (data == "") {
            // id = await DataInsert(`tbl_request_vehicle`, `c_id, d_id, bidding_d_price, bidding_status, bidd_auto_status, pic_lat_long, drop_lat_long, pic_address, drop_address, price, 
            //     tot_km, tot_hour, tot_minute, vehicleid, payment_id, status, status_time_location, m_role, coupon_id, start_time`, 
            //     `'${uid}', '${senddataJson}', '', '${vehicle_list[0].bidding}', '${bidd_auto_st}', '${pic}', '${dropdata}', '${picadd}', '${dropad}', '${price}', 
            //     '${tkm}', '${tot_hour}', '${tot_minute}', '${vehicle_id}', '${payment}', '0', '', '${m_role}', '${coupon_id}', '${date}'`, req.hostname, req.protocol);
                
            // if (id == -1) return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
            // return res.status(200).json({ ResponseCode: 200, Result:true, message: `We’ve sent ${driverid.length} captain requests; they’ll confirm shortly.`, id:id.insertId});
        // }
        
        // else {
            
        //     if (await DataUpdate(`tbl_request_vehicle`, `d_id = '${senddataJson}', bidding_d_price = '', bidding_status = '${vehicle_list[0].bidding}', bidd_auto_status = '${bidd_auto_st}', 
        //         pic_lat_long = '${pic}', drop_lat_long = '${dropdata}', pic_address = '${picadd}', drop_address = '${dropad}', price = '${price}', tot_km = '${tkm}', tot_hour = '${tot_hour}', 
        //         tot_minute = '${tot_minute}', vehicleid = '${vehicle_id}', payment_id = '${payment}', status = '0', status_time_location = '', m_role = '${m_role}', coupon_id = '${coupon_id}', 
        //         start_time = '${date}'`, `id = '${data[0].id}'`, req.hostname, req.protocol) == -1) {
                    
        //         return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
        //     }
        //     return res.status(200).json({ ResponseCode: 200, Result:true, message: `We’ve sent ${driverid.length} captain requests; they’ll confirm shortly.`, id:data[0].id});
        // }

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

router.get("/vehicle_cancel_reason", async(req, res)=>{
    try {
        const ride_cancel_list = await DataFind(`SELECT id, title FROM tbl_ride_cancel_reason WHERE status = '1'`);
        
        return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Data Load Successful', ride_cancel_list});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

router.get("/review_data", async(req, res)=>{
    try {
        const review_list = await DataFind(`SELECT * FROM tbl_ride_review_reason WHERE status = '1'`);
        
        return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Data Load Successful', review_list});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

router.post("/vehicle_live_location", async(req, res)=>{
    try {
        const {uid, d_id} = req.body;

        if(!uid || !d_id) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
        
        const data = await DataFind(`SELECT * FROM tbl_cart_vehicle WHERE c_id = '${uid}' AND d_id = '${d_id}'`);
        if(data == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Request Not Found!'});

        const driver = await DataFind(`SELECT dr.id, COALESCE(ve.map_img, '') AS image, COALESCE(ve.name, '') AS name, COALESCE(ve.description, '') AS description, 
                                        COALESCE(dr.latitude, '') AS latitude, COALESCE(dr.longitude, '') AS longitude 
                                        FROM tbl_driver AS dr
                                        JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id AND ve.id = dr.vehicle
                                        WHERE dr.id = '${data[0].d_id}' AND dr.fstatus = '1' AND dr.status = '1' AND dr.approval_status = '1' AND COALESCE(dr.break_mode, 0) = 0 AND dr.latitude NOT IN ('') AND dr.longitude NOT IN ('')`);
        
        return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Data Load Successful', driver_location:driver[0]});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

router.post("/timeout_vehicle_request", async(req, res)=>{
    try {
        const {request_id, uid} = req.body;

        if(!request_id || !uid) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
        
        const data = await DataFind(`SELECT * FROM tbl_request_vehicle WHERE c_id = '${uid}' ORDER BY id DESC`);
        if(data == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Request Not Found!'});

        if (await DataUpdate(`tbl_request_vehicle`, `d_id = '[]', status = '0'`, `id = '${data[0].id}'`, req.hostname, req.protocol) == -1) {  
            return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
        }

        let array = data[0].d_id
        if (typeof array == "string") array = JSON.parse(array);
        
        return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Request Out successful', id:data[0].id, driverid:array});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})



router.post("/resend_vehicle_request", async(req, res)=>{
    try {
        const {uid, driverid} = req.body;

        if(!uid || !driverid) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
        
        const data = await DataFind(`SELECT * FROM tbl_request_vehicle WHERE c_id = '${uid}' ORDER BY id DESC`);
        if(data == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Request Not Found!'});

        let pl = data[0].pic_lat_long.split("&!"), dl = data[0].drop_lat_long.split("&!!"), drop_lat_lon = "", drop_lat_lon_list = []
        for (let i = 0; i < dl.length;) {
            let dspl = dl[i].split("&!");
            if (i == "0") drop_lat_lon = `${dspl[0]},${dspl[1]}`;
            else {
                drop_lat_lon_list.push({ "lat": dspl[0],"long": dspl[1] });
            }
            i++;
        }

        const general = await DataFind(`SELECT id, vehicle_radius FROM tbl_general_settings`);

        let convertzone = await AllFunction.ZoneLatlon(`${pl[0]},${pl[1]}`, drop_lat_lon, drop_lat_lon_list);
        
        // let dzone = await AllFunction.ZoneData();
        let zonecheck = await AllFunction.CheckZone(convertzone);
        if (zonecheck[1].zc != "0") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Address is not in the zone!'});

        let caldata = await AllFunction.AvailableDriverGet(pl[0], pl[1], general[0].vehicle_radius, `vehicle = '${data[0].vehicleid}'`, zonecheck[2].zid, 1);
        if (caldata.status == false) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'No drivers found nearby. Please try again shortly.!'});

        let d_id = caldata.idlist, senddataJson;
        if (typeof d_id == "string") {
            d_id = JSON.parse(d_id);
            senddataJson = JSON.stringify(d_id);
        } else senddataJson = JSON.stringify(d_id);

        // bidding_d_price, bidding_status, bidd_auto_status
        if (await DataUpdate(`tbl_request_vehicle`, `d_id = '${senddataJson}', bidding_d_price = '', status = '0'`, `id = '${data[0].id}'`, req.hostname, req.protocol) == -1) {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
        }
        return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Request Resend successful', id:data[0].id, driver_list: JSON.parse(senddataJson)});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

router.post("/remove_vehicle_request", async(req, res)=>{
    try {
        const {uid} = req.body;

        if(!uid) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
        
        const data = await DataFind(`SELECT * FROM tbl_request_vehicle WHERE c_id = '${uid}' ORDER BY id DESC`);
        if(data == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Request Not Found!'});

        if (await DataDelete(`tbl_request_vehicle`, `id = '${data[0].id}'`, req.hostname, req.protocol) == -1) {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
        }

        let array = data[0].d_id;
        if (typeof array == "string") array = JSON.parse(array);

        return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Request Cancel successful', id:data[0].id, driver_list:array});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

router.post("/vehicle_ride_cancel", async(req, res)=>{
    try {
        const {uid, request_id, cancel_id, lat, lon} = req.body;
        if(!uid || !request_id || !cancel_id || !lat || !lon) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
        console.log(req.body);
        let rd, indata, fulldate = await AllFunction.TodatDate(), status = "4", driver_list = [];
        
        const cleanVal = (val, defaultValue = '0') => {
            if (val === undefined || val === null || val === 'undefined') {
                return defaultValue;
            }
            return val;
        };

        rd = await DataFind(`SELECT * FROM tbl_request_vehicle WHERE id = '${request_id}' AND c_id = '${uid}'`);
        if(rd == "") {
            rd = await DataFind(`SELECT * FROM tbl_cart_vehicle WHERE (id = '${request_id}' OR req_id = '${request_id}') AND c_id = '${uid}'`);
            if(rd == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Request Not Found!'});
            let updatet = (rd[0].status_time_location && rd[0].status_time_location != "") ? `${rd[0].status_time_location}&!!${status}&${fulldate.date}T${fulldate.time}&${lat}&${lon}` :
            `${status}&${fulldate.date}T${fulldate.time}&${lat}&${lon}`;
            driver_list = [ parseFloat(rd[0].d_id) ];
            let setime = (rd[0].status_time_location && rd[0].status_time_location != "") ? rd[0].status_time_location.split("&!!") : [], starttime = "";
            // let stime = setime[0].split("&"), etime = setime[setime.length - 1].split("&");
            let stime = (setime.length > 0 ? setime[0].split("&") : ["", ""]), etime = new Date().toISOString();
            if (stime[0] == "1") starttime = await AllFunction.TodatDate(stime[1]);
            const packd = typeof rd[0].package_details == "string" ? JSON.parse(rd[0].package_details) : rd[0].package_details;
            const jzone = typeof rd[0].zone == "string" ? JSON.parse(rd[0].zone) : rd[0].zone;

            const c_id = cleanVal(rd[0].c_id, '');
            const d_id = cleanVal(rd[0].d_id, '0');
            const vehicleid = cleanVal(rd[0].vehicleid, '0');
            const bidding_status = cleanVal(rd[0].bidding_status, '0');
            const bidd_auto_status = cleanVal(rd[0].bidd_auto_status, '0');
            const m_role = cleanVal(rd[0].m_role, '');
            const price = cleanVal(rd[0].price, '0');
            const final_price = cleanVal(rd[0].final_price, '0');
            const bid_addjust_amount = cleanVal(rd[0].bid_addjust_amount, '0');
            const km_charge = cleanVal(rd[0].km_charge, '0');
            const additional_time = cleanVal(rd[0].additional_time, '0');
            const addi_time_price = cleanVal(rd[0].addi_time_price, '0');
            const platform_fee = cleanVal(rd[0].platform_fee, '0');
            const weather_price = cleanVal(rd[0].weather_price, '0');
            const coupon_id = cleanVal(rd[0].coupon_id, '0');
            const coupon_amount = cleanVal(rd[0].coupon_amount, '0');
            const extra_charge = cleanVal(rd[0].extra_charge, '0');
            const extra_person_charge = cleanVal(rd[0].extra_person_charge, '0');
            const day_charge = cleanVal(rd[0].day_charge, '0');
            const rent_hour = cleanVal(rd[0].rent_hour, '0');
            const rental_addi_ride_time = cleanVal(rd[0].rental_addi_ride_time, '0');
            const rental_addi_ride_charge = cleanVal(rd[0].rental_addi_ride_charge, '0');
            const rental_hour_charge = cleanVal(rd[0].rental_hour_charge, '0');
            const rental_per_hour_discount = cleanVal(rd[0].rental_per_hour_discount, '0');
            const rental_extra_km = cleanVal(rd[0].rental_extra_km, '0');
            const rental_extra_km_charge = cleanVal(rd[0].rental_extra_km_charge, '0');
            const tot_kg = cleanVal(rd[0].tot_kg, '0');
            const kg_charge = cleanVal(rd[0].kg_charge, '0');
            const payment_id = cleanVal(rd[0].payment_id, '0');
            const tot_km = cleanVal(rd[0].tot_km, '0');
            const tot_hour = cleanVal(rd[0].tot_hour, '0');
            const tot_minute = cleanVal(rd[0].tot_minute, '0');
            const ride_status = cleanVal(rd[0].ride_status, '0');
            const drop_tot = cleanVal(rd[0].drop_tot, '0');
            const drop_complete = cleanVal(rd[0].drop_complete, '');
            const current_run_time = cleanVal(rd[0].current_run_time, '');
            const status_time = cleanVal(rd[0].status_time, '');
            const pic_lat_long = cleanVal(rd[0].pic_lat_long, '');
            const drop_lat_long = cleanVal(rd[0].drop_lat_long, '');
            const outs_category_id = cleanVal(rd[0].outs_category_id, '0');
            const mod_cate_id = cleanVal(rd[0].mod_cate_id, '0');
            const num_passenger = cleanVal(rd[0].num_passenger, '0');
            const book_date = cleanVal(rd[0].book_date, '');
            const book_time = cleanVal(rd[0].book_time, '');

            indata = await DataInsert(`tbl_order_vehicle`, `c_id, d_id, vehicleid, bidding_status, bidd_auto_status, status, m_role, paid_status, price, final_price, paid_amount,
                bid_addjust_amount,
                km_charge, additional_time, addi_time_price, platform_fee, weather_price, coupon_id, coupon_amount, wallet_price, extra_charge, extra_person_charge, day_charge,
                rent_hour, rental_addi_ride_time, rental_addi_ride_charge, rental_hour_charge, rental_per_hour_discount, rental_extra_km, rental_extra_km_charge, tot_kg, kg_charge,
                payment_id, tot_km, tot_hour, tot_minute, package_details, zone, ride_status, start_time, end_time, drop_tot, drop_complete, current_run_time, status_time,
                status_time_location, status_calculation, pic_lat_long, drop_lat_long, pic_address, drop_address, payment_img, cancel_reason, outs_category_id, mod_cate_id,
                num_passenger, book_date, book_time, req_id`,
                `'${c_id}', '${d_id}', '${vehicleid}', '${bidding_status}', '${bidd_auto_status}', '4', '${m_role}', '0', '${price}',
                '${final_price}', '0', '${bid_addjust_amount}', '${km_charge}', '${additional_time}', '${addi_time_price}', '${platform_fee}', '${weather_price}',
                '${coupon_id}', '${coupon_amount}', '0', '${extra_charge}', '${extra_person_charge}', '${day_charge}', '${rent_hour}',
                '${rental_addi_ride_time}', '${rental_addi_ride_charge}', '${rental_hour_charge}', '${rental_per_hour_discount}', '${rental_extra_km}',
                '${rental_extra_km_charge}', '${tot_kg}', '${kg_charge}', '${payment_id}', '${tot_km}', '${tot_hour}', '${tot_minute}',
                '${JSON.stringify(packd)}', '${JSON.stringify(jzone)}', '${ride_status}', '${stime[1] || ''}', '${etime}', '${drop_tot}', '${drop_complete}',
                '${current_run_time}', '${status_time}', '${updatet}', '', '${pic_lat_long}', '${drop_lat_long}', ${mysql.escape(rd[0].pic_address)},
                ${mysql.escape(rd[0].drop_address)}, '', '${cancel_id}', '${outs_category_id}', '${mod_cate_id}', '${num_passenger}', '${book_date}',
                '${book_time}', '${rd[0].req_id}'`, req.hostname, req.protocol);
            if (indata == -1) return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
            if (await DataDelete(`tbl_cart_vehicle`, `id = '${rd[0].id}'`, req.hostname, req.protocol) == -1) {
                return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
            }
            if (await DataUpdate(`tbl_driver`, `rid_status = '0', check_status = '0'`, `id = '${rd[0].d_id}'`, req.hostname, req.protocol) == -1) {
                return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
            }
        } else {
            let updatet = (rd[0].status_time_location && rd[0].status_time_location != "") ? `${rd[0].status_time_location}&!!${status}&${fulldate.date}T${fulldate.time}&${lat}&${lon}` :
                        `${status}&${fulldate.date}T${fulldate.time}&${lat}&${lon}`;
            let dropcount = (rd[0].drop_lat_long && rd[0].drop_lat_long != "") ? rd[0].drop_lat_long.split("&!!").length : 0, driver_list = rd[0].d_id;
            if (typeof rd[0].d_id == "string") driver_list = JSON.parse(rd[0].d_id);
            const packd = typeof rd[0].package_details == "string" ? JSON.parse(rd[0].package_details) : rd[0].package_details;
            const jzone = typeof rd[0].zone == "string" ? JSON.parse(rd[0].zone) : rd[0].zone;

            const c_id = cleanVal(rd[0].c_id, '');
            const d_id = cleanVal(rd[0].d_id, '0');
            const vehicleid = cleanVal(rd[0].vehicleid, '0');
            const bidding_status = cleanVal(rd[0].bidding_status, '0');
            const bidd_auto_status = cleanVal(rd[0].bidd_auto_status, '0');
            const m_role = cleanVal(rd[0].m_role, '');
            const price = cleanVal(rd[0].price, '0');
            const bid_addjust_amount = cleanVal(rd[0].bid_addjust_amount, '0');
            const km_charge = cleanVal(rd[0].km_charge, '0');
            const platform_fee = cleanVal(rd[0].platform_fee, '0');
            const weather_price = cleanVal(rd[0].weather_price || rd[0].weather_charge, '0');
            const coupon_id = cleanVal(rd[0].coupon_id, '0');
            const coupon_amount = cleanVal(rd[0].coupon_amount || rd[0].coupon_price, '0');
            const extra_charge = cleanVal(rd[0].extra_charge, '0');
            const extra_person_charge = cleanVal(rd[0].extra_person_charge, '0');
            const day_charge = cleanVal(rd[0].day_charge, '0');
            const rent_hour = cleanVal(rd[0].rent_hour, '0');
            const rental_addi_ride_time = cleanVal(rd[0].rental_addi_ride_time, '0');
            const rental_addi_ride_charge = cleanVal(rd[0].rental_addi_ride_charge, '0');
            const rental_hour_charge = cleanVal(rd[0].rental_hour_charge, '0');
            const rental_per_hour_discount = cleanVal(rd[0].rental_per_hour_discount, '0');
            const rental_extra_km = cleanVal(rd[0].rental_extra_km, '0');
            const rental_extra_km_charge = cleanVal(rd[0].rental_extra_km_charge, '0');
            const tot_kg = cleanVal(rd[0].tot_kg, '0');
            const kg_charge = cleanVal(rd[0].kg_charge, '0');
            const payment_id = cleanVal(rd[0].payment_id, '0');
            const tot_km = cleanVal(rd[0].tot_km, '0');
            const tot_hour = cleanVal(rd[0].tot_hour, '0');
            const tot_minute = cleanVal(rd[0].tot_minute, '0');
            const pic_lat_long = cleanVal(rd[0].pic_lat_long, '');
            const drop_lat_long = cleanVal(rd[0].drop_lat_long, '');
            const outs_category_id = cleanVal(rd[0].outs_category_id, '0');
            const mod_cate_id = cleanVal(rd[0].mod_cate_id, '0');
            const num_passenger = cleanVal(rd[0].num_passenger, '0');
            const book_date = cleanVal(rd[0].book_date, '');
            const book_time = cleanVal(rd[0].book_time, '');

            indata = await DataInsert(`tbl_order_vehicle`, `c_id, d_id, vehicleid, bidding_status, bidd_auto_status, status, m_role, paid_status, price, final_price, paid_amount,
                bid_addjust_amount, km_charge, additional_time, addi_time_price, platform_fee, weather_price, coupon_id, coupon_amount, wallet_price, extra_charge, extra_person_charge, day_charge,
                rent_hour, rental_addi_ride_time, rental_addi_ride_charge, rental_hour_charge, rental_per_hour_discount, rental_extra_km, rental_extra_km_charge, tot_kg, kg_charge,
                payment_id, tot_km, tot_hour, tot_minute, package_details, zone, ride_status, start_time, end_time, drop_tot, drop_complete, current_run_time, status_time,
                status_time_location, status_calculation, pic_lat_long, drop_lat_long, pic_address, drop_address, payment_img, cancel_reason, outs_category_id, mod_cate_id,
                num_passenger, book_date, book_time, req_id`,
                `'${c_id}', '${d_id}', '${vehicleid}', '${bidding_status}', '${bidd_auto_status}', '4', '${m_role}', '0', '${price}',
                '0', '0', '${bid_addjust_amount}', '${km_charge}', '0', '0', '${platform_fee}', '${weather_price}', '${coupon_id}', '${coupon_amount}', '0', '${extra_charge}',
                '${extra_person_charge}', '${day_charge}', '${rent_hour}', '${rental_addi_ride_time}', '${rental_addi_ride_charge}', '${rental_hour_charge}',
                '${rental_per_hour_discount}', '${rental_extra_km}', '${rental_extra_km_charge}', '${tot_kg}', '${kg_charge}', '${payment_id}',
                '${tot_km}', '${tot_hour}', '${tot_minute}', '${JSON.stringify(packd)}', '${JSON.stringify(jzone)}', '0', '', '', '${dropcount}', '', '', '',
                '${updatet}', '', '${pic_lat_long}', '${drop_lat_long}', ${mysql.escape(rd[0].pic_address)}, ${mysql.escape(rd[0].drop_address)}, '', '${cancel_id}',
                '${outs_category_id}', '${mod_cate_id}', '${num_passenger}', '${book_date}', '${book_time}', '${rd[0].id}'`, req.hostname, req.protocol);
            if (indata == -1) return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
            if (await DataDelete(`tbl_request_vehicle`, `id = '${rd[0].id}'`, req.hostname, req.protocol) == -1) {
                return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
            }
        }
        return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Request Cancel successful', driverid:driver_list});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})


router.post("/vehicle_ride_addstatus", async(req, res)=>{
    try {
        const {uid, d_id, request_id} = req.body;
        if(!uid || !d_id || !request_id) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});

        const rd = await DataFind(`SELECT * FROM tbl_cart_vehicle WHERE id = '${request_id}' AND c_id = '${uid}' AND d_id = '${d_id}'`);
        if (rd == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Request Not Found!' });

        if (rd[0].status == "3") {
            if (rd[0].ride_status != "0") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Please Complete Other Stap!' });
        } else if (rd[0].status == "6") {
            if (rd[0].ride_status != "6") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Please Complete Other Stap!' });
        } 
        if (rd[0].status == "0" || rd[0].status == "1" || rd[0].status == "2" || rd[0].status == "4" || rd[0].status == "5" || rd[0].status == "7" || rd[0].status == "8") {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Please Complete Other Stap!' });
        }

        let dlatlon = rd[0].drop_lat_long.split("&!!"), daddress = rd[0].drop_address.split("&!!"), pending_ride = "", drop_list = [];
        
        if (rd[0].drop_complete == "") pending_ride = 0;
        else pending_ride = parseFloat(rd[0].drop_complete) + 1;

        let ccheck = await AllFunction.CheckCurrentLocation(pending_ride, dlatlon, daddress);

        for (let i = 0; i < dlatlon.length;) {
            let checkadd = daddress[i].split("&!"), checkl = dlatlon[i].split("&!"), status = "";

            if (pending_ride == i) status = "2";
            if (pending_ride > i) status = "3";
            if (pending_ride < i) status = "1";

            drop_list.push({ status: status, title: checkadd[0], subtitle: checkadd[1], latitude: checkl[0], longitude: checkl[1] });
            i++;
        }
        
        return res.status(200).json({ ResponseCode: 200, Result:true, message: "Service Start Successful", current_address:ccheck.current_address, 
            next_address:ccheck.next_address, drop_list });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})



// ============= Vehicle Driver detail ================ //

router.post("/vehicle_driver_detail", async(req, res)=>{
    try {
        const {uid, d_id, request_id} = req.body;

        if(!uid || !d_id) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' });

        let dr = await AllFunction.DriverReview("cve");
        let rd = "";
        const query = `SELECT cve.id, cve.c_id, cve.d_id, cve.price, cve.tot_km, cve.status, cve.otp, cve.tot_hour, cve.tot_minute,
                                cve.current_run_time, cve.status_time, cve.status_time_location, cve.status_calculation, cve.m_role,
                                COALESCE(dr.profile_image, "") AS profile_image, COALESCE(dr.vehicle_image, "") AS vehicle_image, COALESCE(dr.first_name, "") AS first_name, 
                                COALESCE(dr.last_name, "") AS last_name, COALESCE(dr.primary_ccode, "") AS primary_ccode, COALESCE(dr.primary_phoneNo, "") AS primary_phoneNo, 
                                COALESCE(dr.language, "") AS language, COALESCE(dr.vehicle_number, "") AS vehicle_number, COALESCE(dr.car_color, "") AS car_color, 
                                COALESCE(dr.passenger_capacity, "") AS passenger_capacity, COALESCE(GROUP_CONCAT(DISTINCT vr.name SEPARATOR ','), '') AS prefrence_name,
                                COALESCE(dr.date, "") AS join_date, COALESCE(dr.latitude, "") AS latitude, COALESCE(dr.longitude, "") AS longitude, COALESCE(vec.map_img, "") AS map_img, 
                                COALESCE(vec.name, "") AS car_name
                                ${dr.tot_review} ${dr.avgstar}, COALESCE(COUNT(DISTINCT ov.id), 0) AS tot_complete_order
                                FROM tbl_cart_vehicle AS cve
                                JOIN tbl_driver AS dr ON cve.d_id = dr.id
                                JOIN tbl_vehicle AS vec ON dr.vehicle = vec.id
                                LEFT JOIN tbl_vehicle_preference AS vr ON FIND_IN_SET(vr.id, dr.vehicle_prefrence) > 0
                                LEFT JOIN tbl_order_vehicle AS ov ON cve.d_id = ov.d_id AND ov.status = '8'
                                ${dr.table}
                                WHERE ${request_id != "" ? `(cve.id = '${request_id}' OR cve.req_id = '${request_id}') AND` : ``}  cve.c_id = '${uid}' AND cve.d_id = '${d_id}' GROUP BY cve.id`;

        for (let attempt = 1; attempt <= 5; attempt++) {
            rd = await DataFind(query);
            if (rd != "") {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        
        if (rd != "") {
            rd[0].rating = parseFloat(rd[0].avg_star); rd[0].tot_review = parseFloat(rd[0].tot_review);
            delete rd[0].avg_star

            // Calculate dynamic remaining/elapsed wait or trip time
            let run_time = { hour: 0, minute: 0, second: 0, status: 0 };
            if (rd[0].current_run_time && rd[0].current_run_time != "") {
                run_time = await AllFunction.TimeDistance(rd[0]);
            } else if (rd[0].status == "3") {
                run_time = await AllFunction.TimeDistance(rd[0]);
            }

            rd[0].tot_hour = run_time.hour;
            rd[0].tot_minute = run_time.minute;
            rd[0].tot_second = run_time.second;
            rd[0].timer_status = run_time.status; // status: 0 -> count up, 1 -> count down, etc.

            const general = await DataFind(`SELECT * FROM tbl_general_settings`);
            let wait_time = general[0].driver_wait_time;
            if (rd[0].m_role == '2') wait_time = general[0].out_no_min_free_wait;
            else if (rd[0].m_role == '3') wait_time = general[0].ren_no_min_free_wait;
            else if (rd[0].m_role == '4') wait_time = general[0].pack_no_min_free_wait;

            rd[0].pickuptime = wait_time;

            return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Driver Data Load Successful', accepted_d_detail:rd[0] });                     
        } else {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Data Not Found!', accepted_d_detail:[] });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})



// ============= Driver Profile Detail ================ //

router.post("/driver_profile_detail", async(req, res)=>{
    try {
        const {d_id} = req.body;
        if(!d_id) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' });

        let dr = await AllFunction.DriverReview("dr");
        let rd = await DataFind(`SELECT dr.profile_image, dr.vehicle_image, dr.first_name, dr.last_name, dr.primary_ccode, dr.primary_phoneNo, dr.language, dr.vehicle_number, dr.car_color,
                                dr.passenger_capacity, dr.date AS join_date, 
                                COALESCE(GROUP_CONCAT(DISTINCT vr.name SEPARATOR ','), '') AS prefrence_name, COALESCE(GROUP_CONCAT(DISTINCT vr.image SEPARATOR ','), '') AS prefrence_image, COALESCE(vec.name, "") AS car_name
                                ${dr.tot_review} ${dr.avgstar}, COALESCE(COUNT(DISTINCT ov.id), 0) AS tot_complete_order
                                FROM tbl_driver AS dr
                                JOIN tbl_vehicle AS vec ON dr.vehicle = vec.id
                                LEFT JOIN tbl_vehicle_preference AS vr ON FIND_IN_SET(vr.id, dr.vehicle_prefrence) > 0
                                LEFT JOIN tbl_order_vehicle AS ov ON ov.d_id = dr.id AND ov.status = '8'
                                ${dr.outtable}
                                WHERE dr.id = '${d_id}' GROUP BY dr.id`);
        
        if (rd != "") {
            rd[0].rating = parseFloat(rd[0].avg_star); rd[0].tot_review = parseFloat(rd[0].tot_review);
            delete rd[0].avg_star
            return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Driver Data Load Successful', d_detail:rd[0] });                     
        } else {
            return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Data Not Found!', d_detail:[] });              
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})



// ============= Complete Ride ================ //

router.post("/vehicle_ride_complete", upload.single('payment_img'), async(req, res)=>{
    try {
        const {uid, d_id, request_id, wallet, payment_id} = req.body;
        if(!uid || !d_id || !request_id || !wallet) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
        const rd = await DataFind(`SELECT * FROM tbl_cart_vehicle WHERE (id = '${request_id}' OR req_id = '${request_id}') AND c_id = '${uid}' AND d_id = '${d_id}'`);
        if(rd.length == 0) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Request Not Found!'});
        const dr = await DataFind(`SELECT * FROM tbl_driver WHERE id = '${rd[0].d_id}'`);
        if(dr.length == 0) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Request Not Found!'});
        if(parseFloat(rd[0].status) < 7) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Please Complete Other Step!'});
        const customer = await DataFind(`SELECT * FROM tbl_customer WHERE status = 1 AND id = '${uid}'`);
        if(customer == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Customer not found!'});
        let setime = rd[0].status_time_location.split("&!!"), starttime = "", end_time = "", imageUrl = "", paid_amount = 0, paid_status = 0;
        let stime = setime[0].split("&"), etime = setime[setime.length - 1].split("&");
        let starttimeVal = (stime && stime[1]) ? stime[1] : new Date().toISOString();
        let endtimeVal = (etime && etime[1]) ? etime[1] : new Date().toISOString();
        if (payment_id == "10" || payment_id == "11") {
           if (!req.file) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Please Upload Image!'});
           imageUrl = req.file ? "uploads/payment_proof/" + req.file.filename : null;
        }

        let isAutoApproved = true;
        if (payment_id == "10" || payment_id == "11") {
           const paymentDetail = await DataFind(`SELECT auto_approved FROM tbl_payment_detail WHERE id = '${payment_id}'`);
           isAutoApproved = paymentDetail.length > 0 && paymentDetail[0].auto_approved == 1;
        }
        paid_status = isAutoApproved ? 1 : 0;

        const final_price = parseFloat(rd[0].final_price);
        const platform_fee = parseFloat(rd[0].platform_fee);
        const nwallet_amount = parseFloat((final_price - platform_fee).toFixed(2));
        const wallet_price = parseFloat(Number(wallet).toFixed(2));

        // Server-side validations
        if (wallet_price > parseFloat(customer[0].wallet)) {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Wallet balance is insufficient'});
        }
        if (wallet_price > final_price) {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Wallet amount exceeds final price'});
        }
        if (payment_id) {
            const validPayment = await DataFind(`SELECT * FROM tbl_payment_detail WHERE id = '${payment_id}' AND status = 1`);
            if (validPayment.length == 0) {
                return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Invalid payment method'});
            }
        }

        // Deduct customer wallet if used
        if (wallet_price > 0) {
            let wallet_amount = parseFloat((parseFloat(customer[0].wallet) - wallet_price).toFixed(2));
            if (await DataUpdate(`tbl_customer`, `wallet = '${wallet_amount}'`, `id = '${uid}'`, req.hostname, req.protocol) == -1) {
                return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
            }
        }

        paid_amount = parseFloat((final_price - wallet_price).toFixed(2));

        let cash_collected = 0;
        if (payment_id == "9") {
            cash_collected = paid_amount;
        }

        let tot_cash_increase = 0;
        let payout_wallet_increase = 0;

        if (cash_collected > nwallet_amount) {
            tot_cash_increase = parseFloat((cash_collected - nwallet_amount).toFixed(2));
        } else {
            payout_wallet_increase = parseFloat((nwallet_amount - cash_collected).toFixed(2));
        }

        fulldate = await AllFunction.TodatDate();

        if (isAutoApproved) {
            fullwallet = parseFloat((parseFloat(dr[0].wallet) + nwallet_amount).toFixed(2));
            payout_wallet = parseFloat((parseFloat(dr[0].payout_wallet) + payout_wallet_increase).toFixed(2));
            tot_cash = parseFloat((parseFloat(dr[0].tot_cash) + tot_cash_increase).toFixed(2));
        } else {
            fullwallet = parseFloat(dr[0].wallet);
            payout_wallet = parseFloat(dr[0].payout_wallet);
            tot_cash = parseFloat(dr[0].tot_cash);
        }
        if (await DataUpdate(`tbl_driver`,`wallet = '${fullwallet}', payout_wallet = '${payout_wallet}', tot_cash = '${tot_cash}', rid_status = '0', check_status = '0'`,
            `id = '${rd[0].d_id}'`, req.hostname, req.protocol) == -1) {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
        }
        const packd = typeof rd[0].package_details == "string" ? JSON.parse(rd[0].package_details) : rd[0].package_details;
        const jzone = typeof rd[0].zone == "string" ? JSON.parse(rd[0].zone) : rd[0].zone;
        let updatet = rd[0].status_time_location != "" ? `${rd[0].status_time_location}&!!8&${fulldate.date}T${fulldate.time}&0&0` :
                        `8&${fulldate.date}T${fulldate.time}&0&0`;
        let insertid = await DataInsert(`tbl_order_vehicle`, `c_id, d_id, vehicleid, bidding_status, bidd_auto_status, status, m_role, paid_status, price, final_price, paid_amount,
            bid_addjust_amount, km_charge, additional_time, addi_time_price, platform_fee, weather_price, coupon_id, coupon_amount, wallet_price, extra_charge, extra_person_charge, day_charge, rent_hour,
            rental_addi_ride_time, rental_addi_ride_charge, rental_hour_charge, rental_per_hour_discount, rental_extra_km,
            rental_extra_km_charge, tot_kg, kg_charge, payment_id, tot_km, tot_hour, tot_minute, package_details, zone, ride_status, start_time, end_time, drop_tot, drop_complete,
            current_run_time, status_time, status_time_location, status_calculation, pic_lat_long, drop_lat_long, pic_address, drop_address, payment_img, cancel_reason,
            outs_category_id, mod_cate_id, num_passenger, book_date, book_time, req_id`,
            `'${rd[0].c_id}', '${rd[0].d_id}', '${rd[0].vehicleid}', '${rd[0].bidding_status}', '${rd[0].bidd_auto_status}', '8', '${rd[0].m_role}', '${paid_status}', '${rd[0].price}',
            '${rd[0].final_price}', '${paid_amount}', '${rd[0].bid_addjust_amount}', '${rd[0].km_charge}', '${rd[0].additional_time}', '${rd[0].addi_time_price}', '${rd[0].platform_fee}',
            '${rd[0].weather_price}', '${rd[0].coupon_id}', '${rd[0].coupon_amount}', '${wallet}', '${rd[0].extra_charge}', '${rd[0].extra_person_charge}', '${rd[0].day_charge}', '${rd[0].rent_hour}', '${rd[0].rental_addi_ride_time}',
            '${rd[0].rental_addi_ride_charge}', '${rd[0].rental_hour_charge}',
            '${rd[0].rental_per_hour_discount}', '${rd[0].rental_extra_km}', '${rd[0].rental_extra_km_charge}', '${rd[0].tot_kg}', '${rd[0].kg_charge}', '${payment_id || rd[0].payment_id}',
            '${rd[0].tot_km}', '${rd[0].tot_hour}', '${rd[0].tot_minute}', '${JSON.stringify(packd)}', '${JSON.stringify(jzone)}', '${rd[0].ride_status}', '${starttimeVal}', '${endtimeVal}',
            '${rd[0].drop_tot}', '${rd[0].drop_complete}', '${rd[0].current_run_time}', '${rd[0].status_time}', '${updatet}', '${rd[0].status_calculation}', '${rd[0].pic_lat_long}',
            '${rd[0].drop_lat_long}', ${mysql.escape(rd[0].pic_address)}, ${mysql.escape(rd[0].drop_address)}, '${imageUrl}', '', '${rd[0].outs_category_id}', '${rd[0].mod_cate_id}', '${rd[0].num_passenger}', '${rd[0].book_date}',
            '${rd[0].book_time}', '${rd[0].req_id}'`, req.hostname, req.protocol);
        if (insertid == -1) return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
        if (await DataDelete(`tbl_cart_vehicle`, `id = '${rd[0].id}'`, req.hostname, req.protocol) == -1) {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
        }
        if (parseFloat(wallet) != 0) {
            if (await DataInsert(`tbl_transaction_customer`, `c_id, payment_id, amount, date, status, type`,
                `${uid}, '${rd[0].payment_id}', '${wallet}', '${fulldate.date}T${fulldate.time}', '2', '${insertid.insertId}'`, req.hostname, req.protocol) == -1) {
                return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
            }
        }
        if (isAutoApproved) {
            if (await DataInsert(`tbl_transaction_driver`, `d_id, payment_id, amount, date, status, type`,
                `${rd[0].d_id}, '${insertid.insertId}', '${Number((nwallet_amount).toFixed(2))}', '${fulldate.date}T${fulldate.time}', '1', ''`, req.hostname, req.protocol) == -1) {
                return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
            }
        }
        // Chat
        const chat = await DataFind(`SELECT * FROM tbl_chat
                                WHERE (sender_id = '${rd[0].c_id}' AND resiver_id = '${rd[0].d_id}') OR (sender_id = '${rd[0].d_id}' AND resiver_id = '${rd[0].c_id}')`);
        for (let i = 0; i < chat.length;) {
            const emessage = mysql.escape(chat[i].message);
            if (await DataInsert(`tbl_chat_save`, `sender_id, resiver_id, date, message`, `'${chat[i].sender_id}', '${chat[i].resiver_id}', '${chat[i].date}', ${emessage}`, req.hostname, req.protocol) == -1) {
                return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
            }
            i++
        }
        if (await DataDelete(`tbl_chat`, `(sender_id = '${rd[0].c_id}' AND resiver_id = '${rd[0].d_id}') OR (sender_id = '${rd[0].d_id}' AND resiver_id = '${rd[0].c_id}')`, req.hostname, req.protocol) == -1) {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
        }
        const review_list = await DataFind(`SELECT * FROM tbl_ride_review_reason WHERE status = '1'`);
        console.log(111);

        // Notify customer's other sessions (mobile app) about ride completion via socket
        try {
            const io = req.app.get("io");
            if (io) {
                io.to("user_" + uid).emit(`Vehicle_Ride_Complete_Client${uid}`, {
                    request_id: rd[0].id,
                    d_id: rd[0].d_id,
                    order_id: insertid.insertId
                });
                // Also notify the driver about ride completion
                io.to("user_" + rd[0].d_id).emit(`Vehicle_Ride_Complete${rd[0].d_id}`, {
                    request_id: insertid.insertId,
                    d_id: rd[0].d_id
                });
            }
        } catch (socketErr) {
            console.error("Error emitting ride complete socket event:", socketErr);
        }

        return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Ride Complete Successful', request_id:insertid.insertId, review_list});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

router.post("/tbl_review", async(req, res)=>{
    try {
        const {uid, d_id, request_id, def_review, review, tot_star} = req.body;
        if(!uid || !d_id || !request_id || !tot_star) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' });

        const rd = await DataFind(`SELECT * FROM tbl_order_vehicle WHERE id = '${request_id}' AND c_id = '${uid}' AND d_id = '${d_id}'`);
        if(rd == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Request Not Found!'});

        const revi = await DataFind(`SELECT * FROM tbl_review_driver WHERE request_id = '${rd[0].id}' AND customer_id = '${uid}' AND driver_id = '${d_id}'`);
        if(revi != "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Review Found!'});

        let esreview = mysql.escape(review), fulldate = new Date().toISOString();
        if (await DataInsert(`tbl_review_driver`, `driver_id, customer_id, request_id, def_review, review, tot_star, date`,
            `'${d_id}', '${uid}', '${rd[0].id}', '${def_review}', ${esreview}, '${tot_star}', '${fulldate}'`, req.hostname, req.protocol) == -1) {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
        }

        // Notify customer's other sessions (mobile app) about review submission via socket
        try {
            const io = req.app.get("io");
            if (io) {
                io.to("user_" + uid).emit(`Vehicle_Review_Complete_Client${uid}`, {
                    request_id: rd[0].id,
                    d_id: d_id
                });
            }
        } catch (socketErr) {
            console.error("Error emitting review complete socket event:", socketErr);
        }

        return res.status(200).json({ ResponseCode: 200, Result:true, message: "Review Add Successful"});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});



// ============= All Service Reuqest ================ //

async function JsonConvert(idlist) {
    let d_id_list = []
    if (idlist) {
        if (typeof idlist == "string") {
            d_id_list = JSON.parse(idlist);
        } else d_id_list = idlist
    }
    return {d_id_list}
}

async function AllServiceData(status, where, tblname, field, otp) {
    let data = [];
    if (status == "1") {
        data  = await DataFind(`SELECT cv.id, cv.d_id, cv.price, cv.status, cv.bid_addjust_amount, cv.km_charge, cv.extra_charge, cv.extra_person_charge, cv.day_charge, cv.rent_hour, cv.rental_hour_charge, 
                                cv.rental_per_hour_discount, cv.rental_extra_km, cv.rental_extra_km_charge, cv.tot_kg, cv.kg_charge, cv.tot_hour, cv.tot_minute, 
                                cv.status_time_location, cv.pic_lat_long, cv.drop_lat_long, cv.pic_address, cv.drop_address, cv.m_role, cv.book_date, cv.book_time,
                                CASE
                                    WHEN cv.m_role = '1' THEN 'Vehicle'
                                    ELSE (
                                        SELECT name 
                                        FROM tbl_module_setting 
                                        WHERE (
                                            (cv.m_role = '2' AND id = 1) OR (cv.m_role = '3' AND id = 2) OR (cv.m_role = '4' AND id = 3)
                                        ) 
                                        LIMIT 1
                                    )
                                END AS mode_title,
                                COALESCE(vd.name, '') AS vehicle_name, COALESCE(pd.name, '') AS p_name, COALESCE(vd.map_img, '') AS map_img
                                FROM ${tblname} AS cv
                                JOIN tbl_payment_detail AS pd ON cv.payment_id = pd.id
                                JOIN tbl_vehicle AS vd ON cv.vehicleid = vd.id
                                ${where} ORDER BY id DESC`);
    } else {
        let dr = await AllFunction.DriverReview("cv");
        
        data  = await DataFind(`SELECT cv.id, cv.d_id, cv.price, cv.status, cv.price, cv.final_price, cv.paid_amount, cv.bid_addjust_amount, cv.coupon_amount, cv.addi_time_price, cv.platform_fee, 
                                cv.weather_price, cv.wallet_price, cv.km_charge, cv.extra_charge, cv.extra_person_charge, cv.day_charge, cv.rent_hour, cv.rental_addi_ride_time, 
                                cv.rental_addi_ride_charge, cv.rental_hour_charge, cv.rental_per_hour_discount, cv.rental_extra_km, cv.rental_extra_km_charge, cv.tot_kg, cv.kg_charge,
                                cv.additional_time, cv.tot_hour, cv.tot_minute, cv.coupon_id, cv.status_time_location, cv.pic_lat_long, cv.drop_lat_long, cv.pic_address, 
                                cv.drop_address, cv.m_role, cv.book_date, cv.book_time,
                                CASE
                                    WHEN cv.m_role = '1' THEN 'Vehicle'
                                    ELSE (
                                        SELECT name 
                                        FROM tbl_module_setting 
                                        WHERE (
                                            (cv.m_role = '2' AND id = 1) OR (cv.m_role = '3' AND id = 2) OR (cv.m_role = '4' AND id = 3)
                                        ) 
                                        LIMIT 1
                                    )
                                END AS mode_title,
                                cv.current_run_time, COALESCE(vd.name, '') AS vehicle_name, COALESCE(pd.name, '') AS p_name, 
                                COALESCE(dr.profile_image, "") AS profile_image, COALESCE(dr.vehicle_image, "") AS vehicle_image, COALESCE(dr.first_name, "") AS first_name, 
                                COALESCE(dr.last_name, "") AS last_name, COALESCE(dr.primary_ccode, "") AS primary_ccode, COALESCE(dr.primary_phoneNo, "") AS primary_phoneNo, 
                                COALESCE(dr.language, "") AS language, COALESCE(dr.vehicle_number, "") AS vehicle_number, COALESCE(dr.car_color, "") AS car_color
                                ${dr.tot_review}, COALESCE(vd.comission_rate, '') AS comission_rate,
                                COALESCE(vd.comission_type, '') AS comission_type
                                ${dr.avgstar} ${field} ${otp}, COALESCE(dr.latitude, '') AS latitude, COALESCE(dr.longitude, '') AS longitude, COALESCE(vd.map_img, '') AS map_img
                                FROM ${tblname} AS cv
                                LEFT JOIN tbl_payment_detail AS pd ON cv.payment_id = pd.id
                                LEFT JOIN tbl_vehicle AS vd ON cv.vehicleid = vd.id
                                LEFT JOIN tbl_driver AS dr ON cv.d_id = dr.id
                                ${dr.table}
                                ${where} GROUP BY cv.id, vd.name, pd.name, dr.id ORDER BY id DESC`);
    }
    return data
}


// km_charge, extra_charge, extra_person_charge, day_charge, rent_hour, rental_addi_ride_time, rental_addi_ride_charge, rental_hour_charge, rental_per_hour_discount, rental_extra_km,
// rental_extra_km_charge, tot_kg, kg_charge

// c_id, d_id, vehicleid, bidding_d_price, bidding_status, bidd_auto_status, status, m_role, price, paid_amount, km_charge, 
// extra_charge, weather_charge, platform_fee, extra_person_charge, day_charge, rent_hour, rental_hour_charge, rental_per_hour_discount, rental_extra_km, rental_extra_km_charge, 
// tot_kg, kg_charge, coupon_id, coupon_price, payment_id, tot_km, tot_hour, tot_minute, package_details, zone, status_time_location, start_time, pic_lat_long, drop_lat_long, pic_address, 
// drop_address, outs_category_id, mod_cate_id, num_passenger, book_date, book_time

router.post("/all_service_request", async(req, res)=>{
    try {
        const {uid, status} = req.body;
        if(!uid) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' });

        const customer = await DataFind(`SELECT * FROM tbl_customer WHERE id = '${uid}'`);
        if(customer == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Customer Not Found!' });
        
        const general = await DataFind(`SELECT driver_wait_time, offer_expire_time, out_offer_exprie_time_cus, ren_offer_exprie_time_cus, pack_offer_exprie_time_cus FROM tbl_general_settings`);
        if(general == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' });

        let Reuqest_list = [], totrequest = [];

        if (status == "upcoming") {
            let pen_req_request  = await AllServiceData(1, `WHERE cv.c_id = '${uid}' AND (cv.book_date = '' OR cv.book_date IS NULL)`, `tbl_request_vehicle`, 0);

            let first_list = pen_req_request.map(async(val) => {
                let idlist = await JsonConvert(val.d_id);
                val.driver_id_list = idlist ? idlist.d_id_list : []; val.d_id = "0";

                let otherdata = { "final_price": 0, "paid_amount": 0, "coupon_amount": 0, "addi_time_price": 0, "platform_fee": 0, "weather_price": 0, "wallet_price": 0, 
                "additional_time": 0, "coupon_id": "", "rental_addi_ride_time": 0, "rental_addi_ride_charge": 0, "current_run_time": "", "profile_image": "", "vehicle_image": "", 
                "first_name": "", "last_name": "", "primary_ccode": "", "primary_phoneNo": "", "language": "", "vehicle_number": "", "car_color": "", "tot_review": 0, 
                "comission_rate": "", "comission_type": "", "avg_star": 0.0, "otp": "", "latitude": "", "longitude": "", "map_img": val.map_img}
                val = { ...val, ...otherdata};
                return val;
            });
            let flist = await Promise.all(first_list);

            // Filter out expired request searches
            let filteredFlist = [];
            for (let request of flist) {
                if (request.driver_id_list.length === 0) continue; // expired or timed out

                let expireTime = general[0].offer_expire_time;
                if (request.m_role == '2') expireTime = general[0].out_offer_exprie_time_cus;
                else if (request.m_role == '3') expireTime = general[0].ren_offer_exprie_time_cus;
                else if (request.m_role == '4') expireTime = general[0].pack_offer_exprie_time_cus;

                let runtime = await AllFunction.CurrentDatetoOldDateS(request.start_time, expireTime);
                if (runtime > 0) {
                    filteredFlist.push(request);
                }
            }
            flist = filteredFlist;

            let pen_card_request = await AllServiceData(2, `WHERE cv.c_id = '${uid}'`, `tbl_cart_vehicle`, ', cv.driver_id_list', ', cv.otp');

            let secound_list = pen_card_request.map(async(val) => {
                let idlist = await JsonConvert(val.driver_id_list);
                val.driver_id_list = idlist ? idlist.d_id_list : [];
                return val;
            })
            let slist = await Promise.all(secound_list);
            
            totrequest = flist.concat(slist);

        } else if (status == "scheduled") {
            let pen_req_request  = await AllServiceData(1, `WHERE cv.c_id = '${uid}' AND cv.book_date != '' AND cv.status = '0'`, `tbl_request_vehicle`, 0);

            let first_list = pen_req_request.map(async(val) => {
                let idlist = await JsonConvert(val.d_id);
                val.driver_id_list = idlist ? idlist.d_id_list : []; val.d_id = "0";

                let otherdata = { "final_price": 0, "paid_amount": 0, "coupon_amount": 0, "addi_time_price": 0, "platform_fee": 0, "weather_price": 0, "wallet_price": 0, 
                "additional_time": 0, "coupon_id": "", "rental_addi_ride_time": 0, "rental_addi_ride_charge": 0, "current_run_time": "", "profile_image": "", "vehicle_image": "", 
                "first_name": "", "last_name": "", "primary_ccode": "", "primary_phoneNo": "", "language": "", "vehicle_number": "", "car_color": "", "tot_review": 0, 
                "comission_rate": "", "comission_type": "", "avg_star": 0.0, "otp": "", "latitude": "", "longitude": "", "map_img": val.map_img}
                val = { ...val, ...otherdata};
                return val;
            });
            let flist = await Promise.all(first_list);

            // Filter out expired request searches
            let filteredFlist = [];
            for (let request of flist) {
                if (request.driver_id_list.length === 0) continue; // expired or timed out

                let expireTime = general[0].offer_expire_time;
                if (request.m_role == '2') expireTime = general[0].out_offer_exprie_time_cus;
                else if (request.m_role == '3') expireTime = general[0].ren_offer_exprie_time_cus;
                else if (request.m_role == '4') expireTime = general[0].pack_offer_exprie_time_cus;

                let runtime = await AllFunction.CurrentDatetoOldDateS(request.start_time, expireTime);
                if (runtime > 0) {
                    filteredFlist.push(request);
                }
            }
            flist = filteredFlist;
            totrequest = flist;

        } else if (status == "completed") totrequest = await AllServiceData(2, `WHERE cv.c_id = '${uid}' AND cv.status = '8'`, `tbl_order_vehicle`, '', '');
        else if (status == "cancelled") totrequest = await AllServiceData(2, `WHERE cv.c_id = '${uid}' AND cv.status = '4'`, `tbl_order_vehicle`, '', '');

        if (status == "completed" || status == "cancelled") {
            let com_list = totrequest.map(async(val) => {
                val.driver_id_list = []; val.otp = "";
                return val
            })
            let slist = await Promise.all(com_list);
            totrequest = slist
        }

        if (totrequest != "") {
            Reuqest_list = await AllFunction.AllVehicleFormate(totrequest, 1);
            
            return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Data Load Successful', driver_wait_time: parseFloat(general[0].driver_wait_time), Reuqest_list:Reuqest_list});                 
        } else {
            return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Request Not Found!', driver_wait_time: parseFloat(general[0].driver_wait_time), Reuqest_list:[]});              
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


//const { checkedit } = require("../public/js/editor/ckeditor/adapters/check");

router.get("/ride_check", async(req, res)=>{
    try {
        // let date = await checkedit()
        // if (date.c == "1") return res.status(200).json({ ResponseCode: 200, Result: true, message: 'Project delete successful', Successful: date.a, Error:date.b });
        // else return res.status(200).json({ ResponseCode: 401, Result: false, message: 'Project delete Unsuccessful!', Error: date.c });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error', error});
    }
});

// ============= All Ride Detail ================ //

router.post("/all_ride_detail", async(req, res)=>{
    try {
        const {uid, request_id, status} = req.body;
        if(!uid || !request_id || !status) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' });
        let Reuqest_list = [], review_check = 0;

        if (status == "complete") {

            // km_charge, extra_charge, extra_person_charge, day_charge, rent_hour, rental_addi_ride_time, rental_addi_ride_charge, rental_hour_charge, rental_per_hour_discount, 
            // rental_extra_km,
            // rental_extra_km_charge, tot_kg, kg_charge    // g v p s
            

            // c_id, d_id, vehicleid, bidding_status, bidd_auto_status, status, m_role, paid_status, price, final_price, paid_amount, 
            //     km_charge, additional_time, addi_time_price, platform_fee, weather_price, coupon_id, coupon_amount, wallet_price, extra_charge, extra_person_charge, day_charge, rent_hour, 
            //     rental_addi_ride_time, rental_addi_ride_charge, rental_hour_charge, rental_per_hour_discount, rental_extra_km, rental_extra_km_charge, tot_kg, kg_charge, payment_id, 
            //     tot_km, tot_hour, tot_minute, package_details, zone, ride_status, start_time, end_time, drop_tot, drop_complete, current_run_time, status_time, status_time_location, 
            //     status_calculation, pic_lat_long, drop_lat_long, pic_address, drop_address, payment_img, cancel_reason, outs_category_id, mod_cate_id, num_passenger, book_date, 
            //     book_time, req_id

            let mapdata = await DataFind(`SELECT cv.id, cv.c_id, cv.d_id, cv.price, cv.final_price, cv.paid_amount, cv.bid_addjust_amount, cv.coupon_amount, cv.addi_time_price, 
                                            cv.platform_fee, cv.weather_price, cv.wallet_price, cv.additional_time, 
                                            
                                            cv.km_charge, cv.extra_charge, cv.extra_person_charge, cv.day_charge, cv.rent_hour, cv.rental_addi_ride_time, cv.rental_addi_ride_charge, 
                                            cv.rental_hour_charge, cv.rental_per_hour_discount, cv.rental_extra_km, cv.rental_extra_km_charge, cv.tot_kg, cv.kg_charge,

                                            cv.status, cv.tot_km, cv.tot_hour, cv.tot_minute, cv.status_time_location, cv.pic_lat_long, cv.drop_lat_long, 
                                            cv.pic_address, cv.drop_address, cv.m_role, cv.payment_img, cv.payment_id,
                                            CASE
                                                WHEN cv.m_role = '1' THEN 'Vehicle'
                                                ELSE (
                                                    SELECT name 
                                                    FROM tbl_module_setting
                                                    WHERE (
                                                        (cv.m_role = '2' AND id = 1) OR (cv.m_role = '3' AND id = 2) OR (cv.m_role = '4' AND id = 3)
                                                    )
                                                    LIMIT 1
                                                )
                                            END AS mode_title,
                                            cv.coupon_id, COALESCE(vd.name, '') AS vehicle_name, COALESCE(vd.comission_rate, '') AS comission_rate, 
                                            COALESCE(vd.comission_type, '') AS comission_type, COALESCE(dr.profile_image, '') AS profile_image, 
                                            COALESCE(dr.first_name, '') AS first_name, COALESCE(dr.last_name, '') AS last_name, COALESCE(dr.primary_phoneNo, '') AS driver_phone,
                                            COALESCE(pd.image, '') AS p_image, COALESCE(pd.name, '') AS p_name, 
                                            CASE WHEN COUNT(revi.id) > 0 THEN '1' ELSE '0' END AS review_check
                                            FROM tbl_order_vehicle AS cv
                                            LEFT JOIN tbl_driver AS dr ON cv.d_id = dr.id
                                            LEFT JOIN tbl_payment_detail AS pd ON cv.payment_id = pd.id
                                            LEFT JOIN tbl_vehicle AS vd ON cv.vehicleid = vd.id
                                            LEFT JOIN tbl_review_driver AS revi ON cv.d_id = revi.driver_id AND cv.c_id = revi.customer_id AND cv.id = revi.request_id
                                            WHERE cv.id = '${request_id}' AND cv.c_id = '${uid}' AND cv.status NOT IN ('4')
                                            GROUP BY cv.id ORDER BY cv.id DESC;`);
                
            if (mapdata != "") {
                const review = await DataFind(`SELECT * FROM tbl_review_driver WHERE request_id = '${mapdata[0].id}' AND driver_id = '${mapdata[0].d_id}' 
                                                AND customer_id = '${mapdata[0].c_id}'`);

                if (review != "") review_check = 1;
                mapdata[0].c_title = ""; mapdata[0].addi_time = parseFloat(mapdata[0].additional_time);

                mapdata[0].price = parseFloat(mapdata[0].price); mapdata[0].tot_km = parseFloat(mapdata[0].tot_km); mapdata[0].review_check = review_check; mapdata[0].review_check = review_check;
                Reuqest_list = await AllFunction.AllVehicleFormate(mapdata, 2);
    
                delete Reuqest_list[0].tot_drop; delete Reuqest_list[0].comission_rate; delete Reuqest_list[0].comission_type; delete Reuqest_list[0].additional_time;
                return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Data Load Successful', Reuqest_list: Reuqest_list[0]});                 
            } else {
                return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Request Not Found!', Reuqest_list: []});                
            }
        }

        if (status == "cancel") {
            let mapdata = await DataFind(`SELECT cv.id, cv.c_id, cv.d_id, cv.price, cv.final_price, cv.paid_amount, cv.bid_addjust_amount, cv.coupon_amount, cv.addi_time_price, 
                                            cv.platform_fee, cv.weather_price, cv.wallet_price, cv.additional_time, 

                                            cv.km_charge, cv.extra_charge, cv.extra_person_charge, cv.day_charge, cv.rent_hour, cv.rental_addi_ride_time, cv.rental_addi_ride_charge, 
                                            cv.rental_hour_charge, cv.rental_per_hour_discount, cv.rental_extra_km, cv.rental_extra_km_charge, cv.tot_kg, cv.kg_charge,

                                            cv.status, cv.tot_km, cv.tot_hour, cv.tot_minute, cv.status_time_location, cv.pic_lat_long, cv.drop_lat_long, cv.pic_address, 
                                            cv.drop_address, cv.m_role, 
                                            CASE
                                                WHEN cv.m_role = '1' THEN 'Vehicle'
                                                ELSE (
                                                    SELECT name 
                                                    FROM tbl_module_setting 
                                                    WHERE (
                                                        (cv.m_role = '2' AND id = 1) OR (cv.m_role = '3' AND id = 2) OR (cv.m_role = '4' AND id = 3)
                                                    ) 
                                                    LIMIT 1
                                                )
                                            END AS mode_title,
                                            cv.coupon_id, COALESCE(vd.name, '') AS vehicle_name, COALESCE(vd.comission_rate, '') AS comission_rate, 
                                            COALESCE(vd.comission_type, '') AS comission_type, COALESCE(pd.image, '') AS p_image, COALESCE(pd.name, '') AS p_name, 
                                            COALESCE(rcr.title, '') AS c_title, CASE WHEN COUNT(revi.id) > 0 THEN '1' ELSE '0' END AS review_check
                                            FROM tbl_order_vehicle AS cv
                                            LEFT JOIN tbl_payment_detail AS pd ON cv.payment_id = pd.id
                                            LEFT JOIN tbl_vehicle AS vd ON cv.vehicleid = vd.id
                                            LEFT JOIN tbl_ride_cancel_reason AS rcr ON cv.cancel_reason = rcr.id
                                            LEFT JOIN tbl_review_driver AS revi ON cv.d_id = revi.driver_id AND cv.c_id = revi.customer_id AND cv.id = revi.request_id
                                            WHERE cv.id = '${request_id}' AND cv.c_id = '${uid}' AND cv.status IN ('4') GROUP BY cv.id ORDER BY id DESC`);
            
            if (mapdata != "") {
                mapdata[0].price = parseFloat(mapdata[0].price); mapdata[0].tot_km = parseFloat(mapdata[0].tot_km); mapdata[0].addi_time = parseFloat(mapdata[0].additional_time);
                
                mapdata[0].review_check = review_check;
                Reuqest_list = await AllFunction.AllVehicleFormate(mapdata, 2);
    
                delete Reuqest_list[0].tot_drop; delete Reuqest_list[0].comission_rate; delete Reuqest_list[0].comission_type; delete Reuqest_list[0].additional_time;
                return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Data Load Successful', Reuqest_list:Reuqest_list[0]});                 
            } else {
                return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Request Not Found!', Reuqest_list:[]});             
            }
        }

        if (status == "scheduled") {
            let mapdata = await DataFind(`SELECT cv.id, cv.c_id, cv.d_id, cv.price, cv.bid_addjust_amount, cv.km_charge, cv.extra_charge, cv.extra_person_charge, cv.day_charge, 
                                            cv.rent_hour, cv.rental_hour_charge, cv.rental_per_hour_discount, cv.rental_extra_km, cv.rental_extra_km_charge, cv.tot_kg, cv.kg_charge,
                                            cv.status, cv.tot_km, cv.tot_hour, cv.tot_minute, cv.status_time_location, cv.pic_lat_long, cv.drop_lat_long, 
                                            cv.pic_address, cv.drop_address, cv.m_role, cv.book_date, cv.book_time,
                                            cv.platform_fee, cv.weather_charge, cv.coupon_price,
                                            CASE
                                                WHEN cv.m_role = '1' THEN 'Vehicle'
                                                ELSE (
                                                    SELECT name 
                                                    FROM tbl_module_setting
                                                    WHERE (
                                                        (cv.m_role = '2' AND id = 1) OR (cv.m_role = '3' AND id = 2) OR (cv.m_role = '4' AND id = 3)
                                                    )
                                                    LIMIT 1
                                                )
                                            END AS mode_title,
                                            cv.coupon_id, COALESCE(vd.name, '') AS vehicle_name, COALESCE(vd.comission_rate, '') AS comission_rate, 
                                            COALESCE(vd.comission_type, '') AS comission_type, COALESCE(pd.image, '') AS p_image, COALESCE(pd.name, '') AS p_name
                                            FROM tbl_request_vehicle AS cv
                                            LEFT JOIN tbl_payment_detail AS pd ON cv.payment_id = pd.id
                                            LEFT JOIN tbl_vehicle AS vd ON cv.vehicleid = vd.id
                                            WHERE cv.id = '${request_id}' AND cv.c_id = '${uid}' AND cv.status = '0'
                                            GROUP BY cv.id ORDER BY cv.id DESC;`);

            if (mapdata != "") {
                mapdata[0].final_price = mapdata[0].price;
                mapdata[0].paid_amount = 0;
                mapdata[0].coupon_amount = mapdata[0].coupon_price || 0;
                mapdata[0].addi_time_price = 0;
                mapdata[0].platform_fee = mapdata[0].platform_fee || 0;
                mapdata[0].weather_price = mapdata[0].weather_charge || 0;
                mapdata[0].wallet_price = 0;
                mapdata[0].additional_time = 0;
                mapdata[0].profile_image = "";
                mapdata[0].first_name = "";
                mapdata[0].last_name = "";
                mapdata[0].driver_phone = "";
                mapdata[0].c_title = "";
                mapdata[0].addi_time = 0;
                mapdata[0].tot_km = 0;
                mapdata[0].rental_addi_ride_time = 0;
                mapdata[0].rental_addi_ride_charge = 0;

                mapdata[0].price = parseFloat(mapdata[0].price);
                mapdata[0].review_check = 0;
                Reuqest_list = await AllFunction.AllVehicleFormate(mapdata, 2);
    
                let bids = await AllFunction.VehicleBidding([], request_id, 0, 2, mapdata[0].m_role, req.hostname, req.protocol);
                Reuqest_list[0].bidding_list = bids ? (bids.bidding_list || []) : [];

                delete Reuqest_list[0].tot_drop; delete Reuqest_list[0].comission_rate; delete Reuqest_list[0].comission_type; delete Reuqest_list[0].additional_time;
                return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Data Load Successful', Reuqest_list: Reuqest_list[0]});                 
            } else {
                return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Request Not Found!', Reuqest_list: []});                
            }
        }

        return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Request Not Found!', Reuqest_list:[]});     
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post("/ride_additional_detail", async(req, res)=>{
    try {
        const {uid, request_id, status} = req.body;
        if(!uid || !request_id || !status) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong' });
        // status = 1 running ride, 2 - ride details
        let check = [];
        if (status == 1) {
            check = await DataFind(`SELECT id, m_role, book_date, book_time, num_passenger, rent_hour, tot_kg, package_details FROM tbl_cart_vehicle WHERE (id = '${request_id}' OR req_id = '${request_id}') AND c_id = '${uid}'`);
        } else {
            check = await DataFind(`SELECT id, m_role, book_date, book_time, num_passenger, rent_hour, tot_kg, package_details FROM tbl_order_vehicle WHERE (id = '${request_id}' OR req_id = '${request_id}') AND c_id = '${uid}'`);
            if (check == "") {
                check = await DataFind(`SELECT id, m_role, book_date, book_time, num_passenger, rent_hour, tot_kg, package_details FROM tbl_cart_vehicle WHERE (id = '${request_id}' OR req_id = '${request_id}') AND c_id = '${uid}'`);
            }
            if (check == "") {
                check = await DataFind(`SELECT id, m_role, book_date, book_time, num_passenger, rent_hour, tot_kg, package_details FROM tbl_request_vehicle WHERE id = '${request_id}' AND c_id = '${uid}'`);
            }
        }
        if (check == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Request Not Found!' });
        check[0].package_details = typeof check[0].package_details == "string" ? JSON.parse(check[0].package_details) : check[0].package_details;
        return res.status(200).json({ ResponseCode: 200, Result:true, message: "Data load successfully", add_data: check.length > 0 ? check[0] : {} });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})



// ============= Coupon and Payment ================ //

router.get("/coupon_payment", async(req, res)=>{
    try {
        const { service } = req.query;
        let fulldate = await AllFunction.TodatDate();
        let coupon_list = await DataFind(`SELECT * FROM tbl_coupon WHERE start_date <= '${fulldate.date}' AND end_date >= '${fulldate.date}'`);
        
        if (service) {
            coupon_list = coupon_list.filter(cval => {
                const subtitle = cval.sub_title || "";
                const restrictions = subtitle.split("||")[1] || "";
                const restrictedArray = restrictions.split(",").map(r => r.trim());
                return !restrictedArray.includes(service);
            });
        }
        coupon_list.map(cval => {
            let st = new Date(cval.start_date).toISOString().split("T");
            cval.start_date = `${st[0]} ${st[1]}`;

            let en = new Date(cval.end_date).toISOString().split("T");
            cval.end_date = `${en[0]} ${en[1]}`;

            if (cval.sub_title && cval.sub_title.includes("||")) {
                cval.sub_title = cval.sub_title.split("||")[0];
            }
        });
        
        let payment_list = await DataFind(`SELECT * FROM tbl_payment_detail`);

        let spldata = payment_list[10].attribute.split(",");
        let bank_data = [ {bank_name: spldata[0]}, {holder_name: spldata[1]}, {account_no: spldata[2]}, {iafc_code: spldata[3]}, {swift_code: spldata[4]} ];

        const general = await DataFind(`SELECT default_payment FROM tbl_general_settings`);

        return res.status(200).json({ ResponseCode: 200, Result:true, message: "Data Load successful", default_payment:general[0].default_payment, coupon_list, payment_list, bank_data });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
}) 

// ============= Module all data ================ //

router.post("/all_data", async(req, res)=>{
    try {
        const { mrole } = req.body;
        
        if(mrole == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});

        let module_data = []
        if (mrole == "2") module_data = await DataFind(`SELECT * FROM tbl_outstation WHERE status = 1`);

        if (mrole == "3") module_data = await DataFind(`SELECT * FROM tbl_rental WHERE status = 1`);

        if (mrole == "4") module_data = await DataFind(`SELECT * FROM tbl_package`);

        if (module_data != "") return res.status(200).json({ ResponseCode: 200, Result:true, message: "Data Load successful", module_data });
        else return res.status(200).json({ ResponseCode: 401, Result:false, message: "Data not find", module_data });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
}) 

// ============= Module data ================ //

router.post("/module_data", async(req, res)=>{
    try {
        const {mid, mrole} = req.body;
        
        if(mid == "" || mrole == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});

        let module_data = []
        if (mrole == "2") module_data = await DataFind(`SELECT * FROM tbl_outstation WHERE status = 1 AND id = '${mid}'`);

        if (mrole == "3") module_data = await DataFind(`SELECT * FROM tbl_rental WHERE status = 1 AND id = '${mid}'`);

        if (mrole == "4") module_data = await DataFind(`SELECT * FROM tbl_package`);

        if (module_data != "") return res.status(200).json({ ResponseCode: 200, Result:true, message: "Data Load successful", module_data });
        else return res.status(200).json({ ResponseCode: 401, Result:false, message: "Data not find", module_data });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// ============= Add Wallet ================ //

const fs = require('fs');
const path = require('path');

function saveBase64Image(base64Str) {
    if (!base64Str) return null;
    try {
        const matches = base64Str.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        let base64Data = base64Str;
        let ext = '.jpg';
        if (matches && matches.length === 3) {
            const mime = matches[1];
            base64Data = matches[2];
            if (mime === 'image/png') ext = '.png';
            else if (mime === 'image/gif') ext = '.gif';
            else if (mime === 'image/webp') ext = '.webp';
        }
        const buffer = Buffer.from(base64Data, 'base64');
        const filename = "manual_proof_" + Date.now() + Math.floor(Math.random() * 1000) + ext;
        const targetPath = path.join(__dirname, "../public/uploads/payment_proof", filename);
        
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(targetPath, buffer);
        return "uploads/payment_proof/" + filename;
    } catch (e) {
        console.error("saveBase64Image error:", e);
        return null;
    }
}

router.post("/add_wallet", upload.single('payment_img'), async(req, res)=>{
    try {
        const {uid, payment_id, amount, payment_img} = req.body;
        
        const missingField = await AllFunction.CheckBodyData(req, ["uid", "payment_id", "amount"]);   
        if(missingField) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});

        let customer = await DataFind(`SELECT * FROM tbl_customer WHERE status = 1 AND id = '${uid}'`);
        if(customer == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Customer not found!'});

        // Idempotency: Check if a matching pending manual transaction exists within the last 1 minute
        let fulldate = await AllFunction.TodatDate();
        const duplicateCheck = await DataFind(`
            SELECT * FROM tbl_transaction_customer 
            WHERE c_id = '${uid}' AND payment_id = '${payment_id}' AND amount = '${amount}' 
            AND date LIKE '${fulldate.date}%' AND status = '0' LIMIT 1
        `);
        if (duplicateCheck.length > 0) {
            return res.status(200).json({ ResponseCode: 200, Result: true, message: "Duplicate transaction request detected, processing." });
        }

        // Manual bank or QR payment requires proof
        if (payment_id == "10" || payment_id == "11") {
            let proofPath = null;
            if (req.file) {
                proofPath = "uploads/payment_proof/" + req.file.filename;
            } else if (payment_img) {
                proofPath = saveBase64Image(payment_img);
            }

            if (!proofPath) {
                return res.status(200).json({ ResponseCode: 401, Result: false, message: "Payment proof image is required for bank or QR code payments." });
            }

            const paymentDetail = await DataFind(`SELECT auto_approved FROM tbl_payment_detail WHERE id = '${payment_id}'`);
            const isAutoApproved = paymentDetail.length > 0 && paymentDetail[0].auto_approved == 1;

            if (isAutoApproved) {
                // Insert as SUCCESS ('1')
                if (await DataInsert(`tbl_transaction_customer`, `c_id, payment_id, amount, date, status, type, payment_proof`,
                    `${uid}, '${payment_id}', '${amount}', '${fulldate.date}T${fulldate.time}', '1', '', '${proofPath}'`, req.hostname, req.protocol) == -1) {
                    return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
                }
                
                // Credit the customer wallet instantly
                let cdata = customer[0].wallet, wamount = 0;
                if (cdata || cdata != "0" || cdata != "NaN") wamount = cdata;
                let wallet_amount = parseFloat(wamount) + parseFloat(amount);
                if (await DataUpdate(`tbl_customer`,` wallet = '${wallet_amount}'`, `id = '${uid}'`, req.hostname, req.protocol) == -1) {
                    return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
                }

                return res.status(200).json({ ResponseCode: 200, Result:true, message: "Wallet Add successful" });
            } else {
                // Insert as PENDING ('0')
                if (await DataInsert(`tbl_transaction_customer`, `c_id, payment_id, amount, date, status, type, payment_proof`,
                    `${uid}, '${payment_id}', '${amount}', '${fulldate.date}T${fulldate.time}', '0', '', '${proofPath}'`, req.hostname, req.protocol) == -1) {
                    return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
                }
                return res.status(200).json({ ResponseCode: 200, Result:true, message: "Payment proof uploaded successfully! Waiting for admin approval." });
            }
        }

        // Online instant payment (directly inserted from apps/callback)
        if (await DataInsert(`tbl_transaction_customer`, `c_id, payment_id, amount, date, status, type`,
            `${uid}, '${payment_id}', '${amount}', '${fulldate.date}T${fulldate.time}', '1', ''`, req.hostname, req.protocol) == -1) {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
        }

        let cdata = customer[0].wallet, wamount = 0;
        if (cdata || cdata != "0" || cdata != "NaN") wamount = cdata;

        let wallet_amount = parseFloat(wamount) + parseFloat(amount);

        if (await DataUpdate(`tbl_customer`,` wallet = '${wallet_amount}'`, `id = '${uid}'`, req.hostname, req.protocol) == -1) {
            return res.status(200).json({ ResponseCode: 401, Result:false, message: process.env.dataerror });
        }

        return res.status(200).json({ ResponseCode: 200, Result:true, message: "Wallet Add successful" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// ============= Wallet Data ================ //

router.post("/wallet", async(req, res)=>{
    try {
        const {uid} = req.body;
        if(!uid) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});

        const customer = await DataFind(`SELECT * FROM tbl_customer WHERE status = 1 AND id = '${uid}'`);
        if(customer == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Customer not found!'});

        let wallet_data = await DataFind(`SELECT dt.*, COALESCE(pd.name, '') AS pname
                                        FROM tbl_transaction_customer AS dt
                                        LEFT JOIN tbl_payment_detail AS pd ON dt.payment_id = pd.id
                                        WHERE dt.c_id = '${uid}' AND (dt.payment_id = '0' OR pd.wallet_status = '1' OR dt.status IN ('1', '2'))
                                        ORDER BY dt.id DESC`);

        let wdata =  wallet_data.map(async(wval) => {
            const date = new Date(wval.date);
            const formattedDate = date.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
            wval.date = formattedDate;
            if (wval.payment_id == "0") {
                if (wval.type && wval.type.includes("Manual Adjustment")) {
                    let adminInfo = "Admin";
                    let match = wval.type.match(/Added by ([^)]+)/);
                    if (match) {
                        adminInfo = match[1];
                    }
                    if (wval.status == "1") {
                        wval.pname = `Admin Credited (by ${adminInfo})`;
                    } else if (wval.status == "2") {
                        wval.pname = `Admin Debited (by ${adminInfo})`;
                    } else {
                        wval.pname = "Admin Adjusted";
                    }
                } else {
                    wval.pname = "Referred";
                }
            }
            return wval;
        });
        let fulldata = await Promise.all(wdata);

        return res.status(200).json({ ResponseCode: 200, Result:true, message: "Wallet Add successful", wallet_amount:customer[0].wallet, wallet_data:fulldata });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// ============= FAQ Data ================ //

router.get("/faq_data", async(req, res)=>{
    try {
        const faq_list = await DataFind(`SELECT * FROM tbl_list_faq`);

        return res.status(200).json({ ResponseCode: 200, Result:true, message: "Wallet Add successful", faq_list });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// ============= Pages Data ================ //

router.get("/pages_data", async(req, res)=>{
    try {
        const pages_list = await DataFind(`SELECT * FROM tbl_list_pages`);

        return res.status(200).json({ ResponseCode: 200, Result:true, message: "Pages load successfully", pages_list });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// ============= Refer And Earn Data ================ // 

router.post("/refer_and_earn", async(req, res)=>{
    try {
        const {uid} = req.body;
        if(!uid) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});

        const customer = await DataFind(`SELECT id, referral_code FROM tbl_customer WHERE id = '${uid}'`);
        const general = await DataFind(`SELECT refer_credit, signup_credit FROM tbl_general_settings`);

        if (customer != "" || general != "") {
            let refer_data = { referral_code:customer[0].referral_code, refer_credit:general[0].refer_credit, signup_credit:general[0].signup_credit }
            return res.status(200).json({ ResponseCode: 200, Result:true, message: "Data Load successful", refer_data });
        } else return res.status(200).json({ ResponseCode: 200, Result:true, message: "Data Not Found!", refer_data: {referral_code: "", refer_credit: "", signup_credit: ""}});

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// ============= Notification Data ================ // 

router.post("/notification", async(req, res)=>{
    try {
        const {uid} = req.body;
        if(!uid) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});

        const ndata = await DataFind(`SELECT noti.id, noti.image, noti.title, noti.description, noti.date
                                        FROM tbl_send_notification AS noti
                                        LEFT JOIN tbl_customer AS cus ON noti.customer = cus.id
                                        WHERE noti.customer = 'All' OR cus.id = '${uid}' ORDER BY noti.id DESC`);

        ndata.map(val => {
            const date = new Date(val.date);
            const formattedDate = date.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
            val.date = formattedDate;
            return val;
        });
        
        return res.status(200).json({ ResponseCode: 200, Result:true, message: "Data Not Found!", ndata});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// ============= Account Deactive ================ // 

router.post("/account_deactive", async(req, res)=>{
    try {
        const {id} = req.body;

        const driver_list = await DataFind(`SELECT id FROM tbl_customer WHERE id = '${id}'`);      
        if (driver_list == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'ID Not Found!'});

        if (await DataUpdate(`tbl_customer`, `status = '0'`, `id = '${id}'`, req.hostname, req.protocol) == -1) {
    
            req.flash('errors', process.env.dataerror);
            return res.redirect("/valid_license");
        }
        
        return res.status(200).json({ ResponseCode: 200, Result:true, message: "Account Deactivate Successful" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})

router.post("/generate_tracking_link", async(req, res)=>{
    try {
        const { request_id } = req.body;
        if (!request_id) return res.status(200).json({ ResponseCode: 401, Result: false, message: 'Request ID Not Found!' });
        
        const crypto = require("crypto");
        const SECRET = "zippygo_public_tracking_secret_12345!";
        
        // Expire in 60 minutes
        const expiresAt = Date.now() + 60 * 60000;
        const payload = JSON.stringify({ requestId: request_id, expiresAt });
        const encodedPayload = Buffer.from(payload).toString("base64");
        const signature = crypto.createHmac("sha256", SECRET).update(encodedPayload).digest("hex");
        const token = `${encodedPayload}.${signature}`;
        
        const host = req.get('host');
        const protocol = req.protocol;
        const tracking_url = `${protocol}://${host}/public/track/${token}`;
        
        return res.status(200).json({ ResponseCode: 200, Result: true, tracking_url });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
})


module.exports = router;