const { Hono } = require("hono");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const { SignJWT, jwtVerify } = require("jose");
const crypto = require("node:crypto");
const { canCreateRole, canDeleteLicense, canManageAccount } = require("./permissions");

const app = new Hono();
const SESSION_COOKIE = "lloyd_portal_session";
const SESSION_MAX_AGE = 8 * 60 * 60;
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

function apiError(c, status, message) {
  return c.json({ error: message }, status);
}

async function serveAsset(request, assets) {
  const response = await assets.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  headers.set("Cache-Control", "no-store, max-age=0");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getSecret(env) {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters.");
  }
  return new TextEncoder().encode(secret);
}

function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  for (const cookie of cookies.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(cookie.slice(separator + 1).trim());
  }
  return "";
}

function setSessionCookie(c, token, env) {
  const secure = env.NODE_ENV === "production" ? "; Secure" : "";
  c.header(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}${secure}`,
    { append: true },
  );
}

function clearSessionCookie(c, env) {
  const secure = env.NODE_ENV === "production" ? "; Secure" : "";
  c.header(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    { append: true },
  );
}

async function signSession(env, claims) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("lloyd-license-portal")
    .setAudience("lloyd-license-portal")
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(getSecret(env));
}

async function readSession(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  try {
    const result = await jwtVerify(token, getSecret(env), {
      issuer: "lloyd-license-portal",
      audience: "lloyd-license-portal",
    });
    return result.payload;
  } catch {
    return null;
  }
}

function checkSameOrigin(c, env) {
  const origin = c.req.header("Origin");
  if (!origin) return env.NODE_ENV !== "production";
  return origin === new URL(c.req.url).origin;
}

function accountDto(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    parentId: row.parent_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

function licenseDto(row) {
  return {
    id: row.id,
    phone: row.phone,
    resellerId: row.reseller_id,
    createdById: row.created_by_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

function subbotDto(row) {
  const pairingActive = row.status === "pairing";
  return {
    id: row.id,
    status: row.status,
    pairingMethod: row.pairing_method,
    phone: row.phone,
    connectedPhone: row.connected_phone,
    pairingCode: pairingActive ? row.pairing_code : null,
    qrImage: pairingActive ? row.qr_image : null,
    error: row.error_message,
    updatedAt: row.updated_at,
    config: row.config || {},
  };
}

const subbotConfigTextLimits = {
  botname: 60,
  botname2: 60,
  namaOwner: 60,
  owner: 16,
  packname: 80,
  linkOwner: 300,
  linkGrup: 300,
  linkSaluran: 300,
  idSaluran: 120,
  namaSaluran: 80,
  dana: 40,
  gopay: 40,
};
const subbotImageKeys = ["menu", "menuv3", "welcome", "left", "reply", "canvas", "qris"];
const subbotUrlKeys = new Set([
  "linkOwner", "linkGrup", "linkSaluran",
  ...subbotImageKeys.map((key) => `image.${key}`),
]);

function normalizeSubbotConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = new Set([...Object.keys(subbotConfigTextLimits), "image"]);
  if (Object.keys(value).some((key) => !keys.has(key))) return null;
  const config = {};
  for (const [key, maxLength] of Object.entries(subbotConfigTextLimits)) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || value[key].length > maxLength) return null;
    const text = value[key].trim();
    if (key === "owner" && text && !/^\+?[1-9]\d{7,14}$/.test(text.replace(/[\s()-]/g, ""))) return null;
    if (subbotUrlKeys.has(key) && text) {
      try {
        if (new URL(text).protocol !== "https:") return null;
      } catch {
        return null;
      }
    }
    if (text) config[key] = key === "owner" ? text.replace(/\D/g, "") : text;
  }
  if (value.image !== undefined) {
    if (!value.image || typeof value.image !== "object" || Array.isArray(value.image)
        || Object.keys(value.image).some((key) => !subbotImageKeys.includes(key))) return null;
    const image = {};
    for (const key of subbotImageKeys) {
      const url = value.image[key];
      if (url === undefined) continue;
      if (typeof url !== "string" || url.length > 1000) return null;
      const text = url.trim();
      if (text) {
        try {
          if (new URL(text).protocol !== "https:") return null;
        } catch {
          return null;
        }
        image[key] = text;
      }
    }
    if (Object.keys(image).length) config.image = image;
  }
  return config;
}

function announcementDto(row) {
  return {
    title: row.title,
    message: row.message,
    updatedAt: row.updated_at,
  };
}

function validatePhone(phone) {
  return typeof phone === "string" && /^[1-9][0-9]{7,14}$/.test(phone);
}

async function isLicensedPhoneActive(db, phone) {
  const result = await db.query(
    `WITH RECURSIVE account_chain AS (
       SELECT account.id, account.parent_id, account.status
       FROM portal_licenses license
       JOIN portal_accounts account ON account.id = license.reseller_id
       WHERE license.phone = $1 AND license.status = 'active'
       UNION ALL
       SELECT parent.id, parent.parent_id, parent.status
       FROM portal_accounts parent
       JOIN account_chain child ON child.parent_id = parent.id
     )
     SELECT count(*) > 0 AND bool_and(status = 'active') AS active
     FROM account_chain`,
    [phone],
  );
  return result.rows[0]?.active === true;
}

async function getVisibleResellerIds(db, actor) {
  if (actor.role === "owner") {
    const result = await db.query("SELECT id FROM portal_accounts WHERE role = 'reseller'");
    return new Set(result.rows.map((row) => row.id));
  }
  if (actor.role === "partner") {
    const result = await db.query(
      "SELECT id FROM portal_accounts WHERE role = 'reseller' AND parent_id = $1",
      [actor.id],
    );
    return new Set(result.rows.map((row) => row.id));
  }
  return new Set([actor.id]);
}

app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  c.header("Cache-Control", "no-store, max-age=0");
  await next();
});

app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" && c.req.path === "/api/auth/csrf") return next();
  const connectionString = c.env.HYPERDRIVE?.connectionString || c.env.DATABASE_URL;
  if (!connectionString) return apiError(c, 503, "Konfigurasi database belum tersedia.");
  const dbOptions = { connectionString };
  if (!c.env.HYPERDRIVE && c.env.PGSSLMODE === "require") {
    dbOptions.ssl = { rejectUnauthorized: false };
  }
  const db = new Client(dbOptions);
  try {
    await db.connect();
    c.set("db", db);
    await next();
  } finally {
    await db.end().catch((error) => console.error("Could not close database client.", error));
  }
});

async function requireCsrf(c, next) {
  if (!checkSameOrigin(c, c.env)) return apiError(c, 403, "Origin tidak diizinkan.");
  const claims = await readSession(c.req.raw, c.env);
  const csrfToken = c.req.header("X-CSRF-Token");
  if (!claims || typeof claims.csrf !== "string" || !csrfToken || claims.csrf !== csrfToken) {
    return apiError(c, 403, "Token keamanan tidak valid. Muat ulang halaman lalu coba lagi.");
  }
  c.set("sessionClaims", claims);
  await next();
}

async function requireAuth(c, next) {
  const claims = await readSession(c.req.raw, c.env);
  if (!claims || typeof claims.accountId !== "string") {
    clearSessionCookie(c, c.env);
    return apiError(c, 401, "Silakan masuk terlebih dahulu.");
  }
  const result = await c.get("db").query(
    `WITH RECURSIVE account_chain AS (
       SELECT id, name, email, role, parent_id, status
       FROM portal_accounts WHERE id = $1
       UNION ALL
       SELECT parent.id, parent.name, parent.email, parent.role, parent.parent_id, parent.status
       FROM portal_accounts parent
       JOIN account_chain child ON child.parent_id = parent.id
     )
     SELECT id, name, email, role, parent_id, status
     FROM account_chain`,
    [claims.accountId],
  );
  const account = result.rows.find((row) => row.id === claims.accountId);
  if (!account || result.rows.some((row) => row.status !== "active")) {
    clearSessionCookie(c, c.env);
    return apiError(c, 401, "Sesi tidak berlaku. Silakan masuk kembali.");
  }
  c.set("account", {
    id: account.id,
    name: account.name,
    email: account.email,
    role: account.role,
    parentId: account.parent_id,
  });
  c.set("sessionClaims", claims);
  await next();
}

async function requireSubbotWorker(c, next) {
  const expected = c.env.SUBBOT_WORKER_TOKEN;
  const authorization = c.req.header("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (typeof expected !== "string" || expected.length < 32) {
    return apiError(c, 503, "Worker sub-bot belum dikonfigurasi.");
  }
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length
      || !crypto.timingSafeEqual(expectedBytes, suppliedBytes)) {
    return apiError(c, 401, "Otorisasi worker tidak berlaku.");
  }
  await next();
}

const api = new Hono();

api.get("/health", async (c) => {
  await c.get("db").query("SELECT 1");
  return c.json({ status: "ok", database: "connected" });
});

api.get("/auth/csrf", async (c) => {
  const existing = await readSession(c.req.raw, c.env);
  if (existing?.csrf) return c.json({ csrfToken: existing.csrf });
  const csrfToken = crypto.randomBytes(32).toString("hex");
  setSessionCookie(c, await signSession(c.env, { csrf: csrfToken }), c.env);
  return c.json({ csrfToken });
});

api.post("/auth/login", requireCsrf, async (c) => {
  const body = await c.req.json().catch(() => null);
  const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (username.length < 2 || username.length > 60 || password.length > 128) {
    return apiError(c, 400, "Username atau password tidak valid.");
  }

  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const ipHash = crypto.createHmac("sha256", c.env.SESSION_SECRET).update(ip).digest("hex");
  const db = c.get("db");
  await db.query("DELETE FROM portal_login_attempts WHERE attempted_at < now() - interval '15 minutes'");
  const attempts = await db.query(
    `SELECT count(*)::int AS count FROM portal_login_attempts
     WHERE ip_hash = $1 AND attempted_at >= now() - interval '15 minutes'`,
    [ipHash],
  );
  if (attempts.rows[0].count >= 10) {
    return apiError(c, 429, "Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit.");
  }

  const result = await db.query(
    `SELECT id, name, email, role, parent_id, password_hash
     FROM portal_accounts WHERE lower(name) = $1 AND status = 'active'`,
    [username],
  );
  const account = result.rows[0];
  const passwordMatches = account
    ? await bcrypt.compare(password, account.password_hash)
    : await bcrypt.compare(password, "$2a$12$C6UzMDM.H6dfI/f/IKcEe.5Q8h6ZBfMy6YjE5u1k3u2Jp7wQXnJ5e");
  if (!account || !passwordMatches) {
    await db.query("INSERT INTO portal_login_attempts (ip_hash) VALUES ($1)", [ipHash]);
    return apiError(c, 401, "Username atau password salah.");
  }

  const chain = await db.query(
    `WITH RECURSIVE account_chain AS (
       SELECT parent_id, status FROM portal_accounts WHERE id = $1
       UNION ALL
       SELECT parent.parent_id, parent.status
       FROM portal_accounts parent
       JOIN account_chain child ON child.parent_id = parent.id
     )
     SELECT NOT EXISTS (SELECT 1 FROM account_chain WHERE status <> 'active') AS active`,
    [account.id],
  );
  if (!chain.rows[0].active) {
    await db.query("INSERT INTO portal_login_attempts (ip_hash) VALUES ($1)", [ipHash]);
    return apiError(c, 401, "Username atau password salah.");
  }
  await db.query("DELETE FROM portal_login_attempts WHERE ip_hash = $1", [ipHash]);
  const csrfToken = crypto.randomBytes(32).toString("hex");
  const token = await signSession(c.env, { accountId: account.id, csrf: csrfToken });
  setSessionCookie(c, token, c.env);
  return c.json({
    account: {
      id: account.id,
      name: account.name,
      email: account.email,
      role: account.role,
      parentId: account.parent_id,
    },
    csrfToken,
  });
});

api.post("/auth/register", requireCsrf, async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (name.length < 2 || name.length > 60
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120
      || password.length < 8 || password.length > 128) {
    return apiError(c, 400, "Data pendaftaran tidak valid. Password harus berisi 8–128 karakter.");
  }

  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const ipHash = crypto.createHmac("sha256", getSecret(c.env)).update(ip).digest("hex");
  const db = c.get("db");
  await db.query("DELETE FROM portal_signup_attempts WHERE attempted_at < now() - interval '1 hour'");
  const attempts = await db.query(
    `SELECT count(*)::int AS count FROM portal_signup_attempts
     WHERE ip_hash = $1 AND attempted_at >= now() - interval '1 hour'`,
    [ipHash],
  );
  if (attempts.rows[0].count >= 5) {
    return apiError(c, 429, "Terlalu banyak pendaftaran. Coba lagi dalam satu jam.");
  }
  await db.query("INSERT INTO portal_signup_attempts (ip_hash) VALUES ($1)", [ipHash]);

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await db.query(
      `INSERT INTO portal_accounts (id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'user')
       RETURNING id, name, email, role, parent_id, status, created_at`,
      [crypto.randomUUID(), name, email, passwordHash],
    );
    const account = accountDto(result.rows[0]);
    const csrfToken = crypto.randomBytes(32).toString("hex");
    setSessionCookie(c, await signSession(c.env, { accountId: account.id, csrf: csrfToken }), c.env);
    return c.json({ account, csrfToken }, 201);
  } catch (error) {
    if (error.code === "23505" && error.constraint === "portal_accounts_name_lower_uq") {
      return apiError(c, 409, "Username tersebut sudah digunakan.");
    }
    if (error.code === "23505" && error.constraint === "portal_accounts_email_lower_uq") {
      return apiError(c, 409, "Email sudah digunakan.");
    }
    throw error;
  }
});

api.post("/auth/logout", requireCsrf, requireAuth, (c) => {
  clearSessionCookie(c, c.env);
  return c.body(null, 204);
});

api.get("/auth/me", requireAuth, (c) => c.json({ account: c.get("account") }));

api.patch("/auth/profile", requireCsrf, requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (name.length < 2 || name.length > 60
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120
      || currentPassword.length < 1 || currentPassword.length > 128
      || (newPassword && (newPassword.length < 8 || newPassword.length > 128))) {
    return apiError(c, 400, "Data profil tidak valid. Password baru harus berisi 8–128 karakter.");
  }

  const actor = c.get("account");
  const db = c.get("db");
  const current = await db.query("SELECT password_hash FROM portal_accounts WHERE id = $1", [actor.id]);
  if (!current.rowCount || !(await bcrypt.compare(currentPassword, current.rows[0].password_hash))) {
    return apiError(c, 403, "Password saat ini tidak benar.");
  }

  const passwordHash = newPassword ? await bcrypt.hash(newPassword, 12) : current.rows[0].password_hash;
  try {
    const result = await db.query(
      `UPDATE portal_accounts SET name = $1, email = $2, password_hash = $3
       WHERE id = $4
       RETURNING id, name, email, role, parent_id, status, created_at`,
      [name, email, passwordHash, actor.id],
    );
    return c.json({ account: accountDto(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505" && error.constraint === "portal_accounts_name_lower_uq") {
      return apiError(c, 409, "Username tersebut sudah digunakan.");
    }
    if (error.code === "23505" && error.constraint === "portal_accounts_email_lower_uq") {
      return apiError(c, 409, "Email tersebut sudah digunakan.");
    }
    throw error;
  }
});

api.get("/announcement", requireAuth, async (c) => {
  const result = await c.get("db").query(
    "SELECT title, message, updated_at FROM portal_announcement WHERE id = true",
  );
  return c.json({ announcement: result.rows[0] ? announcementDto(result.rows[0]) : null });
});

api.post("/announcement", requireCsrf, requireAuth, async (c) => {
  const actor = c.get("account");
  if (actor.role !== "owner") return apiError(c, 403, "Hanya Owner yang dapat mengelola pengumuman.");
  const body = await c.req.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!title || title.length > 120 || !message || message.length > 3000) {
    return apiError(c, 400, "Judul dan isi pengumuman wajib diisi. Maksimal 120 dan 3000 karakter.");
  }
  const result = await c.get("db").query(
    `INSERT INTO portal_announcement (id, title, message, updated_by_id, updated_at)
     VALUES (true, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE
       SET title = EXCLUDED.title,
           message = EXCLUDED.message,
           updated_by_id = EXCLUDED.updated_by_id,
           updated_at = now()
     RETURNING title, message, updated_at`,
    [title, message, actor.id],
  );
  return c.json({ announcement: announcementDto(result.rows[0]) });
});

api.delete("/announcement", requireCsrf, requireAuth, async (c) => {
  if (c.get("account").role !== "owner") return apiError(c, 403, "Hanya Owner yang dapat mengelola pengumuman.");
  await c.get("db").query("DELETE FROM portal_announcement WHERE id = true");
  return c.body(null, 204);
});

api.get("/bot/password", requireAuth, async (c) => {
  if (c.get("account").role !== "owner") return apiError(c, 403, "Hanya Owner yang dapat mengelola password script.");
  const result = await c.get("db").query("SELECT 1 FROM portal_script_settings WHERE id = true");
  return c.json({ configured: result.rowCount > 0 });
});

api.post("/bot/password", requireCsrf, requireAuth, async (c) => {
  const actor = c.get("account");
  if (actor.role !== "owner") return apiError(c, 403, "Hanya Owner yang dapat mengubah password script.");
  const body = await c.req.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < 12 || password.length > 128) {
    return apiError(c, 400, "Password script harus berisi 12–128 karakter.");
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await c.get("db").query(
    `INSERT INTO portal_script_settings (id, password_hash, updated_by_id, updated_at)
     VALUES (true, $1, $2, now())
     ON CONFLICT (id) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           updated_by_id = EXCLUDED.updated_by_id,
           updated_at = now()`,
    [passwordHash, actor.id],
  );
  return c.json({ configured: true });
});

api.post("/bot/password/verify", async (c) => {
  const body = await c.req.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < 1 || password.length > 128) return c.json({ valid: false });

  const secret = getSecret(c.env);
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const ipHash = crypto.createHmac("sha256", secret).update(ip).digest("hex");
  const db = c.get("db");
  await db.query(
    "DELETE FROM portal_bot_password_attempts WHERE attempted_at < now() - interval '15 minutes'",
  );
  const attempts = await db.query(
    `SELECT count(*)::int AS count FROM portal_bot_password_attempts
     WHERE ip_hash = $1 AND attempted_at >= now() - interval '15 minutes'`,
    [ipHash],
  );
  if (attempts.rows[0].count >= 10) {
    return apiError(c, 429, "Terlalu banyak percobaan password. Coba lagi dalam 15 menit.");
  }
  await db.query("INSERT INTO portal_bot_password_attempts (ip_hash) VALUES ($1)", [ipHash]);

  const result = await db.query(
    "SELECT password_hash FROM portal_script_settings WHERE id = true",
  );
  const passwordHash = result.rows[0]?.password_hash;
  if (!passwordHash || !(await bcrypt.compare(password, passwordHash))) return c.json({ valid: false });
  await db.query("DELETE FROM portal_bot_password_attempts WHERE ip_hash = $1", [ipHash]);

  const verificationToken = await new SignJWT({ purpose: "bot-number-verification" })
    .setSubject(ipHash)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("lloyd-license-portal")
    .setAudience("lloyd-bot-number-verification")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret);
  return c.json({ valid: true, verificationToken });
});

api.post("/bot/number/verify", async (c) => {
  const authorization = c.req.header("Authorization") || "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9._-]+)$/);
  if (!match) return apiError(c, 401, "Verifikasi password diperlukan.");
  const secret = getSecret(c.env);
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const ipHash = crypto.createHmac("sha256", secret).update(ip).digest("hex");
  try {
    const { payload } = await jwtVerify(match[1], secret, {
      issuer: "lloyd-license-portal",
      audience: "lloyd-bot-number-verification",
    });
    if (payload.purpose !== "bot-number-verification" || payload.sub !== ipHash) {
      return apiError(c, 401, "Verifikasi password tidak berlaku.");
    }
  } catch {
    return apiError(c, 401, "Verifikasi password tidak berlaku.");
  }

  const body = await c.req.json().catch(() => null);
  const phone = typeof body?.phone === "string" ? body.phone : "";
  if (!validatePhone(phone)) return c.json({ valid: false, message: "nomor tidak terverifikasi" });

  const db = c.get("db");
  await db.query(
    "DELETE FROM portal_license_verification_attempts WHERE attempted_at < now() - interval '15 minutes'",
  );
  const attempts = await db.query(
    `SELECT count(*)::int AS count FROM portal_license_verification_attempts
     WHERE ip_hash = $1 AND attempted_at >= now() - interval '1 minute'`,
    [ipHash],
  );
  if (attempts.rows[0].count >= 60) {
    return apiError(c, 429, "Terlalu banyak pemeriksaan nomor. Coba lagi sebentar.");
  }
  await db.query(
    "INSERT INTO portal_license_verification_attempts (ip_hash) VALUES ($1)",
    [ipHash],
  );

  const valid = await isLicensedPhoneActive(db, phone);
  if (!valid) return c.json({ valid: false, message: "nomor tidak terverifikasi" });
  const statusToken = await new SignJWT({ purpose: "bot-license-status", phone })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("lloyd-license-portal")
    .setAudience("lloyd-bot-license-status")
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret);
  return c.json({ valid: true, statusToken });
});

api.post("/bot/number/status", async (c) => {
  const authorization = c.req.header("Authorization") || "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9._-]+)$/);
  if (!match) return apiError(c, 401, "Otorisasi status lisensi diperlukan.");
  let phone;
  try {
    const { payload } = await jwtVerify(match[1], getSecret(c.env), {
      issuer: "lloyd-license-portal",
      audience: "lloyd-bot-license-status",
    });
    if (payload.purpose !== "bot-license-status" || !validatePhone(payload.phone)) {
      return apiError(c, 401, "Otorisasi status lisensi tidak berlaku.");
    }
    phone = payload.phone;
  } catch {
    return apiError(c, 401, "Otorisasi status lisensi tidak berlaku.");
  }
  const valid = await isLicensedPhoneActive(c.get("db"), phone);
  return c.json({ valid, ...(!valid ? { message: "nomor tidak terverifikasi" } : {}) });
});

api.get("/subbots/me", requireAuth, async (c) => {
  await c.get("db").query(
    `UPDATE portal_subbots
     SET status = 'failed', command = NULL, pairing_code = NULL, qr_image = NULL,
         error_message = 'Waktu pairing habis. Silakan mulai pairing ulang.',
         updated_at = now()
     WHERE account_id = $1 AND status IN ('queued', 'starting', 'pairing')
       AND updated_at < now() - interval '10 minutes'`,
    [c.get("account").id],
  );
  const result = await c.get("db").query(
    `SELECT id, status, pairing_method, phone, connected_phone, pairing_code,
            qr_image, error_message, updated_at, config
     FROM portal_subbots WHERE account_id = $1`,
    [c.get("account").id],
  );
  return c.json({ subbot: result.rows[0] ? subbotDto(result.rows[0]) : null });
});

api.post("/subbots/me/settings", requireCsrf, requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const config = normalizeSubbotConfig(body?.config);
  if (!config) return apiError(c, 400, "Pengaturan sub-bot tidak valid. Periksa teks dan URL HTTPS.");
  const result = await c.get("db").query(
    `INSERT INTO portal_subbots (id, account_id, status, config)
     VALUES ($1, $2, 'stopped', $3::jsonb)
     ON CONFLICT (account_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()
     WHERE portal_subbots.status IN ('stopped', 'failed')
     RETURNING config`,
    [crypto.randomUUID(), c.get("account").id, JSON.stringify(config)],
  );
  if (!result.rowCount) return apiError(c, 409, "Hentikan sub-bot sebelum mengubah pengaturannya.");
  return c.json({ config: result.rows[0].config });
});

api.post("/subbots/me", requireCsrf, requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const method = body?.method;
  const phone = typeof body?.phone === "string" ? body.phone : null;
  if (!["qr", "pairing-code"].includes(method)
      || (method === "pairing-code" && !validatePhone(phone))
      || (method === "qr" && phone !== null)) {
    return apiError(c, 400, "Pilih metode pairing yang valid dan masukkan nomor untuk kode pairing.");
  }

  const result = await c.get("db").query(
    `INSERT INTO portal_subbots
       (id, account_id, status, command, pairing_method, phone, pairing_code, qr_image,
        connected_phone, error_message, created_at, updated_at, worker_seen_at)
     VALUES ($1, $2, 'queued', 'pair', $3, $4, NULL, NULL, NULL, NULL, now(), now(), NULL)
     ON CONFLICT (account_id) DO UPDATE SET
       status = 'queued', command = 'pair', pairing_method = EXCLUDED.pairing_method,
       phone = EXCLUDED.phone, pairing_code = NULL, qr_image = NULL,
       connected_phone = NULL, error_message = NULL, updated_at = now(), worker_seen_at = NULL
     WHERE portal_subbots.status IN ('stopped', 'failed')
     RETURNING id, status, pairing_method, phone, connected_phone, pairing_code,
             qr_image, error_message, updated_at, config`,
    [crypto.randomUUID(), c.get("account").id, method, phone],
  );
  if (!result.rowCount) return apiError(c, 409, "Sub-bot Anda sedang diproses atau sudah terhubung.");
  return c.json({ subbot: subbotDto(result.rows[0]) }, 202);
});

api.delete("/subbots/me", requireCsrf, requireAuth, async (c) => {
  const result = await c.get("db").query(
    `WITH stopped AS (
       UPDATE portal_subbots
       SET status = 'stop_requested', command = 'stop', pairing_code = NULL,
           qr_image = NULL, error_message = NULL, updated_at = now()
       WHERE account_id = $1 AND status IN ('queued', 'starting', 'pairing', 'connected')
       RETURNING status, true AS stopping
     )
     SELECT status, stopping FROM stopped
     UNION ALL
     SELECT status, status = 'stop_requested' AS stopping
     FROM portal_subbots
     WHERE account_id = $1 AND NOT EXISTS (SELECT 1 FROM stopped)
     LIMIT 1`,
    [c.get("account").id],
  );
  const subbot = result.rows[0];
  if (!subbot) return apiError(c, 404, "Sesi sub-bot tidak ditemukan.");
  return c.json({
    stopping: subbot.stopping,
    status: subbot.status,
  }, subbot.stopping ? 202 : 200);
});

api.post("/bot/subbots/claim", requireSubbotWorker, async (c) => {
  const db = c.get("db");
  await db.query("BEGIN");
  try {
    const result = await db.query(
      `SELECT id, account_id, command, pairing_method, phone, config
       FROM portal_subbots WHERE command IS NOT NULL
       ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const task = result.rows[0];
    if (!task) {
      await db.query("COMMIT");
      return c.json({ task: null });
    }
    const status = task.command === "pair" ? "starting" : "stop_requested";
    await db.query(
      "UPDATE portal_subbots SET command = NULL, status = $1, updated_at = now(), worker_seen_at = now() WHERE id = $2",
      [status, task.id],
    );
    await db.query("COMMIT");
    return c.json({
      task: {
        id: task.id,
        accountId: task.account_id,
        action: task.command,
        method: task.pairing_method,
        phone: task.phone,
        config: task.config || {},
      },
    });
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
});

api.post("/bot/subbots/sync", requireSubbotWorker, async (c) => {
  const result = await c.get("db").query(
    `SELECT subbot.id, subbot.account_id, subbot.pairing_method, subbot.phone, subbot.config
     FROM portal_subbots subbot
     JOIN portal_accounts account ON account.id = subbot.account_id
     WHERE subbot.status IN ('starting', 'pairing', 'connected')
       AND account.status = 'active'
     ORDER BY subbot.created_at`,
  );
  const revoked = await c.get("db").query(
    `SELECT subbot.id, account.id IS NULL AS purge_session
     FROM portal_subbots subbot
     LEFT JOIN portal_accounts account ON account.id = subbot.account_id
     WHERE (account.id IS NULL OR account.status <> 'active')
       AND subbot.status IN ('queued', 'starting', 'pairing', 'connected', 'stop_requested')`,
  );
  const inactive = await c.get("db").query(
    `SELECT subbot.id, subbot.status, subbot.command, subbot.updated_at
     FROM portal_subbots subbot
     JOIN portal_accounts account ON account.id = subbot.account_id
     WHERE account.status = 'active'
       AND subbot.status IN ('queued', 'stop_requested', 'stopped', 'failed')
     ORDER BY subbot.updated_at DESC`,
  );
  return c.json({
    subbots: result.rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      method: row.pairing_method,
      phone: row.phone,
      config: row.config || {},
    })),
    revoked: revoked.rows.map((row) => ({ id: row.id, purgeSession: row.purge_session })),
    inactive: inactive.rows.map((row) => ({
      id: row.id,
      status: row.status,
      command: row.command,
      updatedAt: row.updated_at,
    })),
  });
});

api.post("/bot/subbots/:id/status", requireSubbotWorker, async (c) => {
  const body = await c.req.json().catch(() => null);
  const allowedStatuses = ["starting", "pairing", "connected", "stopped", "failed"];
  const status = body?.status;
  const pairingCode = typeof body?.pairingCode === "string" ? body.pairingCode : null;
  const qrImage = typeof body?.qrImage === "string" ? body.qrImage : null;
  const connectedPhone = typeof body?.connectedPhone === "string" ? body.connectedPhone : null;
  const errorMessage = typeof body?.error === "string" ? body.error.trim().slice(0, 500) : null;
  if (!allowedStatuses.includes(status)
      || (pairingCode && pairingCode.length > 64)
      || (qrImage && (!qrImage.startsWith("data:image/png;base64,") || qrImage.length > 100_000))
      || (connectedPhone && !validatePhone(connectedPhone))) {
    return apiError(c, 400, "Status worker sub-bot tidak valid.");
  }
  const result = await c.get("db").query(
    `UPDATE portal_subbots SET
       status = $1::varchar,
       pairing_code = CASE WHEN $1::varchar = 'pairing' THEN $2::varchar ELSE NULL END,
       qr_image = CASE WHEN $1::varchar = 'pairing' THEN $3::text ELSE NULL END,
       connected_phone = CASE WHEN $1::varchar = 'connected' THEN $4::varchar ELSE connected_phone END,
       error_message = CASE WHEN $1::varchar = 'failed' THEN $5::varchar ELSE NULL END,
       updated_at = now(), worker_seen_at = now()
     WHERE id = $6::uuid
       AND (
         ($1::varchar IN ('starting', 'pairing', 'connected')
           AND status IN ('starting', 'pairing', 'connected'))
         OR ($1::varchar = 'stopped'
           AND status IN ('queued', 'starting', 'pairing', 'connected', 'stop_requested'))
         OR ($1::varchar = 'failed'
           AND status IN ('queued', 'starting', 'pairing', 'connected'))
       )
     RETURNING id`,
    [status, pairingCode, qrImage, connectedPhone, errorMessage, c.req.param("id")],
  );
  if (!result.rowCount) return c.json({ updated: false, ignored: true });
  return c.json({ updated: true });
});

api.post("/bot/subbots/:id/heartbeat", requireSubbotWorker, async (c) => {
  const result = await c.get("db").query(
    `UPDATE portal_subbots subbot SET worker_seen_at = now()
     FROM portal_accounts account
     WHERE subbot.id = $1 AND subbot.account_id = account.id
       AND account.status = 'active' AND subbot.status = 'connected'
     RETURNING subbot.id`,
    [c.req.param("id")],
  );
  return c.json({ active: result.rowCount > 0 });
});

api.get("/accounts", requireAuth, async (c) => {
  const actor = c.get("account");
  let result;
  if (actor.role === "owner") {
    result = await c.get("db").query(
      `SELECT id, name, email, role, parent_id, status, created_at
       FROM portal_accounts WHERE role <> 'owner' ORDER BY created_at DESC`,
    );
  } else if (actor.role === "partner") {
    result = await c.get("db").query(
      `SELECT id, name, email, role, parent_id, status, created_at
       FROM portal_accounts WHERE role = 'reseller' AND parent_id = $1
       ORDER BY created_at DESC`,
      [actor.id],
    );
  } else if (actor.role === "user") {
    return apiError(c, 403, "Akun user hanya dapat mengakses fitur sub-bot.");
  } else {
    return c.json({ accounts: [] });
  }
  return c.json({ accounts: result.rows.map(accountDto) });
});

api.post("/accounts", requireCsrf, requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const actor = c.get("account");
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const { password, role } = body || {};
  if (name.length < 2 || name.length > 60
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120
      || typeof password !== "string" || password.length < 8 || password.length > 128
      || !["partner", "reseller"].includes(role)) {
    return apiError(c, 400, "Data akun tidak valid. Password harus berisi 8–128 karakter.");
  }
  if (!canCreateRole(actor, role)) return apiError(c, 403, "Anda tidak dapat membuat akun dengan role tersebut.");
  let parentId = role === "reseller" && actor.role === "partner" ? actor.id : null;
  if (role === "reseller" && actor.role === "owner" && body.parentId) {
    const parent = await c.get("db").query(
      "SELECT id FROM portal_accounts WHERE id = $1 AND role = 'partner' AND status = 'active'",
      [body.parentId],
    );
    if (!parent.rowCount) return apiError(c, 400, "Partner induk tidak valid.");
    parentId = parent.rows[0].id;
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await c.get("db").query(
      `INSERT INTO portal_accounts (id, name, email, password_hash, role, parent_id, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, email, role, parent_id, status, created_at`,
      [crypto.randomUUID(), name, email, passwordHash, role, parentId, actor.id],
    );
    return c.json({ account: accountDto(result.rows[0]) }, 201);
  } catch (error) {
    if (error.code === "23505" && error.constraint === "portal_accounts_name_lower_uq") {
      return apiError(c, 409, "Username tersebut sudah digunakan.");
    }
    if (error.code === "23505" && error.constraint === "portal_accounts_email_lower_uq") {
      return apiError(c, 409, "Email sudah digunakan.");
    }
    throw error;
  }
});

api.delete("/accounts/:id", requireCsrf, requireAuth, async (c) => {
  const db = c.get("db");
  await db.query("BEGIN");
  try {
    const result = await db.query(
      "SELECT id, role, parent_id FROM portal_accounts WHERE id = $1 AND role <> 'owner' FOR UPDATE",
      [c.req.param("id")],
    );
    const target = result.rows[0];
    if (!target) {
      await db.query("ROLLBACK");
      return apiError(c, 404, "Akun tidak ditemukan.");
    }
    if (!canManageAccount(c.get("account"), {
      id: target.id,
      role: target.role,
      parentId: target.parent_id,
    })) {
      await db.query("ROLLBACK");
      return apiError(c, 403, "Anda tidak memiliki izin menghapus akun ini.");
    }
    if (target.role === "partner") {
      await db.query("DELETE FROM portal_licenses WHERE created_by_id = $1", [target.id]);
      await db.query(
        "UPDATE portal_accounts SET parent_id = NULL WHERE role = 'reseller' AND parent_id = $1",
        [target.id],
      );
    }
    if (target.role === "user") {
      await db.query(
        `UPDATE portal_subbots SET status = 'stop_requested', command = 'stop',
         pairing_code = NULL, qr_image = NULL, updated_at = now()
         WHERE account_id = $1`,
        [target.id],
      );
    }
    await db.query("DELETE FROM portal_accounts WHERE id = $1", [target.id]);
    await db.query("COMMIT");
    return c.body(null, 204);
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
});

api.patch("/accounts/:id/status", requireCsrf, requireAuth, async (c) => {
  if (c.get("account").role !== "owner") return apiError(c, 403, "Hanya Owner yang dapat mengubah status akun.");
  const body = await c.req.json().catch(() => null);
  if (!["active", "inactive"].includes(body?.status)) return apiError(c, 400, "Status akun tidak valid.");
  const result = await c.get("db").query(
    `UPDATE portal_accounts SET status = $1 WHERE id = $2 AND role <> 'owner'
     RETURNING id, name, email, role, parent_id, status, created_at`,
    [body.status, c.req.param("id")],
  );
  if (!result.rowCount) return apiError(c, 404, "Akun tidak ditemukan.");
  return c.json({ account: accountDto(result.rows[0]) });
});

api.get("/licenses", requireAuth, async (c) => {
  const actor = c.get("account");
  const db = c.get("db");
  if (actor.role === "user") return apiError(c, 403, "Akun user hanya dapat mengakses fitur sub-bot.");
  if (actor.role === "reseller") {
    const result = await db.query(
      `SELECT id, phone, reseller_id, created_by_id, status, created_at
       FROM portal_licenses WHERE reseller_id = $1 ORDER BY created_at DESC`,
      [actor.id],
    );
    return c.json({ licenses: result.rows.map(licenseDto) });
  }
  const resellerIds = [...await getVisibleResellerIds(db, actor)];
  const result = await db.query(
    `SELECT id, phone, reseller_id, created_by_id, status, created_at
     FROM portal_licenses WHERE reseller_id = ANY($1::uuid[]) OR created_by_id = $2
     ORDER BY created_at DESC`,
    [resellerIds, actor.id],
  );
  return c.json({ licenses: result.rows.map(licenseDto) });
});

api.post("/licenses/verify", async (c) => {
  return apiError(c, 410, "Verifikasi token per nomor sudah tidak digunakan. Gunakan alur password script.");
});

api.post("/licenses", requireCsrf, requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const phone = typeof body?.phone === "string" ? body.phone.replace(/\D/g, "") : "";
  if (!validatePhone(phone)) return apiError(c, 400, "Nomor harus berupa 8–15 digit internasional tanpa tanda +.");
  const actor = c.get("account");
  if (actor.role === "user") return apiError(c, 403, "Akun user hanya dapat mengakses fitur sub-bot.");
  try {
    const result = await c.get("db").query(
      `INSERT INTO portal_licenses (id, phone, reseller_id, created_by_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, phone, reseller_id, created_by_id, status, created_at`,
      [crypto.randomUUID(), phone, actor.id, actor.id],
    );
    return c.json({ license: licenseDto(result.rows[0]) }, 201);
  } catch (error) {
    if (error.code === "23505") return apiError(c, 409, "Nomor tersebut sudah memiliki lisensi.");
    throw error;
  }
});

api.delete("/licenses/:id", requireCsrf, requireAuth, async (c) => {
  const actor = c.get("account");
  const db = c.get("db");
  const visibleIds = await getVisibleResellerIds(db, actor);
  const result = await db.query(
    "SELECT id, reseller_id, created_by_id FROM portal_licenses WHERE id = $1",
    [c.req.param("id")],
  );
  const license = result.rows[0];
  if (!license) return apiError(c, 404, "Lisensi tidak ditemukan.");
  if (!canDeleteLicense(actor, {
    resellerId: license.reseller_id,
    createdById: license.created_by_id,
  }, visibleIds)) {
    return apiError(c, 403, "Anda tidak memiliki izin menghapus lisensi ini.");
  }
  await db.query("DELETE FROM portal_licenses WHERE id = $1", [license.id]);
  return c.body(null, 204);
});

api.patch("/licenses/:id/status", requireCsrf, requireAuth, async (c) => {
  if (c.get("account").role !== "owner") return apiError(c, 403, "Hanya Owner yang dapat mengubah status lisensi.");
  const body = await c.req.json().catch(() => null);
  if (!["active", "inactive"].includes(body?.status)) return apiError(c, 400, "Status lisensi tidak valid.");
  const result = await c.get("db").query(
    `UPDATE portal_licenses SET status = $1 WHERE id = $2
     RETURNING id, phone, reseller_id, created_by_id, status, created_at`,
    [body.status, c.req.param("id")],
  );
  if (!result.rowCount) return apiError(c, 404, "Lisensi tidak ditemukan.");
  return c.json({ license: licenseDto(result.rows[0]) });
});

app.route("/api", api);
app.notFound((c) => {
  if (c.env?.ASSETS) return serveAsset(c.req.raw, c.env.ASSETS);
  return apiError(c, 404, "Endpoint tidak ditemukan.");
});
app.onError((error, c) => {
  console.error("Permintaan portal gagal.", { method: c.req.method, path: c.req.path, error });
  return apiError(c, 500, "Terjadi kesalahan server. Silakan coba lagi.");
});

module.exports = app;
