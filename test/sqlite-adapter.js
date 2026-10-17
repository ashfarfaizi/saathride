// TEST-ONLY adapter: runs the app's Postgres-flavoured SQL on Node's built-in SQLite
// (node:sqlite) so the API logic can be tested where no Postgres is available.
// It is NOT used in production. It translates $1 placeholders, SERIAL/TIMESTAMPTZ DDL and
// drops FOR UPDATE (SQLite has no row locks; its single connection is serialised instead).
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");

function translate(sql, params) {
  const ordered = [];
  const out = sql
    .replace(/\s+FOR UPDATE(\s+OF\s+\w+)?/gi, "")
    .replace(/\$(\d+)/g, (_, n) => {
      let v = params[Number(n) - 1];
      if (v === undefined) v = null;
      if (typeof v === "boolean") v = v ? 1 : 0;
      ordered.push(v);
      return "?";
    });
  return { sql: out, params: ordered };
}

function run(sqlText, params = []) {
  const t = translate(sqlText, params);
  const stmt = db.prepare(t.sql);
  const returnsRows = /^\s*(SELECT|WITH)/i.test(t.sql) || /\bRETURNING\b/i.test(t.sql);
  if (returnsRows) return stmt.all(...t.params).map((r) => ({ ...r }));
  stmt.run(...t.params);
  return [];
}

let chain = Promise.resolve();
const query = async (sql, params) => run(sql, params);
const one = async (sql, params) => (run(sql, params))[0] || null;

function tx(fn) {
  const next = chain.then(async () => {
    db.exec("BEGIN");
    try {
      const q = async (s, p) => run(s, p);
      const result = await fn({ query: q, one: async (s, p) => run(s, p)[0] || null });
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  });
  chain = next.catch(() => {});
  return next;
}

async function migrate() {
  let sql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  sql = sql
    .replace(/SERIAL PRIMARY KEY/g, "INTEGER PRIMARY KEY AUTOINCREMENT")
    .replace(/TIMESTAMPTZ/g, "TEXT")
    .replace(/DEFAULT now\(\)/g, "DEFAULT CURRENT_TIMESTAMP");
  db.exec(sql);
  // schema_upgrade.sql is Postgres-only except its CREATE INDEX lines (fresh test DBs already have the columns)
  const up = fs.readFileSync(path.join(__dirname, "..", "schema_upgrade.sql"), "utf8");
  for (const stmt of up.split(";")) {
    const s = stmt.replace(/--.*$/gm, "").trim();
    if (/^CREATE/i.test(s)) db.exec(s);
  }
}

const ping = async () => true;
const close = async () => {};
// test helper: wipe data between suites
const reset = () => { for (const t of ["trip_updates","saved_routes","geo_cache","calls","notifications","user_reports","blocked_users","conversations","trip_comments","trip_likes","trip_images","ratings","reports","saved_trips","messages","trip_participants","interests","trips","users"]) db.exec(`DELETE FROM ${t}`); };

module.exports = { query, one, tx, migrate, ping, close, reset };
