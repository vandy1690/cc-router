// Renderer: wires the UI to the engines exposed on window.cc.

// The model catalog lives in src/models.js and arrives over IPC at startup, so
// a model update is a one-file change. Nothing here names a model ID.
let MODELS = {};
let ORDER = [];
let EFFORTS = [];

const $ = (id) => document.getElementById(id);

let decision = null; // last routing decision
let chosenKey = null; // current chosen model (falls back to decision.modelKey)
let chosenSource = "router"; // "router" | "pref" | "manual"
let chosenEffort = null; // set only when you pick an effort by hand
let usage = null; // last usage snapshot
let projects = []; // loaded projects
let pinnedSet = new Set(); // pinned project cwds
let projectPrefs = {}; // cwd -> preferred modelKey (learned from overrides)
let khDismissed = false; // user dismissed the keychain-help panel this session
let cli = null; // { ok, found, version, min, effort } from the Claude Code CLI preflight
let cliDismissed = false;

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
// A model you picked by hand stays picked while you keep typing: the router
// re-deciding under you, and then launching its choice instead of yours, would
// be the worst kind of surprise. Clearing the prompt clears the pick.
function applyDefault() {
  if (chosenSource === "manual" && chosenKey && MODELS[chosenKey]) return;
  const pref = prefForRunin();
  if (pref && MODELS[pref]) {
    chosenKey = pref;
    chosenSource = "pref";
  } else {
    chosenKey = decision.modelKey;
    chosenSource = "router";
  }
}

// Catalog key for any model ID a transcript recorded, by family, so a chat that
// ran on an older Opus resumes on the current Opus.
function keyForModelId(id) {
  const s = String(id || "").toLowerCase();
  if (s.includes("fable") || s.includes("mythos")) return "fable";
  return ORDER.find((k) => s.includes(k)) || null;
}

// ---------- Theme ----------

const TERM_THEMES = {
  // The terminal card wears the dark palette in both themes: --surface ground,
  // paper-white text, and the dark theme's lime accent as the cursor.
  light: { background: "#111111", foreground: "#F0EEE9", cursor: "#CCFF00", cursorAccent: "#111111", selectionBackground: "rgba(204, 255, 0, 0.28)" },
  dark: { background: "#111111", foreground: "#F0EEE9", cursor: "#CCFF00", cursorAccent: "#111111", selectionBackground: "rgba(204, 255, 0, 0.28)" },
};

function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function syncThemeToggle() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  $("themeToggle").setAttribute("aria-label", `Switch to ${next} theme`);
}

$("themeToggle").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  window.cc.setTheme(next);
  syncThemeToggle();
  for (const s of sessions.values()) s.term.options.theme = TERM_THEMES[next];
});

// ---------- Claude Code CLI preflight ----------

// True when the installed CLI is older than this model needs.
function cliTooOldFor(key) {
  const need = MODELS[key] && MODELS[key].minCli;
  if (!cli || !cli.found || !need) return false;
  return cmpVersion(cli.version, need) < 0;
}

function cmpVersion(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// The version recommendation lives in a drawer that slides out from under the
// input box. Closed, it is inert, so its buttons are out of the tab order.
function setDrawer(open) {
  const d = $("cliNotice");
  d.classList.toggle("open", open);
  d.setAttribute("aria-hidden", String(!open));
  d.inert = !open;
}

async function loadCli() {
  cli = await window.cc.checkCli();
  const blocked = ORDER.filter(cliTooOldFor).map((k) => MODELS[k].label);
  if (cli.found && blocked.length === 0) {
    setDrawer(false);
    return;
  }
  if (!cli.found) {
    $("cliNoticeTitle").textContent = "Claude Code was not found";
    $("cliNoticeBody").innerHTML =
      "Sessions run the <code>claude</code> command from your login shell, and it did not answer. Install Claude Code, then check again.";
  } else {
    $("cliNoticeTitle").textContent = `Update Claude Code to use ${joinWords(blocked)}`;
    $("cliNoticeBody").innerHTML =
      `This Mac has Claude Code <b>${escapeHtml(cli.version)}</b>, which was released before ${joinWords(blocked)}. ` +
      `It needs <b>${escapeHtml(cli.min)}</b> or newer. In Terminal, run <code>claude update</code>, then check again. ` +
      `The other models work as they are.`;
  }
  setDrawer(!cliDismissed);
}

function joinWords(a) {
  if (a.length <= 1) return a.join("");
  return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
}

$("cliRecheck").addEventListener("click", async () => {
  $("cliRecheck").textContent = "Checking…";
  cliDismissed = false;
  await loadCli();
  $("cliRecheck").textContent = "Check again";
});
$("cliDismiss").addEventListener("click", () => {
  cliDismissed = true;
  setDrawer(false);
  $("prompt").focus();
});

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

// m.color is a severity ("ok" | "warn" | "over"); the stylesheet owns the look.
// The percentage and the word "over" carry the state, so colour is never alone.
function renderMeter(el, label, m, countdown, extra) {
  const tag = m.live ? "Auto · " : m.synced ? "Synced · " : "";
  let reset;
  if (!m.resetAt) reset = "Resets —";
  else if (countdown) reset = "Resets in " + fmtCountdown(m.resetAt);
  else reset = "Resets " + fmtReset(m.resetAt);
  const shown = Math.min(100, m.pct);
  el.innerHTML = `
    <div class="meter-top">
      <span class="meter-label">${label}</span>
      <span class="meter-pct ${m.over ? "over" : ""}">${m.pct}%${m.over ? " · over" : ""}</span>
    </div>
    <div class="meter-track ${m.color}" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${shown}" aria-valuetext="${m.pct}%${m.over ? ", over the limit" : ""}">
      <div class="meter-fill" style="width:${shown}%"></div>
    </div>
    <div class="meter-bottom">${tag}${reset}</div>${extra ? `<div class="meter-extra">${extra}</div>` : ""}`;
}

// Where the week went, from the live breakdown: "Cowork 81% · Claude Code 17%".
function breakdownText(rows) {
  if (!rows || !rows.length) return "";
  return "This week: " + rows.map((r) => `${escapeHtml(r.name)} ${r.pct}%`).join(" · ");
}

// Why live usage is off, in words.
const LIVE_OFF = {
  no_token: "· manual (auto off)",
  http_401: "· login expired",
  network: "· offline",
};

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
  renderMeter($("meter-weekly"), "Weekly · all models", usage.weeklyAll, false, breakdownText(usage.breakdown)); // clock
  renderMeter($("meter-fable"), `Weekly · ${escapeHtml(usage.fableLabel || "Fable")}`, usage.weeklyFable, false); // clock
  const status = $("usageStatus");
  if (status) {
    if (usage.live) {
      status.textContent = "· live";
      status.className = "usage-status on";
      status.title = "Read from Anthropic. Refreshes every minute and when you return to the window.";
    } else {
      status.textContent = usage.liveError ? LIVE_OFF[usage.liveError] || "· manual" : "";
      status.className = "usage-status off";
      status.title = usage.liveError === "http_401" ? "Open any Claude Code session and the login refreshes itself." : "";
    }
  }
  // Manual sync is only a fallback. When every meter is live it has no job.
  $("syncBtn").hidden = !!usage.allLive;
  if (usage.allLive) $("syncForm").hidden = true;
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
let starterStub = null; // the untouched text of the last starter chip, if any
let routeSeq = 0; // guards against an older, slower answer landing on newer text
const RULES_DELAY = 400; // after the last keystroke, run the free local rules
const CLASSIFIER_DELAY = 700; // then this much more quiet before spawning the classifier
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

$("prompt").addEventListener("input", () => {
  clearTimeout(routeTimer);
  routeSeq++; // anything still in flight is now stale
  const text = $("prompt").value.trim();
  if (!text) {
    decision = null;
    chosenKey = null;
    chosenSource = "router";
    chosenEffort = null;
    renderRoute();
    return;
  }
  routeTimer = setTimeout(runRoute, RULES_DELAY);
});

// What the block shows while the classifier works. Sonnet is the everyday
// default, so it is the safe thing to launch on if you do not want to wait.
function pendingDecision() {
  return {
    pending: true,
    modelKey: "sonnet",
    confidence: 0,
    source: "classifier",
    needsConfirm: false,
    reason: `Asking Haiku to size this up, which takes a few seconds. You can launch now on ${MODELS.sonnet.label}, pick a model yourself, or wait for the answer.`,
  };
}

function settle(d) {
  decision = d;
  applyDefault();
  renderRoute();
}

async function runRoute() {
  const text = $("prompt").value.trim();
  if (!text) return;
  const seq = ++routeSeq;

  // Step 1: the local rules. Instant and free.
  const ruled = await window.cc.routeRules(text);
  if (seq !== routeSeq) return;
  if (ruled) return settle(ruled);

  // A starter chip only wrote the opening words. Do not spend a classifier call
  // sizing up a sentence nobody has finished.
  if (starterStub && text === starterStub) {
    decision = null;
    renderRoute();
    return;
  }

  // Step 2: the classifier, which takes several seconds. Say so at once and
  // unlock Launch on the default. Without this the app looked dead: no status
  // and a disabled button for as long as the call ran.
  settle(pendingDecision());
  await wait(CLASSIFIER_DELAY); // do not spawn a process for every typing pause
  if (seq !== routeSeq) return;
  const d = await window.cc.route(text);
  // If the prompt changed while it ran, a newer request owns the answer;
  // dropping this one keeps a stale model from being shown (and launched).
  if (seq !== routeSeq) return;
  settle(d);
}

// Re-apply the project default when the Run-in target changes.
$("runin").addEventListener("change", () => {
  if (!decision) return;
  applyDefault();
  renderRoute();
});

// Open or close the routing card. Closed, it stays in the DOM with its last
// content, so it can slide away instead of vanishing.
function setReveal(open) {
  const r = $("thinkReveal");
  r.classList.toggle("open", open);
  r.setAttribute("aria-hidden", String(!open));
  r.inert = !open;
}

// The router's effort for the model on screen. It sized up the prompt for its
// own pick; for any other model, start from that model's baseline.
function recommendedEffort(key) {
  if (decision && key === decision.modelKey && decision.effort) return decision.effort;
  return MODELS[key].effort;
}

function currentEffort(key) {
  return chosenEffort || recommendedEffort(key);
}

function renderRoute() {
  const block = $("thinkBlock");
  const alts = $("alts");

  if (!decision) {
    setReveal(false);
    updateLaunchState();
    return;
  }
  setReveal(true);

  const key = chosenKey || decision.modelKey;
  const m = MODELS[key];
  const conf = Math.round(decision.confidence * 100);
  const ask = decision.needsConfirm && chosenSource === "router";

  // "pending" while the classifier is still working; "ok" when the router chose
  // the model; "ask" when the decision is yours (a manual override, a project
  // default) or is being handed to you (ambiguous).
  let state, title, clear = "";
  if (decision.pending && chosenSource === "router") {
    state = "pending";
    title = "Picking a model";
  } else if (chosenSource === "router" && !ask) {
    state = "ok";
    title = `${m.label} chosen`;
  } else {
    state = "ask";
    if (ask) {
      title = "Not sure. Pick a model";
    } else if (chosenSource === "pref") {
      title = `Your default for ${escapeHtml(runinName())}: ${m.label}`;
      clear = ` <button class="pref-clear" id="prefClear" type="button" aria-label="Clear this project's default model" title="Clear this project's default">✕</button>`;
    } else {
      title = `Your pick: ${m.label}`;
    }
  }

  block.className = "think-block " + state;
  // No cost marks while pending: nothing has been chosen yet, and the chips carry them.
  const costHtml = state === "pending" ? "" : ` <span class="tb-cost" aria-label="relative cost ${m.cost.length} of ${ORDER.length}">${m.cost}</span>`;
  $("thinkTitle").innerHTML = `<span class="tb-name">${title}</span>${costHtml}${clear}`;
  $("thinkMeta").textContent = decision.pending ? "asking Haiku" : `${conf}% · ${decision.source}`;
  if (cliTooOldFor(key)) setDrawer(true); // relevant again: this pick cannot launch cleanly
  $("thinkBody").textContent = cliTooOldFor(key)
    ? `${decision.reason} · Needs Claude Code ${MODELS[key].minCli} or newer; this Mac has ${cli.version}.`
    : decision.reason;

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

  // Override chips: every model in the catalog, the chosen one pressed.
  alts.innerHTML =
    `<span class="alts-label" id="altsLabel">Use:</span>` +
    ORDER.map(
      (k) =>
        `<button class="alt-chip ${k === key ? "active" : ""}" type="button" data-key="${k}" aria-pressed="${k === key}" title="${escapeAttr(MODELS[k].blurb)}">${MODELS[k].label} ${MODELS[k].cost}</button>`
    ).join("");
  alts.querySelectorAll(".alt-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      chosenKey = chip.dataset.key;
      chosenSource = "manual";
      renderRoute();
    })
  );

  renderEfforts(key);

  updateLaunchState();
}

// Effort chips: every level `claude --effort` takes, the one in use pressed and
// the recommended one dotted. Hidden when this Claude Code has no --effort flag,
// since the choice would be dropped at launch.
function renderEfforts(key) {
  const row = $("efforts");
  if (!EFFORTS.length || !(cli && cli.effort)) {
    row.innerHTML = "";
    return;
  }
  const rec = recommendedEffort(key);
  const cur = currentEffort(key);
  const note =
    cur === rec
      ? `<span class="eff-note">Recommended</span>`
      : `<button class="eff-note" id="effReset" type="button">Back to ${rec} (recommended)</button>`;
  row.innerHTML =
    `<span class="alts-label">Effort:</span>` +
    EFFORTS.map(
      (e) =>
        `<button class="alt-chip eff-chip ${e === cur ? "active" : ""} ${e === rec ? "rec" : ""}" type="button" data-effort="${e}" aria-pressed="${e === cur}" title="${e === rec ? "Recommended for this prompt" : `Run at ${e} effort`}">${e}</button>`
    ).join("") +
    note;
  row.querySelectorAll(".eff-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      // Picking the recommended level is the same as not overriding it, so it
      // keeps following the router if the model changes.
      chosenEffort = chip.dataset.effort === rec ? null : chip.dataset.effort;
      renderEfforts(key);
    })
  );
  const reset = $("effReset");
  if (reset)
    reset.addEventListener("click", () => {
      chosenEffort = null;
      renderEfforts(key);
    });
}

// ---------- Launch ----------

function updateLaunchState() {
  $("launch").disabled = !decision;
}

function requestLaunch() {
  if (!decision) return;
  const key = chosenKey || decision.modelKey;
  if (cliTooOldFor(key)) showOldCliModal(key);
  else if (overForKey(key)) showOverLimitModal(key);
  else doLaunch(key);
}

$("launch").addEventListener("click", requestLaunch);

function doLaunch(key) {
  const model = MODELS[key].id;
  const prompt = $("prompt").value.trim();
  const cwd = $("runin").value || undefined;
  // Learn: launching a project with a model that overrides the router's pick
  // makes that model the project's default going forward.
  // A pending decision is only a placeholder, so there is nothing to override.
  if (cwd && decision && !decision.pending && key !== decision.modelKey) {
    window.cc.prefsSet(cwd, key);
    projectPrefs[cwd] = key;
  }
  const effort = currentEffort(key);
  createSession({ cwd, model, prompt, effort, title: prompt ? prompt.slice(0, 40) : "New session" }).then((ok) => {
    // The prompt now lives in the session. Start the composer clean, so a model
    // picked by hand for this prompt does not carry over to the next one. If the
    // session failed to start, keep the text so nothing is lost.
    if (!ok) return;
    $("prompt").value = "";
    decision = null;
    chosenKey = null;
    chosenSource = "router";
    chosenEffort = null;
    routeSeq++;
    renderRoute();
  });
}

// One confirm dialog, two reasons to show it.
let modalReturnFocus = null;

function openModal(title, bodyHtml, onGo) {
  modalReturnFocus = document.activeElement;
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = bodyHtml;
  $("modal").hidden = false;
  $("modalGo").onclick = () => {
    closeModal();
    onGo();
  };
  $("modalCancel").onclick = closeModal;
  $("modalCancel").focus(); // the safe choice gets focus
}

function closeModal() {
  $("modal").hidden = true;
  if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
  modalReturnFocus = null;
}

function showOverLimitModal(key) {
  const m = key === "fable" ? usage.weeklyFable : usage.weeklyAll;
  const at = m.spent == null ? `You are at <b>${m.pct}%</b> of this bucket.` : `You are at <b>${m.pct}%</b> of this bucket ($${m.spent} of $${m.ceiling}).`;
  openModal(
    `${MODELS[key].label} is over your weekly limit`,
    `${at} It resets <b>${fmtReset(m.resetAt)}</b>. Launch anyway, or pick a lighter model.`,
    () => doLaunch(key)
  );
}

function showOldCliModal(key) {
  openModal(
    `${MODELS[key].label} needs a newer Claude Code`,
    `This Mac has Claude Code <b>${escapeHtml(cli.version)}</b>. ${MODELS[key].label} needs <b>${escapeHtml(MODELS[key].minCli)}</b> or newer, ` +
      `so this session may fail or waste usage. Run <code>claude update</code> in Terminal first, or pick another model.`,
    () => (overForKey(key) ? showOverLimitModal(key) : doLaunch(key))
  );
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

const FOLDER_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/></svg>`;

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

// Rows are real buttons, so the whole list works from the keyboard and wears
// the system focus ring. The folder toggle and the pin sit side by side: a
// button cannot contain another button.
function renderProject(p, chats, open, pinned) {
  const chatHtml = chats
    .map(
      (c) => `
      <button class="chat" type="button" data-cwd="${escapeAttr(p.cwd)}" data-id="${c.id}" data-model="${escapeAttr(c.model || "")}" title="Reopen this chat">
        <span class="chat-time">${fmtChatTime(c.updated)}</span>
        <span class="chat-title">${escapeHtml(c.title)}</span>
        ${c.model ? `<span class="chat-model">${modelShort(c.model)}</span>` : ""}
      </button>`
    )
    .join("");
  return `
    <div class="project ${open ? "open" : ""}">
      <div class="project-head">
        <button class="project-toggle" type="button" aria-expanded="${open}">
          <span class="folder">${FOLDER_SVG}</span>
          <span class="project-name">${escapeHtml(p.name)}</span>
        </button>
        <button class="pin-btn ${pinned ? "pinned" : ""}" type="button" data-pin="${escapeAttr(p.cwd)}" aria-pressed="${pinned}" aria-label="${pinned ? "Unpin" : "Pin"} ${escapeAttr(p.name)}" title="${pinned ? "Unpin" : "Pin to top"}">${pinned ? "★" : "☆"}</button>
      </div>
      <div class="chats">
        ${chatHtml}
        <div class="project-footer">
          <span class="project-path" title="${escapeAttr(p.cwd)}">${escapeHtml(p.cwd)}</span>
          <button class="btn btn--sm finder-btn" type="button" data-cwd="${escapeAttr(p.cwd)}" title="Reveal in Finder">Open in Finder</button>
        </div>
      </div>
    </div>`;
}

function wireProjects() {
  const list = $("projects");
  list.querySelectorAll(".project-toggle").forEach((btn) =>
    btn.addEventListener("click", () => {
      const open = btn.closest(".project").classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
    })
  );
  list.querySelectorAll(".chat").forEach((chat) =>
    chat.addEventListener("click", () => {
      const title = chat.querySelector(".chat-title");
      reopenChat(chat.dataset.cwd, chat.dataset.id, title ? title.textContent : "", chat.dataset.model);
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

// Resume on the model you have chosen in the composer. With nothing chosen,
// stay in the chat's own family (an old Opus chat resumes on the current Opus)
// rather than silently dropping everything to Sonnet.
function reopenChat(cwd, sessionId, title, recordedModel) {
  const key = decision ? chosenKey || decision.modelKey : keyForModelId(recordedModel) || "sonnet";
  const go = () => createSession({ cwd, model: MODELS[key].id, sessionId, title: title || "Resumed session" });
  if (cliTooOldFor(key)) {
    openModal(
      `${MODELS[key].label} needs a newer Claude Code`,
      `This Mac has Claude Code <b>${escapeHtml(cli.version)}</b>. ${MODELS[key].label} needs <b>${escapeHtml(MODELS[key].minCli)}</b> or newer. ` +
        `Run <code>claude update</code> in Terminal first, or choose another model in the composer.`,
      go
    );
  } else {
    go();
  }
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
    s.term.write("\r\n\x1b[90msession ended\x1b[0m\r\n");
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
    theme: TERM_THEMES[currentTheme()],
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

async function createSession({ cwd, model, sessionId, prompt, effort, title }) {
  wirePtyOnce();
  const mount = document.createElement("div");
  mount.className = "term-mount";
  $("termBody").appendChild(mount);
  const { term, fit } = makeTerm(mount);

  const r = await window.cc.ptyStart({ cwd, model, sessionId, prompt, effort, cols: 80, rows: 24 });
  if (!r || r.ok === false) {
    term.write("\r\n\x1b[31mCould not start Claude Code: " + ((r && r.error) || "") + "\x1b[0m\r\n");
  }
  const id = r && r.id ? r.id : "dead" + sessions.size;
  const s = { id, title: title || "Claude Code", term, fit, mount, ended: !(r && r.ok) };
  sessions.set(id, s);
  if (r && r.ok) term.onData((d) => window.cc.ptyInput(id, d));
  activate(id);
  return !!(r && r.ok);
}

function activate(id) {
  activeId = id;
  document.querySelector(".app").classList.add("session"); // full-window terminal
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
  document.querySelector(".app").classList.remove("session"); // back to rail layout
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

// Each tab is two sibling buttons (select, close) inside a plain wrapper, so
// both are reachable from the keyboard.
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
    const on = s.id === activeId;
    html += `<div class="term-tab ${on ? "active" : ""}" title="${escapeAttr(s.title)}">
      <button class="tab-select" type="button" data-id="${s.id}" aria-current="${on ? "true" : "false"}"><span class="tab-title">${escapeHtml(s.title)}${s.ended ? " · ended" : ""}</span></button>
      <button class="tab-close" type="button" data-close="${s.id}" aria-label="Close ${escapeAttr(s.title)}" title="Close session">✕</button>
    </div>`;
  }
  html += `<button class="term-tab new-tab ${activeId === null ? "active" : ""}" type="button" id="newTab">＋ New</button>`;
  html += `<span class="term-hint">Return to send · ⌘1–9 tabs · ⌘T new</span>`;
  strip.innerHTML = html;

  strip.querySelectorAll(".tab-select").forEach((t) =>
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
    if (e.key === "Escape" && !$("modal").hidden) {
      e.preventDefault();
      closeModal();
      return;
    }
    if (!e.metaKey || e.altKey || e.ctrlKey) return;
    const k = e.key;
    if (k === "Enter") {
      // ⌘Enter launches from the composer.
      if (activeId === null && decision && $("modal").hidden) {
        e.preventDefault();
        requestLaunch();
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

// Prompt starters. Each writes its opening words into the box and leaves the
// cursor at the end for you to finish. Nothing launches. The local rules still
// run at once, so "across the whole repo" shows its routing right away.
document.querySelectorAll("#chips .chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    const el = $("prompt");
    el.value = chip.dataset.p || "";
    starterStub = el.value.trim();
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    runRoute();
  })
);

// ---------- init ----------

(async () => {
  // The catalog first: everything below renders model labels from it.
  const cat = await window.cc.models();
  MODELS = cat.models;
  ORDER = cat.order;
  EFFORTS = cat.efforts || [];
  syncThemeToggle();
  if (window.cc.hotkey) {
    $("hotkeyKey").textContent = window.cc.hotkey;
    $("hotkeyHint").hidden = false;
  }
  projectPrefs = await window.cc.prefsGet();
  loadUsage();
  loadProjects();
  loadCli();
  // Keep the meters current on their own: every minute, and the moment you come
  // back to the window. The live source is a free GET, so this costs nothing.
  setInterval(loadUsage, 60000);
  window.addEventListener("focus", loadUsage);
})();
