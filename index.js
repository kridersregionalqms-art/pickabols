(function () {
"use strict";

// Proteksyon laban sa clickjacking: huwag payagang i-embed ang page sa ibang site.
if (window.top !== window.self) {
  try { window.top.location.href = window.self.location.href; } catch (e) { document.documentElement.innerHTML = ""; }
}

var API = "https://pickabols-api.pickabolers.workers.dev";
var $app = document.getElementById("app");
var sid = null, key = null, data = null, version = 0, isOrg = false;
var pollTimer = null, loadError = null, lastSync = "", statusText = "";
var saving = false, dirty = false;
var lastScore = null, flash = null;
var uiTick = null, warmupInputOpen = false;
var holdUntil = 0, holdTimer = null, cachedMode = false;
var pickPid = null; // ang player na na-tap at hinihintay ang source (hindi ito sine-save)
var homeView = "new"; // anong card ang ipapakita sa home: "new", "join" o "mine" (whitelist, tingnan ang __pbHome)
var cuAsk = null, cuInfo = null; // modal ng catch-up setting: {kind:"add",names:[...]} o {kind:"back",id}; at kung aling ⓘ ang bukas (hindi ito sine-save)
// ====== LISTAHAN NG SOURCE NG SCORE ======
// Para magdagdag: isang linya lang ["key", "Label"]. Ang key ay a-z at _ lang, hanggang 16 na letra.
var SOURCES = [
  ["smash", "Smash"],
  ["dink", "Dink"],
  ["drive", "Drive"],
  ["serve", "Serve (Ace)"],
  ["volley", "Volley"],
  ["drop", "Drop shot"],
  ["lob", "Lob"]
];
// Whitelist: ibinabalik lang ang key kung nasa SOURCES, kung hindi ay null.
function srcKey(k) {
  if (typeof k !== "string") return null;
  for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i][0] === k) return k;
  return null;
}

/* ---------- helpers ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function num(x) { x = Number(x); return isFinite(x) ? x : 0; }
// Ilan ang ipapakita sa Top/Best. Whitelist: 3, 5 o 10 lang, kung hindi ay 5.
function cleanTopN(n) { n = Number(n); return n === 3 || n === 5 || n === 10 ? n : 5; }
function uid() { return Math.random().toString(36).slice(2, 8); }
function $(id) { return document.getElementById(id); }
function pairKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }
function loadKeys() { try { return JSON.parse(localStorage.getItem("pb_keys") || "{}"); } catch (e) { return {}; } }
function saveKey(id, k, name) {
  try {
    var m = loadKeys();
    m[id] = { key: k, name: name || (m[id] && m[id].name) || "" };
    localStorage.setItem("pb_keys", JSON.stringify(m));
  } catch (e) {}
}
function pname(id) {
  var p = data.players.filter(function (x) { return x.id === id; })[0];
  return p ? p.name : "?";
}
function teamNames(ids) { return ids.map(pname).join(" & "); }
// Tinitiyak na tama ang hugis ng data na galing sa server bago i-render.
function okData(d) {
  return !!d && typeof d === "object" && Array.isArray(d.players) && Array.isArray(d.history) &&
    (d.mode === "doubles" || d.mode === "singles");
}
// Huling kopya ng session sa tab na ito, para magamit pa rin ang app kapag sobra na sa reload limit.
function cacheSave() {
  try { if (sid && data) sessionStorage.setItem("pb_cache_" + sid, JSON.stringify({ v: version, d: data })); } catch (e) {}
}
function cacheLoad() {
  try {
    var c = JSON.parse(sessionStorage.getItem("pb_cache_" + sid) || "null");
    return c && okData(c.d) ? c : null;
  } catch (e) { return null; }
}

/* ---------- game logic ---------- */
function makeData(name, mode, target, names) {
  var d = {
    v: 1, name: name, mode: mode, target: target, round: 0,
    players: [], partners: {}, opps: {}, history: [], current: null, next: null, pending: null
  };
  names.forEach(function (n) {
    d.players.push({ id: uid(), name: n, games: 0, last: 0, active: true });
  });
  genNext(d);
  return d;
}
function need(d) { return d.mode === "doubles" ? 4 : 2; }
function activePlayers(d) { return d.players.filter(function (p) { return p.active; }); }
// Hindi kasama sa "lowest" ang mga catch-up player (kung hindi, 0 ang lowest at 0 din ang susunod na bagong player).
function minGames(d) {
  var all = activePlayers(d);
  var a = all.filter(function (p) { return p.cu !== true; });
  if (!a.length) a = all;
  return a.length ? Math.min.apply(null, a.map(function (p) { return num(p.games); })) : 0;
}
// Per-player catch-up. Style "a": alternate lang (laktaw ng 1 game). Style "b": kung 3+ games ang layo niya, tuloy-tuloy; kung 1-2 na lang, alternate.
function cuReady(d, p, round) {
  if (p.cm === "b" && minGames(d) - num(p.games) >= 3) return true;
  return !p.last || round - num(p.last) >= 2;
}
// Kapag naabot na ng catch-up player ang lowest, tatanggalin ang flag at balik siya sa normal na rotation.
function clearCaught(d) {
  var mg = minGames(d);
  activePlayers(d).forEach(function (p) { if (p.cu === true && num(p.games) >= mg) p.cu = false; });
}
function validNext(d) {
  var n = d.next;
  if (!n) return false;
  var ids = [].concat(n.teamA, n.teamB);
  if (ids.length !== need(d)) return false;
  var seen = {};
  for (var i = 0; i < ids.length; i++) {
    if (seen[ids[i]]) return false;
    seen[ids[i]] = 1;
    var p = d.players.filter(function (x) { return x.id === ids[i]; })[0];
    if (!p || !p.active) return false;
  }
  return true;
}
function ensureNext(d) { if (!validNext(d)) genNext(d); }

// Pinipili ang pinakakaunti ang laro, tapos ang pinakamatagal nang naghihintay.
// Random ang tie-break at ang hatian ng teams (iniiwasan ang paulit-ulit na partner/kalaban).
function genNext(d) {
  d.partners = d.partners || {};
  d.opps = d.opps || {};
  var k = need(d);
  var act = activePlayers(d);
  if (act.length < k) { d.next = null; return; }
  var useCu = true; // per-player na ang catch-up: kung walang catch-up na player, normal na rotation ang lalabas
  var rnd = num(d.round) + 1; // round ng larong ito
  if (useCu) clearCaught(d);
  var pool = act.map(function (p) { return { p: p, r: Math.random() }; })
    .sort(function (x, y) {
      return num(x.p.games) - num(y.p.games) || num(x.p.last) - num(y.p.last) || x.r - y.r;
    }).map(function (x) { return x.p; });
  var c, A, B;
  if (useCu) {
    // Unahin ang mga catch-up na handa na (hanggang kalahati ng slots), ang iba ay galing sa normal na rotation.
    var cuAll = pool.filter(function (p) { return p.cu === true; });
    var regs = pool.filter(function (p) { return p.cu !== true; });
    var ready = cuAll.filter(function (p) { return cuReady(d, p, rnd); });
    var pick = ready.slice(0, Math.floor(k / 2));
    c = pick.concat(regs.slice(0, k - pick.length));
    // Kung kulang ang regular, dagdagan ng ibang catch-up para laging may mabuong game.
    cuAll.forEach(function (p) { if (c.length < k && c.indexOf(p) < 0) c.push(p); });
  } else {
    c = pool.slice(0, k);
  }
  if (k === 2) {
    A = [c[0].id]; B = [c[1].id];
  } else {
    var opts = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
    var best = null, bestCost = Infinity;
    opts.forEach(function (o) {
      var t1 = [c[o[0][0]].id, c[o[0][1]].id], t2 = [c[o[1][0]].id, c[o[1][1]].id];
      var cost = (num(d.partners[pairKey(t1[0], t1[1])]) + num(d.partners[pairKey(t2[0], t2[1])])) * 10;
      t1.forEach(function (x) { t2.forEach(function (y) { cost += num(d.opps[pairKey(x, y)]); }); });
      cost += Math.random() * 0.5;
      if (cost < bestCost) { bestCost = cost; best = [t1, t2]; }
    });
    A = best[0]; B = best[1];
  }
  d.next = { teamA: A, teamB: B, round: num(d.round) + 1 };
}
function startNext(d, forced) {
  if (d.current) return;
  ensureNext(d);
  var n = d.next;
  if (!n) return;
  d.round = n.round;
  var first = (forced === "A" || forced === "B") ? forced : (Math.random() < 0.5 ? "A" : "B");
  d.current = {
    round: n.round, teamA: n.teamA, teamB: n.teamB, scoreA: 0, scoreB: 0,
    server: first,
    serverNum: d.mode === "doubles" ? 2 : 1,
    posA: n.teamA.slice(), posB: n.teamB.slice(),
    serverId: (first === "A" ? n.teamA : n.teamB)[0],
    target: d.target, done: false, stack: [],
    track: !!d.analytics, pts: {}, rw: {}
  };
  [].concat(n.teamA, n.teamB).forEach(function (id) {
    d.players.forEach(function (p) { if (p.id === id) { p.games = num(p.games) + 1; p.last = n.round; } });
  });
  if (d.mode === "doubles") {
    [n.teamA, n.teamB].forEach(function (t) {
      var pk = pairKey(t[0], t[1]);
      d.partners[pk] = num(d.partners[pk]) + 1;
    });
  }
  n.teamA.forEach(function (x) {
    n.teamB.forEach(function (y) {
      var ok = pairKey(x, y);
      d.opps[ok] = num(d.opps[ok]) + 1;
    });
  });
  d.next = null;
  genNext(d);
}
// Bago talaga simulan ang laro: pipili muna ang organizer sa pagitan ng "warm up" o diretsong "play for serve".
function startSetup(d) {
  if (d.current || d.pending) return;
  ensureNext(d);
  var n = d.next;
  if (!n) return;
  d.pending = { teamA: n.teamA, teamB: n.teamB, round: n.round, phase: "choose", minutes: 0, endsAt: 0, winner: null };
}
function setWarmup(d, minutes) {
  if (!d.pending) return;
  minutes = Math.max(1, Math.min(60, num(minutes) || 5));
  d.pending.minutes = minutes;
  d.pending.endsAt = Date.now() + minutes * 60000;
  d.pending.phase = "warmup";
}
function resolveServeRally(d, winner) {
  if (!d.pending) return;
  d.pending.winner = winner;
  d.pending.phase = "ready";
}
function beginGame(d) {
  if (!d.pending || d.pending.phase !== "ready") return;
  var forced = d.pending.winner;
  d.pending = null;
  startNext(d, forced);
}
function cancelSetup(d) {
  d.pending = null;
}
// Rebuild: isang click, nagbabago ang teammates. Ang unang player ng Team A ay nananatili at umiikot ang kasama niya.
// Halimbawa: P1 & P2 vs P3 & P4 -> P1 & P4 vs P2 & P3 -> P1 & P3 vs P4 & P2 -> balik sa simula.
function rebuildTeams(d) {
  if (!d.next || d.mode !== "doubles") return;
  var A = d.next.teamA, B = d.next.teamB;
  if (A.length !== 2 || B.length !== 2) return;
  d.next.teamA = [A[0], B[1]];
  d.next.teamB = [A[1], B[0]];
}
// Swap: magpapalit ng left at right ang dalawang player ng isang team sa susunod na laro (bago mag-start).
// Ang unang pangalan ay Right, ang pangalawa ay Left.
function swapTeamSides(d, team) {
  if (!d.next || d.mode !== "doubles") return;
  var key = team === "A" ? "teamA" : "teamB";
  var t = d.next[key];
  if (t.length === 2) d.next[key] = [t[1], t[0]];
}
// Court positions: pos arrays are [rightPlayerId, leftPlayerId] from each team's own view.
function ensurePos(c) {
  if (!c.posA) c.posA = c.teamA.slice();
  if (!c.posB) c.posB = c.teamB.slice();
  if (!c.serverId) c.serverId = (c.server === "A" ? c.posA : c.posB)[0];
}
function swapSides(c, team) {
  var key = team === "A" ? "posA" : "posB";
  if (c[key] && c[key].length === 2) c[key] = [c[key][1], c[key][0]];
}
function partnerOf(c, id) {
  var arr = c.posA.indexOf(id) >= 0 ? c.posA : c.posB;
  return arr[0] === id ? arr[1] : arr[0];
}
function checkDone(c) {
  var a = num(c.scoreA), b = num(c.scoreB);
  c.done = Math.max(a, b) >= num(c.target) && Math.abs(a - b) >= 2;
}
// Ang nagse-serve lang ang nakaka-score. Kapag natalo ang server: doubles server 1 -> server 2;
// server 2 (o singles) -> side out, ang kabilang team ang magse-serve.
function rally(d, winner, pid, src) {
  var c = d.current;
  if (!c || c.done) return;
  c.stack = c.stack || [];
  ensurePos(c);
  var scored = winner === c.server;
  c.stack.push([c.scoreA, c.scoreB, c.server, c.serverNum, c.posA.slice(), c.posB.slice(), c.serverId, pid || null, (pid && scored) ? 1 : 0, (pid && srcKey(src)) || null]);
  if (c.stack.length > 40) c.stack.shift();
  if (winner === c.server) {
    if (winner === "A") c.scoreA = num(c.scoreA) + 1; else c.scoreB = num(c.scoreB) + 1;
    // the serving team's two players switch sides after every point
    if (d.mode === "doubles") swapSides(c, winner);
  } else if (d.mode === "doubles" && num(c.serverNum) === 1) {
    c.serverNum = 2;
    // the partner serves from where he/she is standing
    c.serverId = partnerOf(c, c.serverId);
  } else {
    c.server = c.server === "A" ? "B" : "A";
    c.serverNum = 1;
    // side-out: the new serving team's right-side player serves first
    c.serverId = (c.server === "A" ? c.posA : c.posB)[0];
  }
  // Analytics mode: itala ang rally na napanalunan ng player, at ang puntos kung ang serving team ang nanalo.
  if (pid && c.track) {
    c.rw = c.rw || {};
    c.rw[pid] = num(c.rw[pid]) + 1;
    if (scored) { c.pts = c.pts || {}; c.pts[pid] = num(c.pts[pid]) + 1; }
    var sk = srcKey(src);
    if (sk) {
      c.sc = c.sc || {};
      c.sc[pid] = c.sc[pid] || {};
      c.sc[pid][sk] = num(c.sc[pid][sk]) + 1;
    }
  }
  checkDone(c);
}
// Analytics mode: ang player na na-tap ang nanalo ng rally. Ang team niya ang basehan ng score, tulad ng dati.
function rallyBy(d, pid, src) {
  var c = d.current;
  if (!c || c.done || !c.track || typeof pid !== "string") return;
  var winner = c.teamA.indexOf(pid) >= 0 ? "A" : c.teamB.indexOf(pid) >= 0 ? "B" : null;
  if (!winner) return;
  rally(d, winner, pid, srcKey(src) || "other");
}
function undo(d) {
  var c = d.current;
  if (!c || !c.stack || !c.stack.length) return;
  var s = c.stack.pop();
  c.scoreA = s[0]; c.scoreB = s[1]; c.server = s[2]; c.serverNum = s[3];
  if (s[4]) { c.posA = s[4]; c.posB = s[5]; c.serverId = s[6]; }
  // Bawiin din ang rally at puntos ng player na na-tap (analytics mode).
  if (s[7] && c.rw) {
    c.rw[s[7]] = Math.max(0, num(c.rw[s[7]]) - 1);
    if (s[8] && c.pts) c.pts[s[7]] = Math.max(0, num(c.pts[s[7]]) - 1);
    if (s[9] && c.sc && c.sc[s[7]]) c.sc[s[7]][s[9]] = Math.max(0, num(c.sc[s[7]][s[9]]) - 1);
  }
  checkDone(c);
}
function finish(d) {
  var c = d.current;
  if (!c || !c.done) return;
  // Analytics mode: isama ang rally at puntos ng bawat player sa natapos na laro: [pangalan, puntos, rally].
  var ps = [], sc = [];
  if (c.track) {
    [].concat(c.teamA, c.teamB).forEach(function (id) {
      ps.push([pname(id), num((c.pts || {})[id]), num((c.rw || {})[id])]);
      SOURCES.forEach(function (s) {
        var n = num((((c.sc || {})[id]) || {})[s[0]]);
        if (n > 0) sc.push([pname(id), s[0], n]);
      });
    });
  }
  d.history.push({
    round: c.round, a: c.teamA.map(function (i) { return pname(i); }),
    b: c.teamB.map(function (i) { return pname(i); }),
    sa: num(c.scoreA), sb: num(c.scoreB), t: num(c.target),
    tr: c.track ? 1 : 0, ps: ps, sc: sc
  });
  d.current = null;
  ensureNext(d);
}
// cm = setting ng bagong player: "l" (lowest games), "a" (Style A) o "b" (Style B). Whitelist lang.
function addPlayers(d, names, cm) {
  cm = cm === "a" || cm === "b" ? cm : "l";
  var have = {};
  d.players.forEach(function (p) { have[p.name.toLowerCase()] = 1; });
  var mg = minGames(d);
  names.forEach(function (n) {
    if (!have[n.toLowerCase()]) {
      have[n.toLowerCase()] = 1;
      // Style A/B: totoong 0 ang games at hahabulin ng system. "l" (o wala pang laro): lowest games ang record.
      var cu = cm !== "l" && mg > 0;
      var np = { id: uid(), name: n, games: cu ? 0 : mg, last: cu ? 0 : num(d.round), active: true, cu: cu };
      if (mg > 0) np.cm = cm; // para sa listahan sa Settings
      d.players.push(np);
    }
  });
  ensureNext(d);
}
// cm = setting kapag bumalik galing rest: "l" (lowest games), "a" o "b". Whitelist lang.
function toggleRest(d, id, cm) {
  cm = cm === "a" || cm === "b" ? cm : "l";
  var mg = minGames(d); // lowest ng mga aktibo bago magbago ang status
  d.players.forEach(function (p) {
    if (p.id !== id) return;
    p.active = !p.active;
    if (!p.active) return;
    var behind = num(p.games) < mg;
    if (behind) p.cm = cm; // para sa listahan sa Settings
    if (behind && cm !== "l") {
      p.cu = true; // itatago ang totoong games niya, hahabulin ng system
    } else {
      p.cu = false;
      p.games = Math.max(num(p.games), mg);
    }
  });
  ensureNext(d);
}
function inCurrent(d, id) {
  return !!d.current && d.current.teamA.concat(d.current.teamB).indexOf(id) >= 0;
}
function removePlayer(d, id) {
  if (inCurrent(d, id)) return false;
  d.players = d.players.filter(function (p) { return p.id !== id; });
  ensureNext(d);
  return true;
}
function parseNames(text) {
  var seen = {}, out = [];
  String(text).split(/[\n,]+/).forEach(function (s) {
    s = s.replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 40);
    if (s && !seen[s.toLowerCase()]) { seen[s.toLowerCase()] = 1; out.push(s); }
  });
  return out.slice(0, 60);
}

/* ---------- top stats (analytics) ---------- */
// Kinukuwenta lang mula sa mga natapos na laro na nai-score habang ON ang Analytics. Ito lang ang ibinibigay sa navigation.
function topStats(d) {
  if (!d || !d.analytics) return null;
  var P = Object.create(null), T = Object.create(null), games = 0;
  function getP(n) { return P[n] || (P[n] = { name: n, pts: 0, rw: 0, w: 0, l: 0, diff: 0 }); }
  function byName(a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; }
  (d.history || []).forEach(function (m) {
    if (num(m.tr) !== 1) return;
    games++;
    var sa = num(m.sa), sb = num(m.sb);
    (Array.isArray(m.ps) ? m.ps : []).forEach(function (r) {
      var p = getP(String(r[0]));
      p.pts += num(r[1]);
      p.rw += num(r[2]);
    });
    [[m.a, sa, sb], [m.b, sb, sa]].forEach(function (t) {
      var names = Array.isArray(t[0]) ? t[0] : [], f = t[1], ag = t[2];
      names.forEach(function (n) {
        var p = getP(String(n));
        if (f > ag) p.w++; else p.l++;
        p.diff += f - ag;
      });
      if (d.mode === "doubles" && names.length === 2) {
        var a1 = String(names[0]), a2 = String(names[1]);
        var k = a1 < a2 ? a1 + " & " + a2 : a2 + " & " + a1;
        var tm = T[k] || (T[k] = { name: k, w: 0, l: 0, diff: 0 });
        if (f > ag) tm.w++; else tm.l++;
        tm.diff += f - ag;
      }
    });
  });
  var pl = Object.keys(P).map(function (k) { return P[k]; });
  var lim = cleanTopN(d.topN);
  function rank(a, b) { return b.w - a.w || b.diff - a.diff || byName(a, b); }
  return {
    games: games,
    doubles: d.mode === "doubles",
    scorers: pl.filter(function (p) { return p.pts > 0; })
      .sort(function (a, b) { return b.pts - a.pts || b.rw - a.rw || byName(a, b); }).slice(0, lim),
    rallies: pl.filter(function (p) { return p.rw > 0; })
      .sort(function (a, b) { return b.rw - a.rw || b.pts - a.pts || byName(a, b); }).slice(0, lim),
    wins: pl.filter(function (p) { return p.w + p.l > 0; }).sort(rank).slice(0, lim),
    teams: Object.keys(T).map(function (k) { return T[k]; }).sort(rank).slice(0, lim)
  };
}

/* ---------- network ---------- */
function setStatus(t) {
  statusText = t;
  var el = $("status");
  if (el) el.textContent = t;
}
async function persist() {
  if (!isOrg || !data) return;
  if (saving) { dirty = true; return; }
  saving = true;
  document.body.classList.add("saving");
  setStatus("Saving...");
  try {
    do {
      dirty = false;
      var ctl = new AbortController();
      var tmo = setTimeout(function () { ctl.abort(); }, 15000);
      var r;
      try {
        r = await fetch(API + "/api/sessions/" + sid, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-Organizer-Key": key },
          body: JSON.stringify({ data: data }),
          signal: ctl.signal
        });
      } finally {
        clearTimeout(tmo);
      }
      if (r.status === 403) throw new Error("403");
      if (!r.ok) throw new Error(String(r.status));
      var j = await r.json();
      version = j.version;
      cacheSave();
    } while (dirty);
    setStatus("✓ Saved");
  } catch (e) {
    setStatus(e.message === "403"
      ? "⚠ Wrong organizer key, cannot save"
      : "⚠ Not saved. Click here to retry");
  } finally {
    saving = false;
    document.body.classList.remove("saving");
  }
}
function mutate(fn) {
  if (!isOrg || !data) return;
  fn(data);
  cacheSave();
  render();
  persist();
}
async function loadSession() {
  loadError = null;
  data = null;
  render();
  try {
    var r = await fetch(API + "/api/sessions/" + sid, { cache: "no-store" });
    if (r.status === 404) { loadError = "This session was not found. Please check that the link or code is correct."; render(); return; }
    if (!r.ok) throw new Error(String(r.status));
    var j = await r.json();
    if (!okData(j.data)) throw new Error("bad data");
    data = j.data;
    version = j.version;
    cacheSave();
    lastSync = new Date().toLocaleTimeString();
    if (isOrg) saveKey(sid, key, data.name);
    render();
    if (!isOrg) startLive();
  } catch (e) {
    loadError = "Could not connect. Please try again in a moment.";
    render();
  }
}
async function pollOnce() {
  if (document.hidden || !sid || isOrg || !data) return;
  try {
    var r = await fetch(API + "/api/sessions/" + sid, { cache: "no-store" });
    if (!r.ok) return;
    var j = await r.json();
    lastSync = new Date().toLocaleTimeString();
    if (j.version !== version && okData(j.data)) { version = j.version; data = j.data; cacheSave(); render(); }
    else { var el = $("sync"); if (el) el.textContent = lastSync; }
  } catch (e) {}
}

/* ---------- live updates (WebSocket) ---------- */
var ws = null, wsTimer = null, wsPing = null, wsRetry = 0;
function wsUrl() { return API.replace(/^http/, "ws") + "/api/sessions/" + sid + "/ws"; }
function stopLive() {
  clearInterval(pollTimer);
  clearInterval(wsPing);
  clearTimeout(wsTimer);
  wsRetry = 0;
  if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} ws = null; }
}
function startLive() {
  if (isOrg || !sid || !data) return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, 15000); // slow fallback only, used when the socket is not connected
  var mySid = sid;
  try {
    ws = new WebSocket(wsUrl());
    ws.onopen = function () {
      wsRetry = 0;
      clearInterval(pollTimer);
      clearInterval(wsPing);
      wsPing = setInterval(function () {
        try { if (ws && ws.readyState === 1) ws.send("ping"); } catch (e) {}
      }, 40000);
      pollOnce(); // catch up on anything missed while disconnected
    };
    ws.onmessage = function (e) {
      if (e.data === "pong") return;
      try {
        var m = JSON.parse(e.data);
        if (m && m.t === "changed" && m.v !== version) pollOnce();
      } catch (x) {}
    };
    ws.onclose = function () {
      clearInterval(wsPing);
      ws = null;
      if (sid !== mySid || isOrg) return;
      clearInterval(pollTimer);
      pollTimer = setInterval(pollOnce, 15000);
      wsRetry = Math.min(wsRetry + 1, 5);
      wsTimer = setTimeout(startLive, 1000 * Math.pow(2, wsRetry));
    };
  } catch (e) {}
}

/* ---------- warm-up countdown ---------- */
function startUiTick() {
  if (uiTick) return;
  uiTick = setInterval(function () {
    if (!data || !data.pending || data.pending.phase !== "warmup") { clearInterval(uiTick); uiTick = null; return; }
    if (isOrg && Date.now() >= data.pending.endsAt) {
      mutate(function (d) { if (d.pending) d.pending.phase = "serve"; });
    } else {
      render();
    }
  }, 1000);
}

/* ---------- views ---------- */
function render() {
  if (!sid) renderHome(); else renderSession();
}
function renderHome() {
  var keys = loadKeys();
  // Ang mga code lang na tama ang hugis ang ipinapakita (maaaring galawin ng iba ang localStorage).
  var mine = Object.keys(keys).filter(function (id) { return /^[A-Za-z0-9]{4,12}$/.test(id); });
  var head =
    '<div class="brand home"><img class="logo-lg" src="logo.png" alt="Pickabol logo"><h1>Pickleball Open Play</h1></div>' +
    '<p class="muted">Random, fair rotation of players so nobody waits too long.</p>';
  var card = "";
  if (homeView === "join") {
    card =
      '<div class="card"><h2>Open a session with a code</h2><div class="row">' +
      '<input type="text" id="f-code" maxlength="12" placeholder="e.g. K7XM2P" style="flex:1 1 160px">' +
      '<button class="btn sec" data-act="join">Open</button></div></div>';
  } else if (homeView === "mine") {
    card = '<div class="card"><h2>Your sessions on this device</h2>' + (mine.length ? mine.map(function (id) {
      var nm = String((keys[id] && keys[id].name) || "Session").slice(0, 40);
      return '<p><a href="#/s/' + esc(id) + '">' + esc(nm) + '</a> <span class="muted">(' + esc(id) + ')</span></p>';
    }).join("") : '<p class="muted">No sessions on this device yet.</p>') + "</div>";
  } else {
    card =
      '<div class="card"><h2>Create a new session</h2>' +
      '<label>Group / team name</label><input type="text" id="f-name" maxlength="40" placeholder="e.g. Saturday Open Play">' +
      '<label>Game type</label><div>' +
      '<label class="chip"><input type="radio" name="mode" value="doubles" checked> Doubles (2 vs 2)</label>' +
      '<label class="chip"><input type="radio" name="mode" value="singles"> Singles (1 vs 1)</label></div>' +
      '<label>Play to how many points?</label><select id="f-target"><option>11</option><option>15</option><option>21</option></select>' +
      '<label>Player names (one per line)</label><textarea id="f-players" rows="8" placeholder="John&#10;Mary&#10;Peter&#10;Anna"></textarea>' +
      '<p class="err" id="f-err"></p>' +
      '<button class="btn" data-act="create">Start session</button></div>';
  }
  $app.innerHTML = head + card;
}
function sideOfServer(d, c) {
  ensurePos(c);
  if (d.mode !== "doubles") {
    var s = c.server === "A" ? num(c.scoreA) : num(c.scoreB);
    return s % 2 === 0 ? "Right" : "Left";
  }
  var arr = c.server === "A" ? c.posA : c.posB;
  return arr[0] === c.serverId ? "Right" : "Left";
}
function receiverId(d, c) {
  ensurePos(c);
  var other = c.server === "A" ? c.posB : c.posA;
  if (d.mode !== "doubles") return other[0];
  var mine = c.server === "A" ? c.posA : c.posB;
  return other[mine[0] === c.serverId ? 0 : 1];
}
function courtHtml(d, c) {
  ensurePos(c);
  var sv = c.serverId, rc = receiverId(d, c);
  // Analytics mode: ang organizer ay nagta-tap sa player na nanalo ng rally.
  var tap = isOrg && !!c.track && !c.done;
  function cell(id, side) {
    var role = id === sv ? "srv" : id === rc ? "rcv" : "";
    var tag = role === "srv" ? "Server" : role === "rcv" ? "Receiver" : "";
    return '<div class="cc ' + role + (tap ? " tap" : "") + '"' +
      (tap ? ' data-act="tap" data-id="' + esc(id) + '" role="button" tabindex="0"' : "") + ">" +
      '<div class="cname">' + esc(pname(id)) + "</div>" +
      (tag ? '<div class="crole">' + tag + "</div>" : "") +
      '<div class="cside">' + side + "</div>" +
      (c.track ? '<div class="cpts">' + num((c.pts || {})[id]) + " pts</div>" : "") + "</div>";
  }
  var h = '<div class="court">';
  if (d.mode === "doubles") {
    // Seen from above: Team A (top) has its right court on the viewer's left; Team B (bottom) has its right court on the viewer's right.
    h += '<div class="crow">' + cell(c.posA[0], "Right") + cell(c.posA[1], "Left") + "</div>" +
      '<div class="cband">TEAM A</div><div class="cband">TEAM B</div>' +
      '<div class="crow">' + cell(c.posB[1], "Left") + cell(c.posB[0], "Right") + "</div>";
  } else {
    var sd = sideOfServer(d, c), empty = '<div class="cc empty"></div>';
    h += '<div class="crow">' + (sd === "Right" ? cell(c.posA[0], sd) + empty : empty + cell(c.posA[0], sd)) + "</div>" +
      '<div class="cband">TEAM A</div><div class="cband">TEAM B</div>' +
      '<div class="crow">' + (sd === "Right" ? empty + cell(c.posB[0], sd) : cell(c.posB[0], sd) + empty) + "</div>";
  }
  return h + "</div>";
}
// Lalabas kapag na-tap ng organizer ang player: pumili ng source ng score.
function pickerHtml(d) {
  var h = '<div class="pick-modal"><div class="pick" role="dialog" aria-modal="true" aria-label="How did the player score?">' +
    '<div class="pick-title">' + esc(pname(pickPid)) + ' won the rally. How?</div><div class="pick-grid">';
  SOURCES.forEach(function (s) {
    h += '<button class="btn sec" data-act="pick" data-src="' + esc(s[0]) + '">' + esc(s[1]) + "</button>";
  });
  return h + '</div><div class="row" style="margin-top:10px;justify-content:center"><button class="btn sec sm" data-act="pick-cancel">Wrong player? Go back</button></div></div></div>';
}
// Mga opsyon ng catch-up setting. Fixed na listahan (whitelist), walang galing sa labas.
var CU_OPTS = [
  ["l", "Lowest games", "Starts at the lowest games count of the active players, so the rotation is balanced right away. The record will show games that were not actually played."],
  ["a", "Style A: Alternate", "Keeps the real games count. The system catches the player up quietly: play, skip 1 game, play again, until reaching the lowest."],
  ["b", "Style B: Fast, then alternate", "Keeps the real games count. While 3 or more games behind, the player plays every game. Once 1-2 games behind, alternate (skip 1 game) until reaching the lowest."]
];
// Nakita na ba ng organizer ang ⓘ? Kapag oo, mawawala ang arrow hint.
function cuSeen() {
  try { return localStorage.getItem("pb_cuinfo") === "1"; } catch (e) { return true; }
}
// Modal para sa setting ng bagong player o ng bumalik galing rest. esc() ang pangalan.
function cuModalHtml(d) {
  var ask = cuAsk, who, sub;
  if (ask.kind === "add") {
    if (!ask.names.length) return "";
    who = ask.names[0];
    sub = ask.names.length > 1 ? "New player 1 of " + ask.names.length : "New player";
  } else {
    var bp = d.players.filter(function (x) { return x.id === ask.id; })[0];
    if (!bp) return "";
    who = bp.name;
    sub = "Back from rest \u2022 " + num(bp.games) + " games";
  }
  var h = '<div class="pick-modal"><div class="pick" role="dialog" aria-modal="true" aria-label="Catch-up setting">' +
    '<div class="pick-title">' + esc(who) + "</div>" +
    '<p class="muted center" style="margin:0 0 10px">' + esc(sub) + " \u2022 lowest games now: " + minGames(d) + ". Choose a setting:</p>";
  if (!cuSeen()) h += '<div class="hint hint-info">Tap \u24D8 to read what each setting means.</div>';
  CU_OPTS.forEach(function (o) {
    var open = cuInfo === o[0];
    h += '<div class="cu-opt"><button class="btn sec grow" data-act="cu-pick" data-cm="' + esc(o[0]) + '">' + esc(o[1]) + "</button>" +
      '<button class="info-btn" data-act="cu-info" data-cm="' + esc(o[0]) + '" aria-label="What does ' + esc(o[1]) + ' mean?" aria-expanded="' + (open ? "true" : "false") + '">\u24D8</button></div>' +
      (open ? '<p class="cu-info">' + esc(o[2]) + "</p>" : "");
  });
  return h + '<div class="row" style="margin-top:10px;justify-content:center"><button class="btn sec sm" data-act="cu-cancel">' +
    (ask.kind === "add" ? "Cancel (do not add)" : "Cancel (stay resting)") + "</button></div></div></div>";
}
function callHtml(d, c) {
  var srv = c.server === "A" ? num(c.scoreA) : num(c.scoreB);
  var rcv = c.server === "A" ? num(c.scoreB) : num(c.scoreA);
  var h = '<div class="callrow">' +
    '<div class="callbox srv"><div class="cl">SERVER SCORE</div><div class="cn">' + srv + "</div></div>" +
    '<div class="callbox rcv"><div class="cl">RECEIVER SCORE</div><div class="cn">' + rcv + "</div></div>";
  if (d.mode === "doubles") {
    h += '<div class="callbox"><div class="cl">SERVER NO.</div><div class="cn">' + num(c.serverNum) + "</div></div>";
  }
  return h + "</div>";
}
function boardHtml(d, c) {
  var sA = num(c.scoreA), sB = num(c.scoreB), dbl = d.mode === "doubles";
  var srv = c.server === "A" ? sA : sB, rcv = c.server === "A" ? sB : sA;
  var call = dbl ? srv + "-" + rcv + "-" + num(c.serverNum) : srv + "-" + rcv;
  var side = srv % 2 === 0 ? "right (even)" : "left (odd)";
  var nm = function (ids) { return esc(teamNames(ids)); };
  var h = "";
  if (c.done) {
    var w = sA > sB ? c.teamA : c.teamB;
    h += '<div class="banner">🏆 Winner: ' + nm(w) + " (" + sA + "–" + sB + ")</div>";
  }
  var fA = flash && flash.team === "A", fB = flash && flash.team === "B";
  h += '<div class="board' + (c.done ? "" : " live") + '">' +
    '<div class="team A' + (c.server === "A" && !c.done ? " srv" : "") + '"><div class="lbl">TEAM A</div><div class="names">' + nm(c.teamA) + '</div>' +
    '<div class="score' + (fA ? " pop" : "") + '">' + sA + (fA ? '<span class="plus">+' + flash.n + "</span>" : "") + "</div></div>" +
    '<div class="team B' + (c.server === "B" && !c.done ? " srv" : "") + '"><div class="lbl">TEAM B</div><div class="names">' + nm(c.teamB) + '</div>' +
    '<div class="score' + (fB ? " pop" : "") + '">' + sB + (fB ? '<span class="plus">+' + flash.n + "</span>" : "") + "</div></div></div>";
  if (!c.done) {
    h += courtHtml(d, c) + callHtml(d, c) +
      '<div class="muted center">' + esc(pname(c.serverId)) + " serves from the " + sideOfServer(d, c) +
      " • Play to " + num(c.target) + ", win by 2</div>";
  }
  if (isOrg) {
    if (c.done) {
      h += '<div class="row" style="margin-top:14px"><button class="btn grow" data-act="save">✅ Save result</button>' +
        '<button class="btn sec" data-act="undo">↩ Undo</button></div>';
    } else if (c.track && pickPid && inCurrent(d, pickPid)) {
      h += pickerHtml(d);
    } else if (c.track) {
      h += '<p class="muted center" style="margin-top:12px">Tap the player on the court who won the rally.</p>' +
        '<div class="row" style="margin-top:8px"><button class="btn sec sm" data-act="undo"' +
        ((c.stack && c.stack.length) ? "" : " disabled") + '>↩ Undo</button></div>' +
        '<p class="muted">If the serving team wins the rally, they get +1 point (credited to that player). If the receiving team wins, no point is scored but the serve changes.</p>';
    } else {
      h += '<div class="row" style="margin-top:14px">' +
        '<button class="btn a grow" data-act="rally" data-team="A">Team A won the rally</button>' +
        '<button class="btn b grow" data-act="rally" data-team="B">Team B won the rally</button></div>' +
        '<div class="row" style="margin-top:8px"><button class="btn sec sm" data-act="undo"' +
        ((c.stack && c.stack.length) ? "" : " disabled") + '>↩ Undo</button></div>' +
        '<p class="muted">If the serving team wins the rally, they get +1 point. If the receiving team wins, no point is scored but the serve changes.</p>';
    }
  }
  return h;
}
function nextGridHtml(d, n) {
  var cs = "text-align:center;padding:4px 10px;";
  function cell(side, id) {
    return '<td style="' + cs + '"><div class="muted">' + side + "</div><strong>" + esc(pname(id)) + "</strong></td>";
  }
  function btn(team) {
    return isOrg ? '<td style="' + cs + '"><button class="btn sec sm" data-act="swap" data-team="' + team + '">🔄 Swap House</button></td>' : "";
  }
  var h = "";
  if (isOrg) h += '<div class="row" style="margin-bottom:8px"><button class="btn sec sm" data-act="rebuild">🔧 Rebuild</button></div>';
  h += '<table><tr><td style="' + cs + '">Team A</td>' + cell("Right", n.teamA[0]) + cell("Left", n.teamA[1]) + btn("A") + "</tr>" +
    '<tr><td style="' + cs + '">Team B</td>' + cell("Left", n.teamB[1]) + cell("Right", n.teamB[0]) + btn("B") + "</tr></table>";
  return h;
}
function nextHtml(d) {
  var n = d.next;
  if (!n) return '<p class="muted">At least ' + need(d) + " active players are needed to make a game.</p>";
  var h = '<p><strong>' + esc(teamNames(n.teamA)) + '</strong> <span class="muted">vs</span> <strong>' + esc(teamNames(n.teamB)) + "</strong></p>";
  if (d.mode === "doubles") h = nextGridHtml(d, n);
  if (isOrg) {
    h += '<div class="row"><button class="btn grow" data-act="setup"' + (d.current ? " disabled" : "") + '>▶ Start game</button>' +
      '<button class="btn sec" data-act="shuffle">🔀 Shuffle again</button></div>';
    if (d.current) h += '<p class="muted">The current game must finish before this one can start.</p>';
  }
  return h;
}

function d_mode_dbl(d) { return d.mode === "doubles"; }
function pendingHtml(d) {
  var p = d.pending;
  var nmA = esc(teamNames(p.teamA)), nmB = esc(teamNames(p.teamB));
  var h = '<p><strong>' + nmA + '</strong> <span class="muted">vs</span> <strong>' + nmB + "</strong></p>";
  if (p.phase === "choose") {
    if (!isOrg) return h + '<p class="muted">Waiting for the organizer to start the game...</p>';
    if (warmupInputOpen) {
      h += '<label>Warm-up minutes</label><input type="text" id="f-warmup-min" inputmode="numeric" value="5" style="max-width:120px">' +
        '<div class="row" style="margin-top:8px"><button class="btn grow" data-act="warmup-start">Start warm-up</button>' +
        '<button class="btn sec" data-act="warmup-cancel">Back</button></div>';
    } else {
      h += '<p class="muted">How should this game start?</p>' +
        '<div class="row"><button class="btn grow" data-act="toss-direct">🪙 Play for serve now</button>' +
        '<button class="btn sec grow" data-act="warmup-ask">⏱ Warm up first</button></div>' +
        '<div class="row" style="margin-top:8px"><button class="btn sec sm" data-act="cancel-setup">Cancel</button></div>';
    }
    return h;
  }
  if (p.phase === "warmup") {
    var remain = Math.max(0, Math.round((p.endsAt - Date.now()) / 1000));
    var mm = Math.floor(remain / 60), ss = remain % 60;
    var timeStr = mm + ":" + (ss < 10 ? "0" : "") + ss;
    h += '<div class="warmupbox"><div class="wlabel">⏱ WARM UP</div><div class="wtime">' + timeStr + '</div></div>';
    if (remain <= 0) {
      h += '<p class="muted center">Time\'s up!' + (isOrg ? "" : " Waiting for the organizer...") + "</p>";
      if (isOrg) h += '<div class="row" style="margin-top:8px"><button class="btn grow" data-act="toss-direct">🪙 Play for serve now</button></div>';
    }
    return h;
  }
  if (p.phase === "serve") {
    h += '<p class="muted">Play one rally to decide who serves first. The winner starts serving at 0-0' + (d_mode_dbl(d) ? "-2" : "") + ".</p>";
    if (isOrg) {
      h += '<div class="row" style="margin-top:8px">' +
        '<button class="btn a grow" data-act="serve-a">Team A won the rally</button>' +
        '<button class="btn b grow" data-act="serve-b">Team B won the rally</button></div>';
    } else {
      h += '<p class="muted">Waiting for the organizer to play the serving rally...</p>';
    }
    return h;
  }
  if (p.phase === "ready") {
    var wName = p.winner === "A" ? nmA : nmB;
    h += '<div class="banner">🏓 ' + wName + " won the rally and will serve first!</div>";
    if (isOrg) h += '<div class="row"><button class="btn grow" data-act="begin">▶ Begin game</button>' +
      '<button class="btn sec" data-act="serve-redo">↩ Redo rally</button></div>';
    return h;
  }
  return h;
}
function renderSession() {
  if (loadError) {
    $app.innerHTML = '<h1>🏓 Pickleball Open Play</h1><div class="card"><p class="err">' + esc(loadError) +
      '</p><div class="row"><a class="btn sec" href="#" style="text-decoration:none">Back</a>' +
      '<button class="btn" data-act="reload">Try again</button></div></div>';
    return;
  }
  if (!data) { $app.innerHTML = '<p class="muted">Loading...</p>'; return; }
  var d = data, c = d.current, n = d.next, dbl = d.mode === "doubles";
  flash = null;
  if (c) {
    if (lastScore && lastScore.round === c.round) {
      var da = num(c.scoreA) - lastScore.a, db = num(c.scoreB) - lastScore.b;
      if (da > 0) flash = { team: "A", n: da };
      else if (db > 0) flash = { team: "B", n: db };
    }
    lastScore = { round: c.round, a: num(c.scoreA), b: num(c.scoreB) };
  } else {
    lastScore = null;
  }
  var nextIds = n ? [].concat(n.teamA, n.teamB) : [];
  var base = location.origin + location.pathname;
  var h = "";
  h += '<div class="brand"><img class="logo-sm" src="logo.png" alt="Pickabol"><h1>' + esc(d.name || "Open Play") + "</h1></div>";
  if (cachedMode) h += '<p class="muted" id="cachenote">' + esc(cacheNoteText()) + "</p>";
  h += '<p class="muted">' + (dbl ? "Doubles" : "Singles") + " • Play to " + num(d.target) + " • Code <strong>" + esc(sid) + "</strong></p>";
  if (isOrg) {
    h += '<p class="muted status" id="status" data-act="retry">' + esc(statusText || "✓ Saved") + "</p>";
  } else {
    h += '<p class="muted">View only. Only the organizer can edit. Updates automatically, no need to reload • Last update: <span id="sync">' + esc(lastSync) + "</span></p>";
  }
  if (isOrg) {
    h += '<div class="card"><h2>Share the scoreboard</h2>' +
      '<p class="muted">Send players the link so they can see the score (view only).</p>' +
      '<div class="row"><button class="btn grow" data-act="share">📤 Share score link</button>' +
      '<button class="btn sec" data-act="copy" data-what="view">Copy</button></div>' +
      '<p class="muted" id="copied"></p></div>';
  }
  if (isOrg) {
    h += '<p class="muted">📊 Analytics: <strong>' + (d.analytics ? "ON" : "OFF") + "</strong> • " +
      (c ? "locked until this game ends" : "change it in ☰ Settings before starting a game") + "</p>";
  }
  if (c) {
    h += '<div class="card"><h2>Current game • Round ' + num(c.round) + "</h2>" + boardHtml(d, c) + "</div>";
  }
  if (d.pending && d.pending.phase === "warmup") startUiTick();
  h += '<div class="card"><h2>' + (d.pending ? "Starting next game" : (c ? "Next game" : "Next game is ready")) + "</h2>" + (d.pending ? pendingHtml(d) : nextHtml(d)) + "</div>";

  h += '<div class="card"><h2>Players (' + activePlayers(d).length + " active)</h2><table><tr><th>Name</th><th>Games</th><th>Status</th>" + (isOrg ? "<th></th>" : "") + "</tr>";
  d.players.forEach(function (p) {
    var st = !p.active ? '<span class="tag rest">Resting</span>'
      : inCurrent(d, p.id) ? '<span class="tag play">Playing</span>'
      : nextIds.indexOf(p.id) >= 0 ? '<span class="tag next">Up next</span>'
      : '<span class="tag">Waiting</span>';
    h += "<tr><td>" + esc(p.name) + "</td><td>" + num(p.games) + "</td><td>" + st + "</td>";
    if (isOrg) {
      h += '<td style="white-space:nowrap"><button class="btn sec sm" data-act="rest" data-id="' + esc(p.id) + '">' + (p.active ? "Rest" : "Back") + "</button> " +
        '<button class="btn sec sm" data-act="remove" data-id="' + esc(p.id) + '">✕</button></td>';
    }
    h += "</tr>";
  });
  h += "</table>";
  if (isOrg) {
    h += '<label>Add players (one per line)</label><textarea id="f-add" rows="2"></textarea>' +
      '<div class="row" style="margin-top:8px"><button class="btn sec" data-act="add">Add</button></div>' +
      '<label>Target points for the next game</label><select data-act="target">' +
      [11, 15, 21].map(function (t) { return "<option" + (num(d.target) === t ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select>";
  }
  h += "</div>";

  if (d.history.length) {
    h += '<div class="card"><h2>Completed games (' + d.history.length + ")</h2><table>";
    d.history.slice().reverse().forEach(function (m) {
      var aw = num(m.sa) > num(m.sb);
      h += "<tr><td>#" + num(m.round) + "</td><td>" + (aw ? "<strong>" : "") + esc((m.a || []).join(" & ")) + (aw ? "</strong>" : "") +
        "</td><td>" + num(m.sa) + "–" + num(m.sb) + "</td><td>" + (aw ? "" : "<strong>") + esc((m.b || []).join(" & ")) + (aw ? "" : "</strong>") + "</td></tr>";
    });
    h += "</table></div>";
  }

  h += '<div class="card"><details><summary>How does pickleball scoring work?</summary><ul>' +
    "<li>Games go to <strong>11</strong> points (or 15/21, depending on the session), and you must <strong>win by 2</strong>.</li>" +
    "<li><strong>Only the serving side can score.</strong> If the receiving side wins the rally, no point is scored but they get the serve.</li>" +
    "<li><strong>Doubles:</strong> the score is called with three numbers: server's score, receiver's score, and server #1 or #2 (for example 4-2-1). The game starts at <strong>0-0-2</strong>. When server #1 loses a rally, server #2 (the partner) serves next. When #2 also loses a rally, it's a side-out.</li>" +
    "<li><strong>Singles:</strong> only two numbers are called (server's score, receiver's score).</li>" +
    "<li><strong>Singles:</strong> the server serves from the <strong>right</strong> when their score is even and from the <strong>left</strong> when it is odd.</li>" +
    "<li><strong>Doubles:</strong> the serving team's two players <strong>switch sides every time they score</strong>. After a side-out, the player on the <strong>right</strong> serves first.</li>" +
    "<li>The serve is underhand, diagonal, and must clear the kitchen (the 7-foot zone next to the net).</li>" +
    "<li><strong>Two-bounce rule:</strong> the ball must bounce once on each side before it can be volleyed.</li>" +
    "<li><strong>Kitchen:</strong> no volleying while standing in the kitchen.</li>" +
    "</ul></details></div>";
  // Ang "Create a new session" ay nasa nav na (Sessions > New session), kaya wala na rito.
  if (isOrg && cuAsk) h += cuModalHtml(d);
  $app.innerHTML = h;
}

/* ---------- actions ---------- */
async function createSession() {
  var err = $("f-err");
  var name = ($("f-name").value || "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 40) || "Open Play";
  var modeEl = document.querySelector('input[name="mode"]:checked');
  var mode = modeEl ? modeEl.value : "doubles";
  var target = num($("f-target").value) || 11;
  var names = parseNames($("f-players").value);
  var min = mode === "doubles" ? 4 : 2;
  if (names.length < min) {
    err.textContent = "At least " + min + " players are needed for " + (mode === "doubles" ? "doubles" : "singles") + ".";
    return;
  }
  err.textContent = "Creating...";
  try {
    var d = makeData(name, mode, target, names);
    var r = await fetch(API + "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: d })
    });
    if (!r.ok) throw new Error(String(r.status));
    var j = await r.json();
    saveKey(j.id, j.key, name);
    location.hash = "#/s/" + j.id + "/" + j.key;
  } catch (e) {
    err.textContent = "Could not create the session. Please try again.";
  }
}
function copyText(t) {
  var ok = function () { var el = $("copied"); if (el) el.textContent = "Copied ✓"; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(ok, function () { window.prompt("Copy this:", t); });
  } else {
    window.prompt("Copy this:", t);
  }
}
// Binubuksan ang share sheet ng phone (Messenger, Viber, SMS, atbp.). Kung hindi suportado, kokopyahin na lang ang link.
function shareView(url) {
  var title = (data && data.name) || "Pickleball Open Play";
  if (navigator.share) {
    navigator.share({ title: title, text: "Check the live score: " + title, url: url }).catch(function () {});
  } else {
    copyText(url);
  }
}
function handle(act, ds) {
  var base = location.origin + location.pathname;
  switch (act) {
    case "create": createSession(); break;
    case "join":
      var code = ($("f-code").value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (code.length >= 4) location.hash = "#/s/" + code;
      break;
    case "reload": loadSession(); break;
    // (walang "home-new" case, ang nav na ang nagbubukas ng home gamit ang __pbHome)
    case "retry": if (!saving) persist(); break;
    case "copy": copyText(base + "#/s/" + sid); break;
    case "share": shareView(base + "#/s/" + sid); break;
    case "rally": mutate(function (d) { rally(d, ds.team); }); break;
    case "tap":
      if (typeof ds.id === "string") { pickPid = ds.id; render(); }
      break;
    case "pick":
      var skey = srcKey(ds.src), pp = pickPid;
      pickPid = null;
      if (skey && pp) mutate(function (d) { rallyBy(d, pp, skey); }); else render();
      break;
    case "pick-cancel": pickPid = null; render(); break;
    case "analytics": mutate(function (d) { if (!d.current) d.analytics = !d.analytics; }); break;
    case "undo": mutate(undo); break;
    case "save": mutate(finish); break;
    case "setup": mutate(startSetup); break;
    case "toss-direct": mutate(function (d) { if (d.pending) d.pending.phase = "serve"; }); break;
    case "warmup-ask": warmupInputOpen = true; render(); break;
    case "warmup-cancel": warmupInputOpen = false; render(); break;
    case "warmup-start":
      var warmMin = num(($("f-warmup-min") || {}).value) || 5;
      warmupInputOpen = false;
      mutate(function (d) { setWarmup(d, warmMin); });
      break;
    case "cancel-setup": warmupInputOpen = false; mutate(cancelSetup); break;
    case "serve-a": mutate(function (d) { resolveServeRally(d, "A"); }); break;
    case "serve-b": mutate(function (d) { resolveServeRally(d, "B"); }); break;
    case "serve-redo": mutate(function (d) { if (d.pending) { d.pending.winner = null; d.pending.phase = "serve"; } }); break;
    case "begin": warmupInputOpen = false; mutate(beginGame); break;
    case "shuffle": mutate(genNext); break;
    case "rebuild": mutate(rebuildTeams); break;
    case "swap": mutate(function (d) { swapTeamSides(d, ds.team); }); break;
    case "rest":
      if (!isOrg || !data) break;
      var rp = data.players.filter(function (x) { return x.id === ds.id; })[0];
      if (!rp) break;
      // Bumalik galing rest at kulang ang games: magtatanong muna kung anong setting ang gagamitin.
      if (!rp.active && num(rp.games) < minGames(data)) { cuAsk = { kind: "back", id: rp.id }; cuInfo = null; render(); }
      else mutate(function (d) { toggleRest(d, ds.id, "l"); });
      break;
    case "cu-pick":
      if (!isOrg || !data || !cuAsk) break;
      var cm = ds.cm === "a" || ds.cm === "b" ? ds.cm : "l"; // whitelist
      var ask = cuAsk;
      cuInfo = null;
      if (ask.kind === "add" && ask.names.length) {
        var nm = ask.names.shift();
        if (!ask.names.length) cuAsk = null; // ito na ang huli sa pila
        mutate(function (d) { addPlayers(d, [nm], cm); });
      } else if (ask.kind === "back") {
        var rid = ask.id;
        cuAsk = null;
        mutate(function (d) { toggleRest(d, rid, cm); });
      }
      break;
    case "cu-info":
      var ik = ds.cm === "a" || ds.cm === "b" || ds.cm === "l" ? ds.cm : null; // whitelist
      cuInfo = ik && cuInfo !== ik ? ik : null;
      try { localStorage.setItem("pb_cuinfo", "1"); } catch (err) {} // mawawala na ang arrow hint
      render();
      break;
    case "cu-cancel": cuAsk = null; cuInfo = null; render(); break;
    case "remove":
      if (data && inCurrent(data, ds.id)) { window.alert("This player is still in a game. Please wait until the game is finished."); break; }
      if (window.confirm("Remove this player?")) mutate(function (d) { removePlayer(d, ds.id); });
      break;
    case "add":
      if (!isOrg || !data) break;
      var names = parseNames($("f-add").value);
      if (!names.length) break;
      var have = {};
      data.players.forEach(function (p) { have[p.name.toLowerCase()] = 1; });
      var fresh = names.filter(function (n) { return !have[n.toLowerCase()]; });
      if (!fresh.length) break;
      // May nakalaro na: magtatanong muna ng setting ng bawat bagong player. Wala pa: diretso na.
      if (minGames(data) > 0) { cuAsk = { kind: "add", names: fresh }; cuInfo = null; render(); }
      else mutate(function (d) { addPlayers(d, fresh, "l"); });
      break;
  }
}
document.addEventListener("click", function (e) {
  if (!e.isTrusted) return; // click na gawa ng script, balewalain
  var b = e.target.closest ? e.target.closest("[data-act]") : null;
  if (!b || b.tagName === "SELECT") return;
  handle(b.dataset.act, b.dataset);
});
document.addEventListener("change", function (e) {
  var t = e.target;
  if (t && t.dataset && t.dataset.act === "target") {
    var v = num(t.value);
    mutate(function (d) { d.target = v; });
  }
});
document.addEventListener("visibilitychange", function () { if (!document.hidden) { pollOnce(); startLive(); } });

/* ---------- bantay sa paulit-ulit na reload (viewer lang) ---------- */
// Hanggang 3 reloads kada 60 segundo, para sa viewer at organizer. Sumobra? May countdown muna.
var MAX_RELOADS = 3;
function reloadGuard(max) {
  try {
    var now = Date.now();
    var t = JSON.parse(sessionStorage.getItem("pb_loads") || "[]").filter(function (x) { return now - x < 60000; });
    if (t.length >= max) return Math.max(1, Math.ceil((t[0] + 60000 - now) / 1000));
    t.push(now);
    sessionStorage.setItem("pb_loads", JSON.stringify(t));
  } catch (e) {}
  return 0;
}
function cacheNoteText() {
  var left = Math.max(0, Math.ceil((holdUntil - Date.now()) / 1000));
  return isOrg
    ? "⏳ Too many reloads. Showing your last copy. Everything still works and your changes are saved."
    : "⏳ Too many reloads. Showing the last copy. Live updates resume in " + left + " seconds.";
}
// Sobra sa limit: gamitin pa rin ang app gamit ang huling kopya, at ipagpaliban lang ang koneksyon sa server.
function cacheTick() {
  clearTimeout(holdTimer);
  var left = Math.ceil((holdUntil - Date.now()) / 1000);
  if (left <= 0) {
    cachedMode = false;
    if (!isOrg) { pollOnce(); startLive(); }
    render();
    return;
  }
  var el = $("cachenote");
  if (el) el.textContent = cacheNoteText();
  holdTimer = setTimeout(cacheTick, 1000);
}
function toast(text) {
  var el = document.getElementById("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = text;
  el.style.display = "block";
  clearTimeout(toast.t);
  toast.t = setTimeout(function () { el.style.display = "none"; }, 3500);
}
// Walang pagharang sa F5 / Ctrl+R. Ang limit ay hahawakan ng reloadGuard (3 reloads kada 60 segundo).

/* ---------- routing ---------- */
var firstRoute = true; // ang unang route() ay ang mismong pag-load o reload ng page
function route() {
  var isPageLoad = firstRoute;
  firstRoute = false;
  stopLive();
  clearTimeout(holdTimer);
  if (uiTick) { clearInterval(uiTick); uiTick = null; }
  sid = null; key = null; data = null; isOrg = false; loadError = null; statusText = "";
  lastScore = null; flash = null; warmupInputOpen = false; cachedMode = false; pickPid = null; cuAsk = null; cuInfo = null;
  var m = location.hash.match(/^#\/s\/([A-Za-z0-9]{4,12})(?:\/([a-f0-9]{32}))?$/);
  if (!m) { render(); return; }
  sid = m[1].toUpperCase();
  key = m[2] || (loadKeys()[sid] || {}).key || null;
  if (m[2]) saveKey(sid, m[2]);
  isOrg = !!key;
  var wait = isPageLoad ? reloadGuard(MAX_RELOADS + 1) : 0; // 1 bukas + 3 reloads
  if (wait > 0) {
    var cached = cacheLoad();
    if (cached) {
      // Sobra sa limit: ipakita ang huling kopya para magamit pa rin ang app. Walang request sa server hanggang matapos ang countdown.
      data = cached.d;
      version = cached.v;
      cachedMode = true;
      holdUntil = Date.now() + wait * 1000;
      render();
      cacheTick();
      return;
    }
  }
  loadSession();
}
window.addEventListener("hashchange", route);
// Para sa "Top" sa navigation: kuwenta lang ang ibinibigay (null kung OFF ang Analytics), hindi ang buong data ng session.
window.__pbTop = function () { return data ? topStats(data) : null; };
// Para sa "Best" sa navigation: ranking bawat source ng score. Null kung OFF ang Analytics.
function bestStats(d) {
  if (!d || !d.analytics) return null;
  var tot = Object.create(null), games = 0, lists = Object.create(null), lim = cleanTopN(d.topN);
  SOURCES.forEach(function (s) { tot[s[0]] = Object.create(null); });
  (d.history || []).forEach(function (m) {
    if (num(m.tr) !== 1) return;
    games++;
    (Array.isArray(m.sc) ? m.sc : []).forEach(function (r) {
      if (!Array.isArray(r)) return;
      var k = srcKey(r[1]);
      if (!k) return;
      var n = String(r[0]);
      tot[k][n] = num(tot[k][n]) + num(r[2]);
    });
  });
  SOURCES.forEach(function (s) {
    var o = tot[s[0]];
    lists[s[0]] = Object.keys(o).map(function (n) { return { name: n, n: o[n] }; })
      .filter(function (x) { return x.n > 0; })
      .sort(function (a, b) { return b.n - a.n || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); })
      .slice(0, lim);
  });
  return { games: games, sources: SOURCES.map(function (s) { return [s[0], s[1]]; }), lists: lists };
}
window.__pbBest = function () { return data ? bestStats(data) : null; };
// Para sa "Sessions" sa navigation: whitelist lang ang tinatanggap na view, walang HTML o data na galing sa labas.
window.__pbHome = function (view) {
  if (view !== "new" && view !== "join" && view !== "mine") return;
  homeView = view;
  if (location.hash) location.hash = ""; // hashchange -> route() -> renderHome
  else render();
};
// Para sa Settings sa navigation: hugis lang ng settings ang ibinibigay, hindi ang buong session.
window.__pbSettings = function () {
  if (!data) return null;
  return {
    org: isOrg, analytics: !!data.analytics, topN: cleanTopN(data.topN), locked: !!data.current,
    // Listahan lang ng mga player na may piniling catch-up setting (display lang).
    cuList: data.players.filter(function (p) { return p.cm === "l" || p.cm === "a" || p.cm === "b"; })
      .map(function (p) { return { name: String(p.name), cm: p.cm, cu: p.cu === true, active: p.active !== false }; })
  };
};
// Organizer lang ang makakapagbago (mutate ay tumitingin sa isOrg). Whitelist ang "what" at ang value.
window.__pbSet = function (what, val) {
  if (!isOrg || !data) return;
  if (what === "analytics") {
    mutate(function (d) { if (!d.current) d.analytics = !d.analytics; });
  } else if (what === "topn") {
    var tn = cleanTopN(val);
    mutate(function (d) { d.topN = tn; });
  }
};
window.__pb = { makeData: makeData, genNext: genNext, startNext: startNext, rally: rally, undo: undo,
  finish: finish, addPlayers: addPlayers, toggleRest: toggleRest, setData: function (d) { data = d; } };
route();
})();

/* ------------------------------ navigation codes ------------------------------ */
(function () {
"use strict";

// Guard: huwag mag-load ng dalawang beses.
if (document.getElementById("nav")) return;

var THEME_KEY = "pb_theme";
var NAV_KEY = "pb_nav";
var root = document.documentElement;
var body = document.body;
var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
var wide = window.matchMedia ? window.matchMedia("(min-width: 900px)") : null;

// Whitelist lang ang tinatanggap, para walang kakaibang value na makapasok.
function cleanTheme(t) { return t === "light" || t === "dark" ? t : null; }
function savedTheme() {
  try { return cleanTheme(localStorage.getItem(THEME_KEY)); } catch (e) { return null; }
}
function currentTheme() {
  return savedTheme() || (mq && mq.matches ? "dark" : "light");
}
function setTheme(t) {
  t = cleanTheme(t);
  if (!t) return;
  root.setAttribute("data-theme", t);
  try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  paintTheme();
}
function savedNav() {
  try {
    var v = localStorage.getItem(NAV_KEY);
    return v === "open" || v === "closed" ? v : null;
  } catch (e) { return null; }
}

// Walang innerHTML: textContent lang ang gamit, kaya walang script injection.
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

// Ang nav ay nasa labas ng #app, kaya hindi ito nabubura tuwing nagre-render ang scoreboard.
var toggle = el("button", "nav-toggle", "\u2630");
toggle.type = "button";
toggle.id = "nav-toggle";
toggle.setAttribute("aria-label", "Menu");
toggle.setAttribute("aria-controls", "nav");

var nav = el("nav", "nav-side");
nav.id = "nav";
nav.setAttribute("aria-label", "Main navigation");

// Switch na may label sa kaliwa, "On/Off" sa tabi, at slider sa kanan. Fixed na text lang ang ginagamit (textContent).
function makeSwitch(text) {
  var row = el("button", "sw-row");
  row.type = "button";
  row.setAttribute("role", "switch");
  row.setAttribute("aria-checked", "false");
  var state = el("span", "sw-state", "Off");
  var track = el("span", "sw-track");
  track.appendChild(el("span", "sw-knob"));
  row.appendChild(el("span", "sw-name", text));
  row.appendChild(state);
  row.appendChild(track);
  return { row: row, state: state };
}
function paintSwitch(sw, on, disabled) {
  sw.row.setAttribute("aria-checked", on ? "true" : "false");
  sw.row.classList.toggle("on", !!on);
  sw.row.disabled = !!disabled;
  sw.state.textContent = on ? "On" : "Off";
}

var themeSw = makeSwitch("Dark mode");
var themeBtn = themeSw.row;
themeBtn.id = "theme-btn";

// Logo sa itaas ng sidebar. Fixed ang src at alt, walang galing sa user.
var navLogo = document.createElement("img");
navLogo.className = "nav-logo";
navLogo.src = "logo.png";
navLogo.alt = "Pickabol";
navLogo.decoding = "async";
nav.appendChild(navLogo);
nav.appendChild(el("div", "nav-title", "Menu"));

// "Sessions": may sub-navigation (New session, Join with code, My sessions). Fixed na listahan lang, walang galing sa labas.
var sessBtn = el("button", "btn sec nav-theme");
sessBtn.type = "button";
sessBtn.id = "sess-btn";
sessBtn.setAttribute("aria-expanded", "false");
sessBtn.appendChild(el("span", "nav-icon", "\uD83C\uDFD3"));
sessBtn.appendChild(el("span", "nav-label", "Sessions"));
var sessCaret = el("span", "nav-icon nav-caret", "\u25BE");
sessBtn.appendChild(sessCaret);
nav.appendChild(sessBtn);

var sessSub = el("div", "nav-sub");
sessSub.hidden = true;
var SESS_ITEMS = [
  ["new", "\u2795 New session"],
  ["join", "\uD83D\uDD11 Join with code"],
  ["mine", "\uD83D\uDCCB My sessions"]
];
SESS_ITEMS.forEach(function (it) {
  var b = el("button", "btn sec sm nav-theme", it[1]);
  b.type = "button";
  b.addEventListener("click", function (e) {
    if (!e.isTrusted) return; // click na gawa ng script, balewalain
    if (typeof window.__pbHome === "function") window.__pbHome(it[0]);
    if (!(wide && wide.matches)) setNav(false, false); // sa phone, isara ang nav pagkatapos pumili
  });
  sessSub.appendChild(b);
});
nav.appendChild(sessSub);
sessBtn.addEventListener("click", function (e) {
  if (!e.isTrusted) return;
  sessSub.hidden = !sessSub.hidden;
  sessCaret.textContent = sessSub.hidden ? "\u25BE" : "\u25B4";
  sessBtn.setAttribute("aria-expanded", sessSub.hidden ? "false" : "true");
});
// Ang Dark mode switch ay nasa footer ng nav (tingnan sa ibaba).

// Ang "Top" ay lalabas lang kapag ON ang Analytics ng session. Ang pag-click dito ay nagbubukas ng sub-navigation.
var topBtn = el("button", "btn sec nav-theme");
topBtn.type = "button";
topBtn.id = "top-btn";
topBtn.hidden = true;
topBtn.setAttribute("aria-expanded", "false");
topBtn.appendChild(el("span", "nav-icon", "\uD83C\uDFC6"));
topBtn.appendChild(el("span", "nav-label", "Top"));
var topCaret = el("span", "nav-icon nav-caret", "\u25BE");
topBtn.appendChild(topCaret);
nav.appendChild(topBtn);

// Fixed na listahan lang (whitelist). Walang galing sa labas.
var topSub = el("div", "nav-sub");
topSub.hidden = true;
var TOP_ITEMS = [
  ["scorer", "\uD83C\uDFAF Top Scorer"],
  ["rallies", "\uD83D\uDD25 Top Won Rallies"],
  ["wins", "\uD83E\uDD47 Most Wins"],
  ["team", "\uD83D\uDC65 Top Team"]
];
var subBtns = Object.create(null);
TOP_ITEMS.forEach(function (it) {
  var b = el("button", "btn sec sm nav-theme", it[1]);
  b.type = "button";
  b.addEventListener("click", function () { openTop(it[0]); });
  subBtns[it[0]] = b;
  topSub.appendChild(b);
});
nav.appendChild(topSub);

// "Best": lalabas lang kapag ON ang Analytics. Ang sub-nav ay hinuhubog mula sa SOURCES (tingnan ang refreshBest).
var bestBtn = el("button", "btn sec nav-theme");
bestBtn.type = "button";
bestBtn.id = "best-btn";
bestBtn.hidden = true;
bestBtn.setAttribute("aria-expanded", "false");
bestBtn.appendChild(el("span", "nav-icon", "\u2B50"));
bestBtn.appendChild(el("span", "nav-label", "Best"));
var bestCaret = el("span", "nav-icon nav-caret", "\u25BE");
bestBtn.appendChild(bestCaret);
nav.appendChild(bestBtn);
var bestSub = el("div", "nav-sub long");
bestSub.hidden = true;
nav.appendChild(bestSub);
var bestBtns = Object.create(null);
var bestKey = null;
var bestBuilt = "";
bestBtn.addEventListener("click", function () {
  if (!bestNow()) return;
  bestSub.hidden = !bestSub.hidden;
  bestCaret.textContent = bestSub.hidden ? "\u25BE" : "\u25B4";
  bestBtn.setAttribute("aria-expanded", bestSub.hidden ? "false" : "true");
});
// ---- Settings (footer ng sidebar) ----
var setWrap = el("div", "nav-foot");

var hintFoot = el("div", "hint hint-foot", "Turn on Analytics to see Top and Best.");
hintFoot.hidden = true;

var setPanel = el("div", "nav-setpanel");
setPanel.hidden = true;
// Ang Dark mode switch ay nasa footer na ng nav (tingnan sa ibaba), wala na rito.

var orgBox = el("div", "nav-org");
orgBox.hidden = true;
orgBox.appendChild(el("div", "nav-title set-gap", "Organizer"));
var anSw = makeSwitch("Analytics");
var anBtn = anSw.row;
var anNote = el("p", "muted");
var topLabel = el("label", "", "Show Top how many to everyone?");
var topSel = document.createElement("select");
[3, 5, 10].forEach(function (n) {
  var o = document.createElement("option");
  o.value = String(n);
  o.textContent = "Top " + n;
  topSel.appendChild(o);
});
orgBox.appendChild(anBtn);
orgBox.appendChild(anNote);
orgBox.appendChild(topLabel);
orgBox.appendChild(topSel);

// Listahan lang (display): settings ng mga bagong player at ng mga bumalik galing rest.
// Ang pagpili ay sa modal kapag nag-add o nag-Back. textContent lang ang gamit.
var cuHelp = el("p", "muted");
var cuList = el("ul", "cu-list");
orgBox.appendChild(el("div", "nav-title set-gap", "New / returning players"));
orgBox.appendChild(cuHelp);
orgBox.appendChild(cuList);
setPanel.appendChild(orgBox);

var setBtn = el("button", "btn sec nav-theme");
setBtn.type = "button";
setBtn.setAttribute("aria-expanded", "false");
setBtn.appendChild(el("span", "nav-icon", "\u2699\uFE0F"));
setBtn.appendChild(el("span", "nav-label", "Settings"));
var setCaret = el("span", "nav-icon nav-caret", "\u25B4");
setBtn.appendChild(setCaret);

setWrap.appendChild(hintFoot);
setWrap.appendChild(setPanel);
setWrap.appendChild(setBtn);
setWrap.appendChild(themeBtn);
nav.appendChild(setWrap);

// Hint na nakaturo sa ☰ button. Organizer lang, at lalabas habang OFF ang Analytics.
var hintTop = el("div", "hint hint-top", "Turn on Analytics to see Top and Best.");
hintTop.hidden = true;
hintTop.style.pointerEvents = "none"; // hindi hinaharangan ang clicks sa page
body.appendChild(hintTop);

// Ang hint ay galing lang sa totoong state ng session (organizer at OFF ang Analytics). Walang galing sa user input.
function paintHint() {
  var st = settingsNow();
  var need = !!(st && st.org && !st.analytics);
  var open = isOpen();
  toggle.classList.toggle("pulse", need && !open);
  hintTop.hidden = !(need && !open);                    // nakaturo sa ☰ kapag sarado ang nav
  hintFoot.hidden = !(need && open && setPanel.hidden); // nakaturo sa Settings kapag bukas ang nav
}

setBtn.addEventListener("click", function () {
  setPanel.hidden = !setPanel.hidden;
  setCaret.textContent = setPanel.hidden ? "\u25B4" : "\u25BE";
  setBtn.setAttribute("aria-expanded", setPanel.hidden ? "false" : "true");
  paintHint();
});

function settingsNow() {
  try { return typeof window.__pbSettings === "function" ? window.__pbSettings() : null; } catch (e) { return null; }
}
// Organizer lang ang nakakakita ng Settings (Analytics at Top N). Ang viewer ay walang Settings, Dark mode lang sa footer.
function refreshSettings() {
  var st = settingsNow();
  var show = !!(st && st.org);
  orgBox.hidden = !show;
  setBtn.hidden = !show;
  if (!show) {
    setPanel.hidden = true;
    setCaret.textContent = "\u25B4";
    setBtn.setAttribute("aria-expanded", "false");
    paintHint();
    return;
  }
  paintSwitch(anSw, st.analytics, st.locked);
  anNote.textContent = st.locked ? "Can only be changed between games." : "";
  topSel.value = String(st.topN);
  // Listahan ng catch-up settings. textContent lang, at whitelist ang label.
  var cuItems = Array.isArray(st.cuList) ? st.cuList : [];
  cuHelp.textContent = cuItems.length
    ? "Chosen when a player is added or comes back from rest."
    : "No new or returning players yet.";
  while (cuList.firstChild) cuList.removeChild(cuList.firstChild);
  cuItems.forEach(function (it) {
    var label = it.cm === "a" ? "Style A" : it.cm === "b" ? "Style B" : "Lowest games";
    var state = !it.active ? "resting" : it.cu ? "catching up" : (it.cm === "l" ? "" : "caught up");
    var li = el("li", "");
    li.appendChild(el("span", "", String(it.name)));
    li.appendChild(el("span", "muted", label + (state ? " \u2022 " + state : "")));
    cuList.appendChild(li);
  });
  paintHint();
}
anBtn.addEventListener("click", function (e) {
  if (!e.isTrusted) return; // click na gawa ng script, balewalain
  var st = settingsNow();
  if (!st || !st.org || st.locked) return; // huwag magtiwala sa "disabled" ng button, tingnan ulit ang totoong state
  if (typeof window.__pbSet === "function") window.__pbSet("analytics");
});
topSel.addEventListener("change", function (e) {
  if (!e.isTrusted) return;
  var st = settingsNow();
  if (!st || !st.org) return;
  if (typeof window.__pbSet === "function") window.__pbSet("topn", topSel.value);
});
// (walang listener ang listahan ng catch-up, display lang ito)

body.appendChild(toggle);
body.appendChild(nav);

// On = dark, Off = light.
function paintTheme() {
  paintSwitch(themeSw, currentTheme() === "dark", false);
}

function setNav(open, remember) {
  body.classList.toggle("nav-open", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  nav.setAttribute("aria-hidden", open ? "false" : "true");
  paintHint();
  if (remember) {
    try { localStorage.setItem(NAV_KEY, open ? "open" : "closed"); } catch (e) {}
  }
}
function isOpen() { return body.classList.contains("nav-open"); }

toggle.addEventListener("click", function () { setNav(!isOpen(), true); });
themeBtn.addEventListener("click", function (e) {
  if (!e.isTrusted) return; // click na gawa ng script, balewalain
  setTheme(currentTheme() === "dark" ? "light" : "dark"); // setTheme ay may whitelist (cleanTheme)
});
// Sa phone: mag-close kapag nag-tap sa labas ng sidebar.
document.addEventListener("click", function (e) {
  if (isOpen() && !(wide && wide.matches) && !nav.contains(e.target) && !toggle.contains(e.target)) setNav(false, false);
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && isOpen()) setNav(false, false);
});
if (mq && mq.addEventListener) mq.addEventListener("change", paintTheme);

// ---- Top (analytics) ----
// Walang innerHTML: textContent lang ang gamit, kaya walang script injection.
// Whitelist ang mga pwedeng "kind". Ang kahit anong ibang value ay tinatanggihan.
var TOP_TITLES = Object.freeze({
  scorer: "\uD83C\uDFAF Top Scorer",
  rallies: "\uD83D\uDD25 Top Won Rallies",
  wins: "\uD83E\uDD47 Most Wins",
  team: "\uD83D\uDC65 Top Team"
});
function isKind(k) {
  return typeof k === "string" && Object.prototype.hasOwnProperty.call(TOP_TITLES, k);
}
var topKind = null;
var topBox = el("div", "top-modal");
topBox.hidden = true;
topBox.setAttribute("role", "dialog");
topBox.setAttribute("aria-modal", "true");
topBox.setAttribute("aria-label", "Top");
var topCard = el("div", "top-card");
var topHead = el("div", "top-head");
var topTitle = el("h2", "", "\uD83C\uDFC6 Top");
topHead.appendChild(topTitle);
var topClose = el("button", "btn sec sm", "\u2715");
topClose.type = "button";
topClose.setAttribute("aria-label", "Close");
topHead.appendChild(topClose);
var topBody = el("div", "top-body");
// Tab bar sa loob ng modal: dalawang grupo (Top / Best) at isang hilera ng chips na nag-i-scroll.
var topG = { top: el("button", "btn sec sm", "\uD83C\uDFC6 Top"), best: el("button", "btn sec sm", "\u2B50 Best") };
topG.top.type = "button";
topG.best.type = "button";
var topGroups = el("div", "top-groups");
topGroups.appendChild(topG.top);
topGroups.appendChild(topG.best);
var topChips = el("div", "top-tabs");
topCard.appendChild(topHead);
topCard.appendChild(topGroups);
topCard.appendChild(topChips);
topCard.appendChild(topBody);
topBox.appendChild(topCard);
body.appendChild(topBox);

function topRow(name, value) {
  var li = el("li", "top-row");
  var line = el("div", "top-line");
  line.appendChild(el("span", "top-name", String(name)));
  line.appendChild(el("span", "top-val", String(value)));
  li.appendChild(line);
  return li;
}
function topList(rows, emptyText) {
  if (!rows.length) return el("p", "muted", emptyText);
  var ol = el("ol", "top-list");
  rows.forEach(function (r) { ol.appendChild(r); });
  return ol;
}
function signed(n) { return (n > 0 ? "+" : "") + n; }
// Binubuo ang hilera ng chips ayon sa aktibong grupo. Whitelist lang ang pinagmumulan: TOP_ITEMS at SOURCES.
function paintTabs() {
  while (topChips.firstChild) topChips.removeChild(topChips.firstChild);
  var isBest = !!bestKey;
  topG.top.classList.toggle("on", !isBest);
  topG.best.classList.toggle("on", isBest);
  topG.top.setAttribute("aria-pressed", isBest ? "false" : "true");
  topG.best.setAttribute("aria-pressed", isBest ? "true" : "false");
  if (topBox.hidden) return;
  var active = null;
  function chip(label, on, fn) {
    var b = el("button", "chip-tab" + (on ? " on" : ""), label);
    b.type = "button";
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.addEventListener("click", fn);
    topChips.appendChild(b);
    if (on) active = b;
  }
  if (isBest) {
    var bs = bestNow();
    if (!bs) return;
    bs.sources.forEach(function (s) {
      var key = s[0];
      chip(String(s[1]), key === bestKey, function () { openBest(key); });
    });
  } else {
    var ts = topNow();
    if (!ts) return;
    TOP_ITEMS.forEach(function (it) {
      var kind = it[0];
      if (kind === "team" && !ts.doubles) return;
      chip(it[1], kind === topKind, function () { openTop(kind); });
    });
  }
  // Ilagay sa gitna ng strip ang aktibong chip.
  if (active) topChips.scrollLeft = Math.max(0, active.offsetLeft - (topChips.clientWidth - active.offsetWidth) / 2);
}
topG.top.addEventListener("click", function () { openTop("scorer"); });
topG.best.addEventListener("click", function () {
  var st = bestNow();
  if (st && st.sources.length) openBest(st.sources[0][0]);
});
function paintSub() {
  Object.keys(subBtns).forEach(function (k) {
    subBtns[k].classList.toggle("on", !topBox.hidden && k === topKind);
  });
  Object.keys(bestBtns).forEach(function (k) {
    bestBtns[k].classList.toggle("on", !topBox.hidden && k === bestKey);
  });
  paintTabs();
}
// Isang listahan lang ang ipinapakita sa modal, ayon sa pinili sa sub-navigation.
function fillTop(st, kind) {
  if (!isKind(kind)) return;
  while (topBody.firstChild) topBody.removeChild(topBody.firstChild);
  topTitle.textContent = TOP_TITLES[kind];
  topBody.appendChild(el("p", "muted", st.games + (st.games === 1 ? " game" : " games") + " scored with Analytics ON."));
  if (kind === "scorer") {
    topBody.appendChild(topList(st.scorers.map(function (p) {
      return topRow(p.name, p.pts + " pts");
    }), "No points yet."));
  } else if (kind === "rallies") {
    topBody.appendChild(topList(st.rallies.map(function (p) {
      return topRow(p.name, p.rw + (p.rw === 1 ? " rally" : " rallies"));
    }), "No rallies yet."));
  } else if (kind === "wins") {
    topBody.appendChild(topList(st.wins.map(function (p) {
      return topRow(p.name, p.w + "W-" + p.l + "L (" + signed(p.diff) + ")");
    }), "No games yet."));
  } else if (kind === "team" && st.doubles) {
    topBody.appendChild(topList(st.teams.map(function (t) {
      return topRow(t.name, t.w + "W-" + t.l + "L (" + signed(t.diff) + ")");
    }), "No games yet."));
  }
}
function topNow() {
  try { return typeof window.__pbTop === "function" ? window.__pbTop() : null; } catch (e) { return null; }
}
function closeTop() {
  topBox.hidden = true;
  topKind = null;
  bestKey = null;
  paintSub();
}
function bestNow() {
  try { return typeof window.__pbBest === "function" ? window.__pbBest() : null; } catch (e) { return null; }
}
// Whitelist: ibinabalik lang ang label kung ang key ay nasa listahan ng sources, kung hindi ay null.
function srcLabel(st, key) {
  if (typeof key !== "string") return null;
  for (var i = 0; i < st.sources.length; i++) if (st.sources[i][0] === key) return st.sources[i][1];
  return null;
}
function fillBest(st, key) {
  var label = srcLabel(st, key);
  if (label === null) return;
  while (topBody.firstChild) topBody.removeChild(topBody.firstChild);
  topTitle.textContent = "\u2B50 Best in " + label;
  topBody.appendChild(el("p", "muted", st.games + (st.games === 1 ? " game" : " games") + " scored with Analytics ON."));
  var rows = (st.lists[key] || []).map(function (p) {
    return topRow(p.name, p.n + (p.n === 1 ? " time" : " times"));
  });
  topBody.appendChild(topList(rows, "Nobody yet."));
}
function openBest(key) {
  var st = bestNow();
  if (!st || srcLabel(st, key) === null) return;
  topKind = null;
  bestKey = key;
  if (!(wide && wide.matches)) setNav(false, false);
  fillBest(st, key);
  topBox.hidden = false;
  paintSub();
}
function refreshBest() {
  var st = bestNow();
  bestBtn.hidden = !st;
  if (!st) {
    bestSub.hidden = true;
    bestCaret.textContent = "\u25BE";
    bestBtn.setAttribute("aria-expanded", "false");
    while (bestSub.firstChild) bestSub.removeChild(bestSub.firstChild);
    bestBtns = Object.create(null);
    bestBuilt = "";
    bestKey = null;
    return;
  }
  // Binubuo ulit ang sub-nav kapag nagbago ang listahan ng SOURCES.
  var sig = st.sources.map(function (s) { return s[0]; }).join(",");
  if (sig !== bestBuilt) {
    bestBuilt = sig;
    while (bestSub.firstChild) bestSub.removeChild(bestSub.firstChild);
    bestBtns = Object.create(null);
    st.sources.forEach(function (s) {
      var key = s[0];
      var b = el("button", "btn sec sm nav-theme", s[1]);
      b.type = "button";
      b.addEventListener("click", function () { openBest(key); });
      bestBtns[key] = b;
      bestSub.appendChild(b);
    });
  }
  if (!topBox.hidden && bestKey) {
    if (srcLabel(st, bestKey) === null) closeTop();
    else fillBest(st, bestKey);
  }
}
function openTop(kind) {
  var st = topNow();
  if (!st || !isKind(kind) || (kind === "team" && !st.doubles)) return;
  topKind = kind;
  bestKey = null;
  if (!(wide && wide.matches)) setNav(false, false);
  fillTop(st, kind);
  topBox.hidden = false;
  paintSub();
}
// Sinusundan ang pagbabago ng page (live updates, toggle ng Analytics) para laging tama ang button at ang listahan.
function refreshTop() {
  var st = topNow();
  refreshBest();
  refreshSettings();
  topBtn.hidden = !st;
  if (!st) {
    topSub.hidden = true;
    topCaret.textContent = "\u25BE";
    topBtn.setAttribute("aria-expanded", "false");
    closeTop();
    return;
  }
  subBtns.team.hidden = !st.doubles;
  if (!topBox.hidden && topKind) {
    if (topKind === "team" && !st.doubles) closeTop();
    else fillTop(st, topKind);
  }
}
topBtn.addEventListener("click", function () {
  if (!topNow()) return;
  topSub.hidden = !topSub.hidden;
  topCaret.textContent = topSub.hidden ? "\u25BE" : "\u25B4";
  topBtn.setAttribute("aria-expanded", topSub.hidden ? "false" : "true");
});
topClose.addEventListener("click", closeTop);
topBox.addEventListener("click", function (e) { if (e.target === topBox) closeTop(); });
document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !topBox.hidden) closeTop(); });
var appEl = document.getElementById("app");
if (appEl && window.MutationObserver) new MutationObserver(refreshTop).observe(appEl, { childList: true });
refreshTop();

// Simula: bukas sa desktop (o ayon sa huling pinili), sarado sa phone.
var s = savedNav();
setNav(wide && wide.matches ? (s ? s === "open" : true) : false, false);

var saved = savedTheme();
if (saved) root.setAttribute("data-theme", saved);
paintTheme();
})();
/* ------------------------------ end of navigation codes ------------------------------ */
