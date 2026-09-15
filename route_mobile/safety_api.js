const express = require("express");
const router = express.Router();
const mysql = require("mysql2");
const { DataFind, DataInsert, DataUpdate, DataDelete } = require("../middleware/databse_query");

// ================= trusted contacts ================= //

router.post("/safety/customer/add_emergency_contact", async(req, res)=>{
    try {
        const { user_id, name, phone } = req.body;
        if (!user_id || !name || !phone) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "Missing required fields" });
        }

        const query = `user_id, name, phone`;
        const values = `'${user_id}', ${mysql.escape(name)}, '${phone}'`;

        const result = await DataInsert("tbl_emergency_contacts", query, values, req.hostname, req.protocol);
        if (result === -1) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "Failed to add emergency contact" });
        }

        return res.status(200).json({ ResponseCode: 200, Result: true, message: "Emergency contact added successfully", contact_id: result.insertId });
    } catch (error) {
        console.error("add_emergency_contact error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/safety/customer/emergency_contacts", async(req, res)=>{
    try {
        const { user_id } = req.query;
        if (!user_id) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "Missing user_id parameter" });
        }

        const contacts = await DataFind(`SELECT * FROM tbl_emergency_contacts WHERE user_id = '${user_id}'`);
        return res.status(200).json({ ResponseCode: 200, Result: true, message: "Contacts load successfully", contacts });
    } catch (error) {
        console.error("emergency_contacts error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/safety/customer/delete_emergency_contact/:id", async(req, res)=>{
    try {
        const contactId = req.params.id;
        const result = await DataDelete("tbl_emergency_contacts", `id = '${contactId}'`, req.hostname, req.protocol);
        if (result === -1) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "Failed to delete emergency contact" });
        }

        return res.status(200).json({ ResponseCode: 200, Result: true, message: "Emergency contact deleted successfully" });
    } catch (error) {
        console.error("delete_emergency_contact error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ================= SOS triggers ================= //

router.post("/safety/sos_trigger", async(req, res)=>{
    try {
        const { ride_id, reporter_type, reporter_id, latitude, longitude } = req.body;
        if (!reporter_type || !reporter_id || !latitude || !longitude) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "Missing required fields" });
        }

        let resolvedRideId = ride_id;
        if (!resolvedRideId) {
            const activeRides = reporter_type === 'customer'
                ? await DataFind(`SELECT id FROM tbl_cart_vehicle WHERE c_id = '${reporter_id}' AND status = '2' LIMIT 1`)
                : await DataFind(`SELECT id FROM tbl_cart_vehicle WHERE d_id = '${reporter_id}' AND status = '2' LIMIT 1`);
            
            if (activeRides.length > 0) {
                resolvedRideId = activeRides[0].id;
            } else {
                return res.status(200).json({ ResponseCode: 401, Result: false, message: "No active ride found to trigger SOS" });
            }
        }

        const query = `ride_id, reporter_type, reporter_id, latitude, longitude, status`;
        const values = `'${resolvedRideId}', '${reporter_type}', '${reporter_id}', '${latitude}', '${longitude}', 'active'`;

        const result = await DataInsert("tbl_sos_alerts", query, values, req.hostname, req.protocol);
        if (result === -1) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "Failed to log SOS alert" });
        }

        // Fetch ride details to broadcast rich information to Admin Dashboard
        const ride = await DataFind(`SELECT * FROM tbl_cart_vehicle WHERE id = '${resolvedRideId}'`);
        
        const crypto = require("crypto");
        const SECRET = "zippygo_public_tracking_secret_12345!";
        const expiresAt = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000; // 10 years
        const payloadObj = JSON.stringify({ requestId: resolvedRideId, expiresAt });
        const encodedPayload = Buffer.from(payloadObj).toString("base64");
        const signature = crypto.createHmac("sha256", SECRET).update(encodedPayload).digest("hex");
        const trackingToken = `${encodedPayload}.${signature}`;

        const alertData = {
            id: result.insertId,
            ride_id: resolvedRideId,
            reporter_type,
            reporter_id,
            latitude,
            longitude,
            status: "active",
            created_at: new Date().toISOString(),
            ride_details: ride.length > 0 ? ride[0] : null,
            tracking_token: trackingToken
        };

        // Broadcast active SOS alert via Socket.IO
        const io = req.app.get("io");
        if (io) {
            io.emit("sos_alert", alertData);
        }

        return res.status(200).json({ ResponseCode: 200, Result: true, message: "SOS Alert triggered successfully. Support team has been notified.", alert_id: result.insertId });
    } catch (error) {
        console.error("sos_trigger error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/safety/sos_resolve", async(req, res)=>{
    try {
        const { id, resolution_notes } = req.body;
        if (!id) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "Missing SOS alert ID" });
        }

        const notes = mysql.escape(resolution_notes || "");
        const result = await DataUpdate(
            "tbl_sos_alerts", 
            `status = 'resolved', resolved_at = CURRENT_TIMESTAMP(), resolution_notes = ${notes}`, 
            `id = '${id}'`, 
            req.hostname, 
            req.protocol
        );

        if (result === -1) {
            return res.status(200).json({ ResponseCode: 401, Result: false, message: "Failed to resolve SOS alert" });
        }

        // Notify Dashboard of alert resolution
        const io = req.app.get("io");
        if (io) {
            io.emit("sos_alert_resolved", { id });
        }

        return res.status(200).json({ ResponseCode: 200, Result: true, message: "SOS Alert resolved successfully" });
    } catch (error) {
        console.error("sos_resolve error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ================= live tracking / share status ================= //

router.get("/safety/share_trip/:ride_id", async(req, res)=>{
    try {
        const rideId = req.params.ride_id;
        const ride = await DataFind(`SELECT * FROM tbl_cart_vehicle WHERE id = '${rideId}'`);
        if (ride.length === 0) {
            return res.status(200).json({ ResponseCode: 404, Result: false, message: "Ride not found" });
        }

        // Fetch driver profile & live location
        let driver = null;
        if (ride[0].d_id) {
            const drDetails = await DataFind(`SELECT id, first_name, last_name, primary_phoneNo, secound_phoneNo, profile_image, rating, vehicle_number, latitude, longitude FROM tbl_driver WHERE id = '${ride[0].d_id}'`);
            if (drDetails.length > 0) {
                driver = drDetails[0];
            }
        }

        // Fetch customer name
        let customer = null;
        if (ride[0].c_id) {
            const cusDetails = await DataFind(`SELECT name, mobile FROM tbl_customer WHERE id = '${ride[0].c_id}'`);
            if (cusDetails.length > 0) {
                customer = cusDetails[0];
            }
        }

        return res.status(200).json({ 
            ResponseCode: 200, 
            Result: true, 
            message: "Trip loaded successfully", 
            trip: {
                ride_id: ride[0].id,
                status: ride[0].status,
                pickup_address: ride[0].pic_address,
                drop_address: ride[0].drop_address,
                pickup_lat_long: ride[0].pic_lat_long,
                drop_lat_long: ride[0].drop_lat_long,
                start_time: ride[0].start_time,
                expected_route: ride[0].route_coordinates,
                customer: customer,
                driver: driver
            }
        });
    } catch (error) {
        console.error("share_trip error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/safety/emergency_settings", async (req, res) => {
    try {
        const general = await DataFind(`SELECT emergency_contact_number FROM tbl_general_settings`);
        if (general && general.length > 0) {
            return res.status(200).json({
                ResponseCode: 200,
                Result: true,
                emergency_contact_number: general[0].emergency_contact_number || '112'
            });
        }
        return res.status(200).json({ ResponseCode: 200, Result: true, emergency_contact_number: '112' });
    } catch (e) {
        console.error("emergency_settings error:", e);
        return res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = router;
