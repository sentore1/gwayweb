const geolib = require("geolib");
const { DataFind, DataUpdate } = require("../middleware/databse_query");

function checkRouteDeviation(currentLat, currentLon, routeCoordsString, majorLimit = 500, highRiskLimit = 1000) {
    if (!routeCoordsString || routeCoordsString.trim() === "") {
        return { deviated: false, distance: 0 };
    }
    
    try {
        // Parse coordinates formatted as "lat,lon;lat,lon;..."
        const points = routeCoordsString.split(";").map(pair => {
            const [latStr, lonStr] = pair.split(",");
            if (!latStr || !lonStr) return null;
            return { latitude: parseFloat(latStr), longitude: parseFloat(lonStr) };
        }).filter(p => p !== null);

        if (points.length === 0) {
            return { deviated: false, distance: 0 };
        }

        let minDistance = Infinity;
        const currentPoint = { latitude: parseFloat(currentLat), longitude: parseFloat(currentLon) };

        for (const point of points) {
            const dist = geolib.getDistance(currentPoint, point);
            if (dist < minDistance) {
                minDistance = dist;
            }
        }

        return {
            deviated: minDistance > majorLimit,
            highRisk: minDistance > highRiskLimit,
            distance: minDistance
        };
    } catch (e) {
        console.error("checkRouteDeviation error:", e);
        return { deviated: false, distance: 0 };
    }
}

async function processDriverDeviation(driverId, lat, lon, io) {
    try {
        // Find active ride for this driver (status = '2' means started/active ride)
        const activeRides = await DataFind(`SELECT * FROM tbl_cart_vehicle WHERE d_id = '${driverId}' AND status = '2' LIMIT 1`);
        if (activeRides.length === 0) return;

        const ride = activeRides[0];
        const routeCoords = ride.route_coordinates;
        if (!routeCoords) return;

        const general = await DataFind(`SELECT major_deviation_distance, high_risk_deviation_distance FROM tbl_general_settings`);
        const majorLimit = (general && general.length > 0) ? general[0].major_deviation_distance : 500;
        const highRiskLimit = (general && general.length > 0) ? general[0].high_risk_deviation_distance : 1000;

        const result = checkRouteDeviation(lat, lon, routeCoords, majorLimit, highRiskLimit);
        if (result.deviated) {
            console.log(`[DEVIATION WARNING] Ride #${ride.id} deviated by ${result.distance}m!`);
            
            // Broadcast route deviation warning to customer via Socket.IO
            if (io) {
                io.emit(`route_deviation_${ride.id}`, {
                    ride_id: ride.id,
                    distance: result.distance,
                    highRisk: result.highRisk,
                    message: result.highRisk 
                        ? "🚨 High-risk route deviation detected! Are you safe? Contact emergency support."
                        : "⚠️ Major route deviation detected. Please check the route."
                });

                // Also notify admin panel of deviation if high-risk
                if (result.highRisk) {
                    const crypto = require("crypto");
                    const SECRET = "zippygo_public_tracking_secret_12345!";
                    const expiresAt = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000; // 10 years
                    const payloadObj = JSON.stringify({ requestId: ride.id, expiresAt });
                    const encodedPayload = Buffer.from(payloadObj).toString("base64");
                    const signature = crypto.createHmac("sha256", SECRET).update(encodedPayload).digest("hex");
                    const trackingToken = `${encodedPayload}.${signature}`;

                    io.emit("sos_alert", {
                        id: `dev_${ride.id}`,
                        ride_id: ride.id,
                        reporter_type: "system",
                        reporter_id: 0,
                        latitude: lat,
                        longitude: lon,
                        status: "active",
                        created_at: new Date().toISOString(),
                        tracking_token: trackingToken,
                        ride_details: {
                            ...ride,
                            customer_name: "Deviation Monitor",
                            customer_phone: "Auto Trigger",
                            driver_first_name: "System",
                            driver_last_name: "Warning",
                            driver_phone: "N/A"
                        }
                    });
                }
            }
        }
    } catch (error) {
        console.error("processDriverDeviation error:", error);
    }
}

module.exports = { checkRouteDeviation, processDriverDeviation };
