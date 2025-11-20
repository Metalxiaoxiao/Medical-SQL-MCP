import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || undefined,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

export async function query(sql: string, params?: any[]) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

export type ColumnInfo = {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  column_key: string;
};

export async function introspect(database?: string) {
  const db = database || process.env.DB_DATABASE;
  if (!db) throw new Error('No database configured');

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

export default pool;
