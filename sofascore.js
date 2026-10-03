/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║              SofaScore Proxy API by Romeo Calyx                      ║
 * ╠══════════════════════════════════════════════════════════════════════════════╣
 * ║  Railway (and most datacenter hosts) are hard-blocked by SofaScore with a    ║
 * ║  403 that no fingerprint rotation can clear. Residential connections work     ║
 * ║  fine, so this service runs where the IP is trusted and relays the JSON for   ║
 * ║  the bot.                                                                     ║
 * ║                                                                              ║
 * ║  Endpoints (all mirror the SofaScore v1 API so the bot needs no rewrite):     ║
 * ║    GET  /health                                                                ║
 * ║    GET  /api/*        ->  https://www.sofascore.com/api/v1/*                  ║
 * ║    GET  /img/*        ->  https://img.sofascore.com/api/v1/*  (binary relay)   ║
 * ║                                                                              ║
 * ║  Extras the bot benefits from:                                               ║
 * ║    ?cache=30    TTL in seconds (0 disables caching for that route)           ║
 * ║    shared TTLs keep the auto-goal-alert poller from hammering SofaScore.     ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

"use strict";

const express = require("express");
const { fetch } = require("wreq-js");

const PORT = Number(process.env.PORT) || 3000;
const SS_BASE = "https://www.sofascore.com/api/v1";
const SS_IMG = "https://img.sofascore.com/api/v1";

// The relay is public, so a shared secret is required. The bot sends it as
// `x-api-key`; without it every request is refused.
const API_KEY = process.env.API_KEY || "";

/**
 * Fingerprints rotated per attempt. The okhttp profile leads because it is the
 * least recognisable to bot-detection; a 403 on one profile often clears on the
 * next, so retrying is genuinely useful here.
 */
const FINGERPRINTS = [
  { browser: "okhttp_5", os: "android" },
  { browser: "chrome_149", os: "windows" },
  { browser: "chrome_131", os: "windows" },
  { browser: "firefox_135", os: "windows" },
];

const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.sofascore.com/",
  Origin: "https://www.sofascore.com",
  "x-sofa-locale": "en",
};

// ─── cache ────────────────────────────────────────────────────────────────────
// Live data changes every few seconds; the poller and every command hit the
// same routes, so a short shared cache removes almost all duplicate traffic.
const cache = new Map();
const CACHE_LIMIT = 500;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlSeconds) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

// ─── upstream fetch ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a SofaScore path, rotating fingerprints until one is answered.
 * @returns {Promise<{status:number, text:string}>}
 */
async function upstream(path, kind) {
  const base = kind === "img" ? SS_IMG : SS_BASE;
  const url = path.startsWith("http") ? path : base + path;
  const accept = kind === "img" ? "image/*,*/*" : HEADERS.Accept;

  // The search route sits behind SofaScore's challenge layer. A plain fetch is
  // refused, but a session that has already visited the site answers normally,
  // so those routes go through a warm cookie jar instead.
  if (kind !== "img" && path.startsWith("/search/")) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const s = await fetch.createSession({ browser: "okhttp_5", os: "android" });
        try { await s.fetch("https://www.sofascore.com/", { headers: { Accept: "text/html" } }); } catch {}
        const res = await s.fetch(url, { headers: { ...HEADERS, Accept: "text/html,*/*;q=0.8" } });
        const buf = Buffer.from(await res.arrayBuffer());
        if (res.ok && buf.length) return { status: 200, buffer: buf, type: null };
      } catch {}
    }
    return { status: 403, text: "search challenge not cleared" };
  }

  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 0; attempt < FINGERPRINTS.length; attempt++) {
    const fp = FINGERPRINTS[attempt];
    try {
      const res = await fetch(url, {
        browser: fp.browser,
        os: fp.os,
        headers: { ...HEADERS, Accept: accept },
      });
      const buf = Buffer.from(await res.arrayBuffer());

      if (res.status === 404) return { status: 404, text: "" };
      if (res.ok && buf.length) {
        return { status: 200, buffer: buf, type: res.headers?.get?.("content-type") || null };
      }

      lastStatus = res.status;
      lastBody = buf.toString("utf8").slice(0, 200);
    } catch (err) {
      lastStatus = 0;
      lastBody = err.message.slice(0, 200);
    }
    if (attempt) await sleep(300 * attempt);
  }

  return { status: lastStatus || 502, text: lastBody };
}

// ─── app ──────────────────────────────────────────────────────────────────────

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  if (!API_KEY) return next();
  const key = req.get("x-api-key") || req.query.key;
  if (key === API_KEY) return next();
  res.status(401).json({ error: "unauthorised" });
});

app.get("/health", async (_req, res) => {
  try {
    const r = await upstream("/sport/football/events/live", "json");
    res.json({ ok: r.status === 200, upstream: r.status, at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Image relay — crests and player photos arrive as WebP, which the bot transcodes. */
app.get("/img/*", async (req, res) => {
  const key = "img:" + req.originalUrl;
  const ttl = Number(req.query.cache ?? 3600);
  const hit = ttl > 0 ? cacheGet(key) : null;
  if (hit) {
    res.set("Cache-Control", "public, max-age=" + ttl);
    return res.send(hit.buffer);
  }

  const r = await upstream("/" + req.params[0], "img");
  if (r.status !== 200) return res.status(r.status).end();

  if (ttl > 0) cacheSet(key, { buffer: r.buffer, type: r.type }, ttl);
  res.set("Content-Type", r.type || "image/webp");
  res.set("Cache-Control", "public, max-age=" + ttl);
  res.send(r.buffer);
});

/** JSON relay — mirrors the SofaScore v1 surface exactly. */
app.get("/api/*", async (req, res) => {
  const path = "/" + req.params[0];
  const ttl = Number(req.query.cache ?? 0);
  const key = "api:" + req.originalUrl;

  const hit = ttl > 0 ? cacheGet(key) : null;
  if (hit) {
    return res.json({ ...hit, _cached: true });
  }

  const r = await upstream(path, "json");

  if (r.status === 404) {
    return res.status(404).json({ error: "not found", path });
  }
  if (r.status !== 200) {
    console.error(`[proxy] ${path} -> ${r.status} ${r.text || ""}`);
    return res.status(r.status === 502 ? 502 : r.status).json({
      error: "upstream refused",
      status: r.status,
      detail: r.text || undefined,
    });
  }

  let json;
  try {
    json = JSON.parse(r.buffer.toString("utf8"));
  } catch {
    return res.status(502).json({ error: "upstream sent a non-JSON body" });
  }

  if (ttl > 0) cacheSet(key, json, ttl);
  res.json(json);
});

const server = app.listen(PORT, () => {
  console.log(`[sofascore-api] listening on :${PORT}`);
  console.log(`[sofascore-api] auth: ${API_KEY ? "enabled" : "DISABLED — set API_KEY"}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
