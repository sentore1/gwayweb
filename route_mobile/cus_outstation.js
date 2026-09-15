/* jshint esversion: 6 */
/* jshint esversion: 8 */
/* jshint node: true */



const express = require("express");
const router = express.Router();
const multer  = require('multer');
const mysql = require("mysql2");
const bcrypt = require('bcrypt');
const axios = require('axios');
const geolib = require('geolib');
const AllFunction = require("../route_function/function");
const { sendTemplatedNotification } = require("../route_function/notification_helper");
const { DataFind, DataInsert, DataUpdate, DataDelete } = require("../middleware/databse_query");

router.get("/category_detail", async(req, res)=>{
    try {
        const category = await DataFind(`SELECT * FROM tbl_outstation_category ORDER BY id DESC;`);

        return res.status(200).json({ ResponseCode: 200, Result: true, message: 'Detail load successfully', category});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post("/category_detail", async(req, res)=>{
    try {
        const { cat_id } = req.body;

        const missingField = await AllFunction.BodyDataCheck(["cat_id"], req.body);
        if (missingField.status == false) return res.status(200).json({ ResponseCode: 401, Result:false, message: missingField.message });
        
        const outstation = await DataFind(`SELECT id, image, name, bidding, minimum_fare, maximum_fare FROM tbl_outstation_category WHERE outstation_category = '${cat_id}'  AND status = '1' ORDER BY id DESC;`);
        if (outstation == '') return res.status(200).json({ ResponseCode: 401, Result:false, message: "Data Not Found!" });

        return res.status(200).json({ ResponseCode: 200, Result: true, message: 'Detail load successfully', outstation});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post("/outstation_list", async(req, res)=>{
    try {
        const { cat_id } = req.body;

        const missingField = await AllFunction.BodyDataCheck(["cat_id"], req.body);
        if (missingField.status == false) return res.status(200).json({ ResponseCode: 401, Result:false, message: missingField.message });
        
        const outstation = await DataFind(`SELECT id, image, name, bidding, minimum_fare, maximum_fare, tot_passenger AS passenger_capacity FROM tbl_outstation WHERE outstation_category = '${cat_id}'  AND status = '1' ORDER BY id DESC;`);
        if (outstation == '') return res.status(200).json({ ResponseCode: 401, Result:false, message: "Data Not Found!" });

        return res.status(200).json({ ResponseCode: 200, Result: true, message: 'Detail load successfully', outstation});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post("/vehicle_list", async(req, res)=>{
    try {
        const { outs_id } = req.body;

        const missingField = await AllFunction.BodyDataCheck(["outs_id"], req.body);
        if (missingField.status == false) return res.status(200).json({ ResponseCode: 401, Result:false, message: missingField.message });

        const outstation = await DataFind(`SELECT id, vehicle FROM tbl_outstation WHERE id = '${outs_id}' ORDER BY id DESC;`);
        if (outstation == '') return res.status(200).json({ ResponseCode: 401, Result:false, message: "Data Not Found!" });

        const vehicleIds = typeof outstation[0].vehicle == "string" ? JSON.parse(outstation[0].vehicle) : outstation[0].vehicle;
        const vehicle = await DataFind(`SELECT id, image, name, description FROM tbl_vehicle WHERE id IN (${vehicleIds.join(",")}) AND status = '1'`);

        return res.status(200).json({ ResponseCode: 200, Result: true, message: 'Detail load successfully', vehicle});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post("/fare_calculate", async(req, res)=>{
    try {
        const { outs_id, vehicle_id, num_passenger, book_date, pickup_lat_lon, drop_lat_lon, drop_lat_lon_list } = req.body;

        const missingField = await AllFunction.BodyDataCheck(["outs_id", "vehicle_id", "num_passenger", "book_date", "pickup_lat_lon", "drop_lat_lon", "drop_lat_lon_list"], req.body);
        if (missingField.status == false) return res.status(200).json({ ResponseCode: 401, Result:false, message: missingField.message });

        let outsta = await DataFind(`SELECT * FROM tbl_outstation WHERE status = '1' AND id = '${outs_id}'`);
        if(outsta == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Ride details Not Found!'});

        let rcheck = typeof outsta[0].vehicle == "string" ? JSON.parse(outsta[0].vehicle) : outsta[0].vehicle;
        let checkv = rcheck.includes(Number(vehicle_id));
        if (checkv == false) return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Invalid Ride!'});
        
        const coordValid = AllFunction.ValidateCoordinates(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
        if (!coordValid.status) return res.status(200).json({ ResponseCode: 401, Result: false, message: coordValid.message });

        const sameValid = AllFunction.ValidateSameLocations(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
        if (!sameValid.status) return res.status(200).json({ ResponseCode: 401, Result: false, message: sameValid.message });

        let convertzone = await AllFunction.ZoneLatlon(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
        let zonecheck = await AllFunction.CheckZone(convertzone);

        const general = await DataFind(`SELECT id, out_offer_exprie_time_cus, google_map_key, site_currency, weather_price, weather_type, outstation FROM tbl_general_settings`);
        if(general == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
        if(general[0].outstation == 0) {
            let ms = await DataFind(`SELECT id, name FROM tbl_module_setting`);
            return res.status(200).json({ ResponseCode: 401, Result:false, message: `${ms[0].name} Service temporarily unavailable`});
        }

        if (zonecheck[1].zc != 0) return res.status(200).json({ ResponseCode: 401, Result: false, message: AllFunction.GetOutsideZoneMessage(zonecheck)});
        let zoneresult = zonecheck[0].zr;

        let cal = 0, totmin = 0;
        
        for (let c = 1; c < zoneresult.length;) {

            if (zoneresult[c].status == "1") {
                
                let pickup = `${convertzone[c-1].latitude},${convertzone[c-1].longitude}`;
                let drop = `${convertzone[c].latitude},${convertzone[c].longitude}`;
                let distance = await AllFunction.GetDistance(pickup, drop, general[0].google_map_key);

                if (distance.status == 0) {
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
        
        if (cal == "0") return res.status(200).json({ ResponseCode: 401, Result: false, message: 'Fare Not Calculate'});

        let roundkm = Number(Number(cal).toFixed(2)), km_charge = 0, add_distance = 0, tot_price = 0, extra_charge = 0, weather_charge = 0, extra_person_charge = 0, day_charge = 0, site_commission = 0;
        
        if (roundkm <= outsta[0].min_km_distance) {
            
            tot_price = parseFloat(roundkm) * parseFloat(outsta[0].min_km_price);
        } else {
            add_distance = parseFloat(roundkm) - parseFloat(Number(outsta[0].min_km_distance));
            tot_price = (parseFloat(outsta[0].min_km_distance) * parseFloat(outsta[0].min_km_price) + (parseFloat(add_distance) * parseFloat(outsta[0].after_km_price)));
        }
        km_charge = tot_price;

        if (Number(outsta[0].extra_charge) > 0) {
            tot_price = tot_price + Number(outsta[0].extra_charge);
            extra_charge = Number(outsta[0].extra_charge);
        }
        
        if (outsta[0].tot_passenger > 0) {
            if (num_passenger <= outsta[0].tot_passenger) {
                const passp = Number((num_passenger * outsta[0].per_person_price).toFixed(2));
                tot_price = tot_price + passp; extra_person_charge = passp;
            } else return res.status(200).json({ ResponseCode: 401, Result:false, message: `Maximum passenger limit exceeded. Allowed: ${outsta[0].tot_passenger}`});
        }

        const datec = AllFunction.checkDateTypeinOut(book_date);
        if (datec < 0) return res.status(200).json({ ResponseCode: 401, Result:false, message: `Provided date is invalid`});
        // tot_price = datec == 1 ? tot_price + outsta[0].today_price : ( datec == 2 ? tot_price + outsta[0].tomorrow_price : ( datec == 3 ? tot_price + outsta[0].day_after_price : 0) );
        const dcharge = datec == 1 ? outsta[0].today_price : datec == 2 ? outsta[0].tomorrow_price: datec == 3 ? outsta[0].day_after_price : 0;
        tot_price += dcharge; day_charge = dcharge;

        if (outsta[0].whether_charge == "1") {
            if (general[0].weather_type == 'fix') {
                tot_price = tot_price + Number(general[0].weather_price);
                weather_charge = Number(general[0].weather_price);
            } else {
                const weatherp = Number(((tot_price / 100) * Number(general[0].weather_price)).toFixed(2));
                tot_price = tot_price + weatherp; weather_charge = weatherp
            }
        }

        if (outsta[0].comission_type == 'fix') {
            tot_price = tot_price + Number(outsta[0].comission_rate);
            site_commission = Number(outsta[0].comission_rate);
        } else {
            const scom = Number(((tot_price / 100) * Number(outsta[0].comission_rate)).toFixed(2));
            tot_price = tot_price + scom; site_commission = scom;
        }

        let hou_min = await AllFunction.MinuteToHour(totmin), dr_price = Number((tot_price).toFixed(2));
        
        if (outsta[0].bidding == 0) {
            return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Fare calculate successful', offer_expire_time: general[0].out_offer_exprie_time_cus, zoneresult,
                zone: zonecheck[2].zid, tot_km: roundkm, tot_hour: hou_min.hour, tot_minute: hou_min.minute, tot_price:dr_price, km_charge, extra_charge, weather_charge, 
                extra_person_charge, day_charge, site_commission,
                min_km_distance: outsta[0].min_km_distance, min_km_price: outsta[0].min_km_price, after_km_price: outsta[0].after_km_price, per_person_price: outsta[0].per_person_price, comission_rate: outsta[0].comission_rate, comission_type: outsta[0].comission_type,
                weather_price: general[0].weather_price, weather_type: general[0].weather_type, extra_charge_rate: outsta[0].extra_charge });

        } else {
            
            if (Number(outsta[0].minimum_fare) > Number(dr_price)) {
    
                return res.status(200).json({ ResponseCode: 401, Result: false, message: `The fare in this city exceeds our minimum limit of ${general[0].site_currency}${outsta[0].minimum_fare}.` });
    
            } else if (Number(outsta[0].maximum_fare) < Number(dr_price)) {
    
                return res.status(200).json({ ResponseCode: 401, Result: false, message: `The fare in this city exceeds our maximum limit of ${general[0].site_currency}${outsta[0].maximum_fare}.` });
    
            } else {
                
                return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Fare calculate successful', offer_expire_time: general[0].out_offer_exprie_time_cus, 
                zoneresult, zone: zonecheck[2].zid, tot_km: roundkm, tot_hour: hou_min.hour, tot_minute: hou_min.minute, tot_price:dr_price, km_charge, 
                extra_charge, weather_charge, extra_person_charge, day_charge, site_commission,
                min_km_distance: outsta[0].min_km_distance, min_km_price: outsta[0].min_km_price, after_km_price: outsta[0].after_km_price, per_person_price: outsta[0].per_person_price, comission_rate: outsta[0].comission_rate, comission_type: outsta[0].comission_type,
                weather_price: general[0].weather_price, weather_type: general[0].weather_type, extra_charge_rate: outsta[0].extra_charge });
            }
        }
        
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});



router.post("/send_request", async(req, res)=>{
    try {
        console.log("=== /send_request called ===");
        console.log("Request Body:", JSON.stringify(req.body, null, 2));
        let { uid, outs_category_id, outs_id, vehicle_id, num_passenger, book_date, book_time, tot_km, tot_hour, tot_minute, tot_price, bid_addjust_amount, km_charge, extra_charge, 
            weather_charge, extra_person_charge, day_charge, site_commission, payment_id, coupon_id, bidd_status, bidd_auto_status, zone, pickup_lat_lon, drop_lat_lon, 
            drop_lat_lon_list, pickupadd, dropadd, droplistadd
        } = req.body;

        const missingField = await AllFunction.BodyNumberDataCheck(["uid", "outs_category_id", "outs_id", "vehicle_id", "num_passenger", "book_date", "book_time", "tot_km", "tot_hour", 
            "tot_minute", "tot_price", "bid_addjust_amount", "km_charge", "extra_charge", "weather_charge", "extra_person_charge", "day_charge", "site_commission", "bidd_status", 
            "bidd_auto_status", "zone", "pickup_lat_lon", "drop_lat_lon", "pickupadd", "dropadd"], req.body);
        if (missingField.status == false) return res.status(200).json({ ResponseCode: 401, Result:false, message: missingField.message });


        const general = await DataFind(`SELECT id, vehicle_radius, default_payment, outstation FROM tbl_general_settings`);
        
        if(general == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Something went wrong'});
        if(general[0].outstation == 0) {
            let ms = await DataFind(`SELECT id, name FROM tbl_module_setting`);
            return res.status(200).json({ ResponseCode: 401, Result:false, message: `${ms[0].name} Service temporarily unavailable`});
        }
        let payment = payment_id == "0" ? general[0].default_payment : payment_id;
        
        let picklalo = pickup_lat_lon != '' ? pickup_lat_lon.split(",") : [], coupon_price = 0, driver = [];
        
        const coordValid = AllFunction.ValidateCoordinates(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
        if (!coordValid.status) return res.status(200).json({ ResponseCode: 401, Result: false, message: coordValid.message });

        const sameValid = AllFunction.ValidateSameLocations(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list);
        if (!sameValid.status) return res.status(200).json({ ResponseCode: 401, Result: false, message: sameValid.message });

        if (picklalo.length > 0) {
            console.log("Calling AvailableDriverGet with:", {
                lat: Number(picklalo[0]),
                lon: Number(picklalo[1]),
                radius: general[0].vehicle_radius,
                vehicle_id: `vehicle = '${vehicle_id}'`,
                zone,
                mstatus: 2
            });
            driver = await AllFunction.AvailableDriverGet(Number(picklalo[0]), Number(picklalo[1]), general[0].vehicle_radius, `vehicle = '${vehicle_id}'`, zone, 2);
            console.log("AvailableDriverGet output:", JSON.stringify(driver, null, 2));
        } else return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Pickup location data not found!'});
        
        if (driver.status == false) {
            console.log("No drivers found nearby! Returning early.");
            return res.status(200).json({ ResponseCode: 401, Result:false, message: 'No drivers found nearby. Please try again shortly.!'});
        }

        let convertz = await AllFunction.ZoneLatlon(pickup_lat_lon, drop_lat_lon, drop_lat_lon_list), pic = "", dropdata = "", picadd = "", dropad ="", id = 0, alcount = 0, drocount = 2;

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
        let outsta = await DataFind(`SELECT * FROM tbl_outstation WHERE status = '1' AND id = '${outs_id}'`);
        if(outsta == "") return res.status(200).json({ ResponseCode: 401, Result:false, message: 'Ride details Not Found!'});

        const general_setting = await DataFind(`SELECT * FROM tbl_general_settings`);

        let server_km_charge = 0;
        let roundkm = Number(Number(tot_km).toFixed(2));
        if (roundkm <= outsta[0].min_km_distance) {
            server_km_charge = parseFloat(roundkm) * parseFloat(outsta[0].min_km_price);
        } else {
            let server_add_distance = parseFloat(roundkm) - parseFloat(Number(outsta[0].min_km_distance));
            server_km_charge = (parseFloat(outsta[0].min_km_distance) * parseFloat(outsta[0].min_km_price) + (parseFloat(server_add_distance) * parseFloat(outsta[0].after_km_price)));
        }

        let server_extra_charge = Number(outsta[0].extra_charge) > 0 ? Number(outsta[0].extra_charge) : 0;
        
        let server_extra_person_charge = 0;
        if (outsta[0].tot_passenger > 0 && num_passenger <= outsta[0].tot_passenger) {
            server_extra_person_charge = Number((num_passenger * outsta[0].per_person_price).toFixed(2));
        }

        const datec = AllFunction.checkDateTypeinOut(book_date);
        const server_day_charge = datec == 1 ? outsta[0].today_price : datec == 2 ? outsta[0].tomorrow_price: datec == 3 ? outsta[0].day_after_price : 0;

        let server_base_price = server_km_charge + server_extra_charge + server_extra_person_charge + server_day_charge;

        let server_weather_charge = 0;
        if (outsta[0].whether_charge == "1") {
            if (general_setting[0].weather_type == 'fix') {
                server_weather_charge = Number(general_setting[0].weather_price);
            } else {
                server_weather_charge = Number(((server_base_price / 100) * Number(general_setting[0].weather_price)).toFixed(2));
            }
        }

        let server_price_before_com = server_base_price + server_weather_charge;

        let server_site_commission = 0;
        if (outsta[0].comission_type == 'fix') {
            server_site_commission = Number(outsta[0].comission_rate);
        } else {
            server_site_commission = Number(((server_price_before_com / 100) * Number(outsta[0].comission_rate)).toFixed(2));
        }

        let server_total_price = Number((server_price_before_com + server_site_commission).toFixed(2));

        if (Math.abs(Number(tot_price) - server_total_price) > 0.5) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: 'Pricing validation failed!' });
        }

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

        if (coupon_id != '') {
            const cl = await DataFind(`SELECT * FROM tbl_coupon WHERE id = '${coupon_id}'`);
            if (cl.length > 0) {
                const today = new Date(book_date);
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
                if (restrictions.split(",").map(r => r.trim()).includes("outstation")) {
                    return res.status(200).json({ ResponseCode: 401, Result: false, message: `Not valid for this service` });
                }

                // Check already used
                const usedRequest = await DataFind(`SELECT * FROM tbl_request_vehicle WHERE c_id = '${uid}' AND coupon_id = '${coupon_id}' AND status != '4'`);
                const usedCart = await DataFind(`SELECT * FROM tbl_cart_vehicle WHERE c_id = '${uid}' AND coupon_id = '${coupon_id}' AND status != '4'`);
                if (usedRequest.length > 0 || usedCart.length > 0) {
                    return res.status(200).json({ ResponseCode: 401, Result: false, message: `Already used` });
                }

                let totpc = tot_price - site_commission;
                if (totpc < Number(cl[0].min_amount)) {
                    return res.status(200).json({ ResponseCode: 401, Result: false, message: `Minimum ride amount not met` });
                }

                tot_price -= Number(cl[0].discount_amount); coupon_price = Number(cl[0].discount_amount);
            } else return res.status(200).json({ ResponseCode: 401, Result: false, message: `Coupon not found!` });
        }
        
        let bidd_amount_dif = '', fnala = 0

        const dropa = Number(tot_price);
        const bidAdjust = Number(bid_addjust_amount);

        if (bidd_status == 1 && dropa !== bidAdjust) {
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

        indata = await DataInsert(`tbl_request_vehicle`, `c_id, d_id, vehicleid, bidding_d_price, bidding_status, bidd_auto_status, status, m_role, price, paid_amount, bid_addjust_amount, 
            km_charge, extra_charge, weather_charge, platform_fee, extra_person_charge, day_charge, rent_hour, rental_hour_charge, rental_per_hour_discount, rental_extra_km, 
            rental_extra_km_charge, tot_kg, kg_charge, coupon_id, coupon_price, payment_id, tot_km, tot_hour, tot_minute, package_details, zone, status_time_location, start_time, 
            pic_lat_long, drop_lat_long, pic_address, drop_address, outs_category_id, mod_cate_id, num_passenger, book_date, book_time`,
            `'${uid}', '${JSON.stringify(driver.idlist)}', '${vehicle_id}', '', '${bidd_status}', '${bidd_auto_status == 'true' ? 1 : 0}', '0', '2', 
            '${bid_addjust_amount == '0' ? tot_price : bid_addjust_amount}', '0', '${bidd_amount_dif}', 
            '${km_charge}', '${extra_charge}', '${weather_charge}', '${site_commission}', '${extra_person_charge}', '${day_charge}', '0', '0', '0', '0', '0', '0', '0', '${coupon_id}', 
            '${coupon_price}', '${payment}', '${tot_km}', '${tot_hour}', '${tot_minute}', '[]', '${JSON.stringify(zone)}', '', '${new Date().toISOString()}', '${pic}', '${dropdata}', 
            ${mysql.escape(picadd)}, ${mysql.escape(dropad)}, '${outs_category_id}', '${outs_id}', '${num_passenger}', '${book_date}', 
            '${await AllFunction.convertTo12HourFormat(book_time)}'`, req.hostname, req.protocol);


        for (let  i = 0; i < driver.idlist.length; ) {
            sendTemplatedNotification('new_ride_request', 'driver', driver.idlist[i]);
            i++;
        }

        return res.status(200).json({ ResponseCode: 200, Result:true, message: `We’ve sent ${driver.idlist.length} captain requests; they’ll confirm shortly.`, 
            request_id: indata.insertId, driver_id: driver.idlist });
        
        // return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Request add succesfully', driver_id: driver.idlist });
        // return res.status(200).json({ ResponseCode: 200, Result:true, message: 'Request add succesfully', driver_id: driver[0]?.driver_ids ?? [] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});



module.exports = router;