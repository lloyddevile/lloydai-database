require("dotenv").config();

const { serve } = require("@hono/node-server");
const { serveStatic } = require("@hono/node-server/serve-static");
const app = require("./worker");

app.use("*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT || 3000);
const env = {
  DATABASE_URL: process.env.DATABASE_URL,
  PGSSLMODE: process.env.PGSSLMODE,
  SESSION_SECRET: process.env.SESSION_SECRET,
  NODE_ENV: process.env.NODE_ENV,
};

if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 characters.");
}

serve({
  fetch: (request) => app.fetch(request, env),
  port,
}, (info) => {
  console.log(`Lloyd License Portal listening on port ${info.port}.`);
});
