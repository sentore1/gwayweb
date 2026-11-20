/* jshint esversion: 6 */
/* jshint esversion: 8 */
/* jshint node: true */



const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const multer  = require('multer');
const mysql = require("mysql2");
const { DataFind, DataInsert, DataUpdate, DataDelete } = require("../middleware/databse_query");



router.get("/list", auth, async(req, res)=>{
    try {
        const zone_data = await DataFind(`SELECT * FROM tbl_zone`);

        
        
        res.render("zone", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, zone_data
        })
    } catch (error) {
        console.log(error);
    }
})

router.post("/add_zone", auth, async(req, res)=>{
    try {
          if (process.env.DISABLE_DB_WRITE === 'true') {
    req.flash('errors', 'For demo purpose we disabled crud operations!!');
    return res.redirect("back");
}
        const {name, status, zone_lat_lon} = req.body;

        const all_lat_lon = zone_lat_lon.split(',').map(Number);
        let zone_leg = all_lat_lon.length;

        
        
        let latitude = [], longitude = [], poly_lat = [], poly_long = [], lat_log = [], polygone = [];            

        for (let i = 0; i < zone_leg;) {

            if ((i%2) == 0) {
                latitude.push(all_lat_lon[i]);
                poly_long.push(all_lat_lon[i]);
            } else {
                longitude.push(all_lat_lon[i]);
                poly_lat.push(all_lat_lon[i]);
            }
            i++;
        }

        
        for (let a = 0; a < latitude.length;) {
            lat_log.push(`${latitude[a]}:${longitude[a]}`);
            polygone.push(`${poly_long[a]} ${poly_lat[a]}`);
            a++;
        }

        if (polygone[0] !== polygone[polygone.length - 1]) {
            polygone.push(polygone[0]);
        }
        const polygonWKT = `POLYGON((${polygone.join(', ')}))`;

        let zone = lat_log.toString();

        if (await DataInsert(`tbl_zone`, `name, status, lat_lon, lat_lon_polygon`, `'${name}', '${status}', '${zone}', ST_GeomFromText(${mysql.escape(polygonWKT)}, 4326)`, req.hostname, req.protocol) == -1) {
        

        }
        
        req.flash('success', 'Zone Add successfully');
        res.redirect("/zone/list");
    } catch (error) {
        console.log(error);
    }
})

router.get("/edit/:id", auth, async(req, res)=>{
    try {
        const zone_data = await DataFind(`SELECT * FROM tbl_zone where id = '${req.params.id}'`);

        res.render("edit_zone", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, zone_data
        })
    } catch (error) {
        console.log(error);
    }
})

router.post("/edit_zone", auth, async(req, res)=>{
    try {
          if (process.env.DISABLE_DB_WRITE === 'true') {
    req.flash('errors', 'For demo purpose we disabled crud operations!!');
    return res.redirect("back");
}
        const {zone_id, name, status, zone_lat_lon} = req.body;

        console.log(req.body);

        const esname = mysql.escape(name)
        if (zone_lat_lon == "") {
            if (await DataUpdate(`tbl_zone`, `name = ${esname}, status = '${status}'`, `id = '${zone_id}'`, req.hostname, req.protocol) == -1) {
        

            }
            
        } else {

           



            const all_lat_lon = zone_lat_lon.split(',').map(Number);
            let zone_leg = all_lat_lon.length;

            console.log(all_lat_lon);
            
            let latitude = [], longitude = [], poly_lat = [], poly_long = [], lat_log = [], polygone = [];            

            for (let i = 0; i < zone_leg;) {

                if ((i%2) == 0) {
                    latitude.push(all_lat_lon[i]);
                    poly_long.push(all_lat_lon[i]);
                } else {
                    longitude.push(all_lat_lon[i]);
                    poly_lat.push(all_lat_lon[i]);
                }
                i++;
            }

            
            for (let a = 0; a < latitude.length;) {
                lat_log.push(`${latitude[a]}:${longitude[a]}`);
                polygone.push(`${poly_long[a]} ${poly_lat[a]}`);
                a++;
            }

            if (polygone[0] !== polygone[polygone.length - 1]) {
                polygone.push(polygone[0]);
            }
            const polygonWKT = `POLYGON((${polygone.join(', ')}))`;

            let zone = lat_log.toString();

            if (await DataUpdate(`tbl_zone`, `name = '${name}', status = '${status}', lat_lon = '${zone}', lat_lon_polygon = ST_GeomFromText(${mysql.escape(polygonWKT)}, 4326)`, 
                `id = '${zone_id}'`, req.hostname, req.protocol) == -1) {
        

            }
        }


        
        
        req.flash('success', 'Zone Updated successfully');
        res.redirect("/zone/list");
    } catch (error) {
        console.log(error);
    }
})

router.get("/delete/:id", auth, async(req, res)=>{
    try {
          if (process.env.DISABLE_DB_WRITE === 'true') {
    req.flash('errors', 'For demo purpose we disabled crud operations!!');
    return res.redirect("back");
}
        if (await DataDelete(`tbl_zone`, `id = '${req.params.id}'`, req.hostname, req.protocol) == -1) {
        

        }
        
        req.flash('success', 'Zone Deleted successfully');
        res.redirect("/zone/list");
    } catch (error) {
        console.log(error);
    }
})


router.get("/live_driver", auth, async(req, res)=>{
    try {
        const zone_data = await DataFind(`SELECT * FROM tbl_zone`);
        const vehicle = await DataFind(`SELECT * FROM tbl_vehicle WHERE status = '1'`);

        res.render("zone_driver_location", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, zone_data, vehicle
        })
    } catch (error) {
        console.log(error);
    }
})

router.post("/change_location", auth, async(req, res)=>{
    try {
        const {zid, vid} = req.body;
        
        let zoneWhere = "";
        let zoneData = null;
        if (zid && zid != "0") {
            const zfind = await DataFind(`SELECT * FROM tbl_zone WHERE id = '${zid}'`);
            if (zfind.length > 0) {
                zoneData = zfind[0];
                zoneWhere = `AND (FIND_IN_SET('${zid}', REPLACE(REPLACE(dr.zone, '[', ''), ']', '')) > 0 OR JSON_CONTAINS(dr.zone, CONCAT('["', '${zid}', '"]'), '$') OR JSON_CONTAINS(dr.zone, CONCAT('[', '${zid}', ']'), '$'))`;
            }
        }
        
        let vehicleWhere = "";
        if (vid && vid != "0") {
            vehicleWhere = `AND dr.vehicle = '${vid}'`;
        }

        const query = `
            SELECT 
                dr.id, dr.first_name, dr.last_name, dr.email, dr.primary_ccode, dr.primary_phoneNo,
                dr.secound_ccode, dr.secound_phoneNo, dr.profile_image, dr.vehicle_image, dr.vehicle_number,
                dr.car_color, dr.passenger_capacity, dr.latitude, dr.longitude, dr.fstatus, dr.rid_status,
                dr.break_mode, dr.wallet, dr.pending_zone,
                COALESCE(ve.map_img, '') AS image, 
                COALESCE(ve.name, '') AS vehicle_name,
                COALESCE((SELECT GROUP_CONCAT(name SEPARATOR ', ') FROM tbl_zone WHERE FIND_IN_SET(id, REPLACE(REPLACE(dr.zone, '[', ''), ']', '')) > 0), 'None') AS zone_name,
                COALESCE((SELECT GROUP_CONCAT(name SEPARATOR ', ') FROM tbl_zone WHERE FIND_IN_SET(id, REPLACE(REPLACE(dr.pending_zone, '[', ''), ']', '')) > 0), '') AS pending_zone_name,
                COALESCE((SELECT COUNT(id) FROM tbl_order_vehicle WHERE d_id = dr.id AND status IN ('6', '7', '8', 'Completed')), 0) AS tot_ride,
                CASE WHEN dr.rid_status = 1 THEN 1 ELSE 0 END AS active_ride_count,
                CASE WHEN dr.rid_status = 1 THEN 1 ELSE 0 END AS rid_status,
                CASE WHEN dr.rid_status = 1 THEN COALESCE(
                    NULLIF((SELECT pic_address FROM tbl_order_vehicle WHERE d_id = dr.id AND status NOT IN ('4', '6', '7', '8', 'Completed', 'Cancelled') ORDER BY id DESC LIMIT 1), ''),
                    (SELECT pic_address FROM tbl_order_vehicle WHERE d_id = dr.id ORDER BY id DESC LIMIT 1),
                    ''
                ) ELSE '' END AS active_pic_address,
                CASE WHEN dr.rid_status = 1 THEN COALESCE(
                    NULLIF((SELECT drop_address FROM tbl_order_vehicle WHERE d_id = dr.id AND status NOT IN ('4', '6', '7', '8', 'Completed', 'Cancelled') ORDER BY id DESC LIMIT 1), ''),
                    (SELECT drop_address FROM tbl_order_vehicle WHERE d_id = dr.id ORDER BY id DESC LIMIT 1),
                    ''
                ) ELSE '' END AS active_drop_address,
                COALESCE((SELECT ROUND(AVG(tot_star), 1) FROM tbl_review_driver WHERE driver_id = dr.id), 5.0) AS avg_rating,
                COALESCE((SELECT COUNT(id) FROM tbl_review_driver WHERE driver_id = dr.id), 0) AS total_reviews
            FROM tbl_driver AS dr
            LEFT JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id
            WHERE dr.status = '1' ${zoneWhere} ${vehicleWhere}
            ORDER BY dr.id DESC
        `;

        const dri = await DataFind(query);

        // Attach Live Device Ping Status (Strictly real-time socket/location pings within < 3 mins)
        const liveMap = global.driverLivePings || new Map();
        const now = Date.now();
        dri.forEach(d => {
            const lastPing = liveMap.get(String(d.id));
            d.is_device_live = (lastPing && (now - lastPing < 180000)) ? 1 : 0;
        });

        res.send({
            status: true,
            data: zoneData,
            dri: dri,
            zone: zid ? zid : 0
        });
    } catch (error) {
        console.log(error);
        res.status(500).send({ status: false, error: error.message });
    }
});

router.post("/driver_details", auth, async(req, res)=>{
    try {
        const { driver_id } = req.body;
        if (!driver_id) return res.json({ status: false, message: "Driver ID required" });

        const driQuery = `
            SELECT 
                dr.*,
                COALESCE(ve.name, '') AS vehicle_name,
                COALESCE(ve.image, '') AS vehicle_type_image,
                COALESCE(ve.map_img, '') AS vehicle_map_img,
                COALESCE((SELECT GROUP_CONCAT(name SEPARATOR ', ') FROM tbl_zone WHERE FIND_IN_SET(id, REPLACE(REPLACE(dr.zone, '[', ''), ']', '')) > 0), 'None') AS zone_name,
                COALESCE((SELECT GROUP_CONCAT(name SEPARATOR ', ') FROM tbl_zone WHERE FIND_IN_SET(id, REPLACE(REPLACE(dr.pending_zone, '[', ''), ']', '')) > 0 AND FIND_IN_SET(id, REPLACE(REPLACE(dr.zone, '[', ''), ']', '')) = 0), '') AS pending_zone_name,
                COALESCE((SELECT COUNT(id) FROM tbl_order_vehicle WHERE d_id = dr.id AND status IN ('6', '7', '8', 'Completed')), 0) AS tot_ride,
                COALESCE((SELECT COUNT(id) FROM tbl_order_vehicle WHERE d_id = dr.id AND status = '4'), 0) AS cancelled_rides,
                COALESCE((SELECT ROUND(AVG(tot_star), 1) FROM tbl_review_driver WHERE driver_id = dr.id), 5.0) AS avg_rating,
                COALESCE((SELECT COUNT(id) FROM tbl_review_driver WHERE driver_id = dr.id), 0) AS total_reviews
            FROM tbl_driver AS dr
            LEFT JOIN tbl_vehicle AS ve ON dr.vehicle = ve.id
            WHERE dr.id = '${driver_id}'
        `;
        const driverData = await DataFind(driQuery);
        if (driverData.length === 0) return res.json({ status: false, message: "Driver not found" });

        const liveMap = global.driverLivePings || new Map();
        const lastPing = liveMap.get(String(driver_id));
        driverData[0].is_device_live = (lastPing && (Date.now() - lastPing < 180000)) ? 1 : 0;

        // Get running ride ONLY if driver.rid_status = 1
        let activeRide = null;
        if (driverData[0].rid_status == 1) {
            // 1. First check tbl_cart_vehicle (where active/ongoing rides are stored)
            let rides = await DataFind(`
                SELECT cart.id, cart.req_id, cart.pic_address, cart.drop_address, cart.price, cart.status, cart.book_date, cart.book_time,
                       cus.name AS customer_name, cus.phone AS customer_phone
                FROM tbl_cart_vehicle AS cart
                LEFT JOIN tbl_customer AS cus ON cart.c_id = cus.id
                WHERE cart.d_id = '${driver_id}' AND cart.status NOT IN ('4', '6', '7', '8', 'Completed', 'Cancelled')
                ORDER BY cart.id DESC LIMIT 1
            `);
            // 2. If no active ride in cart, check tbl_order_vehicle
            if (rides.length === 0) {
                rides = await DataFind(`
                    SELECT ord.id, ord.req_id, ord.pic_address, ord.drop_address, ord.price, ord.status, ord.book_date, ord.book_time,
                           cus.name AS customer_name, cus.phone AS customer_phone
                    FROM tbl_order_vehicle AS ord
                    LEFT JOIN tbl_customer AS cus ON ord.c_id = cus.id
                    WHERE ord.d_id = '${driver_id}' AND ord.status NOT IN ('4', '6', '7', '8', 'Completed', 'Cancelled')
                    ORDER BY ord.id DESC LIMIT 1
                `);
            }
            // 3. Fallback to latest ride from tbl_order_vehicle if still nothing found
            if (rides.length === 0) {
                rides = await DataFind(`
                    SELECT ord.id, ord.req_id, ord.pic_address, ord.drop_address, ord.price, ord.status, ord.book_date, ord.book_time,
                           cus.name AS customer_name, cus.phone AS customer_phone
                    FROM tbl_order_vehicle AS ord
                    LEFT JOIN tbl_customer AS cus ON ord.c_id = cus.id
                    WHERE ord.d_id = '${driver_id}'
                    ORDER BY ord.id DESC LIMIT 1
                `);
            }
            if (rides.length > 0) {
                const crypto = require("crypto");
                const SECRET = "zippygo_public_tracking_secret_12345!";
                const rval = rides[0];
                const payload = JSON.stringify({ requestId: rval.req_id || rval.id });
                const encodedPayload = Buffer.from(payload).toString("base64");
                const signature = crypto.createHmac("sha256", SECRET).update(encodedPayload).digest("hex");
                rval.tracking_token = `${encodedPayload}.${signature}`;
                activeRide = rval;
            }
        }

        // Get latest 5 reviews
        const reviews = await DataFind(`
            SELECT r.tot_star, r.review, r.date, c.name AS customer_name
            FROM tbl_review_driver AS r
            LEFT JOIN tbl_customer AS c ON r.customer_id = c.id
            WHERE r.driver_id = '${driver_id}'
            ORDER BY r.id DESC LIMIT 5
        `);

        res.json({
            status: true,
            driver: driverData[0],
            active_ride: activeRide,
            reviews: reviews
        });
    } catch (error) {
        console.log("Error in driver_details endpoint:", error);
        res.status(500).json({ status: false, error: error.message });
    }
});

module.exports = router;