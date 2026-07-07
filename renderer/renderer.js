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
let chosenKey = null; // user override (falls back to decision.modelKey)
let usage = null; // last usage snapshot
let projects = []; // loaded projects

// ---------- Usage meters ----------

function fmtReset(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderMeter(el, label, m) {
  const sync = m.synced ? "Synced · " : "";
  el.innerHTML = `
    <div class="meter-top">
      <span class="meter-label">${label}</span>
      <span class="meter-pct ${m.over ? "over" : ""}">${m.pct}%${m.over ? " · over" : ""}</span>
    </div>
    <div class="meter-track"><div class="meter-fill ${m.color}" style="width:${Math.min(100, m.pct)}%"></div></div>
    <div class="meter-bottom">${sync}Resets ${fmtReset(m.resetAt)}</div>`;
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

async function loadUsage() {
  usage = await window.cc.usage();
  renderMeter($("meter-session"), "Session (5h)", usage.session);
  renderMeter($("meter-weekly"), "Weekly · all models", usage.weeklyAll);
  renderMeter($("meter-fable"), "Weekly · Fable", usage.weeklyFable);
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
  $("routeInfo").innerHTML = `<span class="route-empty">Routing…</span>`;
  decision = await window.cc.route(text);
  chosenKey = decision.modelKey;
  renderRoute();
}

function renderRoute() {
  const info = $("routeInfo");
  const reasoning = $("reasoning");
  const alts = $("alts");

  if (!decision) {
    info.innerHTML = `<span class="route-empty">model: auto</span>`;
    reasoning.hidden = true;
    alts.hidden = true;
    updateLaunchState();
    return;
  }

  const key = chosenKey || decision.modelKey;
  const m = MODELS[key];
  const conf = Math.round(decision.confidence * 100);
  const ask = decision.needsConfirm && key === decision.modelKey;

  info.innerHTML = `
    <div class="badge ${ask ? "ask" : ""}" id="badge" title="Click to see why / change">
      <span class="badge-dot" style="background:${m.color}"></span>
      <span class="badge-name">${m.label}</span>
      <span class="badge-cost">${m.cost}</span>
      <span class="badge-conf">${conf}% · ${decision.source}</span>
    </div>
    ${ask ? `<span class="ask-note">not sure — pick one</span>` : ""}`;

  $("badge").addEventListener("click", () => {
    const showing = !reasoning.hidden;
    reasoning.hidden = showing;
    alts.hidden = showing;
  });

  reasoning.textContent = decision.reason;

  // Full override control: all four models, routed one active.
  alts.innerHTML =
    `<span class="alts-label">Use:</span>` +
    ORDER.map(
      (k) =>
        `<button class="alt-chip ${k === key ? "active" : ""}" data-key="${k}">${MODELS[k].label} ${MODELS[k].cost}</button>`
    ).join("");
  alts.querySelectorAll(".alt-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      chosenKey = chip.dataset.key;
      renderRoute();
      reasoning.hidden = false;
      alts.hidden = false;
    })
  );

  // If the ask badge was open, keep panels visible.
  if (ask) {
    reasoning.hidden = false;
    alts.hidden = false;
  }

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
  createSession({ cwd, model, prompt, title: prompt ? prompt.slice(0, 40) : "New session" });
}

function showOverLimitModal(key) {
  const m = key === "fable" ? usage.weeklyFable : usage.weeklyAll;
  $("modalTitle").textContent = `${MODELS[key].label} is over your weekly limit`;
  $("modalBody").innerHTML = `You're at <b>${m.pct}%</b> of this bucket ($${m.spent} of $${m.ceiling}). It resets <b>${fmtReset(m.resetAt)}</b>. Launch anyway, or pick a lighter model.`;
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
  const runin = $("runin");
  runin.innerHTML =
    `<option value="">Home (~)</option>` +
    projects
      .map((p) => `<option value="${escapeAttr(p.cwd)}">${escapeHtml(p.name)}</option>`)
      .join("");

  const list = $("projects");
  if (!projects.length) {
    list.innerHTML = `<div class="loading">No Claude Code projects found yet.</div>`;
    return;
  }
  list.innerHTML = projects.map(renderProject).join("");
  list.querySelectorAll(".project-head").forEach((head) =>
    head.addEventListener("click", () => head.parentElement.classList.toggle("open"))
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
}

const FOLDER_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/></svg>`;

function renderProject(p, i) {
  const chats = p.chats
    .map(
      (c) => `
      <div class="chat" data-cwd="${escapeAttr(p.cwd)}" data-id="${c.id}" title="Reopen on the chosen model">
        <span class="chat-time">${fmtChatTime(c.updated)}</span>
        <span class="chat-title">${escapeHtml(c.title)}</span>
      </div>`
    )
    .join("");
  return `
    <div class="project ${i === 0 ? "open" : ""}">
      <div class="project-head">
        <span class="folder">${FOLDER_SVG}</span>
        <span class="project-name">${escapeHtml(p.name)}</span>
      </div>
      <div class="chats">
        ${chats}
        <div class="project-footer">
          <span class="project-path" title="${escapeAttr(p.cwd)}">${escapeHtml(p.cwd)}</span>
          <button class="finder-btn" data-cwd="${escapeAttr(p.cwd)}" title="Reveal in Finder">Open in Finder</button>
        </div>
      </div>
    </div>`;
}

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

function wirePtyOnce() {
  if (ptyWired) return;
  window.cc.onPtyData(({ id, data }) => {
    const s = sessions.get(id);
    if (s) s.term.write(data);
  });
  window.cc.onPtyExit(({ id }) => {
    const s = sessions.get(id);
    if (!s) return;
    s.ended = true;
    s.term.write("\r\n\x1b[90m— session ended —\x1b[0m\r\n");
    renderTabs();
  });
  ptyWired = true;
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
  html += `<span class="term-hint">click terminal to type · Return to send</span>`;
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

loadUsage();
loadProjects();
