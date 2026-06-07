import mysql from 'mysql2/promise';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export type ColumnInfo = {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  column_key: string;
};

export interface DBAdapter {
  query(sql: string, params?: any[]): Promise<any[]>;
  introspect(database?: string): Promise<{ tables: any[], columns: any[], fks: any[] }>;
}

class MySQLAdapter implements DBAdapter {
  private pool: mysql.Pool;

  constructor() {
    this.pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_DATABASE || undefined,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
  }

  async query(sql: string, params?: any[]) {
    const [rows] = await this.pool.query(sql, params);
    return rows as any[];
  }

  async introspect(database?: string) {
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

    const tables = await this.query(tablesSql, [db]);
    const columns = await this.query(columnsSql, [db]);
    const fks = await this.query(fksSql, [db]);

    return { tables, columns, fks };
  }
}

class PostgresAdapter implements DBAdapter {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_DATABASE || 'postgres',
    });
  }

  async query(sql: string, params?: any[]) {
    const res = await this.pool.query(sql, params);
    return res.rows;
  }

  async introspect(database?: string) {
    const schema = process.env.DB_SCHEMA || 'public';

    const tablesSql = `
      SELECT 
        t.table_name as "TABLE_NAME", 
        t.table_schema as "TABLE_SCHEMA",
        obj_description(pgc.oid, 'pg_class') as "TABLE_COMMENT"
      FROM information_schema.tables t
      JOIN pg_class pgc ON t.table_name = pgc.relname
      JOIN pg_namespace pgn ON pgc.relnamespace = pgn.oid
      WHERE t.table_schema = $1
        AND pgn.nspname = $1
        AND t.table_type = 'BASE TABLE'
    `;
    
    const columnsSql = `
      SELECT 
        c.table_name as "TABLE_NAME", 
        c.column_name as "COLUMN_NAME", 
        c.data_type as "DATA_TYPE", 
        CASE 
          WHEN tc.constraint_type = 'PRIMARY KEY' THEN 'PRI'
          WHEN tc.constraint_type = 'UNIQUE' THEN 'UNI'
          ELSE ''
        END as "COLUMN_KEY"
      FROM information_schema.columns c
      LEFT JOIN information_schema.key_column_usage kcu 
        ON c.table_name = kcu.table_name 
        AND c.column_name = kcu.column_name
        AND c.table_schema = kcu.table_schema
      LEFT JOIN information_schema.table_constraints tc
        ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      WHERE c.table_schema = $1
      ORDER BY c.table_name, c.ordinal_position
    `;
    
    const fksSql = `
      SELECT
          tc.table_name as "TABLE_NAME", 
          kcu.column_name as "COLUMN_NAME", 
          ccu.table_name AS "REFERENCED_TABLE_NAME",
          ccu.column_name AS "REFERENCED_COLUMN_NAME"
      FROM 
          information_schema.table_constraints AS tc 
          JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1;
    `;

    const tables = await this.query(tablesSql, [schema]);
    const columns = await this.query(columnsSql, [schema]);
    const fks = await this.query(fksSql, [schema]);

    return { tables, columns, fks };
  }
}

const dbType = process.env.DB_TYPE || 'mysql';
let adapter: DBAdapter;

if (dbType === 'postgres') {
  adapter = new PostgresAdapter();
} else {
  adapter = new MySQLAdapter();
}

export async function query(sql: string, params?: any[]) {
  return adapter.query(sql, params);
}

export async function introspect(database?: string) {
  return adapter.introspect(database);
}

export default adapter;

