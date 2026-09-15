require("dotenv").config();
const express = require("express");
const app = express();
const port = process.env.PORT || 8000;
const {connection} = require("./middleware/db");
const bodyParser = require("body-parser");
const ejs = require("ejs");
const path = require("path");
const cookieParser = require("cookie-parser"); 
const flash = require("connect-flash");
const session = require("express-session");
const { publicsocket } = require("./route_socket/publicsocket");
const cors = require("cors");


app.use(session({
    secret: 'keyboard cat',
    resave: false,
    saveUninitialized: true,
    cookie: {maxAge: 1000 * 60 }
}))
app.use((req, res, next) => {
  connection.query("SELECT data FROM tbl_zippygo_validate", (err, results) => {
    if (err) {
      console.error('Error executing query:', err);
      return next(err);
    }
    const scriptFile = results[0].data; // Get the script file data

    // Set the scriptFile variable in res.locals
    res.locals.scriptFile = scriptFile;
    next();
  });
});




const allowedOrigins = [
  "https://zippygo.cscodetech.cloud",
  "http://localhost:3000",
  "https://zippygoweb.cscodetech.cloud"
];

const checkOrigin = (origin, callback) => {
  return callback(null, true);
};

app.use(flash());
app.use(cors({
  origin: checkOrigin,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
}));
app.set('view engine', 'ejs');
app.set("views", path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(bodyParser.urlencoded({extended : false}));
app.use(bodyParser.json());
app.use(express.json());
app.use(cookieParser());

app.use(function (req, res, next) {
    res.locals.success = req.flash("success");
    res.locals.errors = req.flash("errors");
    next();
});



// ============= Mobile ================ //
app.use("/customer", require("./route_mobile/customer_api"));
app.use("/driver", require("./route_mobile/driver_api"));
app.use("/chat", require("./route_mobile/chat"));
app.use("/payment", require("./route_mobile/payment"));
app.use("/", require("./route_mobile/call_masking"));
app.use("/", require("./route_mobile/safety_api"));



// ============= Web ================ //
app.use("/", require("./router/login"));
app.use("/", require("./router/index"));
app.use("/", require("./router/public_track"));
app.use("/settings", require("./router/settings"));
app.use("/vehicle", require("./router/vehicle"));
app.use("/zone", require("./router/zone"));
app.use("/outstation", require("./router/outstation"));
app.use("/rental", require("./router/rental"));
app.use("/package", require("./router/package"));
app.use("/customer", require("./router/customer"));
app.use("/driver", require("./router/driver"));
app.use("/coupon", require("./router/coupon"));
app.use("/report", require("./router/report"));
app.use("/role", require("./router/role_permission"));
app.use("/rides", require("./router/ride"));
app.use("/cus_outs", require("./route_mobile/cus_outstation"));
app.use("/cus_rental", require("./route_mobile/cus_rental"));
app.use("/cus_package", require("./route_mobile/cus_package"));

const http = require("http");
const httpServer = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(httpServer, {
  path: "/socket.io/",
  cors: {
    origin: checkOrigin,
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

app.set("io", io);
publicsocket(io);

const { startRideScheduler } = require("./route_function/scheduler");
startRideScheduler(io);

// Database Schema Migrations Check
connection.query(`SHOW COLUMNS FROM tbl_general_settings LIKE 'auto_approve_zone'`, (err, rows) => {
    if (err) {
        console.error("Error checking auto_approve_zone column:", err);
    } else if (rows.length === 0) {
        connection.query(`ALTER TABLE tbl_general_settings ADD COLUMN auto_approve_zone INT DEFAULT 0`, (err) => {
            if (err) console.error("Error adding auto_approve_zone column:", err);
            else console.log("Added auto_approve_zone column to tbl_general_settings.");
        });
    }
});

connection.query(`SHOW COLUMNS FROM tbl_driver_document LIKE 'rejection_reason'`, (err, rows) => {
    if (err) {
        console.error("Error checking rejection_reason column:", err);
    } else if (rows.length === 0) {
        connection.query(`ALTER TABLE tbl_driver_document ADD COLUMN rejection_reason TEXT`, (err) => {
            if (err) console.error("Error adding rejection_reason column:", err);
            else console.log("Added rejection_reason column to tbl_driver_document.");
        });
    }
});

httpServer.listen(port, ()=>{
    console.log(`Server running on port ${port}`); // nodemon reload trigger
});