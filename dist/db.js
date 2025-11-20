"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.query = query;
exports.introspect = introspect;
const promise_1 = __importDefault(require("mysql2/promise"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const pool = promise_1.default.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || undefined,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});
async function query(sql, params) {
    const [rows] = await pool.query(sql, params);
    return rows;
}
async function introspect(database) {
    const db = database || process.env.DB_DATABASE;
    if (!db)
        throw new Error('No database configured');
    const tablesSql = `
    SELECT TABLE_NAME, TABLE_SCHEMA, TABLE_COMMENT
    FROM information_schema.tables
    WHERE table_schema = ?
  `;
    const columnsSql = `
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_KEY
    FROM information_schema.columns
    WHERE table_schema = ?
    ORDER BY TABLE_NAME, ORDINAL_POSITION
  `;
    const fksSql = `
    SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
    FROM information_schema.key_column_usage
    WHERE table_schema = ? AND REFERENCED_TABLE_NAME IS NOT NULL
  `;
    const tables = await query(tablesSql, [db]);
    const columns = await query(columnsSql, [db]);
    const fks = await query(fksSql, [db]);
    return { tables, columns, fks };
}
exports.default = pool;
