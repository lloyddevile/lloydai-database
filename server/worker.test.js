const test = require("node:test");
const assert = require("node:assert/strict");
const { SignJWT } = require("jose");
const bcrypt = require("bcryptjs");
const { Client } = require("pg");
const app = require("./worker");
const TEST_SECRET = "test-secret-with-at-least-32-characters";

async function createSession(accountId, csrfToken = "csrf-test-token") {
  return new SignJWT({ csrf: csrfToken, accountId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("lloyd-license-portal")
    .setAudience("lloyd-license-portal")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function sessionHeaders(session, csrfToken = "csrf-test-token") {
  return {
    Cookie: `lloyd_portal_session=${encodeURIComponent(session)}`,
    Origin: "https://portal.example",
    "X-CSRF-Token": csrfToken,
  };
}

test("Worker issues a signed CSRF session without requiring a database connection", async () => {
  const response = await app.request(
    "https://portal.example/api/auth/csrf",
    { method: "GET" },
    { SESSION_SECRET: "test-secret-with-at-least-32-characters" },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.csrfToken, /^[a-f0-9]{64}$/);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(response.headers.get("set-cookie"), /SameSite=Strict/);
});

test("Worker returns a JSON 404 for unknown routes", async () => {
  const response = await app.request("https://portal.example/not-found");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("Worker forwards non-API requests to the configured assets binding", async () => {
  const response = await app.request(
    "https://portal.example/",
    {},
    { ASSETS: { fetch: async () => new Response("portal assets") } },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "portal assets");
  assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
});

test("login accepts a case-insensitive account name as username", async () => {
  const originalConnect = Client.prototype.connect;
  const originalQuery = Client.prototype.query;
  const originalEnd = Client.prototype.end;
  const password = "Pass-123";
  const passwordHash = await bcrypt.hash(password, 4);
  const csrfToken = "login-csrf-token";
  const csrfSession = await createSession(undefined, csrfToken);
  Client.prototype.connect = async () => {};
  Client.prototype.end = async () => {};
  Client.prototype.query = async function (sql, values) {
    if (sql.includes("SELECT count(*)::int AS count")) return { rows: [{ count: 0 }] };
    if (sql.includes("FROM portal_accounts WHERE lower(name) = $1")) {
      return values[0] === "lloyd owner"
        ? { rows: [{ id: "owner-id", name: "Lloyd Owner", email: "owner@example.test", role: "owner", parent_id: null, password_hash: passwordHash }] }
        : { rows: [] };
    }
    if (sql.includes("SELECT NOT EXISTS (SELECT 1 FROM account_chain")) return { rows: [{ active: true }] };
    if (sql.includes("DELETE FROM portal_login_attempts")) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected database query: ${sql}`);
  };

  try {
    const login = async (body) => app.request(
      "https://portal.example/api/auth/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `lloyd_portal_session=${encodeURIComponent(csrfSession)}`,
          Origin: "https://portal.example",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify(body),
      },
      { SESSION_SECRET: TEST_SECRET, HYPERDRIVE: { connectionString: "postgres://portal.example/db" } },
    );

    const usernameLogin = await login({ username: " LLOYD OWNER ", password });
    assert.equal(usernameLogin.status, 200);
    assert.equal((await usernameLogin.json()).account.name, "Lloyd Owner");

    const emailLogin = await login({ email: "owner@example.test", password });
    assert.equal(emailLogin.status, 400);
  } finally {
    Client.prototype.connect = originalConnect;
    Client.prototype.query = originalQuery;
    Client.prototype.end = originalEnd;
  }
});

test("new accounts accept passwords with at least 8 characters", async () => {
  const originalConnect = Client.prototype.connect;
  const originalQuery = Client.prototype.query;
  const originalEnd = Client.prototype.end;
  const ownerSession = await createSession("owner-id");
  let insertedAccount;
  Client.prototype.connect = async () => {};
  Client.prototype.end = async () => {};
  Client.prototype.query = async function (sql, values) {
    if (sql.includes("WITH RECURSIVE account_chain AS")) {
      return {
        rows: [{
          id: "owner-id",
          name: "Lloyd Owner",
          email: "owner@example.test",
          role: "owner",
          parent_id: null,
          status: "active",
        }],
      };
    }
    if (sql.includes("INSERT INTO portal_accounts")) {
      insertedAccount = values;
      return {
        rows: [{
          id: values[0],
          name: values[1],
          email: values[2],
          role: values[4],
          parent_id: values[5],
          status: "active",
          created_at: new Date().toISOString(),
        }],
      };
    }
    throw new Error(`Unexpected database query: ${sql}`);
  };

  try {
    const createAccount = async (password) => app.request(
      "https://portal.example/api/accounts",
      {
        method: "POST",
        headers: { ...sessionHeaders(ownerSession), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "New Partner",
          email: "partner@example.test",
          role: "partner",
          password,
        }),
      },
      { SESSION_SECRET: TEST_SECRET, HYPERDRIVE: { connectionString: "postgres://portal.example/db" } },
    );

    const tooShort = await createAccount("Short-7");
    assert.equal(tooShort.status, 400);
    assert.equal(insertedAccount, undefined);

    const created = await createAccount("Pass-123");
    assert.equal(created.status, 201);
    assert.equal((await created.json()).account.name, "New Partner");
    assert.equal(await bcrypt.compare("Pass-123", insertedAccount[3]), true);
  } finally {
    Client.prototype.connect = originalConnect;
    Client.prototype.query = originalQuery;
    Client.prototype.end = originalEnd;
  }
});

test("owner can publish an announcement that all roles can read", async () => {
  const originalConnect = Client.prototype.connect;
  const originalQuery = Client.prototype.query;
  const originalEnd = Client.prototype.end;
  const ownerSession = await createSession("owner-id");
  const partnerSession = await createSession("partner-id");
  let announcement = null;
  Client.prototype.connect = async () => {};
  Client.prototype.end = async () => {};
  Client.prototype.query = async function (sql, values) {
    if (sql.includes("WITH RECURSIVE account_chain AS")) {
      const id = values[0];
      return {
        rows: [{
          id,
          name: id === "owner-id" ? "Owner" : "Partner",
          email: `${id}@example.test`,
          role: id === "owner-id" ? "owner" : "partner",
          parent_id: null,
          status: "active",
        }],
      };
    }
    if (sql.includes("FROM portal_announcement")) return { rows: announcement ? [announcement] : [] };
    if (sql.includes("INSERT INTO portal_announcement")) {
      announcement = { title: values[0], message: values[1], updated_at: new Date().toISOString() };
      return { rows: [announcement] };
    }
    if (sql.includes("DELETE FROM portal_announcement")) {
      announcement = null;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected database query: ${sql}`);
  };

  try {
    const publish = await app.request(
      "https://portal.example/api/announcement",
      {
        method: "POST",
        headers: { ...sessionHeaders(ownerSession), "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Pemeliharaan", message: "Portal tidak tersedia pukul 22.00." }),
      },
      { SESSION_SECRET: TEST_SECRET, HYPERDRIVE: { connectionString: "postgres://portal.example/db" } },
    );
    assert.equal(publish.status, 200);
    assert.equal((await publish.json()).announcement.title, "Pemeliharaan");

    const read = await app.request(
      "https://portal.example/api/announcement",
      { headers: sessionHeaders(partnerSession) },
      { SESSION_SECRET: TEST_SECRET, HYPERDRIVE: { connectionString: "postgres://portal.example/db" } },
    );
    assert.equal(read.status, 200);
    assert.equal((await read.json()).announcement.message, "Portal tidak tersedia pukul 22.00.");

    const denied = await app.request(
      "https://portal.example/api/announcement",
      {
        method: "POST",
        headers: { ...sessionHeaders(partnerSession), "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Tidak diizinkan", message: "..." }),
      },
      { SESSION_SECRET: TEST_SECRET, HYPERDRIVE: { connectionString: "postgres://portal.example/db" } },
    );
    assert.equal(denied.status, 403);

    const remove = await app.request(
      "https://portal.example/api/announcement",
      { method: "DELETE", headers: sessionHeaders(ownerSession) },
      { SESSION_SECRET: TEST_SECRET, HYPERDRIVE: { connectionString: "postgres://portal.example/db" } },
    );
    assert.equal(remove.status, 204);
  } finally {
    Client.prototype.connect = originalConnect;
    Client.prototype.query = originalQuery;
    Client.prototype.end = originalEnd;
  }
});

test("users can update their display name, login email, and password with current-password verification", async () => {
  const originalConnect = Client.prototype.connect;
  const originalQuery = Client.prototype.query;
  const originalEnd = Client.prototype.end;
  const session = await createSession("reseller-id");
  const oldPassword = "Current-password-1";
  let passwordHash = await bcrypt.hash(oldPassword, 4);
  let updatedAccount;
  let updateCount = 0;
  Client.prototype.connect = async () => {};
  Client.prototype.end = async () => {};
  Client.prototype.query = async function (sql, values) {
    if (sql.includes("WITH RECURSIVE account_chain AS")) {
      return {
        rows: [{
          id: "reseller-id",
          name: "Old name",
          email: "old@example.test",
          role: "reseller",
          parent_id: null,
          status: "active",
        }],
      };
    }
    if (sql.includes("SELECT password_hash FROM portal_accounts")) {
      return { rows: [{ password_hash: passwordHash }], rowCount: 1 };
    }
    if (sql.includes("UPDATE portal_accounts SET name = $1")) {
      updateCount += 1;
      passwordHash = values[2];
      updatedAccount = {
        id: values[3],
        name: values[0],
        email: values[1],
        role: "reseller",
        parent_id: null,
        status: "active",
        created_at: new Date().toISOString(),
      };
      return { rows: [updatedAccount], rowCount: 1 };
    }
    throw new Error(`Unexpected database query: ${sql}`);
  };

  try {
    const response = await app.request(
      "https://portal.example/api/auth/profile",
      {
        method: "PATCH",
        headers: { ...sessionHeaders(session), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: " New display name ",
          email: "NEW@example.test ",
          currentPassword: oldPassword,
          newPassword: "Pass-123",
        }),
      },
      { SESSION_SECRET: TEST_SECRET, HYPERDRIVE: { connectionString: "postgres://portal.example/db" } },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.account.name, "New display name");
    assert.equal(body.account.email, "new@example.test");
    assert.equal(await bcrypt.compare("Pass-123", passwordHash), true);
    assert.deepEqual(
      { name: updatedAccount.name, email: updatedAccount.email },
      { name: "New display name", email: "new@example.test" },
    );

    const rejected = await app.request(
      "https://portal.example/api/auth/profile",
      {
        method: "PATCH",
        headers: { ...sessionHeaders(session), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Changed without auth",
          email: "new@example.test",
          currentPassword: oldPassword,
          newPassword: "",
        }),
      },
      { SESSION_SECRET: TEST_SECRET, HYPERDRIVE: { connectionString: "postgres://portal.example/db" } },
    );
    assert.equal(rejected.status, 403);
    assert.equal(updateCount, 1);

    const tooShort = await app.request(
      "https://portal.example/api/auth/profile",
      {
        method: "PATCH",
        headers: { ...sessionHeaders(session), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "New display name",
          email: "new@example.test",
          currentPassword: "Pass-123",
          newPassword: "Short-7",
        }),
      },
      { SESSION_SECRET: TEST_SECRET, HYPERDRIVE: { connectionString: "postgres://portal.example/db" } },
    );
    assert.equal(tooShort.status, 400);
    assert.equal(updateCount, 1);
  } finally {
    Client.prototype.connect = originalConnect;
    Client.prototype.query = originalQuery;
    Client.prototype.end = originalEnd;
  }
});

test("owner, partner, and reseller license registrations belong to their own account", async () => {
  const originalConnect = Client.prototype.connect;
  const originalQuery = Client.prototype.query;
  const originalEnd = Client.prototype.end;
  const secret = "test-secret-with-at-least-32-characters";
  const csrfToken = "csrf-test-token";
  const accounts = [
    { id: "owner-id", role: "owner", parent_id: null },
    { id: "partner-id", role: "partner", parent_id: "owner-id" },
    { id: "reseller-id", role: "reseller", parent_id: "partner-id" },
  ];
  const licenses = [];
  Client.prototype.connect = async () => {};
  Client.prototype.end = async () => {};
  Client.prototype.query = async function (sql, values) {
    if (sql.includes("FROM portal_accounts WHERE id = $1")) {
      const account = accounts.find((item) => item.id === values[0]);
      return { rows: account ? [{ ...account, name: account.role, email: `${account.role}@example.test`, status: "active" }] : [] };
    }
    if (sql.includes("FROM portal_accounts WHERE role = 'reseller'")) return { rows: [] };
    if (sql.includes("INSERT INTO portal_licenses")) {
      const license = {
        id: values[0],
        phone: values[1],
        reseller_id: values[2],
        created_by_id: values[3],
        status: "active",
        created_at: new Date().toISOString(),
      };
      licenses.push(license);
      return { rows: [license] };
    }
    if (sql.includes("FROM portal_licenses WHERE reseller_id = $1")) {
      return { rows: licenses.filter((license) => license.reseller_id === values[0]) };
    }
    if (sql.includes("FROM portal_licenses WHERE reseller_id = ANY($1::uuid[])")) {
      return { rows: licenses.filter((license) => license.created_by_id === values[1]) };
    }
    throw new Error(`Unexpected database query: ${sql}`);
  };

  try {
    for (const account of accounts) {
      const session = await new SignJWT({ csrf: csrfToken, accountId: account.id })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("lloyd-license-portal")
        .setAudience("lloyd-license-portal")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(new TextEncoder().encode(secret));
      const response = await app.request(
        "https://portal.example/api/licenses",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `lloyd_portal_session=${encodeURIComponent(session)}`,
            Origin: "https://portal.example",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({ phone: "6281234567890", resellerId: "another-account-id" }),
        },
        {
          SESSION_SECRET: secret,
          HYPERDRIVE: { connectionString: "postgres://portal.example/db" },
        },
      );

      assert.equal(response.status, 201, `${account.role} should be allowed to register a license`);
      const body = await response.json();
      assert.equal(body.license.resellerId, account.id);
      assert.equal(body.license.createdById, account.id);

      const listResponse = await app.request(
        "https://portal.example/api/licenses",
        {
          headers: {
            Cookie: `lloyd_portal_session=${encodeURIComponent(session)}`,
            Origin: "https://portal.example",
          },
        },
        {
          SESSION_SECRET: secret,
          HYPERDRIVE: { connectionString: "postgres://portal.example/db" },
        },
      );
      assert.equal(listResponse.status, 200);
      const listBody = await listResponse.json();
      assert.equal(listBody.licenses.length, 1, `${account.role} should see its own license with no reseller children`);
      assert.equal(listBody.licenses[0].resellerId, account.id);
    }
  } finally {
    Client.prototype.connect = originalConnect;
    Client.prototype.query = originalQuery;
    Client.prototype.end = originalEnd;
  }
});

test("only the Owner can configure the shared script password", async () => {
  const originalConnect = Client.prototype.connect;
  const originalQuery = Client.prototype.query;
  const originalEnd = Client.prototype.end;
  const secret = "test-secret-with-at-least-32-characters";
  const csrfToken = "csrf-test-token";
  let savedPasswordHash = "";
  Client.prototype.connect = async () => {};
  Client.prototype.end = async () => {};
  Client.prototype.query = async function (sql, values) {
    if (sql.includes("FROM portal_accounts WHERE id = $1")) {
      const role = values[0] === "owner-id" ? "owner" : "partner";
      return {
        rows: [{
          id: values[0],
          name: role,
          email: `${role}@example.test`,
          role,
          parent_id: null,
          status: "active",
        }],
      };
    }
    if (sql.includes("SELECT 1 FROM portal_script_settings")) {
      return { rows: [], rowCount: savedPasswordHash ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO portal_script_settings")) {
      savedPasswordHash = values[0];
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected database query: ${sql}`);
  };

  const makeSession = async (accountId) => new SignJWT({ csrf: csrfToken, accountId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("lloyd-license-portal")
    .setAudience("lloyd-license-portal")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));

  try {
    const ownerSession = await makeSession("owner-id");
    const saveResponse = await app.request(
      "https://portal.example/api/bot/password",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `lloyd_portal_session=${encodeURIComponent(ownerSession)}`,
          Origin: "https://portal.example",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ password: "shared script password" }),
      },
      {
        SESSION_SECRET: secret,
        HYPERDRIVE: { connectionString: "postgres://portal.example/db" },
      },
    );
    assert.equal(saveResponse.status, 200);
    assert.match(savedPasswordHash, /^\$2[aby]\$12\$/);
    assert.notEqual(savedPasswordHash, "shared script password");

    const partnerSession = await makeSession("partner-id");
    const deniedResponse = await app.request(
      "https://portal.example/api/bot/password",
      {
        headers: {
          Cookie: `lloyd_portal_session=${encodeURIComponent(partnerSession)}`,
          Origin: "https://portal.example",
        },
      },
      {
        SESSION_SECRET: secret,
        HYPERDRIVE: { connectionString: "postgres://portal.example/db" },
      },
    );
    assert.equal(deniedResponse.status, 403);
  } finally {
    Client.prototype.connect = originalConnect;
    Client.prototype.query = originalQuery;
    Client.prototype.end = originalEnd;
  }
});

test("bot password challenge verifies a licensed number and refreshes license status", async () => {
  const originalConnect = Client.prototype.connect;
  const originalQuery = Client.prototype.query;
  const originalEnd = Client.prototype.end;
  const secret = "test-secret-with-at-least-32-characters";
  const passwordHash = await bcrypt.hash("correct horse battery", 4);
  let licenseActive = true;
  Client.prototype.connect = async () => {};
  Client.prototype.end = async () => {};
  Client.prototype.query = async function (sql) {
    if (sql.includes("SELECT count(*)::int AS count")) return { rows: [{ count: 0 }] };
    if (sql.includes("SELECT password_hash FROM portal_script_settings")) {
      return { rows: [{ password_hash: passwordHash }] };
    }
    if (sql.includes("count(*) > 0 AND bool_and(status = 'active')")) {
      return { rows: [{ active: licenseActive }] };
    }
    return { rows: [], rowCount: 1 };
  };

  try {
    const failedPassword = await app.request(
      "https://portal.example/api/bot/password/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
        body: JSON.stringify({ password: "wrong password" }),
      },
      {
        SESSION_SECRET: secret,
        HYPERDRIVE: { connectionString: "postgres://portal.example/db" },
      },
    );
    assert.deepEqual(await failedPassword.json(), { valid: false });

    const passwordResponse = await app.request(
      "https://portal.example/api/bot/password/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
        body: JSON.stringify({ password: "correct horse battery" }),
      },
      {
        SESSION_SECRET: secret,
        HYPERDRIVE: { connectionString: "postgres://portal.example/db" },
      },
    );
    assert.equal(passwordResponse.status, 200);
    const { verificationToken } = await passwordResponse.json();
    assert.ok(verificationToken);

    const numberResponse = await app.request(
      "https://portal.example/api/bot/number/verify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${verificationToken}`,
          "CF-Connecting-IP": "192.0.2.10",
        },
        body: JSON.stringify({ phone: "6281234567890" }),
      },
      {
        SESSION_SECRET: secret,
        HYPERDRIVE: { connectionString: "postgres://portal.example/db" },
      },
    );
    assert.equal(numberResponse.status, 200);
    const numberResult = await numberResponse.json();
    assert.equal(numberResult.valid, true);
    assert.ok(numberResult.statusToken);

    const statusResponse = await app.request(
      "https://portal.example/api/bot/number/status",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${numberResult.statusToken}` },
        body: "{}",
      },
      {
        SESSION_SECRET: secret,
        HYPERDRIVE: { connectionString: "postgres://portal.example/db" },
      },
    );
    assert.deepEqual(await statusResponse.json(), { valid: true });

    licenseActive = false;
    const inactiveResponse = await app.request(
      "https://portal.example/api/bot/number/status",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${numberResult.statusToken}` },
        body: "{}",
      },
      {
        SESSION_SECRET: secret,
        HYPERDRIVE: { connectionString: "postgres://portal.example/db" },
      },
    );
    assert.deepEqual(await inactiveResponse.json(), {
      valid: false,
      message: "nomor tidak terverifikasi",
    });
  } finally {
    Client.prototype.connect = originalConnect;
    Client.prototype.query = originalQuery;
    Client.prototype.end = originalEnd;
  }
});

test("legacy token verification is disabled after moving to the shared password flow", async () => {
  const originalConnect = Client.prototype.connect;
  const originalQuery = Client.prototype.query;
  const originalEnd = Client.prototype.end;
  Client.prototype.connect = async () => {};
  Client.prototype.end = async () => {};
  Client.prototype.query = async () => ({ rows: [], rowCount: 0 });
  try {
    const response = await app.request(
      "https://portal.example/api/licenses/verify",
      { method: "POST", body: "{}" },
      {
        SESSION_SECRET: "test-secret-with-at-least-32-characters",
        HYPERDRIVE: { connectionString: "postgres://portal.example/db" },
      },
    );
    assert.equal(response.status, 410);
  } finally {
    Client.prototype.connect = originalConnect;
    Client.prototype.query = originalQuery;
    Client.prototype.end = originalEnd;
  }
});
