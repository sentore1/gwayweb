const schedule = require('node-schedule');
const { connection } = require('../middleware/db');
const AllFunction = require('./function');
const { sendTemplatedNotification } = require('./notification_helper');

const DataFind = (query) => {
    return new Promise((resolve, reject) => {
        connection.query(query, (err, results) => {
            if (err) reject(err);
            else resolve(results);
        });
    });
};

const DataUpdate = (table, updateString, whereString) => {
    return new Promise((resolve, reject) => {
        connection.query(`UPDATE ${table} SET ${updateString} WHERE ${whereString}`, (err, results) => {
            if (err) reject(err);
            else resolve(results);
        });
    });
};

function startRideScheduler(io) {
    // Run every minute
    schedule.scheduleJob('*/1 * * * *', async () => {
        try {
            console.log("--- Running Scheduled Rides Dispatch Job ---");
            
            // Get settings: schedule_ride and schedule_ride_minutes
            const general = await DataFind("SELECT schedule_ride, schedule_ride_minutes, vehicle_radius FROM tbl_general_settings LIMIT 1");
            if (general.length === 0) return;
            
            const isEnabled = general[0].schedule_ride;
            const minutesWindow = general[0].schedule_ride_minutes || 15;
            const vehicleRadius = general[0].vehicle_radius || 10;
            
            if (isEnabled !== 1 && isEnabled !== '1') {
                console.log("Schedule Ride feature is disabled in settings.");
                return;
            }
            
            // Find requests in tbl_request_vehicle where status = '0' and book_date is NOT empty and book_date is NOT NULL and d_id = '[]'
            const pendingRides = await DataFind("SELECT * FROM tbl_request_vehicle WHERE status = '0' AND book_date != '' AND book_date IS NOT NULL AND d_id = '[]'");
            
            const now = new Date();
            
            for (const ride of pendingRides) {
                // Parse date and time in local timezone format (YYYY-MM-DDTHH:MM:00)
                const rideTime = new Date(`${ride.book_date}T${ride.book_time}:00`);
                if (isNaN(rideTime.getTime())) continue;
                
                const diffMs = rideTime - now;
                const diffMins = diffMs / (1000 * 60);
                
                console.log(`Checking scheduled ride #${ride.id} - Departure: ${ride.book_date} ${ride.book_time} (in ${diffMins.toFixed(1)} mins)`);
                
                // If ride is within the dispatch window (e.g. 15 minutes) and not in the past (allow small margin)
                if (diffMins <= minutesWindow && diffMins >= -2) {
                    console.log(`Dispatching scheduled ride #${ride.id} to drivers...`);
                    
                    // Parse pickup coordinates (pic_lat_long format: 'latitude&!longitude')
                    const coords = ride.pic_lat_long.split('&!');
                    if (coords.length < 2) continue;
                    const lat = parseFloat(coords[0]);
                    const lon = parseFloat(coords[1]);
                    
                    const zone = JSON.parse(ride.zone || '[]');
                    const caldata = await AllFunction.AvailableDriverGet(lat, lon, vehicleRadius, `vehicle = '${ride.vehicleid}'`, zone, 1);
                    
                    if (caldata.status === true && caldata.idlist.length > 0) {
                        console.log(`Found ${caldata.idlist.length} candidate drivers for ride #${ride.id}:`, caldata.idlist);
                        
                        // Update tbl_request_vehicle with candidate driver IDs
                        await DataUpdate(
                            'tbl_request_vehicle', 
                            `d_id = '${JSON.stringify(caldata.idlist)}', status_time_location = '${new Date().toISOString()}'`, 
                            `id = '${ride.id}'`
                        );
                        
                        // Send Push Notifications
                        for (const driverId of caldata.idlist) {
                            sendTemplatedNotification('new_ride_request', 'driver', driverId);
                        }
                        
                        // Emit Socket notification to drivers who are online
                        for (const driverId of caldata.idlist) {
                            io.emit(`vehiclerequest${driverId}`, {
                                requestid: ride.id,
                                driverid: caldata.idlist,
                                c_id: ride.c_id,
                                m_role: ride.m_role
                            });
                        }
                        
                    } else {
                        console.log(`No drivers found nearby within ${vehicleRadius} KM for ride #${ride.id} yet. Will retry next minute.`);
                    }
                }
            }
        } catch (error) {
            console.error("Scheduler Error:", error);
        }
    });
}

module.exports = { startRideScheduler };
