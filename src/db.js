/**
 * db.js — PostgreSQL connection pool for the app
 */

import pg from 'pg';

const pool = new pg.Pool({
    user: process.env.APP_DB_USERNAME,
    password: process.env.APP_DB_PASSWORD,
    host: process.env.APP_DB_HOST || 'app-postgres',
    port: parseInt(process.env.APP_POSTGRES_DB_PORT || process.env.APP_DB_PORT || '5432', 10),
    database: process.env.APP_DB_NAME
});

export function getDbEngine() {
    return 'postgres';
}

export { pool };
