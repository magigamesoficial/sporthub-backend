import { Pool } from "pg";

let pool: Pool | undefined;

function buildPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL não configurada");
  }

  const useSsl =
    process.env.NODE_ENV === "production" ||
    connectionString.includes("sslmode=require") ||
    connectionString.includes("render.com");

  return new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
}

export function getPool(): Pool {
  if (!pool) {
    pool = buildPool();
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
