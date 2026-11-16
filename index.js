
(function () {
"use strict";

var API = "https://pickabols-api.pickabolers.workers.dev";
var $app = document.getElementById("app");
var sid = null, key = null, data = null, version = 0, isOrg = false;
var pollTimer = null, loadError = null, lastSync = "", statusText = "";
var saving = false, dirty = false;
var lastScore = null, flash = null;
var uiTick = null, warmupInputOpen = false;
var rebuildOpen = false, rebuildSel = { A: null, B: null };

/* ---------- helpers ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function num(x) { x = Number(x); return isFinite(x) ? x : 0; }
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
function minGames(d) {
  var a = activePlayers(d);
  return a.length ? Math.min.apply(null, a.map(function (p) { return num(p.games); })) : 0;
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
  var pool = act.map(function (p) { return { p: p, r: Math.random() }; })
    .sort(function (x, y) {
      return num(x.p.games) - num(y.p.games) || num(x.p.last) - num(y.p.last) || x.r - y.r;
    }).map(function (x) { return x.p; });
  var c = pool.slice(0, k), A, B;
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
    target: d.target, done: false, stack: []
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
// Manual rebuild: palitan ang isang player sa Team A at isang player sa Team B sa susunod na laro.
function swapTeammates(d, idA, idB) {
  if (!d.next) return;
  var ia = d.next.teamA.indexOf(idA), ib = d.next.teamB.indexOf(idB);
  if (ia < 0 || ib < 0) return;
  d.next.teamA[ia] = idB;
  d.next.teamB[ib] = idA;
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
function rally(d, winner) {
  var c = d.current;
  if (!c || c.done) return;
  c.stack = c.stack || [];
  ensurePos(c);
  c.stack.push([c.scoreA, c.scoreB, c.server, c.serverNum, c.posA.slice(), c.posB.slice(), c.serverId]);
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
  checkDone(c);
}
function undo(d) {
  var c = d.current;
  if (!c || !c.stack || !c.stack.length) return;
  var s = c.stack.pop();
  c.scoreA = s[0]; c.scoreB = s[1]; c.server = s[2]; c.serverNum = s[3];
  if (s[4]) { c.posA = s[4]; c.posB = s[5]; c.serverId = s[6]; }
  checkDone(c);
}
function finish(d) {
  var c = d.current;
  if (!c || !c.done) return;
  d.history.push({
    round: c.round, a: c.teamA.map(function (i) { return pname(i); }),
    b: c.teamB.map(function (i) { return pname(i); }),
    sa: num(c.scoreA), sb: num(c.scoreB), t: num(c.target)
  });
  d.current = null;
  ensureNext(d);
}
function addPlayers(d, names) {
  var have = {};
  d.players.forEach(function (p) { have[p.name.toLowerCase()] = 1; });
  var mg = minGames(d);
  names.forEach(function (n) {
    if (!have[n.toLowerCase()]) {
      have[n.toLowerCase()] = 1;
      d.players.push({ id: uid(), name: n, games: mg, last: num(d.round), active: true });
    }
  });
  ensureNext(d);
}
function toggleRest(d, id) {
  d.players.forEach(function (p) {
    if (p.id === id) {
      p.active = !p.active;
      if (p.active) p.games = Math.max(num(p.games), minGames(d));
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
    s = s.trim().slice(0, 40);
    if (s && !seen[s.toLowerCase()]) { seen[s.toLowerCase()] = 1; out.push(s); }
  });
  return out.slice(0, 60);
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
  setStatus("Saving...");
  try {
    do {
      dirty = false;
      var r = await fetch(API + "/api/sessions/" + sid, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Organizer-Key": key },
        body: JSON.stringify({ data: data })
      });
      if (r.status === 403) throw new Error("403");
      if (!r.ok) throw new Error(String(r.status));
      var j = await r.json();
      version = j.version;
    } while (dirty);
    setStatus("✓ Saved");
  } catch (e) {
    setStatus(e.message === "403"
      ? "⚠ Wrong organizer key, cannot save"
      : "⚠ Not saved. Click here to retry");
  } finally {
    saving = false;
  }
}
function mutate(fn) {
  if (!isOrg || !data) return;
  fn(data);
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
    data = j.data;
    version = j.version;
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
  if (document.hidden || !sid || isOrg) return;
  try {
    var r = await fetch(API + "/api/sessions/" + sid, { cache: "no-store" });
    if (!r.ok) return;
    var j = await r.json();
    lastSync = new Date().toLocaleTimeString();
    if (j.version !== version) { version = j.version; data = j.data; render(); }
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
  if (isOrg || !sid) return;
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
  var keys = loadKeys(), mine = Object.keys(keys);
  var list = "";
  if (mine.length) {
    list = '<div class="card"><h2>Your sessions on this device</h2>' + mine.map(function (id) {
      return '<p><a href="#/s/' + esc(id) + '">' + esc(keys[id].name || "Session") + '</a> <span class="muted">(' + esc(id) + ')</span></p>';
    }).join("") + "</div>";
  }
  $app.innerHTML =
    '<h1>🏓 Pickleball Open Play</h1>' +
    '<p class="muted">Random, fair rotation of players so nobody waits too long.</p>' +
    '<div class="card"><h2>Create a new session</h2>' +
    '<label>Group / team name</label><input type="text" id="f-name" maxlength="40" placeholder="e.g. Saturday Open Play">' +
    '<label>Game type</label><div>' +
    '<label class="chip"><input type="radio" name="mode" value="doubles" checked> Doubles (2 vs 2)</label>' +
    '<label class="chip"><input type="radio" name="mode" value="singles"> Singles (1 vs 1)</label></div>' +
    '<label>Play to how many points?</label><select id="f-target"><option>11</option><option>15</option><option>21</option></select>' +
    '<label>Player names (one per line)</label><textarea id="f-players" rows="8" placeholder="John&#10;Mary&#10;Peter&#10;Anna"></textarea>' +
    '<p class="err" id="f-err"></p>' +
    '<button class="btn" data-act="create">Start session</button></div>' +
    '<div class="card"><h2>Open a session with a code</h2><div class="row">' +
    '<input type="text" id="f-code" maxlength="12" placeholder="e.g. K7XM2P" style="flex:1 1 160px">' +
    '<button class="btn sec" data-act="join">Open</button></div></div>' + list;
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
  function cell(id, side) {
    var role = id === sv ? "srv" : id === rc ? "rcv" : "";
    var tag = role === "srv" ? "Server" : role === "rcv" ? "Receiver" : "";
    return '<div class="cc ' + role + '"><div class="cname">' + esc(pname(id)) + "</div>" +
      (tag ? '<div class="crole">' + tag + "</div>" : "") +
      '<div class="cside">' + side + "</div></div>";
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
function nextHtml(d) {
  var n = d.next;
  if (!n) return '<p class="muted">At least ' + need(d) + " active players are needed to make a game.</p>";
  var h = '<p><strong>' + esc(teamNames(n.teamA)) + '</strong> <span class="muted">vs</span> <strong>' + esc(teamNames(n.teamB)) + "</strong></p>";
  if (isOrg) {
    h += '<div class="row"><button class="btn grow" data-act="setup"' + (d.current ? " disabled" : "") + '>▶ Start game</button>' +
      '<button class="btn sec" data-act="shuffle">🔀 Shuffle again</button></div>';
    if (d.mode === "doubles") {
      h += '<div class="row" style="margin-top:8px"><button class="btn sec sm" data-act="rebuild-toggle">' +
        (rebuildOpen ? "✕ Close rebuild" : "🔧 Rebuild") + "</button></div>";
      if (rebuildOpen) {
        var pickBtns = function (ids, team) {
          return ids.map(function (id) {
            return '<button class="btn sm' + (rebuildSel[team] === id ? "" : " sec") + '" data-act="rebuild-pick" data-team="' + team +
              '" data-id="' + esc(id) + '">' + esc(pname(id)) + "</button>";
          }).join(" ");
        };
        h += '<p class="muted">Tap one player from Team A and one from Team B to swap them.</p>' +
          '<p class="muted" style="margin-bottom:4px">TEAM A</p><div class="row">' + pickBtns(n.teamA, "A") + "</div>" +
          '<p class="muted" style="margin:8px 0 4px">TEAM B</p><div class="row">' + pickBtns(n.teamB, "B") + "</div>";
      }
    }
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
  h += "<h1>🏓 " + esc(d.name || "Open Play") + "</h1>";
  h += '<p class="muted">' + (dbl ? "Doubles" : "Singles") + " • Play to " + num(d.target) + " • Code <strong>" + esc(sid) + "</strong></p>";
  if (isOrg) {
    h += '<p class="muted status" id="status" data-act="retry">' + esc(statusText || "✓ Saved") + "</p>";
  } else {
    h += '<p class="muted">View only. Only the organizer can edit. Updates automatically • Last update: <span id="sync">' + esc(lastSync) + "</span></p>";
  }
  if (isOrg) {
    h += '<div class="card"><h2>Share the scoreboard</h2>' +
      '<p class="muted">Send players the link so they can see the score (view only).</p>' +
      '<div class="row"><button class="btn grow" data-act="share">📤 Share score link</button>' +
      '<button class="btn sec" data-act="copy" data-what="view">Copy</button></div>' +
      '<p class="muted" id="copied"></p></div>';
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
  h += '<p class="muted center"><a href="#">Create a new session</a></p>';
  $app.innerHTML = h;
}

/* ---------- actions ---------- */
async function createSession() {
  var err = $("f-err");
  var name = ($("f-name").value || "").trim().slice(0, 40) || "Open Play";
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
    case "retry": if (!saving) persist(); break;
    case "copy": copyText(base + "#/s/" + sid); break;
    case "share": shareView(base + "#/s/" + sid); break;
    case "rally": mutate(function (d) { rally(d, ds.team); }); break;
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
    case "shuffle": rebuildSel = { A: null, B: null }; mutate(genNext); break;
    case "rebuild-toggle": rebuildOpen = !rebuildOpen; rebuildSel = { A: null, B: null }; render(); break;
    case "rebuild-pick":
      rebuildSel[ds.team] = (rebuildSel[ds.team] === ds.id) ? null : ds.id;
      if (rebuildSel.A && rebuildSel.B) {
        var pa = rebuildSel.A, pb = rebuildSel.B;
        rebuildSel = { A: null, B: null };
        mutate(function (d) { swapTeammates(d, pa, pb); });
      } else {
        render();
      }
      break;
    case "rest": mutate(function (d) { toggleRest(d, ds.id); }); break;
    case "remove":
      if (data && inCurrent(data, ds.id)) { window.alert("This player is still in a game. Please wait until the game is finished."); break; }
      if (window.confirm("Remove this player?")) mutate(function (d) { removePlayer(d, ds.id); });
      break;
    case "add":
      var names = parseNames($("f-add").value);
      if (names.length) mutate(function (d) { addPlayers(d, names); });
      break;
  }
}
document.addEventListener("click", function (e) {
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

/* ---------- routing ---------- */
function route() {
  stopLive();
  if (uiTick) { clearInterval(uiTick); uiTick = null; }
  sid = null; key = null; data = null; isOrg = false; loadError = null; statusText = "";
  lastScore = null; flash = null; warmupInputOpen = false;
  var m = location.hash.match(/^#\/s\/([A-Za-z0-9]{4,12})(?:\/([a-f0-9]{32}))?$/);
  if (!m) { render(); return; }
  sid = m[1].toUpperCase();
  key = m[2] || (loadKeys()[sid] || {}).key || null;
  if (m[2]) saveKey(sid, m[2]);
  isOrg = !!key;
  loadSession();
}
window.addEventListener("hashchange", route);
window.__pb = { makeData: makeData, genNext: genNext, startNext: startNext, rally: rally, undo: undo,
  finish: finish, addPlayers: addPlayers, toggleRest: toggleRest, setData: function (d) { data = d; } };
route();
})();