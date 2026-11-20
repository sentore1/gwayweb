const { connection } = require('./db');

// Execute a SELECT query and return the results
async function DataFind(query) {
    return new Promise((resolve, reject) => {
        connection.query(query, (err, results) => {
            if (err) {
                console.error('DataFind error:', err);
                return reject(err);
            }
            resolve(results);
        });
    });
}

// Execute an INSERT query
// table  - table name
// fields - comma-separated column names  e.g. "name, email, status"
// values - comma-separated values        e.g. "'John', 'john@example.com', '1'"
async function DataInsert(table, fields, values) {
    const query = `INSERT INTO ${table} (${fields}) VALUES (${values})`;
    return new Promise((resolve, reject) => {
        connection.query(query, (err, results) => {
            if (err) {
                console.error('DataInsert error:', err);
                return reject(err);
            }
            resolve(results);
        });
    });
}

// Execute an UPDATE query
// table     - table name
// setClause - SET portion  e.g. "name = 'John', status = '1'"
// condition - WHERE clause e.g. "id = '5'"
async function DataUpdate(table, setClause, condition) {
    const query = `UPDATE ${table} SET ${setClause} WHERE ${condition}`;
    return new Promise((resolve, reject) => {
        connection.query(query, (err, results) => {
            if (err) {
                console.error('DataUpdate error:', err);
                return reject(err);
            }
            resolve(results);
        });
    });
}

// Execute a DELETE query
// table     - table name
// condition - WHERE clause e.g. "id = '5'"
async function DataDelete(table, condition) {
    const query = `DELETE FROM ${table} WHERE ${condition}`;
    return new Promise((resolve, reject) => {
        connection.query(query, (err, results) => {
            if (err) {
                console.error('DataDelete error:', err);
                return reject(err);
            }
            resolve(results);
        });
    });
}

module.exports = { DataFind, DataInsert, DataUpdate, DataDelete };
