/*************************************************************
 * Karmo Ka HisabKitab: secure data service
 * The GitHub dashboard sends the visitor's Google sign-in token here.
 * Data is returned ONLY to verified @lpu.co.in accounts.
 * The Google Sheet itself stays private (Restricted).
 *************************************************************/
var CONFIG = {
  SHEET_TAB: "Imported Claimed Data",
  DOMAIN: "lpu.co.in",
  CLIENT_ID: "417974248161-sp1ocl4mgqb1lk7haj8ft3vs5unh7pqg.apps.googleusercontent.com",
  CACHE_SECONDS: 300,     // the sheets are re-read at most every 5 minutes
  DUTY_ID: "1v19nIC8pKEmCdDVti_k_1lj1GSb38KTZKATqesy9t4k",   // DOC Duty List (stays private)
  DUTY_TAB: "TL Bifurcation",
  HISTORY_TAB: "Roster history",  // created automatically in the claims sheet; remembers people who leave
  APPS_ID: "16N0ADdcClqeUUV-XkMxnIyUB5HYaTyPAjUJU1EsUVl8",   // application assignment sheet (stays private)
  APPS_TAB: ""                     // blank = first tab of that sheet
};

/* Sheet columns sent to the dashboard (nothing else leaves the sheet)
   ts   name uid  claim app  astra paid drona final fired sarathi month */
var COLS = ["A", "M", "L", "E", "C", "N", "Q", "J", "V", "W", "I", "O"];
var DICT_FIELDS = {claim: 3, drona: 7, final: 8, fired: 9, sarathi: 10, month: 11};

/* ---------- Web entry points ---------- */
function doPost(e){
  var req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || "{}"); } catch (err) {}
  try {
    var user = verifyToken_(req.token);
    if (!user) return json_({ok: false, error: "auth", message: "Please sign in with your @" + CONFIG.DOMAIN + " Google account."});
    if (req.fresh) dropIfOlder_(req.what === "apps" ? "ha_" : "hk_", 30);   // Refresh button: rebuild from the sheets
    if (req.what === "apps"){                                       // Application Follow-up page
      var me = emailToUid_()[user.email] || "";
      return json_({ok: true, gz: getPackedApps_(), me: me});
    }
    return json_({ok: true, gz: getPacked_()});
  } catch (err) {
    return json_({ok: false, error: "server", message: String(err && err.message || err)});
  }
}
function doGet(){
  return json_({ok: false, error: "info", message: "This is a data service. Open the Karmo Ka HisabKitab dashboard instead."});
}
function json_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Sign-in check ---------- */
function verifyToken_(token){
  if (!token || typeof token !== "string" || token.length > 5000) return null;
  var cache = CacheService.getScriptCache();
  var key = "tok_" + Utilities.base64EncodeWebSafe(
              Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var res = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token),
                              {muteHttpExceptions: true});
  if (res.getResponseCode() !== 200) return null;
  var info = JSON.parse(res.getContentText());
  var email = String(info.email || "").toLowerCase();
  var now = Math.floor(Date.now() / 1000);
  var ok = info.aud === CONFIG.CLIENT_ID &&
           (info.iss === "accounts.google.com" || info.iss === "https://accounts.google.com") &&
           String(info.email_verified) === "true" &&
           info.hd === CONFIG.DOMAIN &&
           email.slice(-(CONFIG.DOMAIN.length + 1)) === "@" + CONFIG.DOMAIN &&
           Number(info.exp) > now;
  if (!ok) return null;
  var user = {email: email};
  var ttl = Math.min(CONFIG.CACHE_SECONDS, Number(info.exp) - now);
  if (ttl > 10) cache.put(key, JSON.stringify(user), ttl);
  return user;
}

/* ---------- Data: read once, compress, cache ---------- */
function getPacked_(){
  var cache = CacheService.getScriptCache();
  var cached = readCache_(cache);
  if (cached) return cached;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    cached = readCache_(cache);          // another visitor may have just built it
    if (cached) return cached;
    var data = buildData_();
    var gz = Utilities.base64Encode(
               Utilities.gzip(Utilities.newBlob(JSON.stringify(data), "application/json")).getBytes());
    writeCache_(cache, gz);
    return gz;
  } finally { lock.releaseLock(); }
}

function buildData_(){
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_TAB);
  if (!sh) throw new Error('Tab "' + CONFIG.SHEET_TAB + '" not found.');
  var last = sh.getLastRow();
  var colText = {}, tsVals = [], paidVals = [];
  if (last >= 2){
    COLS.forEach(function(c){
      colText[c] = sh.getRange(c + "2:" + c + last).getDisplayValues().map(function(r){ return String(r[0]).trim(); });
    });
    tsVals = sh.getRange("A2:A" + last).getValues().map(function(r){ return r[0]; });
    paidVals = sh.getRange("Q2:Q" + last).getValues().map(function(r){ return r[0]; });
  }
  var dicts = {}, index = {};
  Object.keys(DICT_FIELDS).forEach(function(k){ dicts[k] = []; index[k] = {}; });
  function code(field, value){
    if (!(value in index[field])){ index[field][value] = dicts[field].length; dicts[field].push(value); }
    return index[field][value];
  }
  function ms(v){ return v instanceof Date ? v.getTime() : 0; }

  var rows = [];
  var n = last >= 2 ? last - 1 : 0;
  for (var i = 0; i < n; i++){
    var name = colText.M[i], app = colText.C[i], tsText = colText.A[i];
    if (!tsText && !name && !app) continue;
    rows.push([ms(tsVals[i]), name, colText.L[i], code("claim", colText.E[i]), app, colText.N[i],
               colText.Q[i], ms(paidVals[i]), code("drona", colText.J[i]), code("final", colText.V[i]),
               code("fired", colText.W[i]), code("sarathi", colText.I[i]), code("month", colText.O[i])]);
  }
  var roster = [], rosterNote = "";
  try { roster = buildRoster_(); } catch (e) { rosterNote = String(e && e.message || e); }
  return {
    v: 2,
    updated: Utilities.formatDate(new Date(), "Asia/Kolkata", "dd-MMM-yyyy hh:mm a"),
    count: rows.length,
    roster: roster,
    rosterFields: ["uid", "name", "role", "coord", "sim", "skill", "tlUid", "tlName", "active", "lastSeen"],
    rosterNote: rosterNote,
    fields: ["ts", "name", "uid", "claim", "app", "astra", "paid", "paidTs",
             "drona", "final", "fired", "sarathi", "month"],
    dict: dicts,
    rows: rows
  };
}

/* ---------- Team roster (TL Bifurcation) + automatic history of people who left ---------- */
var H_HEAD = ["UID", "Name", "Role", "Coordinator", "Having SIM", "Skill", "Team Leader UID", "Team Leader Name", "First seen", "Last seen"];

/* Columns are found by their header names, so inserting or moving columns doesn't break anything.
   The Email column is never read. */
var DUTY_COLS = [
  {key: "uid",    test: /^(your\s*)?uid$/i},
  {key: "name",   test: /^name$/i},
  {key: "role",   test: /^role$/i},
  {key: "coord",  test: /coordinator/i},
  {key: "sim",    test: /\bsim\b/i},
  {key: "skill",  test: /^skill/i},
  {key: "tlUid",  test: /team\s*leader\s*uid/i},
  {key: "tlName", test: /team\s*leader\s*name/i}
];
function hasSim_(v){
  var s = String(v || "").trim().toLowerCase();
  return s && !/^(na|n\/a|nil|none|no|-|0)$/.test(s) ? "Yes" : "";
}

function readDuty_(){
  var sh = SpreadsheetApp.openById(CONFIG.DUTY_ID).getSheetByName(CONFIG.DUTY_TAB);
  if (!sh) throw new Error('Tab "' + CONFIG.DUTY_TAB + '" not found in the duty list.');
  var last = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (last < 2) return [];
  var head = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function(h){ return String(h).replace(/\s+/g, " ").trim(); });
  var idx = {};
  DUTY_COLS.forEach(function(c){
    for (var i = 0; i < head.length; i++){ if (c.test.test(head[i])){ idx[c.key] = i; break; } }
  });
  ["uid", "name", "role", "coord", "skill", "tlUid", "tlName"].forEach(function(k){
    if (!(k in idx)) throw new Error('Column for "' + k + '" not found in ' + CONFIG.DUTY_TAB + ' headers.');
  });
  var vals = sh.getRange(2, 1, last - 1, lastCol).getDisplayValues();
  var out = [];
  vals.forEach(function(r){
    var g = function(k){ return k in idx ? String(r[idx[k]]).trim() : ""; };
    var uid = g("uid");
    if (!/^\d+$/.test(uid)) return;
    // Same 8-column layout as before; the 5th value is now "Having SIM" (Yes / blank)
    out.push([uid, g("name"), g("role"), g("coord"), hasSim_(g("sim")), g("skill"), g("tlUid"), g("tlName")]);
  });
  return out;
}

function buildRoster_(){
  var current = readDuty_();
  var today = Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd");
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hs = ss.getSheetByName(CONFIG.HISTORY_TAB);
  if (!hs){
    hs = ss.insertSheet(CONFIG.HISTORY_TAB);
    hs.setFrozenRows(1);
  }
  hs.getRange(1, 1, 1, H_HEAD.length).setValues([H_HEAD]).setFontWeight("bold");
  var hLast = hs.getLastRow();
  var hist = hLast >= 2 ? hs.getRange(2, 1, hLast - 1, H_HEAD.length).getDisplayValues() : [];
  var byUid = {};
  hist.forEach(function(r, i){ if (r[0]) byUid[r[0]] = i; });
  var before = JSON.stringify(hist), activeSet = {};

  current.forEach(function(r){
    activeSet[r[0]] = true;
    if (r[0] in byUid){
      var h = hist[byUid[r[0]]];
      for (var k = 0; k < 8; k++) h[k] = r[k];   // latest details
      h[9] = today;                               // last seen on the duty list
    } else {
      byUid[r[0]] = hist.length;
      hist.push(r.slice(0, 8).concat([today, today]));
    }
  });
  if (JSON.stringify(hist) !== before && hist.length){
    hs.getRange(2, 1, hist.length, H_HEAD.length).setNumberFormat("@").setValues(hist);
  }
  return hist.map(function(h){
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], activeSet[h[0]] ? 1 : 0, h[9]];
  });
}

/* ---------- Clearing saved copies (Refresh button and sheet edits) ---------- */
function dropIfOlder_(pre, seconds){
  var cache = CacheService.getScriptCache();
  var at = parseInt(cache.get(pre + "at"), 10) || 0;
  if (Date.now() - at > seconds * 1000) cache.removeAll([pre + "n", "em_map"]);
}
function clearCaches_(){ CacheService.getScriptCache().removeAll(["hk_n", "ha_n", "em_map"]); }
/* Runs automatically when TL Bifurcation, the claims sheet or the assignment sheet changes */
function onSheetChange(e){ clearCaches_(); }
/* Run ONCE from the editor: installs the "clear on edit" triggers (safe to run again) */
function installTriggers(){
  ScriptApp.getProjectTriggers().forEach(function(t){ if (t.getHandlerFunction() === "onSheetChange") ScriptApp.deleteTrigger(t); });
  var done = [];
  [["Claims sheet", SpreadsheetApp.getActiveSpreadsheet().getId()], ["TL Bifurcation", CONFIG.DUTY_ID], ["Assignment sheet", CONFIG.APPS_ID]].forEach(function(x){
    try { ScriptApp.newTrigger("onSheetChange").forSpreadsheet(x[1]).onChange().create(); done.push(x[0] + ": OK"); }
    catch (err) { done.push(x[0] + ": NOT SET (" + err.message + ")"); }
  });
  Logger.log("Clear-on-edit triggers -> " + done.join(" | "));
}

function writeCache_(cache, b64){
  try {
    var size = 90000, parts = {}, n = 0;
    for (var i = 0; i < b64.length; i += size){ parts["hk_" + n] = b64.substr(i, size); n++; }
    cache.putAll(parts, CONFIG.CACHE_SECONDS);
    cache.put("hk_n", String(n), CONFIG.CACHE_SECONDS);
    cache.put("hk_at", String(Date.now()), CONFIG.CACHE_SECONDS);
  } catch (e) { /* too big to cache: next request reads the sheet again */ }
}
function readCache_(cache){
  var n = parseInt(cache.get("hk_n"), 10);
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push("hk_" + i);
  var got = cache.getAll(keys), out = "";
  for (var j = 0; j < n; j++){ if (!got[keys[j]]) return null; out += got[keys[j]]; }
  return out;
}

/* ---------- Application assignments (Application Follow-up page) ---------- */
/* Columns are found by header name; User Id is never read. */
var APP_COLS = [
  {key: "form",      test: /form\s*name/i},
  {key: "app",       test: /application\s*no/i},
  {key: "pay",       test: /payment\s*date/i, date: true},
  {key: "tl",        test: /^team\s*leader/i},
  {key: "assigned",  test: /assigned\s*on/i, date: true},
  {key: "schol",     test: /scholar/i},
  {key: "phase",     test: /^phase/i},
  {key: "program",   test: /application\s*program/i},
  {key: "pskill",    test: /program\s*skill/i},
  {key: "type",      test: /application\s*type/i},
  {key: "elig",      test: /eligib/i},
  {key: "enrol",     test: /enrol+ment\s*status/i},
  {key: "enrolDate", test: /enrol+ment\s*date/i, date: true}
];
var APP_DICT = ["form", "tl", "schol", "phase", "program", "pskill", "type", "elig", "enrol"];

/* Email -> UID from the duty list's Email column. Used only on the server; emails are never sent to the page. */
function emailToUid_(){
  var cache = CacheService.getScriptCache(), hit = cache.get("em_map");
  if (hit) return JSON.parse(hit);
  var map = {};
  try {
    var sh = SpreadsheetApp.openById(CONFIG.DUTY_ID).getSheetByName(CONFIG.DUTY_TAB);
    var last = sh.getLastRow(), lastCol = sh.getLastColumn();
    var head = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function(h){ return String(h).trim(); });
    var iU = -1, iE = -1;
    head.forEach(function(h, i){ if (iU < 0 && /^(your\s*)?uid$/i.test(h)) iU = i; if (iE < 0 && /e-?mail/i.test(h)) iE = i; });
    if (iU >= 0 && iE >= 0 && last >= 2){
      sh.getRange(2, 1, last - 1, lastCol).getDisplayValues().forEach(function(r){
        var e = String(r[iE]).trim().toLowerCase(), u = String(r[iU]).trim();
        if (e && /^\d+$/.test(u)) map[e] = u;
      });
    }
  } catch (err) {}
  try { cache.put("em_map", JSON.stringify(map), CONFIG.CACHE_SECONDS); } catch (err) {}
  return map;
}
function uidForTl_(text, map){
  var t = String(text || "").trim();
  if (t.indexOf("@") < 0) return t;                                  // names like "Monika-TL-DC-31971" are kept as they are
  var u = map[t.toLowerCase()];
  if (u) return u;
  var m = t.split("@")[0].match(/(\d{4,})/);
  return m ? m[1] : t.split("@")[0];                                 // never send the full email
}

function buildApps_(){
  var ss = SpreadsheetApp.openById(CONFIG.APPS_ID);
  var sh = CONFIG.APPS_TAB ? ss.getSheetByName(CONFIG.APPS_TAB) : ss.getSheets()[0];
  if (!sh) throw new Error("Application sheet tab not found.");
  var last = sh.getLastRow(), lastCol = sh.getLastColumn();
  var head = lastCol ? sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function(h){ return String(h).replace(/\s+/g, " ").trim(); }) : [];
  var idx = {};
  APP_COLS.forEach(function(c){ for (var i = 0; i < head.length; i++){ if (c.test.test(head[i])){ idx[c.key] = i; break; } } });
  if (!("app" in idx) || !("tl" in idx)) throw new Error('Columns "Application No" and "Team Leader" are needed in the application sheet.');
  var text = last >= 2 ? sh.getRange(2, 1, last - 1, lastCol).getDisplayValues() : [];
  var vals = last >= 2 ? sh.getRange(2, 1, last - 1, lastCol).getValues() : [];
  var dicts = {}, index = {};
  APP_DICT.forEach(function(k){ dicts[k] = []; index[k] = {}; });
  function code(k, v){ if (!(v in index[k])){ index[k][v] = dicts[k].length; dicts[k].push(v); } return index[k][v]; }
  var fields = APP_COLS.map(function(c){ return c.key; });
  var emap = emailToUid_();
  var rows = [];
  for (var r = 0; r < text.length; r++){
    var get = function(k){ return k in idx ? String(text[r][idx[k]]).trim() : ""; };
    if (!get("app")) continue;
    rows.push(APP_COLS.map(function(c){
      if (c.date){ var v = c.key in idx ? vals[r][idx[c.key]] : ""; return v instanceof Date ? v.getTime() : 0; }
      var t = get(c.key);
      if (c.key === "tl") t = uidForTl_(t, emap);                     // team leader email -> UID
      return APP_DICT.indexOf(c.key) >= 0 ? code(c.key, t) : t;
    }));
  }
  var roster = [], rosterNote = "";
  try { roster = buildRoster_(); } catch (e) { rosterNote = String(e && e.message || e); }
  return {
    v: 1,
    updated: Utilities.formatDate(new Date(), "Asia/Kolkata", "dd-MMM-yyyy hh:mm a"),
    count: rows.length, fields: fields, dict: dicts, rows: rows,
    found: APP_COLS.filter(function(c){ return c.key in idx; }).map(function(c){ return c.key; }),
    roster: roster, rosterNote: rosterNote,
    rosterFields: ["uid", "name", "role", "coord", "sim", "skill", "tlUid", "tlName", "active", "lastSeen"]
  };
}

function getPackedApps_(){
  var cache = CacheService.getScriptCache();
  var cached = readCacheP_(cache, "ha_");
  if (cached) return cached;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    cached = readCacheP_(cache, "ha_");
    if (cached) return cached;
    var gz = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(buildApps_()), "application/json")).getBytes());
    writeCacheP_(cache, "ha_", gz);
    return gz;
  } finally { lock.releaseLock(); }
}
function writeCacheP_(cache, pre, b64){
  try {
    var size = 90000, parts = {}, n = 0;
    for (var i = 0; i < b64.length; i += size){ parts[pre + n] = b64.substr(i, size); n++; }
    cache.putAll(parts, CONFIG.CACHE_SECONDS);
    cache.put(pre + "n", String(n), CONFIG.CACHE_SECONDS);
    cache.put(pre + "at", String(Date.now()), CONFIG.CACHE_SECONDS);
  } catch (e) {}
}
function readCacheP_(cache, pre){
  var n = parseInt(cache.get(pre + "n"), 10);
  if (!n) return null;
  var keys = []; for (var i = 0; i < n; i++) keys.push(pre + i);
  var got = cache.getAll(keys), out = "";
  for (var j = 0; j < n; j++){ if (!got[keys[j]]) return null; out += got[keys[j]]; }
  return out;
}

/* ---------- Run once from the editor to check setup (View > Execution log) ---------- */
function testSetup(){
  var d = buildData_();
  var gz = Utilities.gzip(Utilities.newBlob(JSON.stringify(d), "application/json")).getBytes();
  Logger.log("Claims read: " + d.count + " | compressed size: " + Math.round(gz.length / 1024) + " KB");
  var active = d.roster.filter(function(r){ return r[8] === 1; }).length;
  var sims = d.roster.filter(function(r){ return r[8] === 1 && r[4] === "Yes"; }).length;
  Logger.log("Having SIM: " + sims + " of " + active + " people on the duty list");
  Logger.log("Roster: " + active + " on the duty list, " + (d.roster.length - active) + " remembered as left" +
             (d.rosterNote ? " | NOTE: " + d.rosterNote : ""));
  UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=test", {muteHttpExceptions: true});
  try {
    var a = buildApps_();
    var agz = Utilities.gzip(Utilities.newBlob(JSON.stringify(a), "application/json")).getBytes();
    var missing = APP_COLS.filter(function(c){ return a.found.indexOf(c.key) < 0; }).map(function(c){ return c.key; });
    Logger.log("Applications read: " + a.count + " | compressed size: " + Math.round(agz.length / 1024) + " KB");
    Logger.log("Application columns found: " + a.found.length + " of " + APP_COLS.length + (missing.length ? " | missing: " + missing.join(", ") : ""));
  } catch (e) { Logger.log("Applications: NOT READ | " + e.message); }
  Logger.log("Setup OK. Now deploy as a web app.");
}
