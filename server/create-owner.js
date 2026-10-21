require("dotenv").config();

const { randomUUID } = require("node:crypto");
const readline = require("node:readline");
const bcrypt = require("bcryptjs");
const { pool } = require("./db");

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      reject(new Error("Jalankan perintah ini dari terminal interaktif agar password tidak ditampilkan."));
      return;
    }
    let value = "";
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    const restore = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
    };
    const onData = (chunk) => {
      const key = chunk.toString("utf8");
      if (key === "\u0003") {
        restore();
        process.stdout.write("\n");
        reject(new Error("Pembuatan owner dibatalkan."));
      } else if (key === "\r" || key === "\n") {
        restore();
        process.stdout.write("\n");
        resolve(value);
      } else if (key === "\u007f" || key === "\b") {
        value = value.slice(0, -1);
      } else if (key >= " " && key !== "\u001b") {
        value += key;
      }
    };
    input.on("data", onData);
  });
}

async function createOwner() {
  const email = String(process.env.OWNER_EMAIL || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) {
    throw new Error("Set OWNER_EMAIL dengan alamat email yang valid sebelum melanjutkan.");
  }
  const password = await readHidden("Password owner (minimal 8 karakter): ");
  if (password.length < 8 || password.length > 128) {
    throw new Error("Password harus berisi 8–128 karakter.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owners = await client.query("SELECT id FROM portal_accounts WHERE role = 'owner' LIMIT 1 FOR UPDATE");
    if (owners.rowCount) throw new Error("Akun owner sudah tersedia. Bootstrap hanya boleh dilakukan satu kali.");
    await client.query(
      `INSERT INTO portal_accounts (id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'owner')`,
      [randomUUID(), "Lloyd Owner", email, passwordHash],
    );
    await client.query("COMMIT");
    console.log(`Akun Owner berhasil dibuat. Username login: Lloyd Owner; email akun: ${email}. Password tidak disimpan dalam konfigurasi.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

createOwner().catch(async (error) => {
  console.error(error.message);
  await pool.end();
  process.exitCode = 1;
});
