/*
 * TCOAAL Browser Player
 * Copyright (C) 2026 kidev
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. This program is distributed in the hope that it
 * will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty
 * of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
 * General Public License for more details: <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/*
 * Install counter for the Mods menu.
 *
 * Runs on the tcoaal.app/api/* route (same origin as the player, so the client
 * needs no CORS and the Android WebView works unchanged), backed by D1:
 *
 *   POST /api/dl/{modId}  -> count one install of {modId}. 204, no body.
 *   GET  /api/dl          -> every count as {"<modId>": <n>, ...}.
 *
 * The counts are deliberately public and unauthenticated: they say roughly how
 * popular a mod is, and nothing more. Anyone can POST, so do not read them as
 * audited figures.
 *
 * Ids are validated against the live mods.json rather than a baked-in list, so
 * adding a mod needs no redeploy here. That check is what keeps the table
 * bounded to real mods: without it, anyone could write unbounded junk rows.
 */

// Where the id allowlist comes from. Same origin as this Worker's route; the
// fetch goes back out through the edge, which serves it from cache.
const MODS_URL = "https://tcoaal.app/mods.json";

// The only site whose pages may count an install.
const ALLOWED_ORIGIN = "https://tcoaal.app";

// How long a fetched id list stays usable, in ms. Only bounds how soon a newly
// published mod can be counted, so minutes are fine and keep the origin quiet.
const IDS_TTL_MS = 10 * 60 * 1000;

// How long the edge may serve a cached GET /api/dl. The Mods menu is not a
// live dashboard: a few minutes stale keeps D1 reads near zero.
const COUNTS_TTL_S = 300;

// Isolate-local memo. Worker isolates are recycled freely, so treat this as a
// best-effort cache and never as the only guard: cf.cacheTtl below does the
// real work across isolates.
let _types = null;
let _typesAt = 0;

/**
 * Map of countable mod id -> its mods.json `type`. Doubles as the id allowlist
 * (a miss is a 404) and as the input to which rate limit applies.
 */
async function modTypes(now) {
  if (_types && now - _typesAt < IDS_TTL_MS) return _types;
  const res = await fetch(MODS_URL, { cf: { cacheTtl: 600 } });
  if (!res.ok) throw new Error("mods.json " + res.status);
  const data = await res.json();
  const map = new Map();
  for (const [id, entry] of Object.entries(data)) {
    map.set(id, (entry && entry.type) || "");
  }
  _types = map;
  _typesAt = now;
  return map;
}

function json(body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8" },
      extraHeaders || {},
    ),
  });
}

/**
 * True when this POST came from a page on some OTHER site.
 *
 * A cross-origin POST with no custom headers is a "simple request", so any
 * third-party page could otherwise make its visitors silently count installs
 * for us. Browsers set Origin on such a POST and it cannot be forged from page
 * script, so a foreign value is a reliable reject.
 *
 * A MISSING Origin is allowed through on purpose: curl never sends one (and
 * could trivially send ours anyway), so demanding it would block honest
 * clients and stop nobody. This narrows drive-by abuse from other people's
 * websites; it is not, and cannot be, a defence against a scripted attacker.
 */
function isForeignOrigin(request) {
  const origin = request.headers.get("Origin");
  return origin !== null && origin !== ALLOWED_ORIGIN;
}

/** POST /api/dl/{modId} */
async function countInstall(modId, env, now, request) {
  let types;
  try {
    types = await modTypes(now);
  } catch (e) {
    // mods.json unreachable: refuse rather than accept an unvalidated id, so a
    // blip upstream can never become junk rows we then have to clean out.
    return new Response("Cannot validate mod id", { status: 503 });
  }
  if (!types.has(modId)) return new Response("Unknown mod id", { status: 404 });

  // Per-IP ceiling, bucketed by how fast the honest version of this event can
  // repeat. Buckets are independent, so exhausting one never blocks another.
  //
  //   overhaul     2/min  ~1200 files, about a minute each: unreachable by hand
  //   translation  8/min  counted at ACTIVATION, not download (see
  //                       trackModInstall): each one costs a page reload, but
  //                       sampling several of the 14 languages is a real
  //                       pattern and must not be throttled into a bias
  //   plugin/other 5/min  1-3 files, ~1s each; a user may add a few in a row
  //
  // Note these limits are per Cloudflare location, not global: they blunt one
  // machine in a loop, not a distributed attacker. The WAF rule on /api/dl* is
  // what protects the account-wide Workers quota, since this check only runs
  // once the Worker is already executing.
  const type = types.get(modId);
  const limiter =
    type === "overhaul"
      ? env.OVERHAUL_LIMITER
      : type === "translation"
        ? env.TRANSLATION_LIMITER
        : env.PLUGIN_LIMITER;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const { success } = await limiter.limit({ key: ip });
  if (!success) return new Response("Too many installs", { status: 429 });

  await env.DB.prepare(
    "INSERT INTO installs (mod_id, count, updated_at) VALUES (?1, 1, ?2)" +
      " ON CONFLICT(mod_id) DO UPDATE SET count = count + 1, updated_at = ?2",
  )
    .bind(modId, new Date(now).toISOString())
    .run();

  return new Response(null, { status: 204 });
}

/** GET (or HEAD) /api/dl */
async function allCounts(url, env, ctx) {
  // Canonical key: a bare GET for this path, query string dropped.
  //
  // Keying on the live request would fold in its method and headers, so a HEAD
  // probe would miss the entry a GET populated (and Cache API rejects a put()
  // keyed on HEAD anyway). Keeping the query string would be worse: this
  // endpoint ignores it, so `?rand=1`, `?rand=2`, ... would each be a fresh
  // key, missing the cache and hitting D1 every time. Dropping it means every
  // spelling of this URL shares one cached response.
  const cache = caches.default;
  const key = new Request(url.origin + url.pathname, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;

  const { results } = await env.DB.prepare(
    "SELECT mod_id, count FROM installs",
  ).all();

  const out = {};
  for (const row of results || []) out[row.mod_id] = row.count;

  const res = json(out, {
    // max-age keeps the browser quiet between menu opens; s-maxage is what the
    // edge honours for the cache.put below.
    "Cache-Control": `public, max-age=60, s-maxage=${COUNTS_TTL_S}`,
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Date.now() is called once per request and passed down: a Worker only
    // advances its clock on I/O, so this is the request's single timestamp.
    const now = Date.now();

    if (url.pathname === "/api/dl") {
      // HEAD as well as GET: a server that answers GET should answer HEAD, and
      // `curl -I` (the obvious way to poke at this) sends HEAD.
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      return allCounts(url, env, ctx);
    }

    const m = url.pathname.match(/^\/api\/dl\/([A-Za-z0-9_-]+)$/);
    if (m) {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (isForeignOrigin(request)) {
        return new Response("Forbidden origin", { status: 403 });
      }
      return countInstall(m[1], env, now, request);
    }

    return new Response("Not found", { status: 404 });
  },
};
