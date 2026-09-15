const mysql = require("mysql2");

var connection = mysql.createPool({
    host     : process.env.DB_HOST || '',
    user     : process.env.DB_USER || '',
    password : process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : '',
    database : process.env.DB_NAME || '',
    charset  : 'utf8mb4',

    connectionLimit : 10,        // ✅ reduced from 100
    waitForConnections: true,
    queueLimit: 0,

    connectTimeout: 10000,       // ✅ 10 sec
    acquireTimeout: 10000
});

/**
 * Safe query helper (same usage)
 */
const mySqlQury = (qry, params = []) => {
    return new Promise((resolve, reject) => {
        connection.query(
            { sql: qry, timeout: 10000 }, // ✅ query timeout
            params,
            (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            }
        );
    });
};

/**
 * Graceful shutdown (IMPORTANT)
 */
process.on('SIGINT', () => {
    console.log('Closing MySQL pool...');
    connection.end(() => process.exit(0));
});

process.on('SIGTERM', () => {
    console.log('Closing MySQL pool...');
    connection.end(() => process.exit(0));
});

module.exports = { connection, mySqlQury };
