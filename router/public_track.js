const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { DataFind } = require("../middleware/databse_query");

const SECRET = "zippygo_public_tracking_secret_12345!";

// Check if request is authenticated as an admin
async function isAdmin(req) {
    try {
        const token = req.cookies && req.cookies.zippygo;
        if (!token) return false;
        const decoded = await jwt.verify(token, process.env.jwt_key);
        return decoded && (decoded.user_role == "1" || decoded.user_role == "2");
    } catch (e) {
        return false;
    }
}

// Verify signature and decrypt payload (stable tracking link with no dynamic expiresAt)
function verifyToken(token) {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [encodedPayload, signature] = parts;
    const expectedSignature = crypto.createHmac("sha256", SECRET).update(encodedPayload).digest("hex");
    if (signature !== expectedSignature) return null;
    try {
        const payload = JSON.parse(Buffer.from(encodedPayload, "base64").toString("utf-8"));
        return payload;
    } catch (e) {
        return null;
    }
}

// Helper to validate tracking link expiration on the server side
async function isRideExpired(requestId, isUserAdmin) {
    if (isUserAdmin) return false; // Admins bypass expiration entirely
    
    // 1. If the ride is in the active cart, it's not expired
    const cartRide = await DataFind(`SELECT id FROM tbl_cart_vehicle WHERE id = '${requestId}' OR req_id = '${requestId}'`);
    if (cartRide && cartRide.length > 0) {
        return false;
    }
    
    // 2. If the ride is a new/pending request, it's not expired
    const requestRide = await DataFind(`SELECT id FROM tbl_request_vehicle WHERE id = '${requestId}'`);
    if (requestRide && requestRide.length > 0) {
        return false;
    }

    // 3. If the ride is completed/cancelled, allow tracking up to 60 minutes after end_time
    const orderRide = await DataFind(`SELECT status, end_time FROM tbl_order_vehicle WHERE id = '${requestId}' OR req_id = '${requestId}'`);
    if (orderRide && orderRide.length > 0) {
        const ride = orderRide[0];
        if (ride.end_time) {
            const endTimeMs = new Date(ride.end_time).getTime();
            if (!isNaN(endTimeMs) && Date.now() - endTimeMs > 60 * 60 * 1000) {
                return true; // Expired
            }
        }
        return false; // Still within 60 minutes or has no valid end_time yet
    }
    
    return true; // Not found anywhere is treated as expired
}

// Render public tracking page
router.get("/public/track/:token", async (req, res) => {
    const { token } = req.params;
    const isUserAdmin = await isAdmin(req);
    const payload = verifyToken(token);
    if (!payload) {
        return res.render("public_track_expired");
    }
    
    // Check for server-side expiration
    const expired = await isRideExpired(payload.requestId, isUserAdmin);
    if (expired) {
        return res.render("public_track_expired");
    }
    
    // Check if the request exists in database (check tbl_cart_vehicle, tbl_order_vehicle, or tbl_request_vehicle)
    let ride = await DataFind(`SELECT id FROM tbl_cart_vehicle WHERE id = '${payload.requestId}' OR req_id = '${payload.requestId}'`);
    if (!ride || ride.length === 0) {
        ride = await DataFind(`SELECT id FROM tbl_order_vehicle WHERE id = '${payload.requestId}' OR req_id = '${payload.requestId}'`);
    }
    if (!ride || ride.length === 0) {
        ride = await DataFind(`SELECT id FROM tbl_request_vehicle WHERE id = '${payload.requestId}'`);
    }
    if (!ride || ride.length === 0) {
        return res.render("public_track_expired");
    }
    
    // Query general settings for favicon and title
    const generalData = await DataFind(`SELECT * FROM tbl_general_settings`);
    const general = generalData[0] || {};
    
    res.render("public_track", { token, general });
});

// Fetch status for public tracking page (JSON polling endpoint)
router.get("/public/track/:token/status", async (req, res) => {
    const { token } = req.params;
    const isUserAdmin = await isAdmin(req);
    const payload = verifyToken(token);
    if (!payload) {
        return res.status(200).json({ ResponseCode: 401, Result: false, message: "Token invalid" });
    }
    
    // Check for server-side expiration
    const expired = await isRideExpired(payload.requestId, isUserAdmin);
    if (expired) {
        return res.status(200).json({ ResponseCode: 401, Result: false, message: "Tracking expired" });
    }
    
    let query = `SELECT cve.id, cve.status, cve.price, cve.tot_km, cve.pic_lat_long, cve.drop_lat_long, cve.pic_address, cve.drop_address, cve.d_id, cve.drop_complete, cve.drop_tot,
                          COALESCE(dr.first_name, '') AS first_name, COALESCE(dr.last_name, '') AS last_name,
                          COALESCE(dr.latitude, '') AS latitude, COALESCE(dr.longitude, '') AS longitude,
                          COALESCE(dr.profile_image, '') AS profile_image,
                          COALESCE(vec.name, '') AS car_name, COALESCE(dr.vehicle_number, '') AS vehicle_number,
                          COALESCE(dr.car_color, '') AS car_color,
                          COALESCE(vec.map_img, '') AS vehicle_map_image,
                          COALESCE(vec.image, '') AS vehicle_image
                   FROM tbl_cart_vehicle AS cve
                   LEFT JOIN tbl_driver AS dr ON cve.d_id = dr.id
                   LEFT JOIN tbl_vehicle AS vec ON dr.vehicle = vec.id
                   WHERE cve.id = '${payload.requestId}' OR cve.req_id = '${payload.requestId}'`;
                   
    let ride = await DataFind(query);
    if (!ride || ride.length === 0) {
        // Fallback to tbl_order_vehicle
        query = `SELECT cve.id, cve.status, cve.price, cve.tot_km, cve.pic_lat_long, cve.drop_lat_long, cve.pic_address, cve.drop_address, cve.d_id, cve.drop_complete, cve.drop_tot,
                        COALESCE(dr.first_name, '') AS first_name, COALESCE(dr.last_name, '') AS last_name,
                        COALESCE(dr.latitude, '') AS latitude, COALESCE(dr.longitude, '') AS longitude,
                        COALESCE(dr.profile_image, '') AS profile_image,
                        COALESCE(vec.name, '') AS car_name, COALESCE(dr.vehicle_number, '') AS vehicle_number,
                        COALESCE(dr.car_color, '') AS car_color,
                        COALESCE(vec.map_img, '') AS vehicle_map_image,
                        COALESCE(vec.image, '') AS vehicle_image
                 FROM tbl_order_vehicle AS cve
                 LEFT JOIN tbl_driver AS dr ON cve.d_id = dr.id
                 LEFT JOIN tbl_vehicle AS vec ON dr.vehicle = vec.id
                 WHERE cve.id = '${payload.requestId}' OR cve.req_id = '${payload.requestId}'`;
        ride = await DataFind(query);
    }
    if (!ride || ride.length === 0) {
        // Fallback to tbl_request_vehicle (for new requests)
        query = `SELECT cve.id, '0' AS status, cve.price, '0' AS tot_km, cve.pic_lat_long, cve.drop_lat_long, cve.pic_address, cve.drop_address, '0' AS d_id, '0' AS drop_complete, '0' AS drop_tot,
                        '' AS first_name, '' AS last_name,
                        '' AS latitude, '' AS longitude,
                        '' AS profile_image,
                        '' AS car_name, '' AS vehicle_number,
                        '' AS car_color,
                        '' AS vehicle_map_image,
                        '' AS vehicle_image
                 FROM tbl_request_vehicle AS cve
                 WHERE cve.id = '${payload.requestId}'`;
        ride = await DataFind(query);
    }
    
    if (!ride || ride.length === 0) {
        return res.status(200).json({ ResponseCode: 404, Result: false, message: "Ride not found" });
    }
    
    return res.status(200).json({ ResponseCode: 200, Result: true, ride: ride[0] });
});

module.exports = router;
