/* jshint esversion: 6 */
/* jshint esversion: 8 */
/* jshint node: true */



const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const multer  = require('multer');
const mysql = require("mysql2");
const sendOneNotification = require("../middleware/send");
let Excel = require('exceljs');
const { DataFind, DataInsert, DataUpdate, DataDelete } = require("../middleware/databse_query");



// ============= Vehicle Report ================ //

async function DailyReport(where) {
    const all = await DataFind(`SELECT
                                    COUNT(*) AS today,
                                    COALESCE(SUM(CASE WHEN status = '1' THEN 1 ELSE 0 END), 0) AS accept,
                                    COALESCE(SUM(CASE WHEN status = '2' THEN 1 ELSE 0 END), 0) AS iamhere,
                                    COALESCE(SUM(CASE WHEN status = '3' THEN 1 ELSE 0 END), 0) AS enterotp,
                                    COALESCE(SUM(CASE WHEN status = '4' THEN 1 ELSE 0 END), 0) AS cancel,
                                    COALESCE(SUM(CASE WHEN status = '5' THEN 1 ELSE 0 END), 0) AS start,
                                    COALESCE(SUM(CASE WHEN status = '6' THEN 1 ELSE 0 END), 0) AS end,
                                    COALESCE(SUM(CASE WHEN status = '7' THEN 1 ELSE 0 END), 0) AS ridecomplete,
                                    COALESCE(SUM(CASE WHEN status = '8' THEN 1 ELSE 0 END), 0) AS complete
                                FROM tbl_cart_vehicle ${where}`);

    const com = await DataFind(`SELECT
                                    COUNT(*) AS today,
                                    COALESCE(SUM(CASE WHEN status = '1' THEN 1 ELSE 0 END), 0) AS accept,
                                    COALESCE(SUM(CASE WHEN status = '2' THEN 1 ELSE 0 END), 0) AS iamhere,
                                    COALESCE(SUM(CASE WHEN status = '3' THEN 1 ELSE 0 END), 0) AS enterotp,
                                    COALESCE(SUM(CASE WHEN status = '4' THEN 1 ELSE 0 END), 0) AS cancel,
                                    COALESCE(SUM(CASE WHEN status = '5' THEN 1 ELSE 0 END), 0) AS start,
                                    COALESCE(SUM(CASE WHEN status = '6' THEN 1 ELSE 0 END), 0) AS end,
                                    COALESCE(SUM(CASE WHEN status = '7' THEN 1 ELSE 0 END), 0) AS ridecomplete,
                                    COALESCE(SUM(CASE WHEN status = '8' THEN 1 ELSE 0 END), 0) AS complete
                                FROM tbl_order_vehicle ${where}`);
    
    let allstatus = [{ total: parseFloat(all[0].today) + parseFloat(com[0].today) }, { accept: parseFloat(all[0].accept) + parseFloat(com[0].accept) }, 
                    { iamhere: parseFloat(all[0].iamhere) + parseFloat(com[0].iamhere) }, { enterotp: parseFloat(all[0].enterotp) + parseFloat(com[0].enterotp) }, 
                    { cancel: parseFloat(all[0].cancel) + parseFloat(com[0].cancel) }, { start: parseFloat(all[0].start) + parseFloat(com[0].start) }, 
                    { end: parseFloat(all[0].end) + parseFloat(com[0].end) }, { ridecomplete: parseFloat(all[0].ridecomplete) + parseFloat(com[0].ridecomplete) }, 
                    { complete: parseFloat(all[0].complete) + parseFloat(com[0].complete) }];
    return allstatus;
}

router.get("/vehicle_daily", auth, async(req, res)=>{
    try {
        const driver = await DataFind(`SELECT * FROM tbl_driver ORDER BY id DESC`);
        let today = new Date().toISOString().split("T")[0];
        let daily_list = await DailyReport(`WHERE start_time LIKE '%${today}%'`);
        const moduled = await DataFind(`SELECT id, name FROM tbl_module_setting`);

        res.render("report_vehicle_daily", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, driver, daily_list, today, moduled
        })
    } catch (error) {
        console.log(error);
    }
})

router.post("/daily_data", auth, async(req, res)=>{
    try {
        let {date, sid, ridet} = req.body;

        let where = "", daily_list = "";

        let mtylist = [ "", "cv.m_role = '1'", "cv.m_role = '2'", "cv.m_role = '3'", "cv.m_role = '4'" ];
        let ml = mtylist[Number(ridet)];

        if (date && sid && ridet) {
            where = `WHERE start_time LIKE '%${date}%' AND d_id = "${sid}" ${ml != '' ? 'AND ' + ml : ''} `;
            daily_list = await DailyReport(where);

        } else if (date && sid) {
            where = `WHERE start_time LIKE '%${date}%' AND d_id = "${sid}"`;
            daily_list = await DailyReport(where);

        } else if (sid && ridet) {
            where = `WHERE d_id = "${sid}" ${ml != '' ? 'AND ' + ml : ''}`;
            daily_list = await DailyReport(where);

        } else if (date && ridet) {
            where = `WHERE start_time LIKE '%${date}%' ${ml != '' ? 'AND ' + ml : ''}`;
            daily_list = await DailyReport(where);

        } else if (date) {
            where = `WHERE start_time LIKE '%${date}%'`;
            daily_list = await DailyReport(where);

        } else if (sid) {
            where = `WHERE d_id = "${sid}"`;
            daily_list = await DailyReport(where);
            
        } else if(ridet) {
            where = `${ml != '' ? 'WHERE ' + ml : ''}`;
            daily_list = await DailyReport(where);
        }

        console.log(daily_list);
        
        res.send({ daily_list });
    } catch (error) {
        console.log(error);
    }
});





router.get("/ride_payment", auth, async(req, res)=>{
    try {
        const rd = await DataFind(`SELECT cv.id, cv.c_id, cv.d_id, cv.price, cv.start_time, COALESCE(cus.name, '') AS cname, COALESCE(dri.first_name, '') AS dfname,
                                    COALESCE(dri.last_name, '') AS dlname, COALESCE(pay.name, '') AS pay_name
                                    FROM tbl_order_vehicle AS cv
                                    LEFT JOIN tbl_customer AS cus ON cv.c_id = cus.id
                                    LEFT JOIN tbl_driver AS dri ON cv.d_id = dri.id
                                    LEFT JOIN tbl_payment_detail AS pay ON cv.payment_id = pay.id
                                    WHERE cv.status = '8'
                                    ORDER BY cv.id DESC`);

        const moduled = await DataFind(`SELECT id, name FROM tbl_module_setting`);
        const vehicles = await DataFind(`SELECT id, name FROM tbl_vehicle WHERE status = '1'`);
        const payments = await DataFind(`SELECT id, name FROM tbl_payment_detail`);
        const zones = await DataFind(`SELECT id, name FROM tbl_zone WHERE status = '1'`);
        
        rd.map(rdval => {
            let sdate = new Date(rdval.start_time);
            const sformattedDate = sdate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
            rdval.start_time = sformattedDate;
        });
        
        res.render("report_ride_payment", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd, moduled, vehicles, payments, zones
        });
    } catch (error) {
        console.log(error);
    }
});

async function PaymentData(where) {
    const rd = await DataFind(`SELECT cv.id, cv.c_id, cv.d_id, cv.price, cv.start_time, COALESCE(cus.name, '') AS cname, COALESCE(dri.first_name, '') AS dfname,
                                    COALESCE(dri.last_name, '') AS dlname, COALESCE(pay.name, '') AS pay_name
                                    FROM tbl_order_vehicle AS cv
                                    LEFT JOIN tbl_customer AS cus ON cv.c_id = cus.id
                                    LEFT JOIN tbl_driver AS dri ON cv.d_id = dri.id
                                    LEFT JOIN tbl_payment_detail AS pay ON cv.payment_id = pay.id
                                    ${where}
                                    ORDER BY cv.id DESC`);

    rd.map(rdval => {
        let sdate = new Date(rdval.start_time);
        const sformattedDate = sdate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        rdval.start_time = sformattedDate;
    });
    return rd;
}

async function PaymentDataWhere(sdate, edate, ridet, vehicle_id, payment_id, zone_id) {
    let where = "WHERE cv.status = '8'";

    if (sdate) {
        where += ` AND cv.start_time >= '${sdate}'`;
    }
    if (edate) {
        where += ` AND cv.end_time <= '${edate}T23:59:59.999Z'`;
    }
    if (ridet && ridet !== '0' && ridet !== '') {
        where += ` AND cv.m_role = '${ridet}'`;
    }
    if (vehicle_id && vehicle_id !== '0' && vehicle_id !== '') {
        where += ` AND cv.vehicleid = '${vehicle_id}'`;
    }
    if (payment_id && payment_id !== '0' && payment_id !== '') {
        where += ` AND cv.payment_id = '${payment_id}'`;
    }
    if (zone_id && zone_id !== '0' && zone_id !== '') {
        where += ` AND FIND_IN_SET('${zone_id}', REPLACE(REPLACE(REPLACE(cv.zone, '[', ''), ']', ''), '"', '')) > 0`;
    }

    return await PaymentData(where);
}

router.post("/rpaymentd", auth, async(req, res)=>{
    try {
        let {sdate, edate, ridet, vehicle_id, payment_id, zone_id} = req.body;

        const data = await PaymentDataWhere(sdate, edate, ridet, vehicle_id, payment_id, zone_id);
        let wdata = req.lan.ld.Wallet;
        
        res.send({ data, wdata });
    } catch (error) {
        console.log(error);
    }
});

router.get("/down_rpaymentd/:id", auth, async(req, res)=>{
    try {
        const sdate = req.query.sdate || req.params.id.split("&")[0];
        const edate = req.query.edate || req.params.id.split("&")[1];
        const ridet = req.query.ridet || req.params.id.split("&")[2] || "";
        const vehicle_id = req.query.vehicle_id || req.params.id.split("&")[3] || "";
        const payment_id = req.query.payment_id || req.params.id.split("&")[4] || "";
        const zone_id = req.query.zone_id || req.params.id.split("&")[5] || "";

        const {site_currency, currency_placement, thousands_separator} = req.general;
        
        const data = await PaymentDataWhere(sdate, edate, ridet, vehicle_id, payment_id, zone_id);
        data.map(pval => {
            let p = pval.price;
            let num_parts = p.toString().split(".");
            let sprated = num_parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands_separator);

            if (currency_placement == "0") p = `${site_currency} ${sprated}`
            if (currency_placement == "1") p = `${sprated} ${site_currency}`

            pval.id = `#${pval.id}`
            pval.price = p
            pval.dfname = `${pval.dfname} ${pval.dlname}`
            pval.pay_name = pval.pay_name && pval.pay_name.trim() !== '' ? pval.pay_name : 'Wallet'
        })

        let workbook = new Excel.Workbook();
        let worksheet = workbook.addWorksheet("paymentreport");

        worksheet.columns = [
            { header: 'Rider', key: 'cname', width: 35},
            { header: 'Driver', key: 'dfname', width: 35},
            { header: 'Ride', key: 'id', width: 30},
            { header: 'Payment Type', key: 'pay_name', width: 35},
            { header: 'Amount', key: 'price', width: 30},
            { header: 'Date', key: 'start_time', width: 40},
      
        ];
        data.forEach(function(row){ worksheet.addRow(row); })
        
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
            "Content-Disposition",
            "attachment; filename=" + "paymentreport.xlsx"
        );

        return workbook.xlsx.write(res).then(function () {
            res.status(200).end
        });
    } catch (error) {
        console.log(error);
    }
});





// ============= Driver Earnings Report ================ //

async function DriverEarningsData(where) {
    return await DataFind(`
        SELECT cv.d_id,
               COALESCE(dri.first_name, '') AS first_name,
               COALESCE(dri.last_name, '') AS last_name,
               COALESCE(dri.primary_ccode, '') AS primary_ccode,
               COALESCE(dri.primary_phoneNo, '') AS primary_phoneNo,
               COUNT(cv.id) AS trips,
               COALESCE(SUM(CAST(cv.price AS DECIMAL(15,2))), 0) AS total_revenue,
               COALESCE(SUM(CASE WHEN cv.payment_id = '9' THEN CAST(cv.price AS DECIMAL(15,2)) ELSE 0 END), 0) AS cash_collected,
               COALESCE(SUM(CASE WHEN cv.payment_id != '9' THEN CAST(cv.price AS DECIMAL(15,2)) ELSE 0 END), 0) AS online_payments,
               COALESCE(SUM(CAST(cv.platform_fee AS DECIMAL(15,2))), 0) AS commission
        FROM tbl_order_vehicle AS cv
        INNER JOIN tbl_driver AS dri ON cv.d_id = dri.id
        LEFT JOIN tbl_payment_detail AS pay ON cv.payment_id = pay.id
        ${where}
        GROUP BY cv.d_id
        ORDER BY total_revenue DESC
    `);
}

router.get("/driver_earnings", auth, async(req, res)=>{
    try {
        const drivers = await DataFind(`SELECT id, first_name, last_name, primary_ccode, primary_phoneNo FROM tbl_driver WHERE status = '1' AND approval_status = '1'`);
        const zones = await DataFind(`SELECT id, name FROM tbl_zone WHERE status = '1'`);
        const data = await DriverEarningsData("WHERE cv.status = '8'");

        res.render("report_driver_earnings", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, data, drivers, zones
        });
    } catch (error) {
        console.log(error);
    }
});

router.post("/rdriverearningsd", auth, async(req, res)=>{
    try {
        let {sdate, edate, driver_id, zone_id} = req.body;
        let where = "WHERE cv.status = '8'";

        if (sdate) where += ` AND cv.start_time >= '${sdate}'`;
        if (edate) where += ` AND cv.end_time <= '${edate}T23:59:59.999Z'`;
        if (driver_id && driver_id !== '0') where += ` AND cv.d_id = '${driver_id}'`;
        if (zone_id && zone_id !== '0') where += ` AND FIND_IN_SET('${zone_id}', REPLACE(REPLACE(REPLACE(cv.zone, '[', ''), ']', ''), '"', '')) > 0`;

        const data = await DriverEarningsData(where);
        res.send({ data });
    } catch (error) {
        console.log(error);
    }
});

router.get("/down_rdriverearningsd", auth, async(req, res)=>{
    try {
        let {sdate, edate, driver_id, zone_id} = req.query;
        let where = "WHERE cv.status = '8'";

        if (sdate) where += ` AND cv.start_time >= '${sdate}'`;
        if (edate) where += ` AND cv.end_time <= '${edate}T23:59:59.999Z'`;
        if (driver_id && driver_id !== '0') where += ` AND cv.d_id = '${driver_id}'`;
        if (zone_id && zone_id !== '0') where += ` AND FIND_IN_SET('${zone_id}', REPLACE(REPLACE(REPLACE(cv.zone, '[', ''), ']', ''), '"', '')) > 0`;

        const data = await DriverEarningsData(where);
        const {site_currency, currency_placement, thousands_separator} = req.general;

        data.forEach((val, i) => {
            val.id = i + 1;
            val.driver_name = `${val.first_name} ${val.last_name} (${val.primary_ccode} ${val.primary_phoneNo})`;
            val.net_earnings = val.total_revenue - val.commission;
            
            // Format currency fields
            ['total_revenue', 'cash_collected', 'online_payments', 'commission', 'net_earnings'].forEach(key => {
                let p = parseFloat(val[key]) || 0;
                let num_parts = p.toFixed(2).split(".");
                let sprated = num_parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands_separator);
                let formatted = currency_placement == "0" ? `${site_currency} ${sprated}.${num_parts[1]}` : `${sprated}.${num_parts[1]} ${site_currency}`;
                val[key + '_formatted'] = formatted;
            });
        });

        let workbook = new Excel.Workbook();
        let worksheet = workbook.addWorksheet("Driver Earnings");

        worksheet.columns = [
            { header: '#', key: 'id', width: 10},
            { header: 'Driver', key: 'driver_name', width: 40},
            { header: 'Trips', key: 'trips', width: 15},
            { header: 'Total Revenue', key: 'total_revenue_formatted', width: 25},
            { header: 'Cash Collected', key: 'cash_collected_formatted', width: 25},
            { header: 'Online Payments', key: 'online_payments_formatted', width: 25},
            { header: 'Platform Commission', key: 'commission_formatted', width: 25},
            { header: 'Net Earnings', key: 'net_earnings_formatted', width: 25}
        ];

        data.forEach(row => worksheet.addRow(row));

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", "attachment; filename=driver_earnings.xlsx");

        return workbook.xlsx.write(res).then(() => res.status(200).end());
    } catch (error) {
        console.log(error);
    }
});


// ============= Cash Rides Report ================ //

async function CashRidesData(where) {
    return await DataFind(`
        SELECT cv.id, cv.c_id, cv.d_id, cv.price AS total_fare, cv.platform_fee AS commission, cv.start_time,
               COALESCE(cus.name, '') AS cname, 
               COALESCE(dri.first_name, '') AS dfname,
               COALESCE(dri.last_name, '') AS dlname,
               COALESCE(dri.primary_ccode, '') AS dccode,
               COALESCE(dri.primary_phoneNo, '') AS dphone
        FROM tbl_order_vehicle AS cv
        LEFT JOIN tbl_customer AS cus ON cv.c_id = cus.id
        LEFT JOIN tbl_driver AS dri ON cv.d_id = dri.id
        ${where}
        ORDER BY cv.id DESC
    `);
}

router.get("/cash_rides", auth, async(req, res)=>{
    try {
        const zones = await DataFind(`SELECT id, name FROM tbl_zone WHERE status = '1'`);
        const rd = await CashRidesData("WHERE cv.status = '8' AND cv.payment_id = '9'");

        rd.forEach(val => {
            let sdate = new Date(val.start_time);
            val.start_time = sdate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });
        });

        res.render("report_cash_rides", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd, zones
        });
    } catch (error) {
        console.log(error);
    }
});

router.post("/rcashridesd", auth, async(req, res)=>{
    try {
        let {sdate, edate, zone_id} = req.body;
        let where = "WHERE cv.status = '8' AND cv.payment_id = '9'";

        if (sdate) where += ` AND cv.start_time >= '${sdate}'`;
        if (edate) where += ` AND cv.end_time <= '${edate}T23:59:59.999Z'`;
        if (zone_id && zone_id !== '0') where += ` AND FIND_IN_SET('${zone_id}', REPLACE(REPLACE(REPLACE(cv.zone, '[', ''), ']', ''), '"', '')) > 0`;

        const data = await CashRidesData(where);
        data.forEach(val => {
            let sdate = new Date(val.start_time);
            val.start_time = sdate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });
        });
        res.send({ data });
    } catch (error) {
        console.log(error);
    }
});

router.get("/down_rcashridesd", auth, async(req, res)=>{
    try {
        let {sdate, edate, zone_id} = req.query;
        let where = "WHERE cv.status = '8' AND cv.payment_id = '9'";

        if (sdate) where += ` AND cv.start_time >= '${sdate}'`;
        if (edate) where += ` AND cv.end_time <= '${edate}T23:59:59.999Z'`;
        if (zone_id && zone_id !== '0') where += ` AND FIND_IN_SET('${zone_id}', REPLACE(REPLACE(REPLACE(cv.zone, '[', ''), ']', ''), '"', '')) > 0`;

        const data = await CashRidesData(where);
        const {site_currency, currency_placement, thousands_separator} = req.general;

        data.forEach(val => {
            let sdate = new Date(val.start_time);
            val.start_time = sdate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });
            val.driver_name = `${val.dfname} ${val.dlname} (${val.dccode} ${val.dphone})`;
            val.id = `#${val.id}`;

            let fare = parseFloat(val.total_fare) || 0;
            let comm = parseFloat(val.commission) || 0;
            let earn = fare - comm;
            val.driver_earnings = earn;

            // Format Currency
            ['total_fare', 'commission', 'driver_earnings'].forEach(key => {
                let p = parseFloat(val[key]) || 0;
                let num_parts = p.toFixed(2).split(".");
                let sprated = num_parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands_separator);
                val[key + '_formatted'] = currency_placement == "0" ? `${site_currency} ${sprated}.${num_parts[1]}` : `${sprated}.${num_parts[1]} ${site_currency}`;
            });
        });

        let workbook = new Excel.Workbook();
        let worksheet = workbook.addWorksheet("Cash Rides");

        worksheet.columns = [
            { header: 'Ride ID', key: 'id', width: 15},
            { header: 'Rider', key: 'cname', width: 30},
            { header: 'Driver', key: 'driver_name', width: 40},
            { header: 'Total Fare', key: 'total_fare_formatted', width: 25},
            { header: 'Platform Commission', key: 'commission_formatted', width: 25},
            { header: 'Driver Net Share', key: 'driver_earnings_formatted', width: 25},
            { header: 'Date', key: 'start_time', width: 35}
        ];

        data.forEach(row => worksheet.addRow(row));

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", "attachment; filename=cash_rides.xlsx");

        return workbook.xlsx.write(res).then(() => res.status(200).end());
    } catch (error) {
        console.log(error);
    }
});


// ============= Wallet Transactions Report ================ //

async function WalletTransactionsData(where) {
    return await DataFind(`
        SELECT wt.id, wt.c_id, wt.amount, wt.date, wt.payment_id, wt.status, wt.payment_proof, wt.rejection_reason,
               COALESCE(cus.name, '') AS cname,
               COALESCE(cus.country_code, '') AS country_code,
               COALESCE(cus.phone, '') AS phone,
               COALESCE(pay.name, 'Stripe') AS pay_name
        FROM tbl_transaction_customer AS wt
        LEFT JOIN tbl_customer AS cus ON wt.c_id = cus.id
        LEFT JOIN tbl_payment_detail AS pay ON wt.payment_id = pay.id
        ${where}
        ORDER BY wt.id DESC
    `);
}

router.get("/wallet_transactions", auth, async(req, res)=>{
    try {
        const customers = await DataFind(`SELECT id, name, country_code, phone FROM tbl_customer WHERE status = '1'`);
        const rd = await WalletTransactionsData("WHERE 1=1");

        rd.forEach(val => {
            let sdate = new Date(val.date);
            val.date = isNaN(sdate.getTime()) ? val.date : sdate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });
        });

        res.render("report_wallet_transactions", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd, customers
        });
    } catch (error) {
        console.log(error);
    }
});

router.post("/wallet_transaction_action", auth, async(req, res)=>{
    try {
        if (process.env.DISABLE_DB_WRITE === 'true') {
            req.flash('errors', 'For demo purpose we disabled crud operations!!');
            return res.redirect("back");
        }
        const { transaction_id, action_status, rejection_reason } = req.body;
        if (!transaction_id || !action_status) {
            req.flash('errors', 'Transaction ID and Action status are required.');
            return res.redirect("back");
        }

        const tx = await DataFind(`SELECT * FROM tbl_transaction_customer WHERE id = '${transaction_id}'`);
        if (tx.length === 0) {
            req.flash('errors', 'Transaction record not found.');
            return res.redirect("back");
        }

        if (tx[0].status !== '0') {
            req.flash('errors', 'This transaction is already processed.');
            return res.redirect("back");
        }

        if (action_status === 'approve') {
            // 1. Update status to success ('1')
            await DataUpdate(`tbl_transaction_customer`, `status = '1'`, `id = '${transaction_id}'`, req.hostname, req.protocol);
            
            // Standard wallet deposit approval
            const customer = await DataFind(`SELECT wallet FROM tbl_customer WHERE id = '${tx[0].c_id}'`);
            if (customer.length > 0) {
                const currentWallet = parseFloat(customer[0].wallet) || 0;
                const newWallet = currentWallet + parseFloat(tx[0].amount);
                await DataUpdate(`tbl_customer`, `wallet = '${newWallet.toFixed(2)}'`, `id = '${tx[0].c_id}'`, req.hostname, req.protocol);
            }
            req.flash('success', 'Transaction approved successfully! Wallet credited.');
        } else if (action_status === 'reject') {
            const reason = rejection_reason || 'Verification failed';
            await DataUpdate(`tbl_transaction_customer`, `status = '2', rejection_reason = '${reason}'`, `id = '${transaction_id}'`, req.hostname, req.protocol);
            req.flash('success', 'Transaction rejected successfully.');
        }

        res.redirect("/report/wallet_transactions");
    } catch (error) {
        console.error("wallet_transaction_action error:", error);
        req.flash('errors', 'An error occurred while processing manual payment transaction.');
        res.redirect("back");
    }
});

router.post("/rwallettransd", auth, async(req, res)=>{
    try {
        let {sdate, edate, customer_id, filter_status} = req.body;
        let where = "WHERE 1=1";

        if (filter_status && filter_status !== 'all') {
            where += ` AND wt.status = '${filter_status}'`;
        }
        if (sdate) where += ` AND wt.date >= '${sdate}'`;
        if (edate) where += ` AND wt.date <= '${edate}T23:59:59.999Z'`;
        if (customer_id && customer_id !== '0') where += ` AND wt.c_id = '${customer_id}'`;

        const data = await WalletTransactionsData(where);
        data.forEach(val => {
            let sdate = new Date(val.date);
            val.date = isNaN(sdate.getTime()) ? val.date : sdate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });
        });
        res.send({ data });
    } catch (error) {
        console.log(error);
    }
});

router.get("/down_rwallettransd", auth, async(req, res)=>{
    try {
        let {sdate, edate, customer_id, filter_status} = req.query;
        let where = "WHERE 1=1";

        if (filter_status && filter_status !== 'all') {
            where += ` AND wt.status = '${filter_status}'`;
        }
        if (sdate) where += ` AND wt.date >= '${sdate}'`;
        if (edate) where += ` AND wt.date <= '${edate}T23:59:59.999Z'`;
        if (customer_id && customer_id !== '0') where += ` AND wt.c_id = '${customer_id}'`;

        const data = await WalletTransactionsData(where);
        const {site_currency, currency_placement, thousands_separator} = req.general;

        data.forEach(val => {
            let sdate = new Date(val.date);
            val.date = isNaN(sdate.getTime()) ? val.date : sdate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });
            val.customer_name = `${val.cname} (${val.country_code} ${val.phone})`;
            val.id = `#${val.id}`;

            let p = parseFloat(val.amount) || 0;
            let num_parts = p.toFixed(2).split(".");
            let sprated = num_parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands_separator);
            val.amount_formatted = currency_placement == "0" ? `${site_currency} ${sprated}.${num_parts[1]}` : `${sprated}.${num_parts[1]} ${site_currency}`;
        });

        let workbook = new Excel.Workbook();
        let worksheet = workbook.addWorksheet("Wallet Deposits");

        worksheet.columns = [
            { header: 'Transaction ID', key: 'id', width: 20},
            { header: 'Customer', key: 'customer_name', width: 40},
            { header: 'Payment Method', key: 'pay_name', width: 25},
            { header: 'Amount Deposited', key: 'amount_formatted', width: 25},
            { header: 'Date', key: 'date', width: 35}
        ];

        data.forEach(row => worksheet.addRow(row));

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", "attachment; filename=wallet_transactions.xlsx");

        return workbook.xlsx.write(res).then(() => res.status(200).end());
    } catch (error) {
        console.log(error);
    }
});


// ============= Driver Payout Report ================ //

async function DriverPayoutsData(where) {
    return await DataFind(`
        SELECT wp.id, wp.driver_id, wp.amount, wp.date, wp.p_type, wp.status, wp.upi_id, wp.paypal_id, wp.bank_no, wp.bank_ifsc, wp.bank_type, wp.image, wp.rejection_reason, wp.justification_note,
               COALESCE(dri.first_name, '') AS dfname,
               COALESCE(dri.last_name, '') AS dlname,
               COALESCE(dri.primary_ccode, '') AS dccode,
               COALESCE(dri.primary_phoneNo, '') AS dphone
        FROM tbl_wallet_withdraw AS wp
        LEFT JOIN tbl_driver AS dri ON wp.driver_id = dri.id
        ${where}
        ORDER BY wp.id DESC
    `);
}

router.get("/driver_payouts", auth, async(req, res)=>{
    try {
        const drivers = await DataFind(`SELECT id, first_name, last_name, primary_ccode, primary_phoneNo FROM tbl_driver WHERE status = '1' AND approval_status = '1'`);
        const rd = await DriverPayoutsData("");

        rd.forEach(val => {
            let sdate = new Date(val.date);
            val.date = isNaN(sdate.getTime()) ? val.date : sdate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });
        });

        res.render("report_driver_payouts", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, rd, drivers
        });
    } catch (error) {
        console.log(error);
    }
});

router.get("/call_logs", auth, async(req, res)=>{
    try {
        const logs = await DataFind(`SELECT * FROM tbl_call_masking_logs ORDER BY id DESC`);
        logs.forEach(val => {
            let sdate = new Date(val.created_at);
            val.date = isNaN(sdate.getTime()) ? val.created_at : sdate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });
        });
        res.render("report_call_logs", {
            auth:req.user, general:req.general, noti:req.notification, per:req.per, lan:req.lan.ld, land:req.lan.lname, logs
        });
    } catch (error) {
        console.log(error);
        res.redirect("back");
    }
});

router.post("/rdriverpayoutsd", auth, async(req, res)=>{
    try {
        let {sdate, edate, driver_id, status} = req.body;
        let where = "";
        let conditions = [];

        if (sdate) conditions.push(`wp.date >= '${sdate}'`);
        if (edate) conditions.push(`wp.date <= '${edate}T23:59:59.999Z'`);
        if (driver_id && driver_id !== '0') conditions.push(`wp.driver_id = '${driver_id}'`);
        if (status && status !== 'All') conditions.push(`wp.status = '${status}'`);

        if (conditions.length > 0) {
            where = "WHERE " + conditions.join(" AND ");
        }

        const data = await DriverPayoutsData(where);
        data.forEach(val => {
            let sdate = new Date(val.date);
            val.date = isNaN(sdate.getTime()) ? val.date : sdate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });
        });
        res.send({ data });
    } catch (error) {
        console.log(error);
    }
});

router.get("/down_rdriverpayoutsd", auth, async(req, res)=>{
    try {
        let {sdate, edate, driver_id, status} = req.query;
        let where = "";
        let conditions = [];

        if (sdate) conditions.push(`wp.date >= '${sdate}'`);
        if (edate) conditions.push(`wp.date <= '${edate}T23:59:59.999Z'`);
        if (driver_id && driver_id !== '0') conditions.push(`wp.driver_id = '${driver_id}'`);
        if (status && status !== 'All') conditions.push(`wp.status = '${status}'`);

        if (conditions.length > 0) {
            where = "WHERE " + conditions.join(" AND ");
        }

        const data = await DriverPayoutsData(where);
        const {site_currency, currency_placement, thousands_separator} = req.general;

        data.forEach(val => {
            let sdate = new Date(val.date);
            val.date = isNaN(sdate.getTime()) ? val.date : sdate.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });
            val.driver_name = `${val.dfname} ${val.dlname} (${val.dccode} ${val.dphone})`;
            
            // Format status
            let s = val.status;
            if (s === '0') val.status_text = 'Pending';
            else if (s === '1') val.status_text = 'Paid/Approved';
            else val.status_text = 'Rejected';

            // Payout details and method type formatting
            let details = '';
            if (val.p_type === '1') {
                val.p_type_text = 'UPI';
                details = `UPI: ${val.upi_id}`;
            } else if (val.p_type === '2') {
                val.p_type_text = 'Paypal';
                details = `Paypal: ${val.paypal_id}`;
            } else if (val.p_type === '3') {
                val.p_type_text = 'BANK Transfer';
                details = `Bank: ${val.bank_no} | IFSC: ${val.bank_ifsc} | Type: ${val.bank_type}`;
            } else {
                val.p_type_text = val.p_type;
                details = '';
            }
            val.payout_details = details;

            let p = parseFloat(val.amount) || 0;
            let num_parts = p.toFixed(2).split(".");
            let sprated = num_parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands_separator);
            val.amount_formatted = currency_placement == "0" ? `${site_currency} ${sprated}.${num_parts[1]}` : `${sprated}.${num_parts[1]} ${site_currency}`;
        });

        let workbook = new Excel.Workbook();
        let worksheet = workbook.addWorksheet("Driver Payouts");

        worksheet.columns = [
            { header: '# Request', key: 'id', width: 15},
            { header: 'Driver', key: 'driver_name', width: 40},
            { header: 'Amount', key: 'amount_formatted', width: 20},
            { header: 'Payout Type', key: 'p_type_text', width: 20},
            { header: 'Payout Details', key: 'payout_details', width: 50},
            { header: 'Status', key: 'status_text', width: 15},
            { header: 'Date', key: 'date', width: 35}
        ];

        data.forEach(row => worksheet.addRow(row));

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", "attachment; filename=driver_payouts.xlsx");

        return workbook.xlsx.write(res).then(() => res.status(200).end());
    } catch (error) {
        console.log(error);
    }
});


module.exports = router;