// SaathRide — database access (Neon PostgreSQL via `pg`).
// Exposes: query(sql, params) -> rows[], one(sql, params) -> row|null, tx(fn), migrate(), ping().
// Under NODE_ENV=test the same interface is backed by an in-memory SQLite (test/sqlite-adapter.js).
const fs = require("fs");
const path = require("path");

if (process.env.NODE_ENV === "test") {
  module.exports = require("./test/sqlite-adapter");
} else {
  const { Pool } = require("pg");

  // Reuse the pool across warm serverless invocations.
  function getPool() {
    if (!globalThis.__saathridePool) {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL is not set (add your Neon connection string to the environment)");
      const pool = new Pool({
        connectionString: url,       // Neon strings already contain ?sslmode=require
        max: 5,                      // small: Neon's pooled endpoint multiplexes connections
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 10_000,
      });
      pool.on("error", (err) => console.error("pg pool error:", err.message));
      globalThis.__saathridePool = pool;
    }
    return globalThis.__saathridePool;
  }

  const query = async (text, params = []) => (await getPool().query(text, params)).rows;
  const one = async (text, params = []) => (await query(text, params))[0] || null;

  async function tx(fn) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const q = async (text, params = []) => (await client.query(text, params)).rows;
      const result = await fn({ query: q, one: async (t, p) => (await q(t, p))[0] || null });
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async function migrate() {
    const client = await getPool().connect();
    try {
      await client.query("SELECT pg_advisory_lock(727274)");   // one migration at a time across instances
      for (const file of ["schema.sql", "schema_upgrade.sql"]) await client.query(fs.readFileSync(path.join(__dirname, file), "utf8"));
    } finally {
      try { await client.query("SELECT pg_advisory_unlock(727274)"); } catch { /* ignore */ }
      client.release();
    }
  }

  const ping = async () => { await query("SELECT 1"); return true; };
  const close = async () => { if (globalThis.__saathridePool) await globalThis.__saathridePool.end(); globalThis.__saathridePool = null; };

  module.exports = { query, one, tx, migrate, ping, close };
}
