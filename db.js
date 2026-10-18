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

  // One migration at a time across serverless instances. The lock is transaction-scoped
  // (pg_advisory_xact_lock) so it works through Neon's pooled (PgBouncer, transaction-mode)
  // endpoint and is released automatically on COMMIT/ROLLBACK — a session lock can be left
  // dangling on a pooled backend and block every later request. All DDL is IF NOT EXISTS,
  // so an instance that waits for the lock simply re-runs it as a no-op.
  async function migrate() {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query("SET LOCAL statement_timeout = '20s'");
      await client.query("SELECT pg_advisory_xact_lock(727275)");
      for (const file of ["schema.sql", "schema_upgrade.sql"]) await client.query(fs.readFileSync(path.join(__dirname, file), "utf8"));
      await client.query("COMMIT");
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  }

  const ping = async () => { await query("SELECT 1"); return true; };
  const close = async () => { if (globalThis.__saathridePool) await globalThis.__saathridePool.end(); globalThis.__saathridePool = null; };

  module.exports = { query, one, tx, migrate, ping, close };
}
