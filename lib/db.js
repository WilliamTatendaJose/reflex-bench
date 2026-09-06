import { Pool } from 'pg';

// Reuse the pool across lambda invocations in the same container.
const g = globalThis;
export const pool =
  g.__reflexPool ||
  (g.__reflexPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  }));

export const q = (text, params) => pool.query(text, params);
