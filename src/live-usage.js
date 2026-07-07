// Reads the real Max-plan usage from Anthropic's unified rate-limit response
// headers, using the Claude Code OAuth token already in the macOS Keychain.
//
// One tiny (~1-token) request per refresh. The token is read here, used only in
// the Authorization header, and NEVER returned to the renderer or logged. Any
// problem (no token, network, changed headers) returns {ok:false} so the caller
// falls back to the manual/proxy meter.

const { execFile } = require("child_process");

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const API_URL = "https://api.anthropic.com/v1/messages";

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

async function fetchLive() {
  const token = await getToken();
  if (!token) return { ok: false, reason: "no_token" };
  let resp;
  try {
    resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
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
    session: s5u == null ? null : { pct: Math.round(s5u * 100), resetAt: s5r ? s5r * 1000 : null },
    weekly: w7u == null ? null : { pct: Math.round(w7u * 100), resetAt: w7r ? w7r * 1000 : null },
  };
}

// Refetch at most every maxAgeMs so we don't spam tiny calls (each still counts
// minutely toward the very limits it measures).
async function getLiveUsage(maxAgeMs = 90000, now = Date.now()) {
  if (cache.data && cache.data.ok && now - cache.at < maxAgeMs) return cache.data;
  const data = await fetchLive();
  if (data.ok) cache = { at: now, data };
  return data;
}

module.exports = { getLiveUsage };
