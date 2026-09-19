// Live plan usage, straight from Anthropic, using the Claude Code login that is
// already in the macOS Keychain. No manual sync.
//
// Two sources, best first:
//
//   1. The usage endpoint. This is what Claude Code's own /usage screen reads.
//      It is a plain GET, so it spends no tokens, and it returns every bucket
//      the plan has: the 5-hour session, the week, and the weekly Fable limit,
//      each with its real reset time, plus how the week splits across Claude
//      Code, Chats, and Cowork.
//   2. The rate-limit headers on a 1-token request. Older path, kept as a
//      fallback: it covers the session and the week, but not Fable.
//
// The endpoint is not a documented public API, so it is parsed defensively and
// anything unexpected falls through to the next source, then to the local
// estimate. The token is read here, used only in the Authorization header, and
// NEVER returned to the renderer, logged, or written anywhere. It is never
// refreshed from here either: Claude Code owns the login, and rotating its
// refresh token from a second program could sign it out.

const { execFile } = require("child_process");
const { CLASSIFIER_MODEL } = require("./models"); // the cheapest model, from the catalog

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

let cache = { at: 0, data: null };

function getToken() {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const raw = stdout.trim();
        // The item is usually JSON ({ claudeAiOauth: { accessToken } }); fall
        // back to the raw string if it's a bare token.
        try {
          const d = JSON.parse(raw);
          resolve((d.claudeAiOauth && d.claudeAiOauth.accessToken) || d.accessToken || raw);
        } catch (_) {
          resolve(raw);
        }
      }
    );
  });
}

function authHeaders(token) {
  return {
    authorization: "Bearer " + token,
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}

const meter = (pct, resetAtMs) =>
  pct == null || Number.isNaN(Number(pct)) ? null : { pct: Math.round(Number(pct)), resetAt: resetAtMs || null };
const ms = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

// Pure: turn the endpoint's JSON into the three meters. Exported for tests.
// Prefers the `limits` list (it names each bucket), then the older top-level
// five_hour / seven_day objects. Percentages here are 0-100.
function parseUsage(body) {
  if (!body || typeof body !== "object") return { ok: false, reason: "bad_body" };
  const limits = Array.isArray(body.limits) ? body.limits.filter(Boolean) : [];
  const byKind = (kind) => limits.find((l) => l.kind === kind);
  const fromLimit = (l) => (l ? meter(l.percent, ms(l.resets_at)) : null);
  const fromWindow = (w) => (w ? meter(w.utilization, ms(w.resets_at)) : null);

  const session = fromLimit(byKind("session")) || fromWindow(body.five_hour);
  const weekly = fromLimit(byKind("weekly_all")) || fromWindow(body.seven_day);

  // The model-scoped weekly limit. Today that is Fable; the label comes from
  // the response, so a renamed or different scoped limit still shows correctly.
  const scoped = limits.filter((l) => l.kind === "weekly_scoped");
  const nameOf = (l) => (l.scope && l.scope.model && l.scope.model.display_name) || "";
  const fableLimit = scoped.find((l) => /fable/i.test(nameOf(l))) || scoped[0] || null;
  const fable = fromLimit(fableLimit);
  if (fable) fable.label = nameOf(fableLimit) || "Fable";

  // Where the week went, largest share first.
  const rows = (body.seven_day_breakdown && body.seven_day_breakdown.rows) || [];
  const breakdown = rows
    .filter((r) => r && r.percent > 0)
    .map((r) => ({ name: String(r.display_name || r.key || "Other"), pct: Math.round(r.percent) }))
    .sort((a, b) => b.pct - a.pct);

  if (!session && !weekly) return { ok: false, reason: "no_limits" };
  return { ok: true, source: "usage", session, weekly, fable, breakdown };
}

async function fetchUsageEndpoint(token) {
  let resp;
  try {
    resp = await fetch(USAGE_URL, { headers: authHeaders(token) });
  } catch (_) {
    return { ok: false, reason: "network" };
  }
  if (resp.status !== 200) return { ok: false, reason: "http_" + resp.status };
  try {
    return parseUsage(await resp.json());
  } catch (_) {
    return { ok: false, reason: "bad_body" };
  }
}

// Fallback: one tiny (~1-token) request, read the unified rate-limit headers.
// Utilization here is 0-1. No Fable bucket on this path.
async function fetchHeaders(token) {
  let resp;
  try {
    resp = await fetch(MESSAGES_URL, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
    });
  } catch (_) {
    return { ok: false, reason: "network" };
  }
  const num = (k) => {
    const v = resp.headers.get(k);
    return v == null || v === "" ? null : Number(v);
  };
  const s5u = num("anthropic-ratelimit-unified-5h-utilization");
  const s5r = num("anthropic-ratelimit-unified-5h-reset");
  const w7u = num("anthropic-ratelimit-unified-7d-utilization");
  const w7r = num("anthropic-ratelimit-unified-7d-reset");
  if (s5u == null && w7u == null) {
    return { ok: false, reason: resp.status === 200 ? "no_headers" : "http_" + resp.status };
  }
  return {
    ok: true,
    source: "headers",
    session: s5u == null ? null : meter(s5u * 100, s5r ? s5r * 1000 : null),
    weekly: w7u == null ? null : meter(w7u * 100, w7r ? w7r * 1000 : null),
    fable: null,
    breakdown: [],
  };
}

async function fetchLive() {
  const token = await getToken();
  if (!token) return { ok: false, reason: "no_token" };
  const usage = await fetchUsageEndpoint(token);
  if (usage.ok) return usage;
  // An expired login fails both the same way; do not spend a token finding out.
  if (usage.reason === "http_401" || usage.reason === "network") return usage;
  const headers = await fetchHeaders(token);
  return headers.ok ? headers : usage;
}

// Refetch at most every maxAgeMs. The usage endpoint is free, so this can be
// short; the cache mostly keeps several UI refreshes from stacking up requests.
async function getLiveUsage(maxAgeMs = 45000, now = Date.now()) {
  if (cache.data && cache.data.ok && now - cache.at < maxAgeMs) return cache.data;
  const data = await fetchLive();
  if (data.ok) cache = { at: now, data };
  return data;
}

module.exports = { getLiveUsage, parseUsage };
