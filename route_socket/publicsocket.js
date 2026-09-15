const AllFunction = require("../route_function/function")
const AllChat = require("../route_function/chat_function")
const schedule = require('node-schedule');
const { DataFind, DataUpdate } = require("../middleware/databse_query");
const sendOneNotification = require("../middleware/send");
let activeSchedules = [];
let jobs = [];



function publicsocket (io) {

io.on('connection', (socket) => {
    const fs = require('fs');
    const path = require('path');
    const logFile = path.join(__dirname, '../socket_debug.log');
    const logMessage = (msg) => {
        const time = new Date().toISOString();
        fs.appendFileSync(logFile, `[${time}] [SocketConnection] ${msg}\n`);
    };

    logMessage(`Socket connected: ${socket.id}`);

    // Join user-specific room
    socket.on('join', (data) => {
        if (data && data.uid) {
            const roomName = "user_" + data.uid;
            socket.join(roomName);
            logMessage(`Socket ${socket.id} joined room: ${roomName}`);
        }
    });

    // // Customer Home
    socket.on('home', async (message) => {
        if (message && message.uid) {
            io.to("user_" + message.uid).emit('home', message);
        } else {
            socket.broadcast.emit('home', message);
        }
    })
    
    // // Home Map
    socket.on('homemap', async (homemessage) => {
        try {
            
            const {uid, status, driver_data, dlocations, ddata} = homemessage;
            const missingField = await AllFunction.CheckSocketData(homemessage, ["uid", "lat", "long", "status", "driver_data", "dlocations", "ddata"]);

            if(!missingField && driver_data.length > 0) {
                if (!global.driverLivePings) global.driverLivePings = new Map();
                global.driverLivePings.set(String(uid), Date.now());
                
                if (dlocations.homemap == "1") {
                    
                    driver_data[0].zone = typeof driver_data[0].zone == "string" ? JSON.parse(driver_data[0].zone) : driver_data[0].zone;

                    let id_lidt = driver_data[0].zone.map(val => {return Number(val)});
                    let data = {id: driver_data[0].id, image: driver_data[0].image, name: driver_data[0].name, description: driver_data[0].description, latitude: driver_data[0].latitude, longitude: driver_data[0].longitude, zone_list:id_lidt}
                    
                    if (driver_data[0].fstatus == "0" && status == "on") {
                        socket.broadcast.emit('Driver_location_On', data);
                    } else if (driver_data[0].fstatus == "1") {
                        if (status == "off") {
                            socket.broadcast.emit('Drive_location_Off', data);
                        }
                        if (status == "on") {
                            socket.broadcast.emit('Driver_location_Update', data);
                        }
                    }
                }
                        
                if (dlocations.vdriloc == 1) {
                    if (ddata.driver != "" && ddata.data != "") {
                        let d = ddata.data;
                        for (let i = 0; i < d.length;) {
                            console.log("V_Driver_Location");
                            
                            io.to("user_" + d[i].c_id).emit(`V_Driver_Location${d[i].c_id}`, {d_id : uid, driver_location:ddata.driver[0]});
                            i++
                        }
                    }
                }
            }
        } catch (error) {
            console.error(error);
            return socket.emit('database_error', { ResponseCode: 401, Result: false, message: process.env.dataerror});
        }
    })



    // // Send Vehicle Ride Request 
    socket.on('vehiclerequest', async (homemessage) => {
        const {requestid, driverid, c_id, m_role} = homemessage;
        
        const gs = await DataFind(`SELECT ${ m_role == 1 ? 'offer_expire_time AS dri_off_expire_time' : 
                                        m_role == 2 ? 'out_offer_exprie_time_dri AS dri_off_expire_time' : 
                                        m_role == 3 ? 'ren_offer_exprie_time_dri AS dri_off_expire_time' :
                                        'pack_offer_exprie_time_dri AS dri_off_expire_time'
                                    }  FROM tbl_general_settings`);
        
        if (gs != "") {
            if (Number(gs[0].dri_off_expire_time) != NaN) {

                if (jobs != "") {
                    for (let i = 0; i < jobs.length; ) {
        
                        if (jobs[i].req_id == requestid && jobs[i].c_id == c_id) {
                            jobs[i].job.cancel();
                        }
                        i++;
                    }
                }
                
                let job = schedule.scheduleJob(new Date(Date.now() + Number(gs[0].dri_off_expire_time) * 1000), async function() {
                    const fs = require('fs');
                    const path = require('path');
                    const logFile = path.join(__dirname, '../socket_debug.log');
                    const logMessage = (msg) => {
                        const time = new Date().toISOString();
                        fs.appendFileSync(logFile, `[${time}] [ScheduledTimeoutJob] ${msg}\n`);
                    };
                    
                    logMessage(`Timeout job triggered for request ${requestid}`);
                    const rcheck = await DataFind(`SELECT id, bidding_d_price FROM tbl_request_vehicle WHERE id = '${requestid}' AND c_id = '${c_id}'`);
                    if (rcheck != "") {
                        if (rcheck[0].bidding_d_price && rcheck[0].bidding_d_price != "") {
                            logMessage(`Request ${requestid} has active driver bids (${rcheck[0].bidding_d_price}). Skipping ScheduledTimeoutJob.`);
                            return;
                        }
                        logMessage(`Request still exists in tbl_request_vehicle. Updating d_id to []`);
                        await DataUpdate(`tbl_request_vehicle`, `d_id = '[]'`, `id = '${requestid}'`);

                        const parsedDrivers = typeof driverid == "string" ? JSON.parse(driverid) : driverid;
                        if (parsedDrivers && parsedDrivers.length) {
                            for (let i = 0; i < parsedDrivers.length;) {
                                logMessage(`Emitting removeotherdata${parsedDrivers[i]} to user_${parsedDrivers[i]}`);
                                io.to("user_" + parsedDrivers[i]).emit(`removeotherdata${parsedDrivers[i]}`, homemessage);
                                i++;
                            }
                        }
                    } else {
                        logMessage(`Request not found (probably accepted or completed). Skipping.`);
                    }
                });
                
                jobs.push({job, req_id: requestid, c_id: c_id, driver_id: driverid});
            }
        }

        const jsndlist = typeof driverid == "string" ? JSON.parse(driverid) : driverid;
        if (jsndlist && jsndlist.length) {
            let totdlen = jsndlist.length;
            for (let i = 0; i < totdlen;) {
                io.to("user_" + jsndlist[i]).emit(`vehiclerequest${jsndlist[i]}`, homemessage)
                i++;
            }
        }

    })
    
    // // Check Bidding Data
    socket.on('load_bidding_data', async (homemessage) => {
        const {uid, request_id, d_id, m_role} = homemessage;
        
        const missingField = await AllFunction.CheckSocketData(homemessage, ["uid", "request_id", "d_id", "m_role"]);
        if (!missingField) {
            
            const hostname = socket.request.headers.host;
            const protocol = socket.request.connection.encrypted ? 'https' : 'http';
    
            let ddatas = await AllFunction.VehicleBidding(d_id, request_id, 0, 2,m_role, hostname, protocol);
            
            if (ddatas != false) {
                io.to("user_" + uid).emit(`Vehicle_Bidding${uid}`, ddatas);
            }
        }
    })

    // // Send Vehicle Bidding Request
    socket.on('Vehicle_Bidding', async (homemessage) => {
        const fs = require('fs');
        const path = require('path');
        const logFile = path.join(__dirname, '../socket_debug.log');
        const logMessage = (msg) => {
            const time = new Date().toISOString();
            fs.appendFileSync(logFile, `[${time}] [Vehicle_Bidding] ${msg}\n`);
        };
        
        logMessage(`Event received: ${JSON.stringify(homemessage)}`);
        
        const {uid, request_id, c_id, price, status, m_role} = homemessage;
        const missingField = await AllFunction.CheckSocketData(homemessage, ["uid", "request_id", "c_id", "price", "status", "m_role"]);
        logMessage(`missingField = ${missingField}`);

        const hostname = socket.request.headers.host;
        const protocol = socket.request.connection.encrypted ? 'https' : 'http';

        if (status == "1" || !missingField) {
            logMessage(`Calling AllFunction.VehicleBidding with uid=${uid}, request_id=${request_id}, price=${price}, status=1, m_role=${m_role}`);
            let ddata = await AllFunction.VehicleBidding(uid, request_id, price, 1, m_role, hostname, protocol);
            logMessage(`AllFunction.VehicleBidding result: ${JSON.stringify(ddata)}`);
            
            if (ddata != false) {
                const eventName = `Vehicle_Bidding${c_id}`;
                logMessage(`Emitting ${eventName} to user_${c_id}`);
                io.to("user_" + c_id).emit(`Vehicle_Bidding${c_id}`, ddata);
                
                if (parseFloat(ddata.off_ex_time) > 0) {

                    let addtime = parseFloat(ddata.off_ex_time);
                    let job = schedule.scheduleJob(new Date(Date.now() + parseFloat(addtime) * 1000), async function() {
        
                        let checkdata = 0;
                        activeSchedules.forEach(val => {
                            if (val.request_id == request_id && val.d_id == uid  && val.c_id == c_id) checkdata++
                        })
                        
                        if (checkdata > 0) {
                            let ddatas = await AllFunction.VehicleBidding(uid, request_id, price, 2, m_role, hostname, protocol);

                            if (ddatas != false) {
                                io.to("user_" + ddatas.c_id).emit(`Vehicle_Bidding${ddatas.c_id}`, { bidding_list: ddatas.bidding_list, off_ex_time: ddatas.off_ex_time });
                                io.to("user_" + uid).emit(`Bidding_decline${uid}`, { request_id: request_id });
                            }
                        }
                        
                    });
        
                    activeSchedules.push({ request_id, d_id: uid, c_id, job });
                }
            }
        }

        if (status == "2") {

            activeSchedules.forEach(val => {
                if (val.request_id == request_id && val.d_id == uid  && val.c_id == c_id) {
                    val.job.cancel();
                }
            })

            let remove = await AllFunction.VehicleBidding(uid, request_id, price, 3, m_role, hostname, protocol);
            
            if (remove != false) {
                io.to("user_" + remove.c_id).emit(`Vehicle_Bidding${remove.c_id}`, { bidding_list: remove.bidding_list, off_ex_time: remove.off_ex_time });
            }
        }
    })

    

    // // Vehicle Request TimeOut 
    socket.on('Accept_Bidding', async(homemessage) => {
        
        const { uid, d_id, price, request_id, m_role } = homemessage;
        const missingField = await AllFunction.CheckSocketData(homemessage, ["uid", "d_id", "price", "request_id", "m_role"]);
        
        if (!missingField) {

            for (let i = 0; i < jobs.length; ) {
                
                if (jobs[i].req_id == request_id) {
                    jobs[i].job.cancel();
                }
                i++;
            }

            const rd = await DataFind(`SELECT * FROM tbl_request_vehicle WHERE id = '${request_id}' AND JSON_CONTAINS(d_id, '${d_id}')`);
            if (rd != "") { 

                activeSchedules.forEach(val => {
                    if (val.request_id == request_id) {
                        val.job.cancel();
                    }
                });

                const hostname = socket.request.headers.host;
                const protocol = socket.request.connection.encrypted ? 'https' : 'http';

                const accept = await AllFunction.AcceptVehicleRide(d_id, request_id, "0", "0", m_role, hostname, protocol, price, rd);

                if(accept != "1" && accept != "2" && accept != "3" && accept != "databaseerror") {
                    let idl = typeof accept.reqmoveid == "string" ? JSON.parse(accept.reqmoveid) : accept.reqmoveid;
                    if (idl && idl.length) {
                        let totdlen = idl.length;
                        for (let i = 0; i < totdlen;) {
                            io.to("user_" + idl[i]).emit(`AcceRemoveOther${idl[i]}`, { requestid: accept.requestid, driverid: idl});
                            i++;
                        }
                    }
                    
                    io.to("user_" + d_id).emit(`Accept_Bidding${d_id}`, {requestid:accept.requestid});
                    
                    // Notify the customer's room so that other customer sessions (e.g. Website) synchronize and close the modal
                    io.to("user_" + uid).emit(`acceptvehrequest${uid}`, {
                        request_id: accept.requestid,
                        uid: d_id,
                        c_id: uid
                    });
                }
            }
        }
    })


    
    // // Vehicle Bidding Decline
    socket.on('Bidding_decline', async(homemessage) => {

        const { uid, id, request_id, m_role } = homemessage;
        const missingField = await AllFunction.CheckSocketData(homemessage, ["uid", "id", "request_id", "m_role"]);

        if (!missingField) {
            const hostname = socket.request.headers.host;
            const protocol = socket.request.connection.encrypted ? 'https' : 'http';
    
            const accept = await AllFunction.VehicleBidding(id, request_id, "0", 4, m_role, hostname, protocol);
    
            if (accept != false) {
                activeSchedules.forEach(val => {
                    
                    if (val.request_id == request_id && val.d_id == id  && val.c_id == uid) {
                        val.job.cancel();
                    }
                })

                io.to("user_" + uid).emit(`Vehicle_Bidding${uid}`, accept);
                io.to("user_" + id).emit(`Bidding_decline${id}`, {request_id: request_id});
            }
        }
    })

    // // Vehicle Request TimeOut 
    socket.on('Driver_Bidding_Req_Reject', async (homemessage) => {
        
        const { uid, c_id, request_id, m_role } = homemessage;
        const missingField = await AllFunction.CheckSocketData(homemessage, ["uid", "c_id", "request_id", "m_role"]);
        
        if (!missingField) {
            const hostname = socket.request.headers.host;
            const protocol = socket.request.connection.encrypted ? 'https' : 'http';
    
            const accept = await AllFunction.VehicleBidding(uid, request_id, "0", 4, m_role, hostname, protocol);
            
            if (accept != false) {
                
                activeSchedules.forEach(val => {
                    
                    if (val.request_id == request_id && val.d_id == uid  && val.c_id == c_id) {
                        val.job.cancel();
                    }
                })

                // Do not emit to the customer on driver rejection to prevent closing the bidding bottom sheet
                // io.to("user_" + c_id).emit(`Vehicle_Bidding${c_id}`, accept);
            }
        }
    })



    // // Vehicle Request TimeOut 
    socket.on('RequestTimeOut', (homemessage) => {
        const fs = require('fs');
        const path = require('path');
        const logFile = path.join(__dirname, '../socket_debug.log');
        const logMessage = (msg) => {
            const time = new Date().toISOString();
            fs.appendFileSync(logFile, `[${time}] [RequestTimeOut] ${msg}\n`);
        };
        logMessage(`RequestTimeOut received: ${JSON.stringify(homemessage)}`);
        const {driverid} = homemessage; 
        const jdlist = typeof driverid == "string" ? JSON.parse(driverid) : driverid;
        if (jdlist && jdlist.length) {
            const dlen = jdlist.length;
            for (let i = 0; i < dlen;) {
                logMessage(`Emitting RequestTimeOut${jdlist[i]} to user_${jdlist[i]}`);
                io.to("user_" + jdlist[i]).emit(`RequestTimeOut${jdlist[i]}`, homemessage);
                i++;
            }
        }
    })

    // // Accept Vehicle Ride Request   { uid: '14', request_id: '27', c_id: '20' }
    socket.on('acceptvehrequest', async (homemessage) => {

        const {uid, request_id, c_id} = homemessage;

        for (let i = 0; i < jobs.length; ) {
        
            if (jobs[i].req_id == request_id) {
                console.log(jobs[i]);
                jobs[i].job.cancel();
            }
            i++
        }

        let ddata = await AllFunction.SendDriverLatLong(homemessage.uid);

        const rd = await DataFind(`SELECT id, driver_id_list FROM tbl_cart_vehicle WHERE id = '${request_id}' AND c_id = '${c_id}' AND d_id = '${uid}'`);
        if (rd != "") {
            let idlist = typeof rd[0].driver_id_list == "string" ? JSON.parse(rd[0].driver_id_list) : rd[0].driver_id_list;
            if (idlist && idlist.length) {
                let totdlen = idlist.length;
                for (let i = 0; i < totdlen;) {
                    io.to("user_" + idlist[i]).emit(`AcceRemoveOther${idlist[i]}`, { requestid:request_id, driverid: idlist});
                    i++;
                }
            }
        }
        
        io.to("user_" + c_id).emit(`acceptvehrequest${c_id}`, homemessage);

        if (ddata && ddata.driver && ddata.driver.length && ddata.data && ddata.data.length) {
            let d = ddata.data;
            for (let i = 0; i < d.length;) {
                io.to("user_" + d[i].c_id).emit(`V_Driver_Location${d[i].c_id}`, {d_id : homemessage.uid, driver_location:ddata.driver[0]});
                i++;
            }
        }
    })

    // // Accept Vehicle Ride Request and Remove other driver
    socket.on('AcceRemoveOther', async(homemessage) => {
        const fs = require('fs');
        const path = require('path');
        const logFile = path.join(__dirname, '../socket_debug.log');
        const logMessage = (msg) => {
            const time = new Date().toISOString();
            fs.appendFileSync(logFile, `[${time}] [AcceRemoveOther] ${msg}\n`);
        };
        logMessage(`AcceRemoveOther received: ${JSON.stringify(homemessage)}`);
        const missingField = await AllFunction.CheckSocketData(homemessage, ["driverid"]);
        if (!missingField) {
            const dl = typeof homemessage.driverid == "string" ? JSON.parse(homemessage.driverid) : homemessage.driverid;
            if (dl && dl.length) {
                const totdlen = dl.length;
                for (let i = 0; i < totdlen;) {
                    logMessage(`Emitting AcceRemoveOther${dl[i]} to user_${dl[i]}`);
                    io.to("user_" + dl[i]).emit(`AcceRemoveOther${dl[i]}`, homemessage);
                    i++;
                }
            }
        }
    })



    // // Vehicle Ride Time Update
    socket.on('Vehicle_Time_update', async (homemessage) => {
        
        const hostname = socket.request.headers.host;
        const protocol = socket.request.connection.encrypted ? 'https' : 'http';

        let date = await AllFunction.TimeUpdate(homemessage, hostname, protocol)
        if (date === true) io.to("user_" + homemessage.c_id).emit(`Vehicle_Time_update${homemessage.c_id}`, homemessage);
    })

    // // Vehicle Ride Time Over Request
    socket.on('Vehicle_Time_Request', async (homemessage) => {

        io.to("user_" + homemessage.d_id).emit(`Vehicle_Time_Request${homemessage.d_id}`, homemessage);
    })

    // // Driver Request Accept And Cancel
    socket.on('Vehicle_Accept_Cancel', async(homemessage) => {
        const {uid, request_id, c_id} = homemessage;

        const missingField = await AllFunction.CheckSocketData(homemessage, ["uid", "request_id", "c_id"]);
        if (!missingField) io.to("user_" + c_id).emit(`Vehicle_Accept_Cancel${c_id}`, { request_id, d_id: uid });
    })

    // // Rider Pick Customer
    socket.on('Vehicle_D_IAmHere', (homemessage) => {
        const { c_id } = homemessage;
        if (c_id) {
            io.to("user_" + c_id).emit('Vehicle_D_IAmHere', homemessage);
        } else {
            socket.broadcast.emit('Vehicle_D_IAmHere', homemessage);
        }
    })

    // // Rider Cancel
    socket.on('Vehicle_Ride_Cancel', (homemessage) => {
        const fs = require('fs');
        const path = require('path');
        const logFile = path.join(__dirname, '../socket_debug.log');
        const logMessage = (msg) => {
            const time = new Date().toISOString();
            fs.appendFileSync(logFile, `[${time}] [Vehicle_Ride_Cancel] ${msg}\n`);
        };
        logMessage(`Vehicle_Ride_Cancel received: ${JSON.stringify(homemessage)}`);
        let { uid, driverid } = homemessage;
        if (!driverid) return;

        let drivers = [];
        if (Array.isArray(driverid)) {
            drivers = driverid;
        } else if (typeof driverid === 'string') {
            try {
                let parsed = JSON.parse(driverid);
                if (Array.isArray(parsed)) {
                    drivers = parsed;
                } else {
                    drivers = [parsed];
                }
            } catch (e) {
                if (driverid.includes(',')) {
                    drivers = driverid.split(',').map(d => d.trim());
                } else {
                    drivers = [driverid];
                }
            }
        } else {
            drivers = [driverid];
        }

        drivers.forEach(dId => {
            if (dId !== null && dId !== undefined && dId !== '') {
                logMessage(`Emitting Vehicle_Ride_Cancel${dId} to user_${dId}`);
                io.to("user_" + dId).emit(`Vehicle_Ride_Cancel${dId}`, { uid: uid, driverid: dId });
            }
        });

        if (uid) {
            io.to("user_" + uid).emit(`Vehicle_Ride_Cancel_Client${uid}`, { uid });
        }
    })

    // // Rider OTP
    socket.on('Vehicle_Ride_OTP', (homemessage) => {
        const { c_id } = homemessage;
        if (c_id) {
            io.to("user_" + c_id).emit('Vehicle_Ride_OTP', homemessage);
        } else {
            socket.broadcast.emit('Vehicle_Ride_OTP', homemessage);
        }
    })

    // // Rider Start And End   { uid: '14', request_id: '27', c_id: '20' }
    socket.on('Vehicle_Ride_Start_End', async (homemessage) => {
        const {uid, c_id, request_id} = homemessage;

        // uid, d_id, request_id
        let dropdata = await AllFunction.VehicleRideStartEndData(uid, c_id, request_id);
        let ddata = await AllFunction.SendDriverLatLong(uid);
        // console.log(ddata);

        io.to("user_" + c_id).emit(`Vehicle_Ride_Start_End${c_id}`, dropdata);

        if (ddata && ddata.driver && ddata.driver.length && ddata.data && ddata.data.length) {
            let d = ddata.data;
            for (let i = 0; i < d.length;) {
                io.to("user_" + d[i].c_id).emit(`V_Driver_Location${d[i].c_id}`, {d_id : homemessage.uid, driver_location: ddata.driver[0]});
                i++;
            }
        }

        if (dropdata.status == "7") {

            const hostname = socket.request.headers.host;
            const protocol = socket.request.connection.encrypted ? 'https' : 'http';
            const payment_price = await AllFunction.VehiclePaymentCal(uid, c_id, request_id, 2, hostname, protocol);
            
            if (payment_price == "1" || !payment_price) io.to("user_" + c_id).emit(`Vehicle_Ride_Payment${c_id}`, { ResponseCode: 401, Result:false, message: 'Request Not Found!' });
            if (payment_price == "2") io.to("user_" + c_id).emit(`Vehicle_Ride_Payment${c_id}`, { ResponseCode: 401, Result:false, message: 'Please Complete Other Stap!' });
            if (payment_price == "3" || payment_price == "4") io.to("user_" + c_id).emit(`Vehicle_Ride_Payment${c_id}`, { ResponseCode: 401, Result:false, message: 'Something went wrong' });

            if (payment_price != "1" || payment_price != "2"|| payment_price != "3") io.to("user_" + c_id).emit(`Vehicle_Ride_Payment${c_id}`, 
            {ResponseCode: 200, Result:true, message: "Ride Complete Successful", price_list: payment_price.price_list, payment_data: payment_price.payment, 
            review_list:payment_price.review_list});
        }

        // let driver = await AllFunction.SendDriverLatLong(uid)
        // if (driver != "") socket.broadcast.emit(`V_Driver_Location${homemessage.c_id}`, {d_id : uid, driver_location:driver.driver[0]})
    })

    // // Dorp Location
    socket.on('drop_location_list', async (homemessage) => {
        const {d_id, c_id, r_id} = homemessage;

        let dropdata = await AllFunction.VehicleRideStartEndData(d_id, c_id, r_id);
         
        io.to("user_" + c_id).emit(`drop_location${c_id}`, dropdata);
    })


    // // Payment Method Change
    socket.on('Vehicle_P_Change', async (homemessage) => {
        const payment = await DataFind(`SELECT id, image, name FROM tbl_payment_detail WHERE id = '${homemessage.payment_id}' AND status = '1'`);
        
        if (payment != "") {
            await DataUpdate(`tbl_cart_vehicle`, `payment_id = '${payment[0].id}'`, `d_id = '${homemessage.d_id}' AND c_id = '${homemessage.userid}'`,
            socket.request.headers.host, socket.request.connection.encrypted ? 'https' : 'http');

            io.to("user_" + homemessage.d_id).emit(`Vehicle_P_Change${homemessage.d_id}`, {payment_data:payment[0]});
        }
    })

    // // Payment Successful And Complete Ride
    socket.on('Vehicle_Ride_Complete', async (homemessage) => {
        const fs = require('fs');
        const path = require('path');
        const logFile = path.join(__dirname, '../socket_debug.log');
        const logMessage = (msg) => {
            const time = new Date().toISOString();
            fs.appendFileSync(logFile, `[${time}] ${msg}\n`);
        };

        logMessage(`Vehicle_Ride_Complete event received with message: ${JSON.stringify(homemessage)}`);
        io.to("user_" + homemessage.d_id).emit(`Vehicle_Ride_Complete${homemessage.d_id}`, homemessage);

        try {
            let check = await DataFind(`SELECT id, c_id FROM tbl_order_vehicle WHERE id = '${homemessage.request_id}' OR req_id = '${homemessage.request_id}'`);
            logMessage(`Query tbl_order_vehicle result: ${JSON.stringify(check)}`);
            if (check == "") {
                check = await DataFind(`SELECT id, c_id FROM tbl_cart_vehicle WHERE id = '${homemessage.request_id}' OR req_id = '${homemessage.request_id}'`);
                logMessage(`Query tbl_cart_vehicle result: ${JSON.stringify(check)}`);
            }
            if (check != "") {
                const c_id = check[0].c_id;
                const order_id = check[0].id;
                const eventName = `Vehicle_Ride_Complete_Client${c_id}`;
                logMessage(`Broadcasting ${eventName} to user_${c_id} room with order_id: ${order_id}`);
                io.to("user_" + c_id).emit(eventName, {
                    ...homemessage,
                    order_id: order_id
                });
            } else {
                logMessage(`No order or cart found for request_id: ${homemessage.request_id}`);
            }
        } catch (e) {
            logMessage(`Error broadcasting complete to client room: ${e.message}`);
            console.error("Error broadcasting complete to client room:", e);
        }
    })






    

    // // Save Chat
    // Remove any previous listener to prevent duplicate handlers on reconnect
    socket.removeAllListeners('Send_Chat');
    socket.on('Send_Chat', async (homemessage) => {
        // status :- customer, driver
        
        const {sender_id, recevier_id, message, status} = homemessage;

        const hostname = socket.request.headers.host;
        const protocol = socket.request.connection.encrypted ? 'https' : 'http';
        let save_chat = await AllChat.Chat_Save(sender_id, sender_id, recevier_id, message, status, hostname, protocol);
        
        if (save_chat != false) {
            // let chat_list = await AllChat.AllChat(uid, sender_id, recevier_id, status, 1);
            
            io.to("user_" + recevier_id).emit(`New_Chat${recevier_id}`, { new_date: save_chat.today_date, id: save_chat.id, sender_id, message, date: save_chat.date });
            io.to("user_" + sender_id).emit(`New_Chat${sender_id}`, { new_date: save_chat.today_date, id: save_chat.id, sender_id, message, date: save_chat.date });
        }
    })


    socket.on("disconnect", () => {
        // console.log("Socket disconnected");
    });


});

}




module.exports = { publicsocket };