/* TMP Transcript Archive — static client-side search.
   Data: data/episodes.json (catalog) + data/shard-NN.json (segment text,
   lazy-loaded once on first search). No backend, no dependencies. */
"use strict";

const $ = (sel) => document.querySelector(sel);
const RESULTS_PAGE = 30;

/* recently-searched list is stored in Supabase (public anon key, RLS-limited
   to insert + select on the `searches` table — see supabase_setup.sql) */
const SUPABASE_URL = "https://ypqxmzyqzaaplitzmesg.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlwcXhtenlxemFhcGxpdHptZXNnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5ODQzNTIsImV4cCI6MjA5OTU2MDM1Mn0.RUpfATJKCwLwEwN8nw4EvGrDGsLnWR2Nihg0fcNaSHk";
const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
const momentHash = (ep, seconds, endSeconds) =>
  `#ep/${ep}?t=${Math.floor(seconds)}` + (endSeconds != null ? `&e=${Math.floor(endSeconds)}` : "");

function playMoment(ep, seconds, clipEndSeconds = null) {
  const m = state.byEp.get(ep);
  if (!m) return;
  state.playingEp = ep;
  state.playingStart = seconds;
  state.clipEnd = clipEndSeconds;
  const t = Math.max(0, Math.floor(seconds - 3));
  const bar = $("#player");
  const audio = $("#player-audio");
  bar.hidden = false;
  document.body.classList.add("has-player");
  $("#player-ep").textContent = `Ep ${ep}: ${m.title}`;
  $("#player-ep").href = `#ep/${ep}`;
  $("#player-at").textContent = clipEndSeconds != null
    ? `clip ${fmtTime(seconds)}–${fmtTime(clipEndSeconds)}` : `from ${fmtTime(seconds)}`;
  audio.playbackRate = state.playbackRate || 1;
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

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch { return false; }
  }
}

/* renders a shareable quote card (cornflower chrome, matching the site) to a
   PNG and triggers a download — no server round-trip needed */
function downloadQuoteImage({ text, name, ep, title }) {
  const W = 1000, H = 560;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#e9edf7";
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, 0, 120);
  grad.addColorStop(0, "#5c86c9");
  grad.addColorStop(1, "#3f66a8");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 96);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 30px Verdana, sans-serif";
  ctx.fillText("Ten Minute Podcast", 36, 60);
  ctx.fillStyle = "#1b2947";
  ctx.font = "bold 42px Georgia, serif";
  wrapText(ctx, `“${text}”`, 36, 190, W - 72, 54);
  ctx.font = "24px Verdana, sans-serif";
  ctx.fillStyle = "#3f4f78";
  ctx.fillText(`${name} · Ep ${ep}${title ? ` · ${title}` : ""}`, 36, H - 44);
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tmp-ep${ep}-quote.png`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";
  for (const word of words) {
    const test = line + word + " ";
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = word + " ";
      y += lineHeight;
    } else {
      line = test;
    }
  }
  ctx.fillText(line, x, y);
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
  const res = await fetch("data/episodes.json");
  if (!res.ok) throw new Error("episodes.json missing: run scripts/build_index.py");
  state.episodes = await res.json();
  for (const e of state.episodes) {
    state.byEp.set(e.ep, e);
    if (e.shard !== undefined) state.shardIds.add(e.shard);
  }
  const done = state.episodes.filter((e) => e.shard !== undefined).length;
  const counterText = `<svg class="icon" aria-hidden="true"><use href="#i-tape"/></svg>` +
    `${done} of ${state.episodes.length} episodes transcribed`;
  $("#counter").innerHTML = done < state.episodes.length
    ? `<a href="#episodes?pending=1" class="counter-link">${counterText} · see what's left</a>`
    : counterText;
  // only offer real names in the "said by" filter — "Speaker A" is a
  // different anonymous voice in every episode, so filtering by it
  // globally would be meaningless
  const speakers = new Set();
  for (const e of state.episodes)
    (e.speakers || []).filter(isNamedSpeaker).forEach((s) => speakers.add(s));
  const sel = $("#spk");
  [...speakers].sort().forEach((s) => {
    const o = document.createElement("option");
    o.value = s; o.textContent = s;
    sel.append(o);
  });
}

/* Loads every shard, but resolves the returned promise as soon as the FIRST
   shard lands (with the rest continuing in the background) — callers that
   want "search as soon as anything is ready" use loadFirstShard(); callers
   that need the full corpus (stats, catchphrase tally) use loadShards(). */
function fetchShard(id) {
  return fetch(`data/shard-${String(id).padStart(2, "0")}.json`)
    .then((res) => res.json())
    .then((sh) => {
      for (const rows of Object.values(sh.eps))
        for (const r of rows) r.push(r[2].toLowerCase());
      state.shards.set(id, sh);
      document.dispatchEvent(new CustomEvent("shard-loaded", { detail: { id, total: state.shardIds.size, loaded: state.shards.size } }));
      return sh;
    });
}

function loadShards() {
  if (state.loadingShards) return state.loadingShards;
  state.loadingShards = Promise.all([...state.shardIds].map(fetchShard));
  return state.loadingShards;
}

function loadFirstShard() {
  if (state.shards.size) return Promise.resolve();
  if (state.loadingShards) return state.loadingShards;
  const all = [...state.shardIds].map(fetchShard);
  state.loadingShards = Promise.all(all);
  return Promise.race(all);
}

/* ---------- search ---------- */

function* iterSegments() {
  for (const sh of state.shards.values())
    for (const [ep, rows] of Object.entries(sh.eps))
      for (let i = 0; i < rows.length; i++)
        yield { ep: +ep, rows, i, speakers: sh.speakers };
}

/* Whisper commonly mishears cast names — expand a query word to the
   spellings/soundalikes people might actually type or that the transcript
   might actually contain, in either direction. */
const NAME_VARIANTS = [
  ["bryan", "brian", "brain", "brine"],
  ["callen", "callan", "cullen"],
  ["delia", "d'elia", "deelia", "dilia"],
  ["chris", "cris", "kris"],
  ["sasso", "sassoe", "sasoe"],
  ["will", "wil"],
  ["wilbot", "will bot", "wille bot"],
];
const VARIANT_OF = new Map();
for (const group of NAME_VARIANTS)
  for (const w of group) VARIANT_OF.set(w, group);

function wordVariants(w) {
  return VARIANT_OF.get(w) || [w];
}

/* ---- typo tier: real edit-distance matching ----
   When the substring tiers find nothing, each query word is compared against
   the corpus's own vocabulary with Levenshtein edit distance, so "diapper"
   finds "diaper" and "pinapple" finds "pineapple". This catches both user
   typos and Whisper mistranscriptions. */

/* how many letter-errors we forgive, scaled by word length */
const typoTolerance = (w) => (w.length <= 4 ? 1 : w.length <= 8 ? 2 : 3);

/* banded Levenshtein with early exit once the distance can't come back
   under `max` — cheap enough to run against the whole vocabulary */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/* every distinct word in the loaded transcripts, with its frequency —
   built once and reused until more shards arrive */
let vocabCache = null;
function corpusVocab() {
  if (vocabCache && vocabCache.shardCount === state.shards.size) return vocabCache.words;
  const words = new Map();
  for (const sh of state.shards.values())
    for (const rows of Object.values(sh.eps))
      for (const r of rows)
        for (const w of r[3].split(/[^a-z0-9']+/))
          if (w.length > 2) words.set(w, (words.get(w) || 0) + 1);
  vocabCache = { shardCount: state.shards.size, words };
  return words;
}

/* nearest real corpus words for one (possibly misspelled) query word */
function closeSpellings(w) {
  const tol = typoTolerance(w);
  const found = [];
  for (const [cand, count] of corpusVocab()) {
    if (cand === w) continue;
    const d = editDistance(w, cand, tol);
    if (d <= tol) found.push({ cand, d, count });
  }
  found.sort((a, b) => a.d - b.d || b.count - a.count);
  return found.slice(0, 8).map((x) => x.cand);
}

/* query word -> [original + name-soundalikes + close spellings] */
let lastTypoVariants = new Map();
function expandQueryWords(words) {
  const map = new Map();
  for (const w of words) {
    const variants = new Set(wordVariants(w));
    if (w.length > 2) for (const v of closeSpellings(w)) variants.add(v);
    map.set(w, [...variants]);
  }
  return map;
}

/* does `haystack` contain any spelling variant of word `w`? */
function includesVariant(haystack, w) {
  for (const v of wordVariants(w)) if (haystack.includes(v)) return true;
  return false;
}

/* relevance score for a ranked (non-exact-positional) hit: reward lines where
   the query is a larger share of what was said, and named speakers (real
   cast/guests) over anonymous "Speaker A" fragments. */
function relevanceScore(text, name, wordCount) {
  const density = wordCount / Math.max(3, text.split(/\s+/).length);
  const namedBonus = isNamedSpeaker(name) ? 0.25 : 0;
  return density + namedBonus;
}

/* segment text plus a peek into the next segment, for phrases that were
   chopped across two transcript lines by the ASR's own segmentation
   ("shut up" / "Chad" landing as two separate rows). */
function spanText(seg) {
  const row = seg.rows[seg.i];
  const next = seg.rows[seg.i + 1];
  return next ? row[3] + " " + next[3] : row[3];
}

function runSearch(qRaw, who) {
  const q = qRaw.toLowerCase().trim();
  const words = q.split(/\s+/).filter((w) => w.length > 1);
  const hits = [];
  // pass 1: exact substring, including phrases split across two adjacent lines
  for (const seg of iterSegments()) {
    const row = seg.rows[seg.i];
    if (who && seg.speakers[row[1]] !== who) continue;
    if (row[3].includes(q)) { hits.push({ ...seg, exact: true, spans: false }); continue; }
    if (words.length > 1 && spanText(seg).includes(q)) hits.push({ ...seg, exact: true, spans: true });
  }
  if (hits.length) {
    for (const h of hits) {
      const name = h.speakers[h.rows[h.i][1]] || "Unknown";
      h.score = relevanceScore(h.spans ? spanText(h) : h.rows[h.i][3], name, words.length || 1);
    }
    hits.sort((a, b) => b.score - a.score);
    return { hits, mode: "exact" };
  }
  if (!words.length) return { hits, mode: "exact" };
  // pass 2: all words present in segment (looser, catches whisper mishears less),
  // with name/soundalike variants tried in both directions
  if (words.length >= 2) {
    for (const seg of iterSegments()) {
      const row = seg.rows[seg.i];
      if (who && seg.speakers[row[1]] !== who) continue;
      if (words.every((w) => includesVariant(row[3], w))) hits.push({ ...seg, exact: false, spans: false });
    }
    if (hits.length) {
      for (const h of hits) {
        const name = h.speakers[h.rows[h.i][1]] || "Unknown";
        h.score = relevanceScore(h.rows[h.i][3], name, words.length);
      }
      hits.sort((a, b) => b.score - a.score);
      return { hits, mode: "loose" };
    }
  }
  // pass 2.5: typo tier — every word must appear as itself OR a close spelling
  // (edit distance against the corpus vocabulary). Single-word queries land
  // here too, so a lone misspelled word no longer dead-ends.
  lastTypoVariants = expandQueryWords(words);
  let anyNewSpelling = false;
  lastTypoVariants.forEach((vs, w) => { if (vs.length > wordVariants(w).length) anyNewSpelling = true; });
  if (anyNewSpelling) {
    for (const seg of iterSegments()) {
      const row = seg.rows[seg.i];
      if (who && seg.speakers[row[1]] !== who) continue;
      if (words.every((w) => lastTypoVariants.get(w).some((v) => row[3].includes(v)))) {
        // lines that contain more of the words as actually typed should
        // outrank lines that only match via corrected spellings
        const asTyped = words.filter((w) => includesVariant(row[3], w)).length;
        hits.push({ ...seg, exact: false, spans: false, asTyped });
      }
    }
    if (hits.length) {
      for (const h of hits) {
        const name = h.speakers[h.rows[h.i][1]] || "Unknown";
        h.score = h.asTyped * 2 + relevanceScore(h.rows[h.i][3], name, words.length);
      }
      hits.sort((a, b) => b.score - a.score);
      return { hits, mode: "typo" };
    }
  }
  if (words.length < 2) return { hits, mode: "exact" };
  // pass 3: fuzzy — most (not all) query words present, so a wrong word
  // ("bag of snakes" vs "barrel of snakes") doesn't sink the whole search.
  // Ranked by how many words matched, then by relevance.
  const need = Math.max(1, Math.ceil(words.length / 2));
  for (const seg of iterSegments()) {
    const row = seg.rows[seg.i];
    if (who && seg.speakers[row[1]] !== who) continue;
    const matched = words.filter((w) => includesVariant(row[3], w)).length;
    if (matched >= need) {
      const name = seg.speakers[row[1]] || "Unknown";
      hits.push({ ...seg, exact: false, spans: false, matched, score: matched + relevanceScore(row[3], name, matched) * 0.1 });
    }
  }
  if (hits.length) {
    hits.sort((a, b) => b.score - a.score);
    return { hits, mode: "fuzzy" };
  }
  // pass 4: last resort — at least one word matches (incl. variants). Only
  // ever used to power "did you mean" suggestions on an otherwise-empty
  // result, never shown as the primary result set.
  for (const seg of iterSegments()) {
    const row = seg.rows[seg.i];
    if (who && seg.speakers[row[1]] !== who) continue;
    const matched = words.filter((w) => includesVariant(row[3], w)).length;
    if (matched >= 1) hits.push({ ...seg, exact: false, spans: false, matched, score: matched });
  }
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, 5), mode: "suggest" };
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
    const variants = mode === "typo" ? (lastTypoVariants.get(w) || wordVariants(w)) : wordVariants(w);
    for (const v of variants) {
      out = out.replace(new RegExp(`(${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"),
        "<mark>$1</mark>");
    }
  }
  return out;
}

function renderResults(fresh) {
  const list = $("#results");
  if (fresh) { list.innerHTML = ""; state.shown = 0; }
  const batch = state.results.slice(state.shown, state.shown + RESULTS_PAGE);
  state.shown += batch.length;
  for (const hit of batch) list.append(buildResultRow(hit));
  $("#search-more").hidden = state.shown >= state.results.length;
}

function buildResultRow(hit) {
  const row = hit.rows[hit.i];
  const [start, spkIdx, text] = row;
  const name = hit.speakers[spkIdx] || "Unknown";
  const meta = state.byEp.get(hit.ep);
  const displayText = hit.spans ? spanText(hit) : text;
  const li = document.createElement("li");
  li.className = "result";
  li.dataset.ep = hit.ep;
  li.dataset.start = start;
  li.innerHTML = `
    <button class="result-quote" aria-expanded="false" title="show surrounding lines">
      <span class="quote-speaker ${speakerClass(name)}">${esc(name)}:</span>
      <span class="quote-text">&ldquo;${highlight(displayText, state.query, hit.mode || state.searchMode)}&rdquo;${hit.spans ? ' <span class="spans-note">(continues into next line)</span>' : ""}</span>
    </button>
    <div class="result-meta">
      <a class="ep-link" href="#ep/${hit.ep}">Ep ${hit.ep}: ${esc(meta?.title || "")}</a>
      ${meta?.date ? `<span>${fmtDate(meta.date)}</span>` : ""}
      <span class="timestamp">${fmtTime(start)}</span>
      <a class="play-link" href="${playUrl(hit.ep, start)}" target="_blank" rel="noopener"><svg class="icon" aria-hidden="true"><use href="#i-play"/></svg> play this moment</a>
      <a class="moment-link" href="${momentHash(hit.ep, start)}" title="permalink to this moment. Copy the address to share it."><svg class="icon" aria-hidden="true"><use href="#i-link"/></svg> link</a>
      <button class="copy-quote-btn btn-plain" type="button" title="copy this quote as text"><svg class="icon" aria-hidden="true"><use href="#i-link"/></svg> copy quote</button>
      <button class="quote-img-btn btn-plain" type="button" title="save a shareable quote image">quote image</button>
    </div>`;
  li.querySelector(".result-quote").addEventListener("click", (ev) =>
    toggleContext(ev.currentTarget, li, hit));
  li.querySelector(".play-link").addEventListener("click", (ev) => {
    ev.preventDefault();
    playMoment(hit.ep, start);
  });
  li.querySelector(".copy-quote-btn").addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const btn = ev.currentTarget;
    const ok = await copyToClipboard(`"${displayText}" (${name}, Ep ${hit.ep}${meta?.title ? `: ${meta.title}` : ""}) ${location.origin}${location.pathname}${momentHash(hit.ep, start)}`);
    flashCopyButton(btn, ok, "copy quote");
  });
  li.querySelector(".quote-img-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    downloadQuoteImage({ text: displayText, name, ep: hit.ep, title: meta?.title || "" });
  });
  return li;
}

function flashCopyButton(btn, ok, restLabel) {
  if (!ok) return;
  const original = btn.textContent;
  btn.textContent = "copied!";
  btn.classList.add("copied");
  setTimeout(() => { btn.textContent = original || restLabel; btn.classList.remove("copied"); }, 1400);
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
    p.dataset.start = s;
    p.innerHTML = `<button class="ctx-play" type="button" title="play from here"><svg class="icon" aria-hidden="true"><use href="#i-play"/></svg></button>
      <span class="quote-speaker ${speakerClass(name)}">${esc(name)}:</span> ${esc(text)}`;
    p.querySelector(".ctx-play").addEventListener("click", () => playMoment(hit.ep, s));
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
    await loadFirstShard();
  }
  executeSearch();
  logSearch(q);
  $("#recent-searches").hidden = true;
  $("#try-box").hidden = true;
  clearInterval(recentSearchesTimer);
}

/* runs the current state.query against whatever shards are loaded so far and
   renders. Called both after the first shard lands, and again — silently —
   each time a later shard finishes, so results keep growing on slow
   connections without the user having to re-search. */
function executeSearch() {
  const q = state.query;
  const status = $("#search-status");
  const { hits, mode } = runSearch(q, $("#spk").value);
  const done = state.episodes.filter((e) => e.shard !== undefined).length;
  const loaded = state.shards.size, total = state.shardIds.size;
  const stillLoading = loaded < total
    ? ` <span class="loading-more">· still loading ${total - loaded} more shard${total - loaded === 1 ? "" : "s"}…</span>` : "";
  if (mode === "suggest" || !hits.length) {
    $("#results").innerHTML = "";
    $("#search-more").hidden = true;
    document.querySelectorAll(".did-you-mean").forEach((el) => el.remove());
    const suggestions = mode === "suggest" ? hits : [];
    status.innerHTML = `<div class="empty"><span class="big">No dice.</span>
      Searched ${done} transcribed episodes. Try fewer or different words.
      The robot transcriber occasionally mishears names.
      ${done < state.episodes.length ? `<br>(${state.episodes.length - done} episodes still await transcription. It might be in one of those.)` : ""}${stillLoading}</div>`;
    if (suggestions.length) {
      const box = document.createElement("div");
      box.className = "did-you-mean";
      box.innerHTML = `<p class="did-you-mean-label">Closest lines we could find:</p>`;
      const ul = document.createElement("ul");
      ul.className = "results";
      state.results = [];
      suggestions.forEach((hit) => ul.append(buildResultRow({ ...hit, mode: "loose" })));
      box.append(ul);
      $("#search-status").insertAdjacentElement("afterend", box);
    }
    return;
  }
  document.querySelectorAll(".did-you-mean").forEach((el) => el.remove());
  state.results = hits;
  state.searchMode = mode;
  status.innerHTML = `<strong>${hits.length}</strong> ${mode !== "exact" ? "close " : ""}hit${hits.length === 1 ? "" : "s"} across ${done} transcribed episodes` +
    (mode === "loose" ? " (no exact match: showing lines containing all your words, best matches first)"
      : mode === "typo" ? " (no exact match: showing lines with close spellings of your words, best matches first)"
      : mode === "fuzzy" ? " (fuzzy match: showing lines containing most of your words, best matches first)" : "") + stillLoading;
  renderResults(true);
}

let shardRefreshDebounce = null;
document.addEventListener("shard-loaded", () => {
  if (!state.query) return;
  clearTimeout(shardRefreshDebounce);
  shardRefreshDebounce = setTimeout(executeSearch, 150);
});

/* ---------- episodes view ---------- */

let episodesPendingOnly = false;
function renderEpisodes(filter = "", pendingOnly = false) {
  const f = filter.toLowerCase();
  const list = $("#ep-list");
  const banner = $("#ep-pending-banner");
  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const e of state.episodes) {
    const done = e.shard !== undefined;
    if (pendingOnly && done) continue;
    if (f && !(`${e.ep} ${e.title}`.toLowerCase().includes(f))) continue;
    const li = document.createElement("li");
    li.className = "ep-row" + (done ? "" : " is-pending");
    li.innerHTML = `
      <span class="num">${e.ep}</span>
      <span class="t">${done ? `<a href="#ep/${e.ep}">${esc(e.title)}</a>` : esc(e.title)}</span>
      ${e.date ? `<span class="when">${fmtDate(e.date)}</span>` : ""}
      ${done ? "" : `<span class="pending">not yet transcribed</span>`}`;
    frag.append(li);
  }
  list.append(frag);
  if (banner) {
    banner.hidden = !pendingOnly;
    if (pendingOnly) {
      const n = state.episodes.filter((e) => e.shard === undefined).length;
      banner.innerHTML = n
        ? `Showing ${n} untranscribed episode${n === 1 ? "" : "s"}. <a href="#episodes">show all episodes</a>`
        : `Everything's transcribed! <a href="#episodes">show all episodes</a>`;
    }
  }
  if (!list.children.length)
    list.innerHTML = `<div class="empty"><span class="big">${pendingOnly ? "Nothing pending. It's all transcribed." : "No episode matches."}</span></div>`;
}

/* ---------- episode page ---------- */

let epRenderToken = 0;
async function renderEpisodePage(ep, atSeconds = null, clipEndSeconds = null) {
  const root = $("#ep-page");
  const meta = state.byEp.get(ep);
  state.epPageLines = null;
  state.epPageEp = null;
  state.karaokeIdx = -1;
  if (!meta) { root.innerHTML = `<div class="empty"><span class="big">No episode ${ep}.</span></div>`; return; }
  const archiveLink = `https://archive.org/details/${meta.item}/${encodeURIComponent(meta.file)}`;
  let resumeAt = null;
  if (atSeconds === null) {
    try {
      const positions = JSON.parse(localStorage.getItem("tmp_positions") || "{}");
      if (positions[ep] > 5) resumeAt = positions[ep];
    } catch { /* ignore */ }
  }
  const head = `
    <a class="back-link" href="#episodes">&larr; all episodes</a>
    <div class="ep-head">
      <h2>Ep ${ep}: ${esc(meta.title)}</h2>
      <p class="ep-sub">${meta.date ? fmtDate(meta.date) + " · " : ""}${meta.duration ? Math.round(meta.duration / 60) + " min · " : ""}Ten Minute Podcast</p>
      ${meta.desc ? `<p class="ep-desc">${esc(meta.desc)}</p>` : ""}
    </div>
    <div class="listen-box">
      <a class="btn-primary" href="${archiveLink}" target="_blank" rel="noopener"><svg class="icon" aria-hidden="true"><use href="#i-play"/></svg> Listen on archive.org</a>
      <span>Audio lives on the Internet Archive. Tap any timestamp to play from that line, right here.</span>
    </div>
    ${resumeAt ? `<button id="resume-btn" class="btn-plain resume-btn" type="button">▶ Resume from ${fmtTime(resumeAt)}</button>` : ""}
    ${clipEndSeconds != null && atSeconds != null ? `<button id="play-clip-btn" class="btn-primary resume-btn" type="button">▶ Play this clip (${fmtTime(atSeconds)}–${fmtTime(clipEndSeconds)})</button>` : ""}`;
  if (meta.shard === undefined) {
    root.innerHTML = head + `<div class="empty"><span class="big">Not transcribed yet.</span>
      This one is still in the queue. The audio link above works right now.</div>`;
    return;
  }
  root.innerHTML = head + `<div class="skeleton"></div><div class="skeleton"></div>`;
  $("#resume-btn")?.addEventListener("click", () => playMoment(ep, resumeAt));
  $("#play-clip-btn")?.addEventListener("click", () => playMoment(ep, atSeconds, clipEndSeconds));
  await loadShards();
  const sh = state.shards.get(meta.shard);
  const rows = sh?.eps[String(ep)] || [];
  const legend = (meta.speakers || []).map((s) => isNamedSpeaker(s)
    ? `<a class="${speakerClass(s)}" href="#cast/${encodeURIComponent(s)}">● ${esc(s)}</a>`
    : `<span class="${speakerClass(s)}">● ${esc(s)}</span>`).join("");
  root.innerHTML = head + `<div class="speaker-legend">${legend}</div><div class="transcript" id="ep-transcript"></div>`;
  const container = $("#ep-transcript");
  const myToken = ++epRenderToken; // guard against a stale chunked render finishing after the user navigated away
  const lineEls = new Array(rows.length);

  // build in chunks off a single big innerHTML string so a long episode
  // doesn't block the main thread / jank mobile scrolling on first paint
  const CHUNK = 60;
  let idx = 0;
  function renderChunk() {
    if (myToken !== epRenderToken) return; // navigated away mid-render
    if (!document.body.contains(container)) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(rows.length, idx + CHUNK);
    for (; idx < end; idx++) {
      const [start, spkIdx, text] = rows[idx];
      const name = sh.speakers[spkIdx] || "Unknown";
      const div = document.createElement("div");
      div.className = "line";
      div.innerHTML = `<a class="ts" href="${momentHash(ep, start)}" data-start="${start}"
           title="play from ${fmtTime(start)}, or copy this link to share the moment">${fmtTime(start)}</a>
        <p><span class="quote-speaker ${speakerClass(name)}">${esc(name)}:</span>${esc(text)}</p>`;
      div.querySelector(".ts").addEventListener("click", (ev) => {
        ev.preventDefault();
        history.replaceState(null, "", momentHash(ep, start));
        playMoment(ep, start);
      });
      frag.appendChild(div);
      lineEls[idx] = div;
    }
    container.appendChild(frag);
    if (idx < rows.length) {
      // rAF pauses in hidden tabs, which would strand a permalink opened in
      // a background tab at the first chunk — fall back to a timer there
      if (document.hidden) setTimeout(renderChunk, 16);
      else requestAnimationFrame(renderChunk);
    } else {
      finishRender();
    }
  }
  function finishRender() {
    state.epPageLines = rows.map((r, i) => ({ start: r[0], el: lineEls[i] }));
    state.epPageEp = ep;
    if (atSeconds !== null) {
      // ?t= was floored to a whole second when the link was made, so aim for
      // the middle of that second and take whichever line starts closest
      const target = atSeconds + 0.5;
      let at = Math.max(0, lineIndexAt(state.epPageLines, target));
      const next = state.epPageLines[at + 1];
      if (next && Math.abs(next.start - target) < Math.abs(state.epPageLines[at].start - target)) at++;
      if (at >= 0 && lineEls[at]) {
        lineEls[at].classList.add("line-target");
        lineEls[at].scrollIntoView({ block: "center" });
      }
    }
  }
  renderChunk();
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

/* highlight the matching context line inside any expanded search-result
   context box for the episode currently playing, so following-along works
   from the search results view too, not just the full episode page */
function highlightPlayingContext() {
  const audio = $("#player-audio");
  const t = audio.currentTime;
  document.querySelectorAll(`.result[data-ep="${state.playingEp}"] .result-context`).forEach((box) => {
    let best = null, bestDelta = Infinity;
    box.querySelectorAll(".ctx-line[data-start]").forEach((el) => {
      const s = Number(el.dataset.start);
      const delta = t - s;
      if (delta >= -0.25 && delta < bestDelta) { bestDelta = delta; best = el; }
    });
    box.querySelectorAll(".ctx-line").forEach((el) => el.classList.toggle("now-playing", el === best));
  });
}

let lastPositionSave = 0;
function onPlayerTimeUpdate() {
  const audio = $("#player-audio");
  onTimeUpdate();
  highlightPlayingContext();
  if (state.clipEnd != null && audio.currentTime >= state.clipEnd) {
    audio.pause();
    audio.currentTime = state.clipEnd;
  }
  // remember playback position per episode so a visitor can resume later
  const now = Date.now();
  if (state.playingEp != null && now - lastPositionSave > 4000) {
    lastPositionSave = now;
    try {
      const positions = JSON.parse(localStorage.getItem("tmp_positions") || "{}");
      positions[state.playingEp] = audio.currentTime;
      localStorage.setItem("tmp_positions", JSON.stringify(positions));
    } catch { /* storage unavailable/full — resume just won't work this session */ }
  }
}

/* ---------- cast ---------- */

async function loadStats() {
  if (state.stats) return state.stats;
  const res = await fetch("data/stats.json");
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
    <p class="ep-sub">Plus ${fmtHours(unnamedSecs)} from voices the matcher couldn't name:
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
    ? `${fmtDate(first.date)} (Ep ${first.ep}) to ${fmtDate(last.date)} (Ep ${last.ep})`
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
       Longest lie: <a href="#ep/${longest.ep}">Ep ${longest.ep}: ${esc(longest.title)}</a>
       at <strong>${fmtTime(longest.duration)}</strong>. Shortest:
       <a href="#ep/${shortest.ep}">Ep ${shortest.ep}: ${esc(shortest.title)}</a> at ${fmtTime(shortest.duration)}.</p>
    <h3 class="stats-h">Catchphrase counter</h3>
    <p class="ep-sub">How often it got said across every transcript. Tap a phrase to see every hit.</p>
    <div id="phrase-body"><button id="phrase-btn" class="btn-plain"><svg class="icon" aria-hidden="true"><use href="#i-search"/></svg> tally the catchphrases
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
  const labelEl = $("#random-label");
  btn.disabled = true;
  const label = labelEl.textContent;
  labelEl.textContent = "rolling…";
  try {
    await loadShards();
    // pick from lines that are actually good demo material — a real (named)
    // speaker saying more than a few words, not a one-word fragment or an
    // unidentified "Speaker A" aside. Falls back to any line if that pool
    // is somehow empty.
    const good = [];
    for (const sh of state.shards.values())
      for (const [ep, rows] of Object.entries(sh.eps))
        for (let i = 0; i < rows.length; i++) {
          const [start, spkIdx, text] = rows[i];
          const name = sh.speakers[spkIdx] || "Unknown";
          if (isNamedSpeaker(name) && text.split(/\s+/).length >= 6) good.push({ ep: +ep, start });
        }
    let ep, start;
    if (good.length) {
      const pick = good[Math.floor(Math.random() * good.length)];
      ({ ep, start } = pick);
    } else {
      const all = [];
      for (const sh of state.shards.values())
        for (const epId of Object.keys(sh.eps)) all.push({ ep: +epId, n: sh.eps[epId].length, sh });
      const pick = all[Math.floor(Math.random() * all.length)];
      const i = Math.floor(Math.random() * pick.n);
      ep = pick.ep; start = pick.sh.eps[pick.ep][i][0];
    }
    location.hash = momentHash(ep, start);
    playMoment(ep, start);
  } finally {
    btn.disabled = false;
    labelEl.textContent = label;
  }
}

/* ---------- this day ---------- */

function renderDay() {
  const now = new Date();
  const mmdd = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const withDates = state.episodes.filter((e) => e.date);
  $("#day-title").textContent = `This day in TMP: ${now.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
  const body = $("#day-body");
  if (!withDates.length) {
    body.innerHTML = `<div class="empty"><span class="big">Air dates aren't loaded yet.</span>
      Once episode air dates are added to the archive, this tab shows every episode
      released on today's date: "10 years ago today" and all that.</div>`;
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

/* ---------- recently searched (global, cross-visitor) ---------- */

/* Racial/ethnic-slur filter for the public "recently searched" list only —
   search itself is never blocked, this just keeps slurs off the shared list.
   Checked both before logging (so they never reach the DB) and again on
   display (in case a row predates this filter or the client check is bypassed). */
const SLUR_PATTERNS = [
  /n[i1!|]+[gq]+[e3a@]*r+/i,
  /f[a4@]g+([o0]t+)?/i,
  /k[i1!|]+k+[e3]+/i,
  /sp[i1!|]+c+/i,
  /ch[i1!|]+n+k+/i,
  /g[o0]+[o0]+k+/i,
  /w[e3]+tb[a4@]+ck+/i,
  /r[e3]+t[a4@]+rd+/i,
  /tr[a4@]+nn+y+/i,
  /coon/i,
  /beaner/i,
  /jungle bunny/i,
  /towelhead/i,
  /sand ?nigg/i,
];

function containsSlur(text) {
  const normalized = text.replace(/[^a-z0-9]/gi, "");
  return SLUR_PATTERNS.some((re) => re.test(normalized) || re.test(text));
}

let recentSearchesTimer = null;
let lastLoggedSearch = null;
const RECENT_SEARCHES_LIMIT = 25;

async function logSearch(q) {
  if (!sb || q === lastLoggedSearch || containsSlur(q)) return;
  lastLoggedSearch = q;
  try {
    await sb.from("searches").insert({ q });
  } catch {
    // best-effort — a logging failure shouldn't affect search itself
  }
}

async function loadRecentSearches() {
  const box = $("#recent-searches");
  const list = $("#recent-searches-list");
  if (!sb) { box.hidden = true; return; }
  try {
    const { data, error } = await sb
      .from("searches")
      .select("q")
      .order("created_at", { ascending: false })
      .limit(RECENT_SEARCHES_LIMIT);
    if (error) throw error;
    const clean = data.filter((e) => !containsSlur(e.q));
    // dedupe repeat queries so a popular search doesn't spam the list, and
    // drop half-typed prefixes of a query that appears in fuller form
    // ("and they will sa" when "and they will say no" is also on the list —
    // rows logged per-keystroke before the settle delay existed)
    const seen = new Set();
    const keys = clean.map((e) => e.q.toLowerCase().trim());
    const deduped = clean.filter((e, i) => {
      const k = keys[i];
      if (seen.has(k)) return false;
      if (keys.some((other, j) => j !== i && other.length > k.length && other.startsWith(k))) return false;
      seen.add(k);
      return true;
    });
    if (!deduped.length) { box.hidden = true; return; }
    list.innerHTML = deduped.map((e) =>
      `<li><a href="#search?q=${encodeURIComponent(e.q)}">${esc(e.q)}</a></li>`).join("");
    box.hidden = false;
  } catch {
    box.hidden = true;
  }
}

function startRecentSearchesPolling() {
  loadRecentSearches();
  clearInterval(recentSearchesTimer);
  // don't poll a hidden tab — saves the request and avoids a layout jump
  // the visitor never sees
  if (document.hidden) return;
  recentSearchesTimer = setInterval(loadRecentSearches, 30000);
}

document.addEventListener("visibilitychange", () => {
  const onSearchTab = !$("#view-search").hidden && !location.hash.includes("?");
  if (document.hidden) {
    clearInterval(recentSearchesTimer);
  } else if (onSearchTab) {
    startRecentSearchesPolling();
  }
});

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
    const e = params.get("e");
    renderEpisodePage(Number(epMatch[1]), t !== null ? Number(t) : null, e !== null ? Number(e) : null);
  }
  if (castMatch) {
    const name = castMatch[1] ? decodeURIComponent(castMatch[1]) : null;
    name ? renderCastPage(name) : renderCastIndex();
  }
  if (tab === "episodes") {
    episodesPendingOnly = params.get("pending") === "1";
    renderEpisodes($("#ep-filter").value, episodesPendingOnly);
  }
  if (tab === "stats") renderStats();
  if (tab === "day") renderDay();
  if (tab === "search" && qs) {
    const q = params.get("q");
    const spk = params.get("spk") || "";
    if (spk !== $("#spk").value) $("#spk").value = spk;
    if (q && q !== $("#q").value) { $("#q").value = q; onSearch(); }
    else if (q && !state.results.length) onSearch();
  }
  if (tab === "search" && !qs) {
    $("#try-box").hidden = false;
    startRecentSearchesPolling();
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
    const res = await fetch("data/taglines.json");
    const lines = await res.json();
    const [ep, start, name, text] = lines[Math.floor(Math.random() * lines.length)];
    const short = name.split(" ")[0];
    el.innerHTML = `<a href="${momentHash(ep, start)}" title="Ep ${ep}: hear it">` +
      `${esc(short)} says &ldquo;${esc(text.replace(/[.?!]$/, ""))}&rdquo;</a>?`;
  } catch {
    el.textContent = TAGLINES[Math.floor(Math.random() * TAGLINES.length)] + "?";
  }
}

async function boot() {
  setTagline();
  $("#try-list").innerHTML = CATCHPHRASES.map((p) =>
    `<li><a href="#search?q=${encodeURIComponent(p)}">&ldquo;${esc(p)}&rdquo;</a></li>`).join("");
  $("#search-form").addEventListener("submit", onSearch);
  // belt-and-suspenders: some embedded browsers don't fire implicit form
  // submission for Enter in a search field
  $("#q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); onSearch(); }
  });
  $("#spk").addEventListener("change", () => state.query && onSearch());
  // once the corpus is in memory (after the first search), typing searches
  // live — no need to hit enter again
  let liveSearchDebounce = null;
  $("#q").addEventListener("input", (e) => {
    if (!state.shards.size) return; // first search still needs the explicit submit to kick off loading
    const q = e.target.value.trim();
    clearTimeout(liveSearchDebounce);
    liveSearchDebounce = setTimeout(() => {
      if (q.length < 2) return;
      state.query = q;
      // replaceState, not location.hash= — a hash assignment pushes a new
      // history entry per keystroke, which would wreck the back button
      history.replaceState(null, "", `#search?q=${encodeURIComponent(q)}` +
        ($("#spk").value ? `&spk=${encodeURIComponent($("#spk").value)}` : ""));
      executeSearch();
      $("#recent-searches").hidden = true;
      $("#try-box").hidden = true;
      clearInterval(recentSearchesTimer);
    }, 200);
  });
  // The shared "recently searched" list should get finished thoughts, not a
  // prefix caught mid-word — a fixed typing-pause timer logged a half-typed
  // query whenever someone paused to think, so log only once they're
  // actually done: field loses focus, tab goes hidden, or the page unloads.
  const logCurrentQuery = () => {
    const q = $("#q").value.trim();
    if (q.length >= 2) logSearch(q);
  };
  $("#q").addEventListener("blur", logCurrentQuery);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) logCurrentQuery();
  });
  window.addEventListener("pagehide", logCurrentQuery);
  $("#more-btn").addEventListener("click", () => renderResults(false));
  $("#player-close").addEventListener("click", closePlayer);
  // If a stream errors out, forget the src so the next click starts clean.
  $("#player-audio").addEventListener("error", (e) => {
    delete e.target.dataset.src;
  });
  $("#ep-filter").addEventListener("input", (e) => renderEpisodes(e.target.value, episodesPendingOnly));
  $("#random-btn").addEventListener("click", randomBit);
  $("#player-audio").addEventListener("timeupdate", onPlayerTimeUpdate);
  $("#player-back").addEventListener("click", () => {
    $("#player-audio").currentTime = Math.max(0, $("#player-audio").currentTime - 15);
  });
  $("#player-fwd").addEventListener("click", () => {
    $("#player-audio").currentTime += 15;
  });
  $("#player-speed").addEventListener("change", (e) => {
    const rate = Number(e.target.value);
    state.playbackRate = rate;
    $("#player-audio").playbackRate = rate;
    try { localStorage.setItem("tmp_playback_rate", String(rate)); } catch { /* ignore */ }
  });
  $("#player-clip-btn").addEventListener("click", async () => {
    const audio = $("#player-audio");
    if (state.playingEp == null || state.playingStart == null) return;
    const end = audio.currentTime;
    if (end <= state.playingStart + 1) return;
    state.clipEnd = end;
    const link = `${location.origin}${location.pathname}${momentHash(state.playingEp, state.playingStart, end)}`;
    history.replaceState(null, "", momentHash(state.playingEp, state.playingStart, end));
    const ok = await copyToClipboard(link);
    flashCopyButton($("#player-clip-btn"), ok, "clip this");
  });
  try {
    const savedRate = Number(localStorage.getItem("tmp_playback_rate"));
    if (savedRate) { state.playbackRate = savedRate; $("#player-speed").value = String(savedRate); }
  } catch { /* ignore */ }
  window.addEventListener("hashchange", route);
  try {
    await loadCatalog();
  } catch (err) {
    $("#counter").textContent = "Error: " + err.message;
  }
  route();
  $("#q").focus();
}

boot();
