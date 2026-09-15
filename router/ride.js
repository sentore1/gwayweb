/* jshint esversion: 6 */
/* jshint esversion: 8 */
/* jshint node: true */



const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const { DataFind, DataInsert, DataUpdate, DataDelete } = require("../middleware/databse_query");
const AllFunction = require("../route_function/function");

async function StatusTimeTitle(status, lan) {
    let ttitle = ''
    if (status == "0") ttitle = `${lan.New} ${lan.Ride} ${lan.Request}`;
    else if (status == "1") ttitle = `${lan.Accepted}`;
    else if (status == "2") ttitle = `${lan.Arrived_at_the_location}`;
    else if (status == "3") ttitle = `${lan.Confirm} ${lan.Ride}`;
    else if (status == "4") ttitle = `${lan.Canceled}`;
    else if (status == "5") ttitle = `${lan.Ride} ${lan.Start}`;
    else if (status == "6") ttitle = `${lan.Ride} ${lan.End}`;
    else if (status == "7") ttitle = `${lan.Waiting} ${lan.Payment}`;
    else if (status == "8") ttitle = `${lan.Complete}`;
    return ttitle
}

router.get("/new", auth, auth, async(req, res)=>{
    try {
        // Query expiration limits from general settings (defaults to 10 and 15)
        const general = await DataFind("SELECT immediate_request_expire_minutes, scheduled_request_expire_minutes FROM tbl_general_settings LIMIT 1");
        const immediateExpireLimit = (general.length > 0 && general[0].immediate_request_expire_minutes !== null) ? parseInt(general[0].immediate_request_expire_minutes) : 10;
        const scheduledExpireLimit = (general.length > 0 && general[0].scheduled_request_expire_minutes !== null) ? parseInt(general[0].scheduled_request_expire_minutes) : 15;

        // Auto-cleanup expired ride requests
        const now = new Date();
        const parseSafeDate = (dateStr) => {
            if (!dateStr) return null;
            let d = new Date(dateStr);
            if (!isNaN(d.getTime())) return d;
            
            const parts = dateStr.split(/[\sT]/);
            if (parts.length >= 2) {
                const dateParts = parts[0].split('-');
                const timeParts = parts[1].split(':');
                if (dateParts.length === 3 && timeParts.length >= 2) {
                    return new Date(
                        parseInt(dateParts[0]),
                        parseInt(dateParts[1]) - 1,
                        parseInt(dateParts[2]),
                        parseInt(timeParts[0]),
                        parseInt(timeParts[1]),
                        timeParts[2] ? parseInt(timeParts[2]) : 0
                    );
                }
            }
            return null;
        };

        const allRides = await DataFind("SELECT id, start_time, book_date, book_time FROM tbl_request_vehicle");
        for (const ride of allRides) {
            let isExpired = false;
            if (ride.book_date && ride.book_date !== '') {
                // Scheduled ride (parse parts safely to support single-digits or varying formats)
                const dateParts = ride.book_date.split('-');
                const timeParts = (ride.book_time || '00:00').split(':');
                if (dateParts.length === 3 && timeParts.length >= 2) {
                    const rideTime = new Date(
                        parseInt(dateParts[0]),
                        parseInt(dateParts[1]) - 1,
                        parseInt(dateParts[2]),
                        parseInt(timeParts[0]),
                        parseInt(timeParts[1]),
                        timeParts[2] ? parseInt(timeParts[2]) : 0
                    );
                    if (!isNaN(rideTime.getTime())) {
                        const diffMins = (now - rideTime) / (1000 * 60);
                        if (diffMins > scheduledExpireLimit) {
                            isExpired = true;
                        }
                    }
                } else {
                    isExpired = true;
                }
            } else if (ride.start_time && ride.start_time !== '') {
                // Immediate/on-demand ride
                const rideTime = parseSafeDate(ride.start_time);
                if (rideTime) {
                    const diffMins = (now - rideTime) / (1000 * 60);
                    if (diffMins > immediateExpireLimit) {
                        isExpired = true;
                    }
                } else {
                    isExpired = true;
                }
            } else {
                // Garbage/corrupt data
                isExpired = true;
            }

            if (isExpired) {
                await DataDelete("tbl_request_vehicle", `id = '${ride.id}'`);
            }
        }

        const rd = await DataFind(`SELECT cv.id, cv.c_id, cv.d_id, cv.price, cv.pic_address, cv.drop_address, cv.id AS req_id,
                                    COALESCE(cus.name, '') AS cname,
                                    CASE
                                    WHEN cv.m_role = '1' THEN 'Vehicle'
                                    ELSE (
                                        SELECT name 
                                        FROM tbl_module_setting 
                                        WHERE (
                                            (cv.m_role = '2' AND id = 1) 
                                         OR (cv.m_role = '3' AND id = 2) 
                                         OR (cv.m_role = '4' AND id = 3)
                                        ) 
                                        LIMIT 1
                                    )
                                    END AS mode_title
                                    FROM tbl_request_vehicle AS cv
                                    LEFT JOIN tbl_customer AS cus ON cv.c_id = cus.id
                                    ORDER BY cv.id DESC`);

        const crypto = require("crypto");
        const SECRET = "zippygo_public_tracking_secret_12345!";
        let rides = rd.map(async(rval) => {
            let RideAddress = await AllFunction.RideAddress(rval, 2);
            rval.pic_address = RideAddress.piclatlon.title;
            rval.drop_address = RideAddress.dropdata[0].title;
            
            // Generate public tracking token
            const payload = JSON.stringify({ requestId: rval.req_id || rval.id });
            const encodedPayload = Buffer.from(payload).toString("base64");
            const signature = crypto.createHmac("sha256", SECRET).update(encodedPayload).digest("hex");
            rval.tracking_token = `${encodedPayload}.${signature}`;

            return rval;
        })
        const user_data = await Promise.all(rides);

        res.render("ride_new_list", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd:user_data
        });
    } catch (error) {
        console.log(error);
    }
})

async function NewRideDataFind(id, lan) {

    // c_id, d_id, vehicleid, bidding_d_price, bidding_status, bidd_auto_status, status, m_role, price, paid_amount, km_charge, 
    // extra_charge, weather_charge, platform_fee, extra_person_charge, day_charge, rent_hour, rental_hour_charge, rental_per_hour_discount, rental_extra_km, rental_extra_km_charge, 
    // tot_kg, kg_charge, coupon_id, coupon_price, payment_id, tot_km, tot_hour, tot_minute, package_details, zone, status_time_location, start_time, pic_lat_long, drop_lat_long, 
    // pic_address, drop_address, outs_category_id, mod_cate_id, num_passenger, book_date, book_time
    
    // cv.final_price, cv.coupon_amount, cv.platform_fee, cv.weather_price, 
    // (cv.price + cv.addi_time_price + cv.weather_price) AS driver_fee, cv.price AS fprice,

    // cv.km_charge, cv.additional_time, cv.addi_time_price, cv.extra_charge, cv.extra_person_charge, cv.day_charge, cv.rent_hour, cv.rental_addi_ride_time, 
    // cv.rental_addi_ride_charge, cv.rental_hour_charge, cv.rental_per_hour_discount, cv.rental_extra_km, cv.rental_extra_km_charge, cv.tot_kg, cv.kg_charge,

    const rd = await DataFind(`SELECT cv.id, cv.c_id, cv.d_id, cv.price, 0 AS final_price, cv.bid_addjust_amount, cv.tot_km, cv.status, cv.start_time, cv.tot_minute, cv.pic_address, cv.m_role,
                                cv.id AS req_id, cv.drop_address, cv.book_date, cv.book_time, COALESCE(cus.name, '') AS cname, COALESCE(cus.email, '') AS cemail, COALESCE(cus.country_code, '') AS cccode, 
                                COALESCE(cus.phone, '') AS cphone, COALESCE(vei.name, '') AS vehicle_name, COALESCE(pay.name, '') AS pay_name, COUNT(ordl.id) AS tot_order,
                                CASE
                                    WHEN cv.m_role = '1' THEN 'Vehicle'
                                    ELSE (
                                        SELECT name 
                                        FROM tbl_module_setting 
                                        WHERE (
                                            (cv.m_role = '2' AND id = 1) 
                                            OR (cv.m_role = '3' AND id = 2) 
                                            OR (cv.m_role = '4' AND id = 3)
                                        )
                                        LIMIT 1
                                    )
                                    END AS mode_title
                                FROM tbl_request_vehicle AS cv
                                LEFT JOIN tbl_customer AS cus ON cv.c_id = cus.id
                                LEFT JOIN tbl_vehicle AS vei ON cv.vehicleid = vei.id
                                LEFT JOIN tbl_payment_detail AS pay ON cv.payment_id = pay.id
                                LEFT JOIN tbl_order_vehicle AS ordl ON cv.c_id = ordl.c_id
                                WHERE cv.id = '${id}'
                                GROUP BY cv.id, cv.c_id, cv.d_id, cv.price, cv.tot_km, cv.status, cv.start_time, cv.tot_minute, cv.pic_address, cv.m_role, cv.drop_address, cv.book_date, cv.book_time, cus.name, cus.email, 
                                cus.country_code, cus.phone, vei.name, pay.name
                                ORDER BY cv.id DESC`);

    if (rd != "") {
        let RideAddress = await AllFunction.RideAddress(rd[0], 2);
        rd[0].pic_address = RideAddress.piclatlon;
        rd[0].drop_address = RideAddress.dropdata;

        // Query expiration limits from general settings based on status & role
        let expiry_time = null;
        if (rd[0].status == '0') {
            let expire_limit = 140; // Default fallback
            const generalSettings = await DataFind("SELECT offer_expire_time, out_offer_exprie_time_cus, ren_offer_exprie_time_cus, pack_offer_exprie_time_cus FROM tbl_general_settings LIMIT 1");
            if (generalSettings.length > 0) {
                if (rd[0].m_role == '1') expire_limit = parseFloat(generalSettings[0].offer_expire_time || 140);
                else if (rd[0].m_role == '2') expire_limit = parseFloat(generalSettings[0].out_offer_exprie_time_cus || 60);
                else if (rd[0].m_role == '3') expire_limit = parseFloat(generalSettings[0].ren_offer_exprie_time_cus || 100);
                else if (rd[0].m_role == '4') expire_limit = parseFloat(generalSettings[0].pack_offer_exprie_time_cus || 60);
            }
            if (rd[0].start_time && rd[0].start_time !== '') {
                let rideTime = new Date(rd[0].start_time);
                if (!isNaN(rideTime.getTime())) {
                    expiry_time = new Date(rideTime.getTime() + expire_limit * 1000).toISOString();
                }
            }
        }
        rd[0].expiry_time = expiry_time;

        let original_start_time_iso = '';
        if (rd[0].start_time != '' ) {
            let date = new Date(rd[0].start_time);
            if (!isNaN(date.getTime())) {
                original_start_time_iso = date.toISOString();
            }
            const formattedDate = date.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
            rd[0].start_time = formattedDate;
        }
        rd[0].end_time = '-';
        rd[0].status_time = rd[0].tot_minute;
        
        rd[0].platform_fee = 0;
        rd[0].driver_fee = 0;
        rd[0].bidding_status = 0;
        rd[0].drop_complete = '';

        let firsttime = []

        if (original_start_time_iso !== '') {
            const formattedDate = original_start_time_iso.replace('T', ' ').slice(0, 19);
            let ttitle = await StatusTimeTitle(rd[0].status, lan);
    
            firsttime.push({status:rd[0].status, time:formattedDate, lat:0, lon:0, title:ttitle });
        }

        rd[0].first_stime = firsttime;
        rd[0].second_stime = [];
        
        rd[0].dfname = 'No driver'; rd[0].dlname = 'available'; rd[0].demail = 'No driver available'; rd[0].dpcode = 'No driver'; rd[0].dpnumber = 'available'; rd[0].dscode = 'No driver'; 
        rd[0].dsnumber = 'available';
        
        for (let i = 0; i < RideAddress.dropdata.length;) {
            if (rd[0].drop_complete != "") {
            if (rd[0].drop_complete < i) rd[0].drop_address[i].status = 'border-success';
            if (rd[0].drop_complete == i) rd[0].drop_address[i].status = 'border-warning';
            } else rd[0].drop_address[i].status = '';
            i++;
        }
    } else return false;
    return rd;
}

router.get("/ndetail/:id", auth, auth, async(req, res)=>{
    try {
        const rd = await NewRideDataFind(req.params.id, req.lan.ld);
        
        if (rd == false) {
            req.flash('errors', 'Data not available');
            return res.redirect("back")
        }

        console.log(rd);
        
        res.render("ride_detail", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd:rd[0]
        });
    } catch (error) {
        console.log(error);
    }
})





router.get("/running", auth, auth, async(req, res)=>{
    try {
        const rd = await DataFind(`SELECT cv.id, cv.req_id, cv.c_id, cv.d_id, cv.price, cv.final_price, cv.pic_address, cv.drop_address,
                                    COALESCE(cus.name, '') AS cname, COALESCE(dri.first_name, '') AS dfname, COALESCE(dri.last_name, '') AS dlname,
                                    CASE
                                        WHEN cv.m_role = '1' THEN 'Vehicle'
                                        ELSE (
                                            SELECT name 
                                            FROM tbl_module_setting 
                                            WHERE (
                                                (cv.m_role = '2' AND id = 1) 
                                             OR (cv.m_role = '3' AND id = 2) 
                                             OR (cv.m_role = '4' AND id = 3)
                                            ) 
                                            LIMIT 1
                                        )
                                        END AS mode_title
                                    FROM tbl_cart_vehicle AS cv
                                    LEFT JOIN tbl_customer AS cus ON cv.c_id = cus.id
                                    LEFT JOIN tbl_driver AS dri ON cv.d_id = dri.id 
                                    ORDER BY cv.id DESC`);
        
        const crypto = require("crypto");
        const SECRET = "zippygo_public_tracking_secret_12345!";
        
        let rides = rd.map(async(rval) => {
            let RideAddress = await AllFunction.RideAddress(rval, 2);
            rval.pic_address = RideAddress.piclatlon.title;
            rval.drop_address = RideAddress.dropdata[0].title;
            
            // Generate public tracking token
            const payload = JSON.stringify({ requestId: rval.req_id || rval.id });
            const encodedPayload = Buffer.from(payload).toString("base64");
            const signature = crypto.createHmac("sha256", SECRET).update(encodedPayload).digest("hex");
            rval.tracking_token = `${encodedPayload}.${signature}`;

            return rval;
        })
        const user_data = await Promise.all(rides);

        res.render("ride_running_list", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd:user_data
        });
    } catch (error) {
        console.log(error);
    }
})

async function RunningRideDataFind(id, lan) {
    const rd = await DataFind(`SELECT cv.id, cv.c_id, cv.d_id, cv.price, cv.platform_fee, (cv.price + cv.addi_time_price + cv.weather_price) AS driver_fee, 

                                cv.final_price, cv.bid_addjust_amount, cv.coupon_amount, cv.wallet_price, cv.platform_fee, cv.weather_price, 
                                (cv.price + cv.addi_time_price + cv.weather_price) AS driver_fee, cv.price AS fprice,

                                cv.km_charge, cv.additional_time, cv.addi_time_price, cv.extra_charge, cv.extra_person_charge, cv.day_charge, cv.rent_hour, cv.rental_addi_ride_time, 
                                cv.rental_addi_ride_charge, cv.rental_hour_charge, cv.rental_per_hour_discount, cv.rental_extra_km, cv.rental_extra_km_charge, cv.tot_kg, cv.kg_charge,

                                cv.bidding_status, cv.tot_km, 
                                cv.status, cv.start_time, cv.status_time, cv.drop_complete, cv.status_time_location, cv.pic_address, 
                                cv.drop_address, COALESCE(cus.name, '') AS cname, COALESCE(cus.email, '') AS cemail, COALESCE(cus.country_code, '') AS cccode, COALESCE(cus.phone, '') AS cphone, 
                                COALESCE(dri.first_name, '') AS dfname, COALESCE(dri.last_name, '') AS dlname, COALESCE(dri.email, '') AS demail, COALESCE(dri.primary_ccode, '') AS dpcode,
                                COALESCE(dri.primary_phoneNo, '') AS dpnumber, COALESCE(dri.secound_ccode, '') AS dscode, COALESCE(dri.secound_phoneNo, '') AS dsnumber,
                                COALESCE(vei.name, '') AS vehicle_name, COALESCE(pay.name, '') AS pay_name, COUNT(ordl.id) AS tot_order,
                                COALESCE(vei.min_km_distance, '0') AS min_km_distance, COALESCE(vei.min_km_price, '0') AS min_km_price, COALESCE(vei.after_km_price, '0') AS after_km_price,
                                COALESCE(vei.comission_rate, '0') AS comission_rate, COALESCE(vei.comission_type, '') AS comission_type,
                                CASE
                                    WHEN cv.m_role = '1' THEN 'Vehicle'
                                    ELSE (
                                        SELECT name 
                                        FROM tbl_module_setting 
                                        WHERE (
                                            (cv.m_role = '2' AND id = 1) 
                                            OR (cv.m_role = '3' AND id = 2) 
                                            OR (cv.m_role = '4' AND id = 3)
                                        ) 
                                        LIMIT 1
                                    )
                                    END AS mode_title
                                FROM tbl_cart_vehicle AS cv
                                LEFT JOIN tbl_customer AS cus ON cv.c_id = cus.id
                                LEFT JOIN tbl_driver AS dri ON cv.d_id = dri.id
                                LEFT JOIN tbl_vehicle AS vei ON cv.vehicleid = vei.id
                                LEFT JOIN tbl_payment_detail AS pay ON cv.payment_id = pay.id
                                LEFT JOIN tbl_order_vehicle AS ordl ON cv.c_id = ordl.c_id
                                WHERE cv.id = '${id}'
                                GROUP BY cv.id, cv.c_id, cv.d_id, cv.bidding_status, cv.price, cv.platform_fee, cv.addi_time_price, cv.weather_price, cv.tot_km, cv.status, cv.start_time, 
                                cv.status_time, cv.drop_complete, cv.pic_address, cv.drop_address, cus.name, cus.email, cus.country_code, cus.phone, dri.first_name, dri.last_name, 
                                dri.email, dri.primary_ccode, dri.primary_phoneNo, dri.secound_ccode, dri.secound_phoneNo, vei.name, pay.name,
                                vei.min_km_distance, vei.min_km_price, vei.after_km_price, vei.comission_rate, vei.comission_type
                                ORDER BY cv.id DESC`);

    if (rd != "") {
        let RideAddress = await AllFunction.RideAddress(rd[0], 2);
        rd[0].pic_address = RideAddress.piclatlon;
        rd[0].drop_address = RideAddress.dropdata;
        const raw_start_time = rd[0].start_time;
        let date = new Date(rd[0].start_time);
        const formattedDate = date.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        rd[0].start_time = formattedDate;
        rd[0].end_time = '-';
        rd[0].status_time = await AllFunction.CalculateMinuteToHour(rd[0].status_time.split("&!!")[0].split("&")[2]);

        let trip_start_time = null;
        if (rd[0].status_time_location != '') {
            let spltime = rd[0].status_time_location.split("&!!");
            for (let a = 0; a < spltime.length; a++) {
                let sd = spltime[a].split("&");
                if (sd[0] == "5") {
                    trip_start_time = sd[1];
                    break;
                }
            }
        }
        if (!trip_start_time) {
            trip_start_time = raw_start_time;
        }
        rd[0].trip_start_time = trip_start_time;

        let firsttime = [], condate = [], addcheck = 0, dropcnum = Number(rd[0].drop_complete); 
        if (rd[0].status_time_location != '') {
            let spltime = rd[0].status_time_location.split("&!!");
            
            // for (let a = 0; a < spltime.length;) {
            //     let sd = spltime[a].split("&"), ttitle = '';
            //     const formattedDate = new Date(sd[1]).toISOString().replace('T', ' ').slice(0, 19);

            //     if (sd[0] == "5") {
            //         addcheck++;
            //         ttitle = await StatusTimeTitle(sd[0], lan);
            //         ttitle = `${addcheck} ${ttitle}`;
            //     } else if (sd[0] == "6") ttitle = `${addcheck} ${ttitle}`;
            //     else ttitle = ttitle;

            //     if (a == 0) firsttime.push({status:sd[0], time:formattedDate, lat:sd[2], lon:sd[3], title:ttitle });
            //     else condate.push({status:sd[0], time:formattedDate, title:ttitle });
            //     a++
            // }

            // Order Accepted&&2:48 PM&0&1&!!31, Lajamni Chowk, Mota Varachha, Surat, Gujarat, India, 394101&&2:49 PM&0&1&!!Bardoli Police Station&Near Sardar Baug, Limda Chowk, 171, Station Rd, Talavadi, Bardoli, Gujarat 394601, India&0&0&0

            for (let a = 0; a < spltime.length;) {
                let sd = spltime[a].split("&"), ttitle = '', addtitle = '', addsubtitle = '';
                const formattedDate = new Date(sd[1]).toISOString().replace('T', ' ').slice(0, 19);

                ttitle = await StatusTimeTitle(sd[0], lan);
                
                if (sd[0] == "5" || sd[0] == "6") {
                    addtitle = rd[0].drop_address[addcheck].title
                    addsubtitle = rd[0].drop_address[addcheck].subtitle
                }

                let shown = addcheck
                if (sd[0] == "5") {
                    ttitle = `${shown+1} ${ttitle}`;
                } else if (sd[0] == "6") {
                    addcheck++;
                    ttitle = `${addcheck} ${ttitle}`;
                } else ttitle = ttitle;

                if (a == 0) firsttime.push({status:sd[0], time:formattedDate, lat:sd[2], lon:sd[3], title: ttitle, addtit: addtitle, addubtit: addsubtitle })
                else condate.push({status:sd[0], time:formattedDate, title:ttitle, addtit: addtitle, addubtit: addsubtitle })   
                a++
            }
        }
        rd[0].first_stime = firsttime;
        rd[0].second_stime = condate;

        // console.log(rd[0].first_stime);
        // console.log(rd[0].second_stime);
        
        for (let i = 0; i < RideAddress.dropdata.length;) {
            if (rd[0].drop_complete != "") {
                if (Number(rd[0].drop_complete) > i) rd[0].drop_address[i].status = 'border-success';
                else if (Number(rd[0].drop_complete) == i) rd[0].drop_address[i].status = 'border-warning';
                else rd[0].drop_address[i].status = '';
            } else rd[0].drop_address[i].status = '';
            i++;
        }
    } else return false;
    return rd;
}

router.get("/rdetail/:id", auth, auth, async(req, res)=>{
    try {
        const rd = await RunningRideDataFind(req.params.id, req.lan.ld);
        
        if (rd == false) {
            req.flash('errors', 'Data not available');
            return res.redirect("back")
        }
        
        res.render("ride_detail", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd:rd[0]
        });
    } catch (error) {
        console.log(error);
    }
})



router.get("/completed", auth, auth, async(req, res)=>{
    try {
        const rd = await DataFind(`SELECT cv.id, cv.req_id, cv.c_id, cv.d_id, cv.price, cv.final_price, cv.pic_address, cv.drop_address,
                                    COALESCE(cus.name, '') AS cname, COALESCE(dri.first_name, '') AS dfname, COALESCE(dri.last_name, '') AS dlname,
                                    CASE
                                        WHEN cv.m_role = '1' THEN 'Vehicle'
                                        ELSE (
                                            SELECT name 
                                            FROM tbl_module_setting 
                                            WHERE (
                                                (cv.m_role = '2' AND id = 1) 
                                             OR (cv.m_role = '3' AND id = 2) 
                                             OR (cv.m_role = '4' AND id = 3)
                                            ) 
                                            LIMIT 1
                                        )
                                    END AS mode_title
                                    FROM tbl_order_vehicle AS cv
                                    LEFT JOIN tbl_customer AS cus ON cv.c_id = cus.id
                                    LEFT JOIN tbl_driver AS dri ON cv.d_id = dri.id
                                    WHERE cv.status = '8'
                                    ORDER BY cv.id DESC`);
        
        const crypto = require("crypto");
        const SECRET = "zippygo_public_tracking_secret_12345!";
        let rides = rd.map(async(rval) => {
            let RideAddress = await AllFunction.RideAddress(rval, 2);
            rval.pic_address = RideAddress.piclatlon.title;
            rval.drop_address = RideAddress.dropdata[0].title;
            
            // Generate public tracking token
            const payload = JSON.stringify({ requestId: rval.req_id || rval.id });
            const encodedPayload = Buffer.from(payload).toString("base64");
            const signature = crypto.createHmac("sha256", SECRET).update(encodedPayload).digest("hex");
            rval.tracking_token = `${encodedPayload}.${signature}`;

            return rval;
        })
        const user_data = await Promise.all(rides);

        res.render("ride_complete_list", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd:user_data
        });
    } catch (error) {
        console.log(error);
    }
})

async function CompletedRideDataFind(id, where, lan) {

    // c_id, d_id, vehicleid, bidding_status, bidd_auto_status, status, m_role, paid_status, price, final_price, paid_amount, 
    // km_charge, additional_time, addi_time_price, platform_fee, weather_price, coupon_id, coupon_amount, wallet_price, extra_charge, extra_person_charge, day_charge, rent_hour, 
    // rental_addi_ride_time, rental_addi_ride_charge, rental_hour_charge, rental_per_hour_discount, rental_extra_km, 
    // rental_extra_km_charge, tot_kg, kg_charge, payment_id, tot_km, tot_hour, tot_minute, package_details, zone, ride_status, start_time, end_time, drop_tot, drop_complete, 
    // current_run_time, status_time, status_time_location, status_calculation, pic_lat_long, drop_lat_long, pic_address, drop_address, payment_img, cancel_reason, 
    // outs_category_id, mod_cate_id, num_passenger, book_date, book_time, req_id

    // km_charge, additional_time, extra_charge, extra_person_charge, day_charge, rent_hour, rental_addi_ride_time, rental_addi_ride_charge, rental_hour_charge, 
    // rental_per_hour_discount, rental_extra_km, rental_extra_km_charge, tot_kg, kg_charge

    const rd = await DataFind(`SELECT cv.id, cv.c_id, cv.d_id, cv.price, cv.final_price, cv.bid_addjust_amount, cv.coupon_amount, cv.wallet_price, cv.platform_fee, cv.weather_price, cv.paid_status, cv.m_role,
                                (cv.price + cv.addi_time_price + cv.weather_price) AS driver_fee, cv.price AS fprice,

                                cv.km_charge, cv.additional_time, cv.addi_time_price, cv.extra_charge, cv.extra_person_charge, cv.day_charge, cv.rent_hour, cv.rental_addi_ride_time, 
                                cv.rental_addi_ride_charge, cv.rental_hour_charge, cv.rental_per_hour_discount, cv.rental_extra_km, cv.rental_extra_km_charge, cv.tot_kg, cv.kg_charge,

                                cv.bidding_status, cv.tot_km, cv.status, cv.start_time, cv.end_time, cv.tot_minute, cv.drop_complete, cv.status_time_location, cv.pic_address, 
                                cv.drop_address, cv.payment_img, cv.payment_id, COALESCE(cus.name, '') AS cname, COALESCE(cus.email, '') AS cemail, COALESCE(cus.country_code, '') AS cccode, 
                                COALESCE(cus.phone, '') AS cphone, COALESCE(dri.first_name, '') AS dfname, COALESCE(dri.last_name, '') AS dlname, COALESCE(dri.email, '') AS demail, 
                                COALESCE(dri.primary_ccode, '') AS dpcode, COALESCE(dri.primary_phoneNo, '') AS dpnumber, COALESCE(dri.secound_ccode, '') AS dscode, 
                                COALESCE(dri.secound_phoneNo, '') AS dsnumber, COALESCE(vei.name, '') AS vehicle_name, COALESCE(pay.name, '') AS pay_name, COUNT(*) AS tot_order,
                                COALESCE(vei.min_km_distance, '0') AS min_km_distance, COALESCE(vei.min_km_price, '0') AS min_km_price, COALESCE(vei.after_km_price, '0') AS after_km_price,
                                COALESCE(vei.comission_rate, '0') AS comission_rate, COALESCE(vei.comission_type, '') AS comission_type,
                                CASE
                                    WHEN cv.m_role = '1' THEN 'Vehicle'
                                    ELSE (
                                        SELECT name 
                                        FROM tbl_module_setting 
                                        WHERE (
                                            (cv.m_role = '2' AND id = 1) 
                                         OR (cv.m_role = '3' AND id = 2) 
                                         OR (cv.m_role = '4' AND id = 3)
                                        ) 
                                        LIMIT 1
                                    )
                                    END AS mode_title
                                FROM tbl_order_vehicle AS cv
                                LEFT JOIN tbl_customer AS cus ON cv.c_id = cus.id
                                LEFT JOIN tbl_driver AS dri ON cv.d_id = dri.id
                                LEFT JOIN tbl_vehicle AS vei ON cv.vehicleid = vei.id
                                LEFT JOIN tbl_payment_detail AS pay ON cv.payment_id = pay.id
                                WHERE cv.id = '${id}' ${where}
                                GROUP BY cv.id, cv.c_id, cv.d_id, cv.bidding_status, cv.price, cv.final_price, cv.coupon_amount, cv.addi_time_price, cv.platform_fee, cv.weather_price, cv.m_role,
                                cv.tot_km, cv.status, cv.start_time, cv.end_time, cv.tot_minute, cv.drop_complete, cv.pic_address, cv.drop_address, cus.name, cus.email, cus.country_code, 
                                cus.phone, dri.first_name, dri.last_name, dri.email, dri.primary_ccode, dri.primary_phoneNo, dri.secound_ccode, dri.secound_phoneNo, vei.name, pay.name,
                                cv.payment_img, cv.payment_id, vei.min_km_distance, vei.min_km_price, vei.after_km_price, vei.comission_rate, vei.comission_type
                                ORDER BY cv.id DESC`);

    if (rd != "") {
        let RideAddress = await AllFunction.RideAddress(rd[0], 2);
        rd[0].pic_address = RideAddress.piclatlon;
        rd[0].drop_address = RideAddress.dropdata;

        let sdate = new Date(rd[0].start_time), edate = new Date(rd[0].end_time);
        const sformattedDate = sdate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        rd[0].start_time = sformattedDate;
        
        const eformattedDate = edate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        rd[0].end_time = eformattedDate;

        let firsttime = [], condate = [], addcheck = 0;
        if (rd[0].status_time_location != '') {
            let spltime = rd[0].status_time_location.split("&!!");
            
            for (let a = 0; a < spltime.length;) {
                let sd = spltime[a].split("&"), ttitle = '', addtitle = '', addsubtitle = '';
                const formattedDate = new Date(sd[1]).toISOString().replace('T', ' ').slice(0, 19);

                ttitle = await StatusTimeTitle(sd[0], lan);
                
                if (sd[0] == "5" || sd[0] == "6") {
                    addtitle = rd[0].drop_address[addcheck].title
                    addsubtitle = rd[0].drop_address[addcheck].subtitle
                }

                let shown = addcheck
                if (sd[0] == "5") {
                    ttitle = `${shown+1} ${ttitle}`;
                } else if (sd[0] == "6") {
                    addcheck++;
                    ttitle = `${addcheck} ${ttitle}`;
                } else ttitle = ttitle;

                
                if (a == 0) firsttime.push({status:sd[0], time:formattedDate, lat:sd[2], lon:sd[3], title: ttitle, addtit: addtitle, addubtit: addsubtitle })
                else condate.push({status:sd[0], time:formattedDate, title:ttitle, addtit: addtitle, addubtit: addsubtitle })   
                a++
            }
        }
        rd[0].first_stime = firsttime;
        rd[0].second_stime = condate;

        for (let i = 0; i < RideAddress.dropdata.length;) {
            if (rd[0].status == "8") {
                rd[0].drop_address[i].status = rd[0].status == '8' ? 'border-success' : '';
            } else {
                if (rd[0].drop_complete != "") {
                    if (rd[0].drop_complete < i) rd[0].drop_address[i].status = 'border-success';
                    if (rd[0].drop_complete == i) rd[0].drop_address[i].status = 'border-warning';
                } else rd[0].drop_address[i].status = '';
            }
            i++;
        }
        
        rd[0].status_time = await AllFunction.CalculateMinuteToHour(rd[0].tot_minute);

    } else return false;
    return rd;
}

router.get("/codetail/:id", auth, auth, async(req, res)=>{
    try {
        const rd = await CompletedRideDataFind(req.params.id, `AND cv.status = '8'`, req.lan.ld);
        
        if (rd == false) {
            req.flash('errors', 'Data not available');
            return res.redirect("back")
        }
        
        res.render("ride_detail", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd:rd[0]
        });
    } catch (error) {
        console.log(error);
    }
})





router.get("/cancelled", auth, auth, async(req, res)=>{
    try {
        const rd = await DataFind(`SELECT cv.id, cv.req_id, cv.c_id, cv.d_id, cv.price, cv.final_price, cv.pic_address, cv.drop_address,
                                    COALESCE(cus.name, '') AS cname, COALESCE(dri.first_name, '') AS dfname, COALESCE(dri.last_name, '') AS dlname,
                                    CASE
                                        WHEN cv.m_role = '1' THEN 'Vehicle'
                                        ELSE (
                                            SELECT name 
                                            FROM tbl_module_setting 
                                            WHERE (
                                                (cv.m_role = '2' AND id = 1) 
                                             OR (cv.m_role = '3' AND id = 2) 
                                             OR (cv.m_role = '4' AND id = 3)
                                            ) 
                                            LIMIT 1
                                        )
                                        END AS mode_title
                                    FROM tbl_order_vehicle AS cv
                                    LEFT JOIN tbl_customer AS cus ON cv.c_id = cus.id
                                    LEFT JOIN tbl_driver AS dri ON cv.d_id = dri.id
                                    WHERE cv.status = '4'
                                    ORDER BY cv.id DESC`);
        
        const crypto = require("crypto");
        const SECRET = "zippygo_public_tracking_secret_12345!";
        let rides = rd.map(async(rval) => {
            let RideAddress = await AllFunction.RideAddress(rval, 2);
            rval.pic_address = RideAddress.piclatlon.title;
            rval.drop_address = RideAddress.dropdata[0].title;
            
            // Generate public tracking token
            const payload = JSON.stringify({ requestId: rval.req_id || rval.id });
            const encodedPayload = Buffer.from(payload).toString("base64");
            const signature = crypto.createHmac("sha256", SECRET).update(encodedPayload).digest("hex");
            rval.tracking_token = `${encodedPayload}.${signature}`;

            return rval;
        })
        const user_data = await Promise.all(rides);

        res.render("ride_cancelled_list", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd:user_data
        });
    } catch (error) {
        console.log(error);
    }
});

router.get("/cadetail/:id", auth, auth, async(req, res)=>{
    try {
        const rd = await CompletedRideDataFind(req.params.id, `AND cv.status = '4'`, req.lan.ld);
        
        if (rd == false) {
            req.flash('errors', 'Data not available');
            return res.redirect("back")
        }
        
        res.render("ride_detail", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd:rd[0]
        });
    } catch (error) {
        console.log(error);
    }
})





router.get("/all", auth, auth, async(req, res)=>{
    try {
        const nrd = await DataFind(`SELECT cv.id, cv.c_id, cv.d_id, cv.price, cv.status, cv.start_time, cv.pic_address, cv.drop_address, cv.id AS req_id,
                                    COALESCE(cus.name, '') AS cname, '' AS dfname, '' AS dlname, 0 AS rides,
                                    CASE
                                        WHEN cv.m_role = '1' THEN 'Vehicle'
                                        ELSE (
                                            SELECT name 
                                            FROM tbl_module_setting 
                                            WHERE (
                                                (cv.m_role = '2' AND id = 1) 
                                             OR (cv.m_role = '3' AND id = 2) 
                                             OR (cv.m_role = '4' AND id = 3)
                                            ) 
                                            LIMIT 1
                                        )
                                        END AS mode_title
                                    FROM tbl_request_vehicle AS cv
                                    LEFT JOIN tbl_customer AS cus ON cv.c_id = cus.id
                                    ORDER BY cv.id DESC`);

        const crd = await DataFind(`SELECT cv.id, cv.c_id, cv.d_id, cv.price, cv.status, cv.start_time, cv.pic_address, cv.drop_address, cv.req_id,
                                    COALESCE(cus.name, '') AS cname, COALESCE(dri.first_name, '') AS dfname, COALESCE(dri.last_name, '') AS dlname, 1 AS rides,
                                    CASE
                                        WHEN cv.m_role = '1' THEN 'Vehicle'
                                        ELSE (
                                            SELECT name 
                                            FROM tbl_module_setting 
                                            WHERE (
                                                (cv.m_role = '2' AND id = 1) 
                                             OR (cv.m_role = '3' AND id = 2) 
                                             OR (cv.m_role = '4' AND id = 3)
                                            ) 
                                            LIMIT 1
                                        )
                                        END AS mode_title
                                    FROM tbl_cart_vehicle AS cv
                                    LEFT JOIN tbl_customer AS cus ON cv.c_id = cus.id
                                    LEFT JOIN tbl_driver AS dri ON cv.d_id = dri.id`);
        
        const rd = await DataFind(`SELECT cv.id, cv.c_id, cv.d_id, cv.price, cv.status, cv.start_time, cv.pic_address, cv.drop_address, cv.req_id,
                                    COALESCE(cus.name, '') AS cname, COALESCE(dri.first_name, '') AS dfname, COALESCE(dri.last_name, '') AS dlname, 2 AS rides,
                                    CASE
                                        WHEN cv.m_role = '1' THEN 'Vehicle'
                                        ELSE (
                                            SELECT name 
                                            FROM tbl_module_setting 
                                            WHERE (
                                                (cv.m_role = '2' AND id = 1) 
                                             OR (cv.m_role = '3' AND id = 2) 
                                             OR (cv.m_role = '4' AND id = 3)
                                            ) 
                                            LIMIT 1
                                        )
                                        END AS mode_title
                                    FROM tbl_order_vehicle AS cv
                                    LEFT JOIN tbl_customer AS cus ON cv.c_id = cus.id
                                    LEFT JOIN tbl_driver AS dri ON cv.d_id = dri.id`);
                                    
        const all = nrd.concat(crd, rd);
        const shorted = all.sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
        
        const { filter } = req.query;
        let filteredRides = shorted;

        if (filter === 'today') {
            const todayStr = new Date().toDateString();
            filteredRides = shorted.filter(r => r.start_time && new Date(r.start_time).toDateString() === todayStr);
        } else if (filter === 'this_week') {
            const now = new Date();
            const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            filteredRides = shorted.filter(r => {
                if (!r.start_time) return false;
                const rdate = new Date(r.start_time);
                return rdate >= oneWeekAgo && rdate <= now;
            });
        } else if (filter === 'completed') {
            filteredRides = shorted.filter(r => (r.status || '').toString() === '8');
        } else if (filter === 'cancelled') {
            filteredRides = shorted.filter(r => (r.status || '').toString() === '4');
        } else if (filter === 'running') {
            filteredRides = shorted.filter(r => ['1', '2', '3', '5', '6'].includes((r.status || '').toString()));
        } else if (filter === 'payment_pending') {
            filteredRides = shorted.filter(r => (r.status || '').toString() === '7');
        }

        const crypto = require("crypto");
        const SECRET = "zippygo_public_tracking_secret_12345!";
        let rides = filteredRides.map(async(rval) => {
            let RideAddress = await AllFunction.RideAddress(rval, 2);
            rval.pic_address = RideAddress.piclatlon.title;
            rval.drop_address = RideAddress.dropdata[0].title;
            
            // Generate public tracking token
            const payload = JSON.stringify({ requestId: rval.req_id || rval.id });
            const encodedPayload = Buffer.from(payload).toString("base64");
            const signature = crypto.createHmac("sha256", SECRET).update(encodedPayload).digest("hex");
            rval.tracking_token = `${encodedPayload}.${signature}`;

            return rval;
        })
        const user_data = await Promise.all(rides);
        
        res.render("ride_all_list", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd:user_data, selectedFilter: filter || ''
        });
    } catch (error) {
        console.log(error);
    }
})

router.get("/alldetail", auth, auth, async(req, res)=>{
    try {
        const {u, c, s} = req.query;
        
        let request = [], sta = 1;
        request = await DataFind(`SELECT id FROM tbl_request_vehicle WHERE id = '${u}' AND c_id = '${c}'`);
        
        if (request == "") {
            request = await DataFind(`SELECT id FROM tbl_cart_vehicle WHERE req_id = '${u}' AND c_id = '${c}'`);
           
            sta = 2;
            if (request == "") {
                request = await DataFind(`SELECT id FROM tbl_order_vehicle WHERE req_id = '${u}' AND c_id = '${c}'`);
                sta = 3;
            } 
            if (request == "") {
                req.flash('errors', 'Data not available');
                return res.redirect("back")
            }
        }
        
        let rd = [];
        if (sta == "1") rd = await NewRideDataFind(u, req.lan.ld);
        else if (sta == "2") rd = await RunningRideDataFind(request[0].id, req.lan.ld);
        else if (sta == "3") {
            rd = await CompletedRideDataFind(request[0].id, '', req.lan.ld);
            
            if (rd != false) {
                if (rd[0].status == "8") rd[0].price = rd[0].final_price;
            }
        }

        if (rd == false) {
            req.flash('errors', 'Data not available');
            return res.redirect("back")
        }

        console.log(rd);
        
        res.render("ride_detail", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd:rd[0]
        });
    } catch (error) {
        console.log(error);
    }
})





router.post("/approve_payment", auth, async(req, res)=>{
    try {
        if (process.env.DISABLE_DB_WRITE === 'true') {
            req.flash('errors', 'For demo purpose we disabled crud operations!!');
            return res.redirect("back");
        }
        const { order_id } = req.body;
        if (!order_id) {
            req.flash('errors', 'Order ID is required.');
            return res.redirect("back");
        }

        const order = await DataFind(`SELECT * FROM tbl_order_vehicle WHERE id = '${order_id}'`);
        if (order.length === 0) {
            req.flash('errors', 'Ride order not found.');
            return res.redirect("back");
        }

        if (order[0].paid_status == '1') {
            req.flash('errors', 'This payment is already approved.');
            return res.redirect("back");
        }

        // 1. Update ride order setting paid_status = '1' and actual paid_amount
        const paid_amount = order[0].final_price - order[0].wallet_price;
        await DataUpdate(`tbl_order_vehicle`, `paid_status = '1', paid_amount = '${paid_amount}'`, `id = '${order_id}'`, req.hostname, req.protocol);

        // 2. Credit driver's wallet for this ride
        const driver = await DataFind(`SELECT * FROM tbl_driver WHERE id = '${order[0].d_id}'`);
        if (driver.length > 0) {
            const nwallet_amount = parseFloat(order[0].final_price) - parseFloat(order[0].platform_fee);
            const payout_wallet = parseFloat(driver[0].payout_wallet) + nwallet_amount;
            const fullwallet = parseFloat(driver[0].wallet) + nwallet_amount;
            
            await DataUpdate(`tbl_driver`, `wallet = '${fullwallet.toFixed(2)}', payout_wallet = '${payout_wallet.toFixed(2)}'`, `id = '${order[0].d_id}'`, req.hostname, req.protocol);
            
            // Insert driver transaction log
            let d = new Date();
            let dateStr = d.toISOString().split('T')[0];
            let timeStr = d.toTimeString().split(' ')[0];
            let fulldate = `${dateStr}T${timeStr}`;
            await DataInsert(`tbl_transaction_driver`, `d_id, payment_id, amount, date, status, type`,
                `${order[0].d_id}, '${order_id}', '${nwallet_amount.toFixed(2)}', '${fulldate}', '1', ''`, req.hostname, req.protocol);
        }

        req.flash('success', 'Ride payment approved successfully! Driver wallet credited.');
        res.redirect("back");
    } catch (error) {
        console.error("approve_payment error:", error);
        req.flash('errors', 'An error occurred while approving ride payment.');
        res.redirect("back");
    }
});

module.exports = router;