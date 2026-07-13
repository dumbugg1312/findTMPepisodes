/* TMP Transcript Archive — static client-side search.
   Data: data/episodes.json (catalog) + data/shard-NN.json (segment text,
   lazy-loaded once on first search). No backend, no dependencies. */
"use strict";

const $ = (sel) => document.querySelector(sel);
const RESULTS_PAGE = 30;

const state = {
  episodes: [],          // full catalog (transcribed + pending)
  byEp: new Map(),
  shardIds: new Set(),   // shards that exist
  shards: new Map(),     // shardId -> {speakers, eps:{ep:[[start,spkIdx,text,lowered]]}}
  loadingShards: null,   // promise while shards load
  results: [],
  shown: 0,
  query: "",
  stats: null,           // stats.json (lazy)
  playingEp: null,       // episode currently in the mini player
  epPageLines: null,     // [{start, el}] for the open episode page (karaoke)
  epPageEp: null,
  karaokeIdx: -1,
  pendingSeek: null,
};

const isNamedSpeaker = (s) =>
  s && s !== "Unknown" && !/^speaker\s/i.test(s);

/* ---------- utils ---------- */

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const esc = (t) => t.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function speakerClass(name) {
  if (!name) return "spk-anon";
  if (name === "Will Sasso") return "spk-will";
  if (name === "Chris D'Elia") return "spk-chris";
  if (name === "Bryan Callen") return "spk-bryan";
  if (/^speaker |^unknown$/i.test(name)) return "spk-anon";
  return "spk-guest";
}

function playUrl(ep, seconds) {
  const m = state.byEp.get(ep);
  if (!m) return "#";
  const t = Math.max(0, Math.floor(seconds - 3)); // land a beat early
  return `https://archive.org/details/${m.item}/${encodeURIComponent(m.file)}?start=${t}`;
}

/* mini player: streams the mp3 straight from archive.org and seeks to the
   moment (their /details page ignores ?start=, so we play it ourselves) */
const momentHash = (ep, seconds) => `#ep/${ep}?t=${Math.floor(seconds)}`;

function playMoment(ep, seconds) {
  const m = state.byEp.get(ep);
  if (!m) return;
  state.playingEp = ep;
  const t = Math.max(0, Math.floor(seconds - 3));
  const bar = $("#player");
  const audio = $("#player-audio");
  bar.hidden = false;
  document.body.classList.add("has-player");
  $("#player-ep").textContent = `Ep ${ep} — ${m.title}`;
  $("#player-ep").href = `#ep/${ep}`;
  $("#player-at").textContent = `from ${fmtTime(seconds)}`;
  const src = `https://archive.org/download/${m.item}/${encodeURIComponent(m.file)}`;
  const seekAndPlay = () => {
    try { audio.currentTime = t; } catch { /* not seekable yet */ }
    audio.play().catch(() => { /* user gesture expired or load aborted */ });
  };
  // Cancel any seek armed by a previous click that never fired.
  if (state.pendingSeek) audio.removeEventListener("loadedmetadata", state.pendingSeek);
  state.pendingSeek = null;
  if (audio.dataset.src !== src) {
    // New file: swap src and (re)load — only here, never on a same-file replay,
    // because load() resets the element and strands playback (mobile Safari).
    audio.pause();
    audio.src = src;
    audio.dataset.src = src;
    state.pendingSeek = seekAndPlay;
    audio.addEventListener("loadedmetadata", seekAndPlay, { once: true });
    audio.load();
  } else if (audio.readyState >= 1) {
    seekAndPlay();
  } else {
    // Same file but metadata never arrived (previous load failed) — retry.
    state.pendingSeek = seekAndPlay;
    audio.addEventListener("loadedmetadata", seekAndPlay, { once: true });
    audio.load();
  }
}

function closePlayer() {
  const audio = $("#player-audio");
  audio.pause();
  $("#player").hidden = true;
  document.body.classList.remove("has-player");
}

const fmtDate = (iso) => {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${d}, ${y}`;
};

/* ---------- data loading ---------- */

async function loadCatalog() {
  const res = await fetch("data/episodes.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("episodes.json missing — run scripts/build_index.py");
  state.episodes = await res.json();
  for (const e of state.episodes) {
    state.byEp.set(e.ep, e);
    if (e.shard !== undefined) state.shardIds.add(e.shard);
  }
  const done = state.episodes.filter((e) => e.shard !== undefined).length;
  $("#counter").textContent =
    `📼 ${done} of ${state.episodes.length} episodes transcribed`;
  const speakers = new Set();
  for (const e of state.episodes) (e.speakers || []).forEach((s) => speakers.add(s));
  const sel = $("#spk");
  [...speakers].sort().forEach((s) => {
    const o = document.createElement("option");
    o.value = s; o.textContent = s;
    sel.append(o);
  });
}

function loadShards() {
  if (state.loadingShards) return state.loadingShards;
  state.loadingShards = Promise.all([...state.shardIds].map(async (id) => {
    const res = await fetch(`data/shard-${String(id).padStart(2, "0")}.json`,
                            { cache: "no-cache" });
    const sh = await res.json();
    for (const rows of Object.values(sh.eps))
      for (const r of rows) r.push(r[2].toLowerCase());
    state.shards.set(id, sh);
  }));
  return state.loadingShards;
}

/* ---------- search ---------- */

function* iterSegments() {
  for (const sh of state.shards.values())
    for (const [ep, rows] of Object.entries(sh.eps))
      for (let i = 0; i < rows.length; i++)
        yield { ep: +ep, rows, i, speakers: sh.speakers };
}

function runSearch(qRaw, who) {
  const q = qRaw.toLowerCase().trim();
  const hits = [];
  // pass 1: exact substring
  for (const seg of iterSegments()) {
    const row = seg.rows[seg.i];
    if (who && seg.speakers[row[1]] !== who) continue;
    if (row[3].includes(q)) hits.push({ ...seg, exact: true });
  }
  if (hits.length) return { hits, mode: "exact" };
  // pass 2: all words present in segment (looser, catches whisper mishears less)
  const words = q.split(/\s+/).filter((w) => w.length > 1);
  if (words.length < 2) return { hits, mode: "exact" };
  for (const seg of iterSegments()) {
    const row = seg.rows[seg.i];
    if (who && seg.speakers[row[1]] !== who) continue;
    if (words.every((w) => row[3].includes(w))) hits.push({ ...seg, exact: false });
  }
  return { hits, mode: "loose" };
}

function highlight(text, q, mode) {
  if (mode === "exact") {
    const i = text.toLowerCase().indexOf(q.toLowerCase().trim());
    if (i < 0) return esc(text);
    const j = i + q.trim().length;
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, j)) + "</mark>" + esc(text.slice(j));
  }
  let out = esc(text);
  for (const w of q.toLowerCase().split(/\s+/).filter((w) => w.length > 1)) {
    out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"),
      "<mark>$1</mark>");
  }
  return out;
}

function renderResults(fresh) {
  const list = $("#results");
  if (fresh) { list.innerHTML = ""; state.shown = 0; }
  const batch = state.results.slice(state.shown, state.shown + RESULTS_PAGE);
  state.shown += batch.length;
  for (const hit of batch) {
    const row = hit.rows[hit.i];
    const [start, spkIdx, text] = row;
    const name = hit.speakers[spkIdx] || "Unknown";
    const meta = state.byEp.get(hit.ep);
    const li = document.createElement("li");
    li.className = "result";
    li.innerHTML = `
      <button class="result-quote" aria-expanded="false" title="show surrounding lines">
        <span class="quote-speaker ${speakerClass(name)}">${esc(name)}:</span>
        <span class="quote-text">&ldquo;${highlight(text, state.query, hit.mode)}&rdquo;</span>
      </button>
      <div class="result-meta">
        <a class="ep-link" href="#ep/${hit.ep}">Ep ${hit.ep} — ${esc(meta?.title || "")}</a>
        ${meta?.date ? `<span>${fmtDate(meta.date)}</span>` : ""}
        <span class="timestamp">${fmtTime(start)}</span>
        <a class="play-link" href="${playUrl(hit.ep, start)}" target="_blank" rel="noopener">▶ play this moment</a>
        <a class="moment-link" href="${momentHash(hit.ep, start)}" title="permalink to this moment — copy the address to share it">🔗 link</a>
      </div>`;
    li.querySelector(".result-quote").addEventListener("click", (ev) =>
      toggleContext(ev.currentTarget, li, hit));
    li.querySelector(".play-link").addEventListener("click", (ev) => {
      ev.preventDefault();
      playMoment(hit.ep, start);
    });
    list.append(li);
  }
  $("#search-more").hidden = state.shown >= state.results.length;
}

function toggleContext(btn, li, hit) {
  const open = li.querySelector(".result-context");
  if (open) { open.remove(); btn.setAttribute("aria-expanded", "false"); return; }
  const div = document.createElement("div");
  div.className = "result-context";
  const from = Math.max(0, hit.i - 2), to = Math.min(hit.rows.length - 1, hit.i + 2);
  for (let k = from; k <= to; k++) {
    const [s, spkIdx, text] = hit.rows[k];
    const name = hit.speakers[spkIdx] || "Unknown";
    const p = document.createElement("p");
    p.className = "ctx-line" + (k === hit.i ? " hit" : "");
    p.innerHTML = `<span class="quote-speaker ${speakerClass(name)}">${esc(name)}:</span> ${esc(text)}`;
    div.append(p);
  }
  li.append(div);
  btn.setAttribute("aria-expanded", "true");
}

async function onSearch(ev) {
  ev?.preventDefault();
  const q = $("#q").value.trim();
  if (q.length < 2) return;
  state.query = q;
  const who = $("#spk").value;
  location.hash = `#search?q=${encodeURIComponent(q)}` +
    (who ? `&spk=${encodeURIComponent(who)}` : "");
  const status = $("#search-status");
  const doneCount = state.shardIds.size;
  if (!doneCount) {
    status.innerHTML = `<div class="empty"><span class="big">Nothing transcribed yet.</span>
      Run a transcription batch first, then rebuild the index.</div>`;
    return;
  }
  if (!state.shards.size) {
    $("#results").innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    status.textContent = "loading transcripts (first search only)…";
    await loadShards();
  }
  const { hits, mode } = runSearch(q, $("#spk").value);
  hits.sort((a, b) => a.ep - b.ep || a.rows[a.i][0] - b.rows[b.i][0]);
  state.results = hits;
  const done = state.episodes.filter((e) => e.shard !== undefined).length;
  if (!hits.length) {
    $("#results").innerHTML = "";
    $("#search-more").hidden = true;
    status.innerHTML = `<div class="empty"><span class="big">No dice.</span>
      Searched ${done} transcribed episodes. Try fewer or different words —
      the robot transcriber occasionally mishears names.
      ${done < state.episodes.length ? `<br>(${state.episodes.length - done} episodes still await transcription — it might be in one of those.)` : ""}</div>`;
    return;
  }
  status.innerHTML = `<strong>${hits.length}</strong> ${mode === "loose" ? "close " : ""}hit${hits.length === 1 ? "" : "s"} across ${done} transcribed episodes` +
    (mode === "loose" ? " (no exact match — showing lines containing all your words)" : "");
  renderResults(true);
}

/* ---------- episodes view ---------- */

function renderEpisodes(filter = "") {
  const f = filter.toLowerCase();
  const list = $("#ep-list");
  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const e of state.episodes) {
    if (f && !(`${e.ep} ${e.title}`.toLowerCase().includes(f))) continue;
    const li = document.createElement("li");
    const done = e.shard !== undefined;
    li.className = "ep-row" + (done ? "" : " is-pending");
    li.innerHTML = `
      <span class="num">${e.ep}</span>
      <span class="t">${done ? `<a href="#ep/${e.ep}">${esc(e.title)}</a>` : esc(e.title)}</span>
      ${e.date ? `<span class="when">${fmtDate(e.date)}</span>` : ""}
      ${done ? "" : `<span class="pending">not yet transcribed</span>`}`;
    frag.append(li);
  }
  list.append(frag);
  if (!list.children.length)
    list.innerHTML = `<div class="empty"><span class="big">No episode matches.</span></div>`;
}

/* ---------- episode page ---------- */

async function renderEpisodePage(ep, atSeconds = null) {
  const root = $("#ep-page");
  const meta = state.byEp.get(ep);
  state.epPageLines = null;
  state.epPageEp = null;
  state.karaokeIdx = -1;
  if (!meta) { root.innerHTML = `<div class="empty"><span class="big">No episode ${ep}.</span></div>`; return; }
  const archiveLink = `https://archive.org/details/${meta.item}/${encodeURIComponent(meta.file)}`;
  const head = `
    <a class="back-link" href="#episodes">&larr; all episodes</a>
    <div class="ep-head">
      <h2>Ep ${ep}: ${esc(meta.title)}</h2>
      <p class="ep-sub">${meta.date ? fmtDate(meta.date) + " · " : ""}${meta.duration ? Math.round(meta.duration / 60) + " min · " : ""}Ten Minute Podcast</p>
      ${meta.desc ? `<p class="ep-desc">${esc(meta.desc)}</p>` : ""}
    </div>
    <div class="listen-box">
      <a class="btn-primary" href="${archiveLink}" target="_blank" rel="noopener">▶ Listen on archive.org</a>
      <span>Audio lives on the Internet Archive — tap any timestamp to play from that line, right here.</span>
    </div>`;
  if (meta.shard === undefined) {
    root.innerHTML = head + `<div class="empty"><span class="big">Not transcribed yet.</span>
      This one is still in the queue — the audio link above works right now.</div>`;
    return;
  }
  root.innerHTML = head + `<div class="skeleton"></div><div class="skeleton"></div>`;
  await loadShards();
  const sh = state.shards.get(meta.shard);
  const rows = sh?.eps[String(ep)] || [];
  const legend = (meta.speakers || []).map((s) => isNamedSpeaker(s)
    ? `<a class="${speakerClass(s)}" href="#cast/${encodeURIComponent(s)}">● ${esc(s)}</a>`
    : `<span class="${speakerClass(s)}">● ${esc(s)}</span>`).join("");
  let html = head + `<div class="speaker-legend">${legend}</div><div class="transcript">`;
  for (const [start, spkIdx, text] of rows) {
    const name = sh.speakers[spkIdx] || "Unknown";
    html += `<div class="line">
      <a class="ts" href="${momentHash(ep, start)}" data-start="${start}"
         title="play from ${fmtTime(start)} — or copy this link to share the moment">${fmtTime(start)}</a>
      <p><span class="quote-speaker ${speakerClass(name)}">${esc(name)}:</span>${esc(text)}</p>
    </div>`;
  }
  root.innerHTML = html + "</div>";
  const lineEls = [...root.querySelectorAll(".line")];
  state.epPageLines = rows.map((r, i) => ({ start: r[0], el: lineEls[i] }));
  state.epPageEp = ep;
  root.querySelectorAll(".ts").forEach((a) =>
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      // shareable URL without a re-render (hashchange would rebuild the page)
      history.replaceState(null, "", momentHash(ep, Number(a.dataset.start)));
      playMoment(ep, Number(a.dataset.start));
    }));
  if (atSeconds !== null) {
    const idx = lineIndexAt(state.epPageLines, atSeconds);
    if (idx >= 0) {
      lineEls[idx].classList.add("line-target");
      lineEls[idx].scrollIntoView({ block: "center" });
    }
  }
}

/* index of the last line starting at or before t (binary search) */
function lineIndexAt(lines, t) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t + 0.25) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/* karaoke: highlight the line under the playhead on the open episode page */
function onTimeUpdate() {
  if (!state.epPageLines || state.playingEp !== state.epPageEp) return;
  const t = $("#player-audio").currentTime;
  const idx = lineIndexAt(state.epPageLines, t);
  if (idx === state.karaokeIdx) return;
  if (state.karaokeIdx >= 0)
    state.epPageLines[state.karaokeIdx]?.el.classList.remove("now");
  state.karaokeIdx = idx;
  if (idx < 0) return;
  const el = state.epPageLines[idx].el;
  el.classList.add("now");
  if ($("#player-follow").checked) {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }
}

/* ---------- cast ---------- */

async function loadStats() {
  if (state.stats) return state.stats;
  const res = await fetch("data/stats.json", { cache: "no-cache" });
  state.stats = res.ok ? await res.json() : { talk: {}, talkByEp: {} };
  return state.stats;
}

const fmtHours = (secs) => {
  const h = secs / 3600;
  return h >= 10 ? `${Math.round(h)} h` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(secs / 60)} min`;
};

function castInfo(name) {
  const eps = state.episodes.filter((e) => (e.speakers || []).includes(name));
  const dated = eps.filter((e) => e.date);
  return { eps, first: dated[0], last: dated[dated.length - 1] };
}

async function renderCastIndex() {
  const root = $("#cast-page");
  root.innerHTML = `<div class="skeleton"></div>`;
  const stats = await loadStats();
  const named = Object.entries(stats.talk).filter(([n]) => isNamedSpeaker(n));
  const unnamedSecs = Object.entries(stats.talk)
    .filter(([n]) => !isNamedSpeaker(n)).reduce((a, [, s]) => a + s, 0);
  const max = named[0]?.[1] || 1;
  let html = `<h2 class="view-title">The cast</h2>
    <p class="ep-sub">Everyone the voice-matcher can put a name to, by total time on mic across the whole run.</p>
    <ul class="cast-list">`;
  for (const [name, secs] of named) {
    const { eps } = castInfo(name);
    html += `<li class="cast-row">
      <a class="cast-name ${speakerClass(name)}" href="#cast/${encodeURIComponent(name)}">${esc(name)}</a>
      <span class="cast-bar"><span style="width:${Math.max(2, (secs / max) * 100)}%"></span></span>
      <span class="cast-meta">${fmtHours(secs)} · ${eps.length} ep${eps.length === 1 ? "" : "s"}</span>
    </li>`;
  }
  html += `</ul>
    <p class="ep-sub">Plus ${fmtHours(unnamedSecs)} from voices the matcher couldn't name —
    one-off characters, guests, and bits (they stay "Speaker A/B/…" until identified).</p>`;
  root.innerHTML = html;
}

async function renderCastPage(name) {
  const root = $("#cast-page");
  root.innerHTML = `<div class="skeleton"></div>`;
  const stats = await loadStats();
  const { eps, first, last } = castInfo(name);
  if (!eps.length) {
    root.innerHTML = `<a class="back-link" href="#cast">&larr; all cast</a>
      <div class="empty"><span class="big">Nobody by that name on the mic.</span></div>`;
    return;
  }
  const secs = stats.talk[name] || 0;
  // co-appearance tally
  const co = new Map();
  for (const e of eps)
    for (const s of e.speakers || [])
      if (s !== name && isNamedSpeaker(s)) co.set(s, (co.get(s) || 0) + 1);
  const top = [...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const era = first && last
    ? `${fmtDate(first.date)} (Ep ${first.ep}) &rarr; ${fmtDate(last.date)} (Ep ${last.ep})`
    : "dates unknown";
  root.innerHTML = `
    <a class="back-link" href="#cast">&larr; all cast</a>
    <div class="ep-head"><h2 class="${speakerClass(name)}">${esc(name)}</h2>
      <p class="ep-sub">${eps.length} episodes · ${fmtHours(secs)} on mic · ${era}</p>
    </div>
    ${top.length ? `<p class="cast-co">Most often on with: ${top.map(([s, n]) =>
      `<a class="${speakerClass(s)}" href="#cast/${encodeURIComponent(s)}">${esc(s)}</a> (${n})`).join(", ")}</p>` : ""}
    <ul class="ep-list">` + eps.map((e) => `
      <li class="ep-row">
        <span class="num">${e.ep}</span>
        <span class="t"><a href="#ep/${e.ep}">${esc(e.title)}</a></span>
        ${e.date ? `<span class="when">${fmtDate(e.date)}</span>` : ""}
      </li>`).join("") + "</ul>";
}

/* ---------- stats ---------- */

const CATCHPHRASES = ["shut up", "dude", "diamond", "do the voice",
  "hotline", "pineapple", "wilbot"];

async function renderStats() {
  const body = $("#stats-body");
  body.innerHTML = `<div class="skeleton"></div>`;
  const stats = await loadStats();
  const named = Object.entries(stats.talk).filter(([n]) => isNamedSpeaker(n)).slice(0, 10);
  const max = named[0]?.[1] || 1;
  const durs = state.episodes.filter((e) => e.duration);
  const overTen = durs.filter((e) => e.duration > 660);
  const longest = [...durs].sort((a, b) => b.duration - a.duration)[0];
  const shortest = [...durs].sort((a, b) => a.duration - b.duration)[0];
  const avg = durs.reduce((a, e) => a + e.duration, 0) / (durs.length || 1);
  body.innerHTML = `
    <h3 class="stats-h">Who actually talks</h3>
    <ul class="cast-list">${named.map(([name, secs]) => `
      <li class="cast-row">
        <a class="cast-name ${speakerClass(name)}" href="#cast/${encodeURIComponent(name)}">${esc(name)}</a>
        <span class="cast-bar"><span style="width:${Math.max(2, (secs / max) * 100)}%"></span></span>
        <span class="cast-meta">${fmtHours(secs)}</span>
      </li>`).join("")}
    </ul>
    <h3 class="stats-h">The "ten minute" audit</h3>
    <p>Average episode: <strong>${fmtTime(avg)}</strong> across ${durs.length} episodes.
       ${overTen.length} of them (${Math.round((overTen.length / durs.length) * 100)}%) blew past eleven minutes.
       Longest lie: <a href="#ep/${longest.ep}">Ep ${longest.ep} — ${esc(longest.title)}</a>
       at <strong>${fmtTime(longest.duration)}</strong>. Shortest:
       <a href="#ep/${shortest.ep}">Ep ${shortest.ep} — ${esc(shortest.title)}</a> at ${fmtTime(shortest.duration)}.</p>
    <h3 class="stats-h">Catchphrase counter</h3>
    <p class="ep-sub">How often it got said across every transcript. Tap a phrase to see every hit.</p>
    <div id="phrase-body"><button id="phrase-btn" class="btn-plain">🔎 tally the catchphrases
      <small>(loads all transcripts, ~12&nbsp;MB)</small></button></div>`;
  $("#phrase-btn").addEventListener("click", tallyPhrases);
}

async function tallyPhrases() {
  const div = $("#phrase-body");
  div.innerHTML = `<div class="skeleton"></div>`;
  await loadShards();
  const rows = CATCHPHRASES.map((p) => {
    let n = 0;
    for (const seg of iterSegments())
      if (seg.rows[seg.i][3].includes(p)) n++;
    return { p, n };
  }).sort((a, b) => b.n - a.n);
  const max = rows[0]?.n || 1;
  div.innerHTML = `<ul class="cast-list">${rows.map(({ p, n }) => `
    <li class="cast-row">
      <a class="cast-name" href="#search?q=${encodeURIComponent(p)}">&ldquo;${esc(p)}&rdquo;</a>
      <span class="cast-bar"><span style="width:${Math.max(2, (n / max) * 100)}%"></span></span>
      <span class="cast-meta">${n.toLocaleString()}×</span>
    </li>`).join("")}</ul>`;
}

/* ---------- random bit ---------- */

async function randomBit() {
  const btn = $("#random-btn");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "🎲 rolling…";
  try {
    await loadShards();
    const all = [];
    for (const sh of state.shards.values())
      for (const ep of Object.keys(sh.eps)) all.push({ ep: +ep, n: sh.eps[ep].length, sh });
    const pick = all[Math.floor(Math.random() * all.length)];
    const i = Math.floor(Math.random() * pick.n);
    const start = pick.sh.eps[pick.ep][i][0];
    location.hash = momentHash(pick.ep, start);
    playMoment(pick.ep, start);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ---------- this day ---------- */

function renderDay() {
  const now = new Date();
  const mmdd = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const withDates = state.episodes.filter((e) => e.date);
  $("#day-title").textContent = `This day in TMP — ${now.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
  const body = $("#day-body");
  if (!withDates.length) {
    body.innerHTML = `<div class="empty"><span class="big">Air dates aren't loaded yet.</span>
      Once episode air dates are added to the archive, this tab shows every episode
      released on today's date — "10 years ago today" and all that.</div>`;
    return;
  }
  const todays = withDates.filter((e) => e.date.slice(5) === mmdd);
  if (!todays.length) {
    body.innerHTML = `<div class="empty"><span class="big">Nothing aired on this date.</span>
      The boys took today off, every year. Check back tomorrow.</div>`;
    return;
  }
  body.innerHTML = `<ul class="ep-list">` + todays.map((e) => {
    const years = now.getFullYear() - Number(e.date.slice(0, 4));
    const done = e.shard !== undefined;
    return `<li class="ep-row${done ? "" : " is-pending"}">
      <span class="num">${e.ep}</span>
      <span class="t">${done ? `<a href="#ep/${e.ep}">${esc(e.title)}</a>` : esc(e.title)}</span>
      <span class="when">${years} year${years === 1 ? "" : "s"} ago today</span>
    </li>`;
  }).join("") + "</ul>";
}

/* ---------- routing ---------- */

function route() {
  const hash = location.hash || "#search";
  const [path, qs] = hash.slice(1).split("?");
  const params = new URLSearchParams(qs || "");
  const views = { search: "#view-search", episodes: "#view-episodes",
                  cast: "#view-cast", stats: "#view-stats",
                  day: "#view-day", ep: "#view-ep" };
  const epMatch = path.match(/^ep\/(\d+)$/);
  const castMatch = path.match(/^cast(?:\/(.+))?$/);
  const tab = epMatch ? "ep" : castMatch ? "cast" : (views[path] ? path : "search");
  for (const [k, sel] of Object.entries(views)) $(sel).hidden = k !== tab;
  document.querySelectorAll(".tabs a").forEach((a) => {
    const current = a.dataset.tab === (epMatch ? "episodes" : tab);
    if (current) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (epMatch) {
    const t = params.get("t");
    renderEpisodePage(Number(epMatch[1]), t !== null ? Number(t) : null);
  }
  if (castMatch) {
    const name = castMatch[1] ? decodeURIComponent(castMatch[1]) : null;
    name ? renderCastPage(name) : renderCastIndex();
  }
  if (tab === "episodes") renderEpisodes($("#ep-filter").value);
  if (tab === "stats") renderStats();
  if (tab === "day") renderDay();
  if (tab === "search" && qs) {
    const q = params.get("q");
    const spk = params.get("spk") || "";
    if (spk !== $("#spk").value) $("#spk").value = spk;
    if (q && q !== $("#q").value) { $("#q").value = q; onSearch(); }
    else if (q && !state.results.length) onSearch();
  }
  if (tab !== "ep") window.scrollTo(0, 0);
}

/* ---------- boot ---------- */

const TAGLINES = ["Chad shuts up", "the pineapple gets profiled", "Bryan does the voice",
  "they call the hotline", "Will loses it", "the robot shows up"];

/* the masthead blank rotates through REAL lines from the archive; each one is
   a link straight to its moment */
async function setTagline() {
  const el = $("#tagline-blank");
  try {
    const res = await fetch("data/taglines.json", { cache: "no-cache" });
    const lines = await res.json();
    const [ep, start, name, text] = lines[Math.floor(Math.random() * lines.length)];
    const short = name.split(" ")[0];
    el.innerHTML = `<a href="${momentHash(ep, start)}" title="Ep ${ep} — hear it">` +
      `${esc(short)} says &ldquo;${esc(text.replace(/[.?!]$/, ""))}&rdquo;</a>?`;
  } catch {
    el.textContent = TAGLINES[Math.floor(Math.random() * TAGLINES.length)] + "?";
  }
}

async function boot() {
  setTagline();
  $("#search-form").addEventListener("submit", onSearch);
  $("#spk").addEventListener("change", () => state.query && onSearch());
  $("#more-btn").addEventListener("click", () => renderResults(false));
  $("#player-close").addEventListener("click", closePlayer);
  // If a stream errors out, forget the src so the next click starts clean.
  $("#player-audio").addEventListener("error", (e) => {
    delete e.target.dataset.src;
  });
  $("#ep-filter").addEventListener("input", (e) => renderEpisodes(e.target.value));
  $("#random-btn").addEventListener("click", randomBit);
  $("#player-audio").addEventListener("timeupdate", onTimeUpdate);
  window.addEventListener("hashchange", route);
  try {
    await loadCatalog();
  } catch (err) {
    $("#counter").textContent = "⚠ " + err.message;
  }
  route();
  $("#q").focus();
}

boot();
