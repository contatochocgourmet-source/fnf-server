// FNF Online server (protocol 24) - zero dependencies, Node 18+
// Talks to FNFOnline.hxc with plain HTTP: POST /poll, POST /auth, GET /online, GET /leaderboard
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 7777;
const PROTOCOL = 24;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
const OWNER_NAME = (process.env.OWNER_NAME || "").toLowerCase(); // this account gets the [OWNER] tag
const SESSION_TTL = 90 * 1000; // a silent session is dropped after this
const MATCH_GRACE = 90 * 1000; // matches keep a disconnected player this long

// ------------------------------------------------------------------ storage
let db = { users: {}, settings: { maintenance: false, announce: null, news: null }, dms: {}, gchat: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); } catch (e) {}
let dirty = false;
function save() { dirty = true; }
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try { fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(db)); fs.renameSync(DATA_FILE + ".tmp", DATA_FILE); } catch (e) { console.error("save failed", e.message); }
}, 5000);
process.on("SIGTERM", () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) {} process.exit(0); });

const key = (n) => String(n || "").toLowerCase();
const now = () => Date.now();

function hashPass(pass, salt) { return crypto.scryptSync(pass, salt, 32).toString("hex"); }
function nameOk(n) {
  if (typeof n !== "string" || n.length < 3 || n.length > 16) return false;
  for (let i = 0; i < n.length; i++) { const c = n.charCodeAt(i); if (c < 33 || c > 126) return false; }
  return true;
}

// ------------------------------------------------------------------ ranks
function rankOf(r) {
  if (r < 1050) return "BRONZE";
  if (r < 1150) return "SILVER";
  if (r < 1300) return "GOLD";
  if (r < 1450) return "PLATINUM";
  if (r < 1650) return "DIAMOND";
  return "CHAMPION";
}
function newUser(name, pass) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { name, salt, hash: hashPass(pass, salt), tokens: [], rating: 1000, w: 0, l: 0, streak: 0, best: 0,
    pfp: "default1", badge: "", noFR: false, noJoin: false, friends: [], requests: [], nameChanged: 0,
    banned: false, createdAt: now() };
}
function profileOf(u) {
  if (!u) return null;
  return { name: u.name, rank: rankOf(u.rating), rating: u.rating, w: u.w, l: u.l, streak: u.streak, best: u.best,
    pfp: u.pfp, badge: u.badge || "", owner: isOwner(u) };
}
function isOwner(u) { return OWNER_NAME !== "" && key(u.name) === OWNER_NAME; }

// ------------------------------------------------------------------ sessions
const sessions = new Map(); // sid -> session
const online = new Map();   // lower name -> session
function newSession(u) {
  const s = { sid: crypto.randomBytes(12).toString("hex"), user: u, outbox: [], lastSeen: now(), state: "online",
    queue: null, room: null, match: null, gchat: false };
  sessions.set(s.sid, s);
  const old = online.get(key(u.name));
  if (old && old !== s) dropSession(old, true);
  online.set(key(u.name), s);
  return s;
}
function push(s, msg) { if (s) s.outbox.push(msg); }
function pushTo(name, msg) { const s = online.get(key(name)); if (s) push(s, msg); return !!s; }
function statusOf(name) {
  const s = online.get(key(name));
  if (!s) return "offline";
  if (s.match) return "in a match";
  if (s.room) return "private room";
  if (s.queue) return "searching";
  return "online";
}

function dropSession(s, replaced) {
  if (!s || s.dead) return;
  s.dead = true;
  leaveQueue(s);
  leaveRoom(s);
  if (s.match) leaveMatch(s, true);
  sessions.delete(s.sid);
  if (online.get(key(s.user.name)) === s) online.delete(key(s.user.name));
}
setInterval(() => {
  const t = now();
  for (const s of [...sessions.values()]) {
    const limit = s.match ? MATCH_GRACE : SESSION_TTL;
    if (t - s.lastSeen > limit) dropSession(s);
  }
}, 5000);

// ------------------------------------------------------------------ matchmaking
const queues = { normal: [], bo3: [], party: [] };
function leaveQueue(s) {
  if (!s.queue) return;
  const q = queues[s.queue.mode];
  const i = q ? q.indexOf(s) : -1;
  if (i >= 0) q.splice(i, 1);
  s.queue = null;
}
function enqueue(s, m) {
  leaveQueue(s);
  const mode = m.party ? "party" : (m.mode === "normal" ? "normal" : "bo3");
  s.queue = { mode, matchMods: m.matchMods === true, mods: Array.isArray(m.mods) ? m.mods : [], since: now() };
  const q = queues[mode];
  q.push(s);
  if (mode === "party") {
    for (const p of q) push(p, { t: "queued", count: q.length, party: true });
    if (q.length >= 4) startParty(q.splice(0, 4), false, null);
    return;
  }
  // 1v1: pair with the first other player
  const other = q.find((x) => x !== s);
  if (!other) { push(s, { t: "queued", count: 1 }); return; }
  q.splice(q.indexOf(s), 1);
  q.splice(q.indexOf(other), 1);
  s.queue = other.queue = null;
  startDuel([other, s], mode === "bo3" ? 3 : 1, true, null, other.queue, s.queue);
}
// party queue: 3 people start after 25 sec
setInterval(() => {
  const q = queues.party;
  if (q.length >= 3 && now() - Math.min(...q.map((x) => x.queue.since)) > 25000) startParty(q.splice(0, 4), false, null);
}, 1000);

function commonMods(a, b) {
  const A = (a && a.mods) || [], B = (b && b.mods) || [];
  return A.filter((x) => B.indexOf(x) >= 0);
}

function startDuel(pl, bestOf, ranked, rules, qa, qb) {
  const [a, b] = pl;
  const room = crypto.randomBytes(5).toString("hex");
  const wantMods = !!(a._wm && b._wm);
  const common = commonMods(a._q || qa, b._q || qb);
  const m = { room, ranked, bestOf, party: false, players: [a, b], wins: [0, 0], results: [null, null], rules,
    over: false, left: [false, false], rounds: 0 };
  a.match = b.match = m;
  for (let i = 0; i < 2; i++) {
    const me = pl[i], opp = pl[1 - i];
    me.queue = null;
    push(me, { t: "match", room, song: null, side: i === 0 ? "bf" : "dad", opponent: opp.user.name, bestOf,
      common, modsOnly: wantMods, opp: profileOf(opp.user), me: profileOf(me.user), ranked, rules, private: !ranked });
  }
}
function startParty(pl, ranked, rules) {
  const room = crypto.randomBytes(5).toString("hex");
  const m = { room, ranked: false, bestOf: 1, party: true, players: pl, results: pl.map(() => null), rules,
    over: false, left: pl.map(() => false), rounds: 0, wins: pl.map(() => 0) };
  const names = pl.map((p) => p.user.name);
  const profiles = pl.map((p) => profileOf(p.user));
  pl.forEach((p) => { p.match = m; leaveQueue(p); });
  pl.forEach((me, i) => push(me, { t: "match", room, song: null, side: i === 0 ? "bf" : "dad", opponent: names[(i + 1) % names.length],
    bestOf: 1, common: [], modsOnly: false, party: true, slot: i, players: names, profiles, ranked: false,
    rules, private: !!rules }));
}

function applyElo(winner, loser) {
  const ea = 1 / (1 + Math.pow(10, (loser.rating - winner.rating) / 400));
  const gain = Math.max(8, Math.round(28 * (1 - ea)));
  const lose = Math.max(6, Math.round(24 * (1 - ea)));
  winner.rating += gain; winner.w++; winner.streak++; if (winner.streak > winner.best) winner.best = winner.streak;
  const before = loser.rating;
  loser.rating = Math.max(0, loser.rating - lose); loser.l++; loser.streak = 0;
  save();
  return { gain, lose: before - loser.rating };
}

function onResult(s, msg) {
  const m = s.match;
  if (!m || m.over || m.party) return;
  const i = m.players.indexOf(s);
  if (i < 0 || m.results[i]) return;
  m.results[i] = { score: Number(msg.score) || 0, misses: Number(msg.misses) || 0 };
  if (!m.results[0] || !m.results[1]) return;
  const [r0, r1] = m.results;
  let w = -1; // -1 tie
  if (r0.score > r1.score) w = 0; else if (r1.score > r0.score) w = 1;
  if (w >= 0) m.wins[w]++;
  m.rounds++;
  m.results = [null, null];
  const need = m.bestOf === 1 ? 1 : 2;
  const over = m.bestOf === 1 ? true : (m.wins[0] >= need || m.wins[1] >= need || m.rounds >= 5);
  let seriesWinner = -1;
  if (over) {
    if (m.wins[0] > m.wins[1]) seriesWinner = 0; else if (m.wins[1] > m.wins[0]) seriesWinner = 1;
    m.over = true;
  }
  let elo = null;
  if (over && m.ranked && seriesWinner >= 0) {
    elo = applyElo(m.players[seriesWinner].user, m.players[1 - seriesWinner].user);
  }
  for (let k = 0; k < 2; k++) {
    const me = m.players[k];
    const o = {
      t: "round", me: m.wins[k], them: m.wins[1 - k], over,
      won: w < 0 ? null : (w === k), seriesWon: over ? (seriesWinner < 0 ? null : seriesWinner === k) : null
    };
    if (over && m.ranked) {
      o.rank = rankOf(me.user.rating); o.rating = me.user.rating;
      o.change = elo ? (seriesWinner === k ? elo.gain : -elo.lose) : 0;
    }
    push(me, o);
  }
}

function leaveMatch(s, silent) {
  const m = s.match;
  if (!m) return;
  s.match = null;
  const i = m.players.indexOf(s);
  if (i >= 0) m.left[i] = true;
  if (m.party) {
    m.players.forEach((p, k) => { if (p !== s && !m.left[k]) push(p, { t: "opponent_left", slot: i, name: s.user.name }); });
    if (m.left.every((x) => x)) m.over = true;
    return;
  }
  const other = m.players[1 - i];
  if (m.ranked && !m.over && other && other.match === m) {
    // leaving a ranked match early = a loss
    const e = applyElo(other.user, s.user);
    m.over = true;
    push(s, { t: "rank_update", won: false, change: -e.lose, rank: rankOf(s.user.rating), rating: s.user.rating });
    push(other, { t: "rank_update", won: true, change: e.gain, rank: rankOf(other.user.rating), rating: other.user.rating });
  }
  if (other && other.match === m) push(other, { t: "opponent_left" });
  if (other && other.match === m && (m.over || m.left[1 - i])) other.match = other.match; // client leaves on its own
}

function relay(s, data) {
  const m = s.match;
  if (!m) return;
  const i = m.players.indexOf(s);
  m.players.forEach((p, k) => { if (p !== s && !m.left[k]) push(p, { t: "relay", data, slot: i }); });
}

// ------------------------------------------------------------------ private rooms
const rooms = new Map(); // CODE -> {code, host, guests:[sessions], rules}
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genCode() {
  for (;;) {
    let c = "";
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
function roomPlayers(r) { return [r.host, ...r.guests]; }
function sendLobby(r) {
  const pl = roomPlayers(r);
  const names = pl.map((p) => p.user.name);
  const pfps = pl.map((p) => p.user.pfp);
  pl.forEach((p, i) => push(p, { t: "lobby", you: i === 0 ? "host" : "guest", players: names, pfps, host: r.host.user.name, code: r.code }));
}
function leaveRoom(s) {
  const r = s.room;
  if (!r) return;
  s.room = null;
  if (r.host === s) {
    rooms.delete(r.code);
    r.guests.forEach((g) => { g.room = null; push(g, { t: "lobby_closed", msg: r.host.user.name + " closed the room" }); });
  } else {
    r.guests = r.guests.filter((g) => g !== s);
    sendLobby(r);
  }
}
function joinRoom(s, code) {
  code = String(code || "").toUpperCase();
  const r = rooms.get(code);
  if (!r) { push(s, { t: "error", code: "room", msg: "room not found" }); return; }
  if (r.guests.length >= 3) { push(s, { t: "error", code: "room", msg: "room is full" }); return; }
  if (r.host === s || r.guests.indexOf(s) >= 0) { sendLobby(r); return; }
  leaveRoom(s); leaveQueue(s);
  r.guests.push(s); s.room = r;
  sendLobby(r);
}

// ------------------------------------------------------------------ chat / friends helpers
function chatMsgOf(u, text, sticker) {
  return { from: u.name, text: String(text || "").slice(0, 300), sticker: sticker || null, at: now(), owner: isOwner(u), badge: u.badge || "" };
}
const dmKey = (a, b) => [key(a), key(b)].sort().join("|");
function friendEntry(name) {
  const u = db.users[key(name)];
  return { name: u ? u.name : name, status: statusOf(name), pfp: u ? u.pfp : "default1", owner: u ? isOwner(u) : false, badge: u ? u.badge || "" : "" };
}
function sendFriends(s) {
  const u = s.user;
  const list = u.friends.map((n) => {
    const e = friendEntry(n);
    const thread = db.dms[dmKey(u.name, n)] || [];
    e.unread = thread.filter((m) => key(m.from) === key(n) && !m.read).length;
    return e;
  });
  push(s, { t: "friends", list, requests: u.requests.length });
}
function sendRequests(s) {
  push(s, { t: "friend_requests", list: s.user.requests.map(friendEntry) });
}

// ------------------------------------------------------------------ message handler
function handle(s, msg) {
  const u = s.user;
  switch (msg.t) {
    case "queue": leaveRoom(s); s._wm = msg.matchMods === true; s._q = { mods: Array.isArray(msg.mods) ? msg.mods : [] }; enqueue(s, msg); break;
    case "cancel": leaveQueue(s); break;
    case "relay": relay(s, msg.data); break;
    case "result": onResult(s, msg); break;
    case "leave": leaveQueue(s); if (s.match) leaveMatch(s); leaveRoom(s); break;
    case "bye": dropSession(s); break;
    case "cheat_flag": case "report": console.log("[report]", u.name, JSON.stringify(msg).slice(0, 300)); break;

    case "create_room": {
      leaveRoom(s); leaveQueue(s);
      let code = String(msg.code || "").toUpperCase();
      if (!code || rooms.has(code)) code = genCode();
      const r = { code, host: s, guests: [], rules: msg.rules || null };
      rooms.set(code, r); s.room = r;
      push(s, { t: "room_created", code });
      sendLobby(r);
      break;
    }
    case "join_room": joinRoom(s, msg.code); break;
    case "join_friend": {
      const t = online.get(key(msg.name));
      if (!t || !t.room || t.user.noJoin) push(s, { t: "error", code: "room", msg: msg.name + " isnt in a room you can join" });
      else joinRoom(s, t.room.code);
      break;
    }
    case "start_room": {
      const r = s.room;
      if (!r || r.host !== s) break;
      const pl = roomPlayers(r);
      if (pl.length < 2) break;
      rooms.delete(r.code);
      pl.forEach((p) => { p.room = null; });
      if (pl.length === 2) { pl[0]._wm = pl[1]._wm = false; startDuel(pl, 1, false, r.rules, null, null); }
      else startParty(pl, false, r.rules || {});
      break;
    }
    case "invite": {
      if (!s.room) break;
      const ok = pushTo(msg.name, { t: "invited", from: u.name, code: s.room.code });
      if (ok) push(s, { t: "invite_sent", to: msg.name });
      else push(s, { t: "friend_msg", msg: msg.name + " is offline" });
      break;
    }

    case "friends_list": sendFriends(s); break;
    case "friend_requests": sendRequests(s); break;
    case "friend_add": {
      const t = db.users[key(msg.name)];
      if (!t) { push(s, { t: "friend_msg", msg: "no player called " + msg.name + "!" }); break; }
      if (t === u) { push(s, { t: "friend_msg", msg: "thats you!" }); break; }
      if (u.friends.indexOf(t.name) >= 0) { push(s, { t: "friend_msg", msg: "already friends!" }); break; }
      if (t.noFR) { push(s, { t: "friend_msg", msg: t.name + " isnt taking friend requests!" }); break; }
      if (u.requests.indexOf(t.name) >= 0) { // they already asked us: just accept
        handle(s, { t: "friend_accept", name: t.name }); break;
      }
      if (t.requests.indexOf(u.name) < 0) { t.requests.push(u.name); save(); }
      pushTo(t.name, { t: "friend_request", from: u.name });
      push(s, { t: "friend_msg", msg: "request sent to " + t.name + "!" });
      break;
    }
    case "friend_accept": {
      const t = db.users[key(msg.name)];
      if (!t) break;
      u.requests = u.requests.filter((n) => key(n) !== key(t.name));
      if (u.friends.indexOf(t.name) < 0) u.friends.push(t.name);
      if (t.friends.indexOf(u.name) < 0) t.friends.push(u.name);
      save();
      push(s, { t: "friend_msg", msg: "u and " + t.name + " are friends now!" });
      sendFriends(s); sendRequests(s);
      const ts = online.get(key(t.name)); if (ts) sendFriends(ts);
      break;
    }
    case "friend_decline": {
      u.requests = u.requests.filter((n) => key(n) !== key(msg.name));
      save(); sendRequests(s); sendFriends(s);
      break;
    }
    case "friend_remove": {
      const t = db.users[key(msg.name)];
      u.friends = u.friends.filter((n) => key(n) !== key(msg.name));
      if (t) t.friends = t.friends.filter((n) => key(n) !== key(u.name));
      save();
      push(s, { t: "friend_msg", msg: "removed " + msg.name });
      sendFriends(s);
      const ts = t ? online.get(key(t.name)) : null; if (ts) sendFriends(ts);
      break;
    }

    case "gchat_join": s.gchat = true; push(s, { t: "gchat_history", msgs: db.gchat.slice(-60) }); break;
    case "gchat_leave": s.gchat = false; break;
    case "gchat_send": {
      const text = String(msg.text || "").trim();
      if (!text && !msg.sticker) break;
      const m = chatMsgOf(u, text, msg.sticker);
      db.gchat.push(m); if (db.gchat.length > 200) db.gchat.shift(); save();
      for (const o of online.values()) if (o.gchat) push(o, { t: "gchat_msg", msg: m });
      break;
    }
    case "chat_history": {
      const k2 = dmKey(u.name, msg.with);
      push(s, { t: "chat_history", with: msg.with, msgs: (db.dms[k2] || []).slice(-50) });
      (db.dms[k2] || []).forEach((m) => { if (key(m.from) !== key(u.name)) m.read = true; });
      break;
    }
    case "chat_read": {
      (db.dms[dmKey(u.name, msg.with)] || []).forEach((m) => { if (key(m.from) !== key(u.name)) m.read = true; });
      save();
      break;
    }
    case "chat_send": {
      const target = db.users[key(msg.to)];
      const text = String(msg.text || "").trim();
      if (!target || (!text && !msg.sticker)) break;
      const m = chatMsgOf(u, text, msg.sticker); m.to = target.name;
      const k2 = dmKey(u.name, target.name);
      (db.dms[k2] = db.dms[k2] || []).push(m);
      if (db.dms[k2].length > 100) db.dms[k2].shift();
      save();
      push(s, { t: "chat_msg", msg: m });
      pushTo(target.name, { t: "chat_msg", msg: m });
      break;
    }

    case "profile_get": push(s, { t: "profile", p: profileOf(u), noFR: u.noFR, noJoin: u.noJoin, nameLeft: Math.max(0, u.nameChanged + 30 * 86400000 - now()) }); break;
    case "profile_set": {
      if (typeof msg.pfp === "string") u.pfp = msg.pfp.slice(0, 20);
      if (typeof msg.noFR === "boolean") u.noFR = msg.noFR;
      if (typeof msg.noJoin === "boolean") u.noJoin = msg.noJoin;
      save();
      break;
    }
    case "change_name": {
      const nn = String(msg.newName || "");
      const left = u.nameChanged + 30 * 86400000 - now();
      if (!nameOk(nn)) { push(s, { t: "name_result", ok: false, msg: "3-16 letters, no spaces" }); break; }
      if (left > 0) { push(s, { t: "name_result", ok: false, msg: "u can only change ur name once a month" }); break; }
      if (db.users[key(nn)] && key(nn) !== key(u.name)) { push(s, { t: "name_result", ok: false, msg: "that name is taken" }); break; }
      delete db.users[key(u.name)];
      const old = u.name;
      u.name = nn; u.nameChanged = now();
      db.users[key(nn)] = u;
      for (const o of Object.values(db.users)) {
        o.friends = o.friends.map((n) => (n === old ? nn : n));
        o.requests = o.requests.map((n) => (n === old ? nn : n));
      }
      save();
      push(s, { t: "name_result", ok: true, name: nn, msg: "name changed to " + nn + "!" });
      break;
    }
    case "change_pass": {
      if (hashPass(String(msg.old || ""), u.salt) !== u.hash) { push(s, { t: "pass_result", ok: false, msg: "wrong old password" }); break; }
      const np = String(msg.pass || "");
      if (np.length < 6 || np.length > 64) { push(s, { t: "pass_result", ok: false, msg: "password needs at least 6 characters" }); break; }
      u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hashPass(np, u.salt); save();
      push(s, { t: "pass_result", ok: true, msg: "password changed!" });
      break;
    }

    case "spectate": push(s, { t: "error", code: "spectate", msg: "spectating isnt supported on this server" }); break;
    case "spectate_stop": break;
    default:
      if (String(msg.t).indexOf("admin_") === 0) push(s, { t: "error", code: "admin", msg: "not allowed" });
  }
}

// ------------------------------------------------------------------ HTTP
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 2e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch (e) { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Cache-Control": "no-store" });
  res.end(body);
}

function hello(msg) {
  if (msg.protocol !== PROTOCOL) return { error: { t: "error", code: "version", msg: "update the mod! (server wants protocol " + PROTOCOL + ")" } };
  if (db.settings.maintenance) return { error: { t: "error", code: "maintenance", msg: "SERVER UNDER MAINTENANCE, BE BACK SOON!" } };
  const u = db.users[key(msg.name)];
  if (!u || !msg.token || u.tokens.indexOf(msg.token) < 0) return { error: { t: "error", code: "auth", msg: "log in first" } };
  if (u.banned) return { error: { t: "error", code: "banned", msg: "u are banned" } };
  return { user: u };
}

async function onPoll(req, res) {
  const body = await readBody(req);
  if (!body) return send(res, 400, { error: "bad_json" });
  let s = body.sid ? sessions.get(body.sid) : null;
  const out = Array.isArray(body.out) ? body.out : [];
  const reply = { now: now() };
  if (!s) {
    if (body.sid) return send(res, 200, Object.assign(reply, { error: "bad_session", msgs: [] }));
    const hi = out.find((m) => m && m.t === "hello");
    if (!hi) return send(res, 200, Object.assign(reply, { msgs: [{ t: "error", code: "auth", msg: "no hello" }] }));
    const r = hello(hi);
    if (r.error) return send(res, 200, Object.assign(reply, { msgs: [r.error] }));
    s = newSession(r.user);
    push(s, { t: "welcome", name: r.user.name, owner: isOwner(r.user) });
    if (db.settings.announce) push(s, { t: "announce", msg: db.settings.announce.msg, id: db.settings.announce.id });
  }
  s.lastSeen = now();
  for (const m of out) { if (!m || m.t === "hello") continue; try { handle(s, m); } catch (e) { console.error("handle", m.t, e); } }
  reply.sid = s.sid;
  reply.msgs = s.outbox;
  s.outbox = [];
  send(res, 200, reply);
}

async function onAuth(req, res) {
  const b = await readBody(req);
  if (!b) return send(res, 400, { ok: false, error: "bad request" });
  if (b.protocol !== PROTOCOL) return send(res, 200, { ok: false, error: "update the mod!" });
  const name = String(b.name || ""), pass = String(b.password || "");
  if (!nameOk(name)) return send(res, 200, { ok: false, error: "3-16 letters, no spaces" });
  if (pass.length < 6 || pass.length > 64) return send(res, 200, { ok: false, error: "password needs at least 6 characters" });
  let u = db.users[key(name)];
  if (!u) {
    u = newUser(name, pass);
    db.users[key(name)] = u;
  } else if (hashPass(pass, u.salt) !== u.hash) return send(res, 200, { ok: false, error: "wrong password" });
  if (u.banned) return send(res, 200, { ok: false, error: "u are banned" });
  const token = crypto.randomBytes(24).toString("hex");
  u.tokens.push(token); if (u.tokens.length > 8) u.tokens.shift();
  save();
  send(res, 200, { ok: true, name: u.name, token });
}

function onLeaderboard(url, res) {
  const me = key(url.searchParams.get("me") || "");
  const all = Object.values(db.users).filter((u) => u.w + u.l > 0 && !u.banned).sort((a, b) => b.rating - a.rating || b.w - a.w);
  const top = all.slice(0, 50).map(profileOf);
  const out = { top };
  const mu = db.users[me];
  if (mu) {
    const p = profileOf(mu);
    const idx = all.indexOf(mu);
    if (idx >= 0) p.place = idx + 1;
    out.me = p;
  }
  send(res, 200, out);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (url.pathname === "/poll" && req.method === "POST") return onPoll(req, res);
    if (url.pathname === "/auth" && req.method === "POST") return onAuth(req, res);
    if (url.pathname === "/online") {
      const o = { online: online.size, maintenance: db.settings.maintenance === true };
      if (db.settings.announce) o.announce = db.settings.announce.msg, o.announceId = db.settings.announce.id;
      if (db.settings.news) o.news = db.settings.news;
      return send(res, 200, o);
    }
    if (url.pathname === "/leaderboard") return onLeaderboard(url, res);
    if (url.pathname === "/" || url.pathname === "/health") return send(res, 200, { ok: true, protocol: PROTOCOL });
    // mod transfer routes are not implemented: the game falls back to GameBanana
    if (/^\/(modprep|modstatus|modfile|modchunk|sc)$/.test(url.pathname)) return send(res, 200, { ok: false, error: "mod transfer not supported on this server" });
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "server error" });
  }
});
server.listen(PORT, () => console.log("FNF Online server on :" + PORT + " (protocol " + PROTOCOL + ")"));
