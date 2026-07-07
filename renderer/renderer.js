// Renderer: wires the UI to the engines exposed on window.cc.

// Local mirror of the catalog for cost cues + override chips (label, cost, color).
const MODELS = {
  haiku: { id: "claude-haiku-4-5", label: "Haiku 4.5", cost: "$", color: "#4f9d69" },
  sonnet: { id: "claude-sonnet-4-6", label: "Sonnet 4.6", cost: "$$", color: "#6b8fbf" },
  opus: { id: "claude-opus-4-8", label: "Opus 4.8", cost: "$$$", color: "#d9a441" },
  fable: { id: "claude-fable-5", label: "Fable 5", cost: "$$$$", color: "#cc5b52" },
};
const ORDER = ["haiku", "sonnet", "opus", "fable"];

const $ = (id) => document.getElementById(id);

let decision = null; // last routing decision
let chosenKey = null; // current chosen model (falls back to decision.modelKey)
let chosenSource = "router"; // "router" | "pref" | "manual"
let usage = null; // last usage snapshot
let projects = []; // loaded projects
let pinnedSet = new Set(); // pinned project cwds
let projectPrefs = {}; // cwd -> preferred modelKey (learned from overrides)
let khDismissed = false; // user dismissed the keychain-help panel this session

// The preferred model for the current Run-in project, if any.
function prefForRunin() {
  const cwd = $("runin").value;
  return cwd ? projectPrefs[cwd] || null : null;
}

// Display name of the current Run-in selection.
function runinName() {
  const sel = $("runin");
  const opt = sel.options[sel.selectedIndex];
  return opt ? opt.textContent : "this project";
}

// Set the chosen model from a project pref (if any) or the router's pick.
function applyDefault() {
  const pref = prefForRunin();
  if (pref && MODELS[pref]) {
    chosenKey = pref;
    chosenSource = "pref";
  } else {
    chosenKey = decision.modelKey;
    chosenSource = "router";
  }
}

// ---------- Usage meters ----------

function fmtReset(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Session resets on a short rolling window, so Claude shows it as a countdown
// ("in 49m"). Weekly is a fixed wall-clock time ("Sat 11:59 AM").
function fmtCountdown(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const t = Math.round(ms / 60000);
  const h = Math.floor(t / 60);
  const m = t % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderMeter(el, label, m, countdown) {
  const tag = m.live ? "Auto · " : m.synced ? "Synced · " : "";
  let reset;
  if (!m.resetAt) reset = "Resets —";
  else if (countdown) reset = "Resets in " + fmtCountdown(m.resetAt);
  else reset = "Resets " + fmtReset(m.resetAt);
  el.innerHTML = `
    <div class="meter-top">
      <span class="meter-label">${label}</span>
      <span class="meter-pct ${m.over ? "over" : ""}">${m.pct}%${m.over ? " · over" : ""}</span>
    </div>
    <div class="meter-track"><div class="meter-fill ${m.color}" style="width:${Math.min(100, m.pct)}%"></div></div>
    <div class="meter-bottom">${tag}${reset}</div>`;
}

// --- Manual sync ---
$("syncBtn").addEventListener("click", () => {
  const f = $("syncForm");
  const show = f.hidden;
  if (show && usage) {
    $("sync-session").value = usage.session.pct;
    $("sync-weeklyAll").value = usage.weeklyAll.pct;
    $("sync-weeklyFable").value = usage.weeklyFable.pct;
    // Prefill the session reset countdown only if it was user-set.
    if (usage.session.resetUserSet && usage.session.resetAt) {
      const rem = new Date(usage.session.resetAt).getTime() - Date.now();
      $("sync-reset-h").value = rem > 0 ? Math.floor(rem / 3600000) : "";
      $("sync-reset-m").value = rem > 0 ? Math.floor((rem % 3600000) / 60000) : "";
    } else {
      $("sync-reset-h").value = "";
      $("sync-reset-m").value = "";
    }
  }
  f.hidden = !show;
});
$("syncCancel").addEventListener("click", () => ($("syncForm").hidden = true));
$("syncSave").addEventListener("click", async () => {
  const h = Number($("sync-reset-h").value || 0);
  const m = Number($("sync-reset-m").value || 0);
  await window.cc.saveSync({
    session: $("sync-session").value,
    weeklyAll: $("sync-weeklyAll").value,
    weeklyFable: $("sync-weeklyFable").value,
    sessionResetMin: h * 60 + m,
  });
  $("syncForm").hidden = true;
  await loadUsage();
});

// Keychain help: enable (re-triggers the macOS prompt) / dismiss.
$("khEnable").addEventListener("click", async () => {
  $("khEnable").textContent = "Requesting…";
  await window.cc.enableLive();
  $("khEnable").textContent = "Turn on auto usage";
  khDismissed = false;
  await loadUsage();
});
$("khDismiss").addEventListener("click", () => {
  khDismissed = true;
  $("keychainHelp").hidden = true;
});

async function loadUsage() {
  usage = await window.cc.usage();
  renderMeter($("meter-session"), "Session (5h)", usage.session, true); // countdown
  renderMeter($("meter-weekly"), "Weekly · all models", usage.weeklyAll, false); // clock
  renderMeter($("meter-fable"), "Weekly · Fable", usage.weeklyFable, false); // clock
  const status = $("usageStatus");
  if (status) {
    if (usage.live) {
      status.textContent = "· live";
      status.className = "usage-status on";
    } else {
      status.textContent = usage.liveError ? "· manual (auto off)" : "";
      status.className = "usage-status off";
    }
  }
  // Offer step-by-step keychain help when that's what's blocking auto usage.
  const kh = $("keychainHelp");
  if (kh) {
    const needsKeychain = !usage.live && usage.liveError === "no_token";
    kh.hidden = !(needsKeychain && !khDismissed);
  }
  updateLaunchState();
}

function overForKey(key) {
  if (!usage) return false;
  return key === "fable" ? usage.weeklyFable.over : usage.weeklyAll.over;
}

// ---------- Routing ----------

let routeTimer = null;
$("prompt").addEventListener("input", () => {
  clearTimeout(routeTimer);
  const text = $("prompt").value.trim();
  if (!text) {
    decision = null;
    chosenKey = null;
    renderRoute();
    return;
  }
  routeTimer = setTimeout(runRoute, 550);
});

async function runRoute() {
  const text = $("prompt").value.trim();
  if (!text) return;
  decision = await window.cc.route(text);
  applyDefault();
  renderRoute();
}

// Re-apply the project default when the Run-in target changes.
$("runin").addEventListener("change", () => {
  if (!decision) return;
  applyDefault();
  renderRoute();
});

function renderRoute() {
  const block = $("thinkBlock");
  const alts = $("alts");

  if (!decision) {
    block.hidden = true;
    updateLaunchState();
    return;
  }
  block.hidden = false;

  const key = chosenKey || decision.modelKey;
  const m = MODELS[key];
  const conf = Math.round(decision.confidence * 100);
  const ask = decision.needsConfirm && chosenSource === "router";

  // Green when the router chose the model; yellow when the decision is yours
  // (a manual override, a project default) or is being handed to you (ambiguous).
  let color, title, clear = "";
  if (chosenSource === "router" && !ask) {
    color = "green";
    title = `${m.label} chosen`;
  } else {
    color = "yellow";
    if (ask) {
      title = "Not sure — pick a model";
    } else if (chosenSource === "pref") {
      title = `Your default for ${escapeHtml(runinName())}: ${m.label}`;
      clear = ` <button class="pref-clear" id="prefClear" title="Clear this project's default">✕</button>`;
    } else {
      title = `Your pick: ${m.label}`;
    }
  }

  block.className = "think-block " + color;
  $("thinkTitle").innerHTML = `<span class="tb-name">${title}</span> <span class="tb-cost">${m.cost}</span>${clear}`;
  $("thinkMeta").textContent = `${conf}% · ${decision.source}`;
  $("thinkBody").textContent = decision.reason;

  const prefClear = $("prefClear");
  if (prefClear) {
    prefClear.addEventListener("click", (e) => {
      e.stopPropagation();
      const cwd = $("runin").value;
      if (cwd) {
        window.cc.prefsSet(cwd, null);
        delete projectPrefs[cwd];
      }
      chosenKey = decision.modelKey;
      chosenSource = "router";
      renderRoute();
    });
  }

  // Override chips: all four models, the chosen one active.
  alts.innerHTML =
    `<span class="alts-label">Use:</span>` +
    ORDER.map(
      (k) =>
        `<button class="alt-chip ${k === key ? "active" : ""}" data-key="${k}">${MODELS[k].label} ${MODELS[k].cost}</button>`
    ).join("");
  alts.querySelectorAll(".alt-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      chosenKey = chip.dataset.key;
      chosenSource = "manual";
      renderRoute();
    })
  );

  updateLaunchState();
}

// ---------- Launch ----------

function updateLaunchState() {
  $("launch").disabled = !decision;
}

$("launch").addEventListener("click", () => {
  if (!decision) return;
  const key = chosenKey || decision.modelKey;
  if (overForKey(key)) {
    showOverLimitModal(key);
  } else {
    doLaunch(key);
  }
});

function doLaunch(key) {
  const model = MODELS[key].id;
  const prompt = $("prompt").value.trim();
  const cwd = $("runin").value || undefined;
  // Learn: launching a project with a model that overrides the router's pick
  // makes that model the project's default going forward.
  if (cwd && decision && key !== decision.modelKey) {
    window.cc.prefsSet(cwd, key);
    projectPrefs[cwd] = key;
  }
  createSession({ cwd, model, prompt, title: prompt ? prompt.slice(0, 40) : "New session" });
}

function showOverLimitModal(key) {
  const m = key === "fable" ? usage.weeklyFable : usage.weeklyAll;
  const at = m.spent == null ? `You're at <b>${m.pct}%</b> of this bucket.` : `You're at <b>${m.pct}%</b> of this bucket ($${m.spent} of $${m.ceiling}).`;
  $("modalTitle").textContent = `${MODELS[key].label} is over your weekly limit`;
  $("modalBody").innerHTML = `${at} It resets <b>${fmtReset(m.resetAt)}</b>. Launch anyway, or pick a lighter model.`;
  $("modal").hidden = false;
  $("modalGo").onclick = () => {
    $("modal").hidden = true;
    doLaunch(key);
  };
  $("modalCancel").onclick = () => ($("modal").hidden = true);
}

// ---------- Projects / recall ----------

async function loadProjects() {
  projects = await window.cc.projects();
  pinnedSet = new Set(await window.cc.pinsGet());
  const runin = $("runin");
  runin.innerHTML =
    `<option value="">Home (~)</option>` +
    projects
      .map((p) => `<option value="${escapeAttr(p.cwd)}">${escapeHtml(p.name)}</option>`)
      .join("");
  renderProjects($("chatSearch").value);
}

const FOLDER_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/></svg>`;

function modelShort(id) {
  if (!id) return "";
  if (id.includes("fable")) return "Fable";
  if (id.includes("opus")) return "Opus";
  if (id.includes("sonnet")) return "Sonnet";
  if (id.includes("haiku")) return "Haiku";
  return id;
}

// Render the projects list, filtered by the search query, pinned ones on top.
function renderProjects(query) {
  const q = (query || "").trim().toLowerCase();
  const list = $("projects");
  if (!projects.length) {
    list.innerHTML = `<div class="loading">No Claude Code projects found yet.</div>`;
    return;
  }
  // Pinned first; the engine already sorts by recency within each group.
  const sorted = projects
    .slice()
    .sort((a, b) => (pinnedSet.has(b.cwd) ? 1 : 0) - (pinnedSet.has(a.cwd) ? 1 : 0));

  const items = [];
  sorted.forEach((p, i) => {
    const nameMatch = !q || p.name.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q);
    const chats = p.chats.filter(
      (c) => !q || nameMatch || (c.title || "").toLowerCase().includes(q)
    );
    if (q && !nameMatch && chats.length === 0) return; // hide non-matches while searching
    const open = q ? true : pinnedSet.has(p.cwd) || i === 0;
    items.push(renderProject(p, chats, open, pinnedSet.has(p.cwd)));
  });

  list.innerHTML = items.length
    ? items.join("")
    : `<div class="loading">No matches.</div>`;
  wireProjects();
}

function renderProject(p, chats, open, pinned) {
  const chatHtml = chats
    .map(
      (c) => `
      <div class="chat" data-cwd="${escapeAttr(p.cwd)}" data-id="${c.id}" title="Reopen on the chosen model">
        <span class="chat-time">${fmtChatTime(c.updated)}</span>
        <span class="chat-title">${escapeHtml(c.title)}</span>
        ${c.model ? `<span class="chat-model">${modelShort(c.model)}</span>` : ""}
      </div>`
    )
    .join("");
  return `
    <div class="project ${open ? "open" : ""}">
      <div class="project-head">
        <span class="folder">${FOLDER_SVG}</span>
        <span class="project-name">${escapeHtml(p.name)}</span>
        <button class="pin-btn ${pinned ? "pinned" : ""}" data-pin="${escapeAttr(p.cwd)}" title="${pinned ? "Unpin" : "Pin to top"}">${pinned ? "★" : "☆"}</button>
      </div>
      <div class="chats">
        ${chatHtml}
        <div class="project-footer">
          <span class="project-path" title="${escapeAttr(p.cwd)}">${escapeHtml(p.cwd)}</span>
          <button class="finder-btn" data-cwd="${escapeAttr(p.cwd)}" title="Reveal in Finder">Open in Finder</button>
        </div>
      </div>
    </div>`;
}

function wireProjects() {
  const list = $("projects");
  list.querySelectorAll(".project-head").forEach((head) =>
    head.addEventListener("click", (e) => {
      if (e.target.closest(".pin-btn")) return;
      head.parentElement.classList.toggle("open");
    })
  );
  list.querySelectorAll(".chat").forEach((chat) =>
    chat.addEventListener("click", () => {
      const title = chat.querySelector(".chat-title");
      reopenChat(chat.dataset.cwd, chat.dataset.id, title ? title.textContent : "");
    })
  );
  list.querySelectorAll(".finder-btn").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.cc.openFinder(btn.dataset.cwd);
    })
  );
  list.querySelectorAll(".pin-btn").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const arr = await window.cc.pinsToggle(btn.dataset.pin);
      pinnedSet = new Set(arr);
      renderProjects($("chatSearch").value);
    })
  );
}

$("chatSearch").addEventListener("input", () => renderProjects($("chatSearch").value));

function reopenChat(cwd, sessionId, title) {
  const key = decision ? chosenKey || decision.modelKey : "sonnet";
  createSession({ cwd, model: MODELS[key].id, sessionId, title: title || "Resumed session" });
}

function fmtChatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

// ---------- Embedded Claude Code sessions (tabbed) ----------

const sessions = new Map(); // id -> { id, title, term, fit, mount, ended }
let activeId = null; // active session id, or null when the composer is shown
let ptyWired = false;

const TERM_THEME = { background: "#1e2127", foreground: "#e7e9ec", cursor: "#ccff00" };

// A background session that streamed output then went quiet for this long has
// almost certainly finished its turn / is waiting for you. Claude Code emits a
// live spinner while working, so silence is a reliable "done" signal.
const QUIET_MS = 10000;

function wirePtyOnce() {
  if (ptyWired) return;
  window.cc.onPtyData(({ id, data }) => {
    const s = sessions.get(id);
    if (!s) return;
    s.term.write(data);
    s.notifiedQuiet = false;
    if (s.quietTimer) clearTimeout(s.quietTimer);
    s.quietTimer = setTimeout(() => maybeNotifyQuiet(id), QUIET_MS);
  });
  window.cc.onPtyExit(({ id }) => {
    const s = sessions.get(id);
    if (!s) return;
    s.ended = true;
    if (s.quietTimer) clearTimeout(s.quietTimer);
    s.term.write("\r\n\x1b[90m— session ended —\x1b[0m\r\n");
    if (id !== activeId) notify("Session ended", s.title, id);
    renderTabs();
  });
  ptyWired = true;
}

function maybeNotifyQuiet(id) {
  const s = sessions.get(id);
  if (!s || s.ended || id === activeId || s.notifiedQuiet) return;
  s.notifiedQuiet = true;
  notify("Session ready", (s.title || "Claude Code") + " may be waiting for you", id);
}

function notify(title, body, id) {
  try {
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.cc.focusWindow();
      if (sessions.has(id)) activate(id);
    };
  } catch (_) {}
}

function makeTerm(mount) {
  const term = new Terminal({
    fontFamily: 'Menlo, Monaco, "SF Mono", monospace',
    fontSize: 12.5,
    cursorBlink: true,
    theme: TERM_THEME,
  });
  const FitCtor = window.FitAddon && window.FitAddon.FitAddon;
  const fit = FitCtor ? new FitCtor() : null;
  if (fit) term.loadAddon(fit);
  term.open(mount);
  return { term, fit };
}

function fitSession(s) {
  if (!s || !s.fit) return;
  try {
    s.fit.fit();
    window.cc.ptyResize(s.id, s.term.cols, s.term.rows);
  } catch (_) {}
}

async function createSession({ cwd, model, sessionId, prompt, title }) {
  wirePtyOnce();
  const mount = document.createElement("div");
  mount.className = "term-mount";
  $("termBody").appendChild(mount);
  const { term, fit } = makeTerm(mount);

  const r = await window.cc.ptyStart({ cwd, model, sessionId, prompt, cols: 80, rows: 24 });
  if (!r || r.ok === false) {
    term.write("\r\n\x1b[31mCould not start Claude Code: " + ((r && r.error) || "") + "\x1b[0m\r\n");
  }
  const id = r && r.id ? r.id : "dead" + sessions.size;
  const s = { id, title: title || "Claude Code", term, fit, mount, ended: !(r && r.ok) };
  sessions.set(id, s);
  if (r && r.ok) term.onData((d) => window.cc.ptyInput(id, d));
  activate(id);
}

function activate(id) {
  activeId = id;
  $("composeView").hidden = true;
  $("termView").hidden = false;
  for (const s of sessions.values()) {
    s.mount.style.display = s.id === id ? "block" : "none";
  }
  renderTabs();
  const s = sessions.get(id);
  if (s) {
    // You're looking at it now — cancel any pending "ready" notification.
    s.notifiedQuiet = false;
    if (s.quietTimer) {
      clearTimeout(s.quietTimer);
      s.quietTimer = null;
    }
    requestAnimationFrame(() => {
      fitSession(s);
      s.term.focus();
      setTimeout(() => {
        fitSession(s);
        s.term.focus();
      }, 80);
    });
  }
}

function showCompose() {
  activeId = null;
  $("termView").hidden = true;
  $("composeView").hidden = false;
  renderTabs();
}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.quietTimer) clearTimeout(s.quietTimer);
  window.cc.ptyKill(id);
  try {
    s.term.dispose();
  } catch (_) {}
  s.mount.remove();
  sessions.delete(id);
  if (activeId === id) {
    const next = sessions.keys().next();
    if (!next.done) activate(next.value);
    else showCompose();
  } else {
    renderTabs();
  }
}

function renderTabs() {
  const strip = $("termTabs");
  if (sessions.size === 0) {
    strip.hidden = true;
    strip.innerHTML = "";
    return;
  }
  strip.hidden = false;
  let html = "";
  for (const s of sessions.values()) {
    html += `<div class="term-tab ${s.id === activeId ? "active" : ""}" data-id="${s.id}" title="${escapeAttr(s.title)}">
      <span class="tab-title">${escapeHtml(s.title)}${s.ended ? " · ended" : ""}</span>
      <button class="tab-close" data-close="${s.id}" title="Close session">✕</button>
    </div>`;
  }
  html += `<button class="term-tab new-tab ${activeId === null ? "active" : ""}" id="newTab">＋ New</button>`;
  html += `<span class="term-hint">Return to send · ⌘1–9 tabs · ⌘T new</span>`;
  strip.innerHTML = html;

  strip.querySelectorAll(".term-tab[data-id]").forEach((t) =>
    t.addEventListener("click", () => activate(t.dataset.id))
  );
  strip.querySelectorAll(".tab-close").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSession(b.dataset.close);
    })
  );
  const newTab = $("newTab");
  if (newTab) newTab.addEventListener("click", showCompose);
}

// Refit the active session on window resize.
window.addEventListener("resize", () => {
  const s = sessions.get(activeId);
  if (s) fitSession(s);
});

// Clicking the terminal focuses the active session so input and Return land.
$("termView").addEventListener("click", () => {
  const s = sessions.get(activeId);
  if (s) s.term.focus();
});

// Keyboard shortcuts (capture phase so they beat the terminal's key handling).
window.addEventListener(
  "keydown",
  (e) => {
    if (!e.metaKey || e.altKey || e.ctrlKey) return;
    const k = e.key;
    if (k === "Enter") {
      // ⌘Enter launches from the composer.
      if (activeId === null && decision) {
        e.preventDefault();
        const key = chosenKey || decision.modelKey;
        if (overForKey(key)) showOverLimitModal(key);
        else doLaunch(key);
      }
    } else if (k === "t" || k === "T") {
      // ⌘T: new session (go to composer).
      e.preventDefault();
      showCompose();
      $("prompt").focus();
    } else if (/^[1-9]$/.test(k)) {
      // ⌘1–9: switch to the Nth session tab.
      const ids = Array.from(sessions.keys());
      const idx = Number(k) - 1;
      if (idx < ids.length) {
        e.preventDefault();
        activate(ids[idx]);
      }
    }
  },
  true
);

// ---------- quick-start chips ----------

document.querySelectorAll("#chips .chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    const el = $("prompt");
    el.value = chip.dataset.p || "";
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    runRoute();
  })
);

// ---------- init ----------

(async () => {
  projectPrefs = await window.cc.prefsGet();
})();
loadUsage();
loadProjects();

// Keep the live meters current (session/weekly refresh from real headers).
setInterval(loadUsage, 120000);
