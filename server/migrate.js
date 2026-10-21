require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const { pool } = require("./db");

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS portal_schema_migrations (
        id varchar(120) PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`,
    );
    const migrationDir = path.join(__dirname, "migrations");
    const migrationFiles = (await fs.readdir(migrationDir))
      .filter((file) => /^\d{3}-[a-z0-9-]+\.sql$/.test(file))
      .sort();

    for (const file of migrationFiles) {
      const applied = await client.query(
        "SELECT id FROM portal_schema_migrations WHERE id = $1",
        [file],
      );
      if (applied.rowCount) continue;

      await client.query("BEGIN");
      try {
        const sql = await fs.readFile(path.join(migrationDir, file), "utf8");
        await client.query(sql);
        await client.query("INSERT INTO portal_schema_migrations (id) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`Migrasi ${file} berhasil diterapkan.`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    console.log("Semua migrasi PostgreSQL telah diterapkan.");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error("Migrasi PostgreSQL gagal.", error);
  process.exitCode = 1;
});
