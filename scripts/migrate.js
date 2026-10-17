// Usage: npm run migrate   (needs DATABASE_URL in .env or the environment)
const db = require("../db");
db.migrate()
  .then(() => { console.log("✓ Schema is up to date."); return db.close(); })
  .catch((err) => { console.error("Migration failed:", err.message); process.exit(1); });
