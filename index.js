
(function () {
"use strict";

var API = "https://pickabols-api.pickabolers.workers.dev";
var $app = document.getElementById("app");
var sid = null, key = null, data = null, version = 0, isOrg = false;
var pollTimer = null, loadError = null, lastSync = "", statusText = "";
var saving = false, dirty = false;

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
    players: [], partners: {}, opps: {}, history: [], current: null, next: null
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
function startNext(d) {
  if (d.current) return;
  ensureNext(d);
  var n = d.next;
  if (!n) return;
  d.round = n.round;
  d.current = {
    round: n.round, teamA: n.teamA, teamB: n.teamB, scoreA: 0, scoreB: 0,
    server: Math.random() < 0.5 ? "A" : "B",
    serverNum: d.mode === "doubles" ? 2 : 1,
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
  c.stack.push([c.scoreA, c.scoreB, c.server, c.serverNum]);
  if (c.stack.length > 40) c.stack.shift();
  if (winner === c.server) {
    if (winner === "A") c.scoreA = num(c.scoreA) + 1; else c.scoreB = num(c.scoreB) + 1;
  } else if (d.mode === "doubles" && num(c.serverNum) === 1) {
    c.serverNum = 2;
  } else {
    c.server = c.server === "A" ? "B" : "A";
    c.serverNum = 1;
  }
  checkDone(c);
}
function undo(d) {
  var c = d.current;
  if (!c || !c.stack || !c.stack.length) return;
  var s = c.stack.pop();
  c.scoreA = s[0]; c.scoreB = s[1]; c.server = s[2]; c.serverNum = s[3];
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
  setStatus("Nagse-save...");
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
    setStatus("✓ Naka-save");
  } catch (e) {
    setStatus(e.message === "403"
      ? "⚠ Mali ang organizer key, hindi makaka-save"
      : "⚠ Hindi na-save. I-click ito para ulitin");
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
    if (r.status === 404) { loadError = "Hindi nahanap ang session na ito. Tiyaking tama ang link o code."; render(); return; }
    if (!r.ok) throw new Error(String(r.status));
    var j = await r.json();
    data = j.data;
    version = j.version;
    lastSync = new Date().toLocaleTimeString();
    if (isOrg) saveKey(sid, key, data.name);
    render();
    if (!isOrg) pollTimer = setInterval(pollOnce, 5000);
  } catch (e) {
    loadError = "Hindi makakonekta. Subukan ulit sa ilang sandali.";
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

/* ---------- views ---------- */
function render() {
  if (!sid) renderHome(); else renderSession();
}
function renderHome() {
  var keys = loadKeys(), mine = Object.keys(keys);
  var list = "";
  if (mine.length) {
    list = '<div class="card"><h2>Mga session mo sa device na ito</h2>' + mine.map(function (id) {
      return '<p><a href="#/s/' + esc(id) + '">' + esc(keys[id].name || "Session") + '</a> <span class="muted">(' + esc(id) + ')</span></p>';
    }).join("") + "</div>";
  }
  $app.innerHTML =
    '<h1>🏓 Pickleball Open Play</h1>' +
    '<p class="muted">Random at patas na pag-ikot ng players para hindi matagal maghintay.</p>' +
    '<div class="card"><h2>Gumawa ng bagong session</h2>' +
    '<label>Pangalan ng grupo / team</label><input type="text" id="f-name" maxlength="40" placeholder="hal. Sabado Open Play">' +
    '<label>Uri ng laro</label><div>' +
    '<label class="chip"><input type="radio" name="mode" value="doubles" checked> Doubles (2 vs 2)</label>' +
    '<label class="chip"><input type="radio" name="mode" value="singles"> Singles (1 vs 1)</label></div>' +
    '<label>Hanggang ilang points ang laro?</label><select id="f-target"><option>11</option><option>15</option><option>21</option></select>' +
    '<label>Mga pangalan ng players (isa kada linya)</label><textarea id="f-players" rows="8" placeholder="Juan&#10;Maria&#10;Pedro&#10;Ana"></textarea>' +
    '<p class="err" id="f-err"></p>' +
    '<button class="btn" data-act="create">Simulan ang session</button></div>' +
    '<div class="card"><h2>Buksan ang session gamit ang code</h2><div class="row">' +
    '<input type="text" id="f-code" maxlength="12" placeholder="hal. K7XM2P" style="flex:1 1 160px">' +
    '<button class="btn sec" data-act="join">Buksan</button></div></div>' + list;
}
function boardHtml(d, c) {
  var sA = num(c.scoreA), sB = num(c.scoreB), dbl = d.mode === "doubles";
  var srv = c.server === "A" ? sA : sB, rcv = c.server === "A" ? sB : sA;
  var call = dbl ? srv + "-" + rcv + "-" + num(c.serverNum) : srv + "-" + rcv;
  var side = srv % 2 === 0 ? "kanan (even)" : "kaliwa (odd)";
  var nm = function (ids) { return esc(teamNames(ids)); };
  var h = "";
  if (c.done) {
    var w = sA > sB ? c.teamA : c.teamB;
    h += '<div class="banner">🏆 Panalo: ' + nm(w) + " (" + sA + "–" + sB + ")</div>";
  }
  h += '<div class="board">' +
    '<div class="team A' + (c.server === "A" && !c.done ? " srv" : "") + '"><div class="lbl">TEAM A</div><div class="names">' + nm(c.teamA) + '</div><div class="score">' + sA + "</div>" +
    (c.server === "A" && !c.done ? '<div class="muted">🏓 Nagse-serve</div>' : "") + "</div>" +
    '<div class="team B' + (c.server === "B" && !c.done ? " srv" : "") + '"><div class="lbl">TEAM B</div><div class="names">' + nm(c.teamB) + '</div><div class="score">' + sB + "</div>" +
    (c.server === "B" && !c.done ? '<div class="muted">🏓 Nagse-serve</div>' : "") + "</div></div>";
  if (!c.done) {
    h += '<div class="call">' + esc(call) + "</div>" +
      '<div class="muted center">Mag-serve mula sa ' + side + (dbl ? " • Server #" + num(c.serverNum) : "") +
      " • Hanggang " + num(c.target) + ", win by 2</div>";
  }
  if (isOrg) {
    if (c.done) {
      h += '<div class="row" style="margin-top:14px"><button class="btn grow" data-act="save">✅ I-save ang resulta</button>' +
        '<button class="btn sec" data-act="undo">↩ Undo</button></div>';
    } else {
      h += '<div class="row" style="margin-top:14px">' +
        '<button class="btn a grow" data-act="rally" data-team="A">Team A ang nanalo sa rally</button>' +
        '<button class="btn b grow" data-act="rally" data-team="B">Team B ang nanalo sa rally</button></div>' +
        '<div class="row" style="margin-top:8px"><button class="btn sec sm" data-act="undo"' +
        ((c.stack && c.stack.length) ? "" : " disabled") + '>↩ Undo</button></div>' +
        '<p class="muted">Kapag ang nagse-serve ang nanalo sa rally, +1 point. Kapag ang receiver ang nanalo, walang point pero lilipat ang serve.</p>';
    }
  }
  return h;
}
function nextHtml(d) {
  var n = d.next;
  if (!n) return '<p class="muted">Kailangan ng hindi bababa sa ' + need(d) + " active players para makabuo ng laro.</p>";
  var h = '<p><strong>' + esc(teamNames(n.teamA)) + '</strong> <span class="muted">vs</span> <strong>' + esc(teamNames(n.teamB)) + "</strong></p>";
  if (isOrg) {
    h += '<div class="row"><button class="btn grow" data-act="start"' + (d.current ? " disabled" : "") + '>▶ Simulan ang laro</button>' +
      '<button class="btn sec" data-act="shuffle">🔀 Shuffle ulit</button></div>';
    if (d.current) h += '<p class="muted">Matatapos muna ang kasalukuyang laro bago ito masimulan.</p>';
  }
  return h;
}
function renderSession() {
  if (loadError) {
    $app.innerHTML = '<h1>🏓 Pickleball Open Play</h1><div class="card"><p class="err">' + esc(loadError) +
      '</p><div class="row"><a class="btn sec" href="#" style="text-decoration:none">Bumalik</a>' +
      '<button class="btn" data-act="reload">Subukan ulit</button></div></div>';
    return;
  }
  if (!data) { $app.innerHTML = '<p class="muted">Naglo-load...</p>'; return; }
  var d = data, c = d.current, n = d.next, dbl = d.mode === "doubles";
  var nextIds = n ? [].concat(n.teamA, n.teamB) : [];
  var base = location.origin + location.pathname;
  var h = "";
  h += "<h1>🏓 " + esc(d.name || "Open Play") + "</h1>";
  h += '<p class="muted">' + (dbl ? "Doubles" : "Singles") + " • Hanggang " + num(d.target) + " • Code <strong>" + esc(sid) + "</strong></p>";
  if (isOrg) {
    h += '<p class="muted status" id="status" data-act="retry">' + esc(statusText || "✓ Naka-save") + "</p>";
  } else {
    h += '<p class="muted">Panonood ka lang. Ang organizer lang ang makakapag-edit. Auto-refresh kada 5 segundo • Huling update: <span id="sync">' + esc(lastSync) + "</span></p>";
  }
  if (isOrg) {
    h += '<div class="card"><h2>I-share</h2>' +
      '<label>View link, ibigay sa players (scoreboard lang)</label><div class="linkbox">' + esc(base + "#/s/" + sid) + "</div>" +
      '<div class="row" style="margin-top:6px"><button class="btn sec sm" data-act="copy" data-what="view">Kopyahin ang view link</button></div>' +
      '<label>Organizer link, sa iyo lang (nakakapag-edit)</label><div class="linkbox">' + esc(base + "#/s/" + sid + "/" + key) + "</div>" +
      '<div class="row" style="margin-top:6px"><button class="btn sec sm" data-act="copy" data-what="org">Kopyahin ang organizer link</button> <span class="muted" id="copied"></span></div>' +
      '<p class="muted">Huwag ibigay sa players ang organizer link. Itago ito para makabalik ka kung magpalit ng device.</p></div>';
  }
  if (c) {
    h += '<div class="card"><h2>Kasalukuyang laro • Round ' + num(c.round) + "</h2>" + boardHtml(d, c) + "</div>";
  }
  h += '<div class="card"><h2>' + (c ? "Susunod na laro" : "Handa na ang susunod na laro") + "</h2>" + nextHtml(d) + "</div>";

  h += '<div class="card"><h2>Mga players (' + activePlayers(d).length + " active)</h2><table><tr><th>Pangalan</th><th>Laro</th><th>Status</th>" + (isOrg ? "<th></th>" : "") + "</tr>";
  d.players.forEach(function (p) {
    var st = !p.active ? '<span class="tag rest">Pahinga</span>'
      : inCurrent(d, p.id) ? '<span class="tag play">Naglalaro</span>'
      : nextIds.indexOf(p.id) >= 0 ? '<span class="tag next">Susunod</span>'
      : '<span class="tag">Naghihintay</span>';
    h += "<tr><td>" + esc(p.name) + "</td><td>" + num(p.games) + "</td><td>" + st + "</td>";
    if (isOrg) {
      h += '<td style="white-space:nowrap"><button class="btn sec sm" data-act="rest" data-id="' + esc(p.id) + '">' + (p.active ? "Pahinga" : "Balik") + "</button> " +
        '<button class="btn sec sm" data-act="remove" data-id="' + esc(p.id) + '">✕</button></td>';
    }
    h += "</tr>";
  });
  h += "</table>";
  if (isOrg) {
    h += '<label>Magdagdag ng players (isa kada linya)</label><textarea id="f-add" rows="2"></textarea>' +
      '<div class="row" style="margin-top:8px"><button class="btn sec" data-act="add">Idagdag</button></div>' +
      '<label>Target points ng susunod na laro</label><select data-act="target">' +
      [11, 15, 21].map(function (t) { return "<option" + (num(d.target) === t ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select>";
  }
  h += "</div>";

  if (d.history.length) {
    h += '<div class="card"><h2>Mga natapos na laro (' + d.history.length + ")</h2><table>";
    d.history.slice().reverse().forEach(function (m) {
      var aw = num(m.sa) > num(m.sb);
      h += "<tr><td>#" + num(m.round) + "</td><td>" + (aw ? "<strong>" : "") + esc((m.a || []).join(" & ")) + (aw ? "</strong>" : "") +
        "</td><td>" + num(m.sa) + "–" + num(m.sb) + "</td><td>" + (aw ? "" : "<strong>") + esc((m.b || []).join(" & ")) + (aw ? "" : "</strong>") + "</td></tr>";
    });
    h += "</table></div>";
  }

  h += '<div class="card"><details><summary>Paano ang scoring ng pickleball?</summary><ul>' +
    "<li>Hanggang <strong>11</strong> points (o 15/21 depende sa napili), at kailangang <strong>lamang ng 2</strong>.</li>" +
    "<li><strong>Ang nagse-serve lang ang nakaka-score.</strong> Kapag nanalo ang receiver sa rally, walang point pero napupunta sa kanila ang serve.</li>" +
    "<li><strong>Doubles:</strong> tatlong numero ang tinatawag: score ng server, score ng receiver, at server #1 o #2 (halimbawa 4-2-1). Nagsisimula ang laro sa <strong>0-0-2</strong>. Kapag natalo ng server #1 ang rally, si server #2 (partner) naman ang magse-serve. Kapag natalo rin si #2, side-out na.</li>" +
    "<li><strong>Singles:</strong> dalawang numero lang (score ng server, score ng receiver).</li>" +
    "<li>Kapag <strong>even</strong> ang score ng nagse-serve, sa <strong>kanan</strong> siya mag-se-serve. Kapag <strong>odd</strong>, sa <strong>kaliwa</strong>.</li>" +
    "<li>Underhand ang serve, pa-diagonal, at kailangang lumampas sa kitchen (7 feet na zone sa tabi ng net).</li>" +
    "<li><strong>Two-bounce rule:</strong> kailangang tumalbog nang tig-isang beses sa magkabilang side bago pwedeng i-volley.</li>" +
    "<li><strong>Kitchen:</strong> bawal mag-volley habang nasa loob ng kitchen.</li>" +
    "</ul></details></div>";
  h += '<p class="muted center"><a href="#">Gumawa ng bagong session</a></p>';
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
    err.textContent = "Kailangan ng hindi bababa sa " + min + " players para sa " + (mode === "doubles" ? "doubles" : "singles") + ".";
    return;
  }
  err.textContent = "Ginagawa...";
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
    err.textContent = "Hindi nagawa ang session. Subukan ulit.";
  }
}
function copyText(t) {
  var ok = function () { var el = $("copied"); if (el) el.textContent = "Na-copy ✓"; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(ok, function () { window.prompt("Kopyahin ito:", t); });
  } else {
    window.prompt("Kopyahin ito:", t);
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
    case "copy": copyText(ds.what === "org" ? base + "#/s/" + sid + "/" + key : base + "#/s/" + sid); break;
    case "rally": mutate(function (d) { rally(d, ds.team); }); break;
    case "undo": mutate(undo); break;
    case "save": mutate(finish); break;
    case "start": mutate(startNext); break;
    case "shuffle": mutate(genNext); break;
    case "rest": mutate(function (d) { toggleRest(d, ds.id); }); break;
    case "remove":
      if (data && inCurrent(data, ds.id)) { window.alert("Naglalaro pa ang player na ito. Hintayin munang matapos ang laro."); break; }
      if (window.confirm("Alisin ang player na ito?")) mutate(function (d) { removePlayer(d, ds.id); });
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
document.addEventListener("visibilitychange", function () { if (!document.hidden) pollOnce(); });

/* ---------- routing ---------- */
function route() {
  clearInterval(pollTimer);
  sid = null; key = null; data = null; isOrg = false; loadError = null; statusText = "";
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