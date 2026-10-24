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
   ts   name uid  claim app  astra paid drona final fired sarathi month rebuttal */
var COLS = ["A", "M", "L", "E", "C", "N", "Q", "J", "V", "W", "I", "O", "X", "F"];
var DICT_FIELDS = {claim: 3, drona: 7, final: 8, fired: 9, sarathi: 10, month: 11, rebuttal: 12, mode: 13};

/* ---------- Web entry points ---------- */
function doPost(e){
  var req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || "{}"); } catch (err) {}
  try {
    var user = verifyToken_(req.token);
    if (!user) return json_({ok: false, error: "auth", message: "Please sign in with your @" + CONFIG.DOMAIN + " Google account."});
    if (req.what === "ping"){ logVisit_(user.email, req.page); return json_({ok: true}); }   // page opened (usage report)
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

/* ---------- Lead conversion (Meritto -> BigQuery, filled daily by the leads-job in Google Cloud) ----------
   Reads only the lead_summary view: counts per day (Lead Assignment Date) and counselor UID. No lead-level data.
   Needs: Apps Script linked to project 417974248161 and the BigQuery advanced service added (Services > BigQuery API). */
var LEADS_BQ = {project: "karmo-ka-hisabkitab", location: "asia-south1",
                view: "karmo-ka-hisabkitab.hisabkitab_leads.lead_summary", days: 400};
function leadSummary_(){
  try {
    var req = {query: "SELECT UNIX_MILLIS(TIMESTAMP(day, 'Asia/Kolkata')) AS d, uid, leads, converted, admitted FROM `" +
                      LEADS_BQ.view + "` WHERE day >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL " + LEADS_BQ.days + " DAY)",
               useLegacySql: false, location: LEADS_BQ.location, timeoutMs: 30000};
    var res = BigQuery.Jobs.query(req, LEADS_BQ.project), jobId = res.jobReference.jobId, rows = [], tries = 0;
    while (!res.jobComplete && tries++ < 40){
      Utilities.sleep(500);
      res = BigQuery.Jobs.getQueryResults(LEADS_BQ.project, jobId, {location: LEADS_BQ.location});
    }
    if (!res.jobComplete) throw new Error("query did not finish in time");
    var add = function(list){ (list || []).forEach(function(x){
      rows.push([Number(x.f[0].v), String(x.f[1].v), Number(x.f[2].v) || 0, Number(x.f[3].v) || 0, Number(x.f[4].v) || 0]); }); };
    add(res.rows);
    var token = res.pageToken;
    while (token){
      var page = BigQuery.Jobs.getQueryResults(LEADS_BQ.project, jobId, {pageToken: token, location: LEADS_BQ.location});
      add(page.rows); token = page.pageToken;
    }
    return rows;
  } catch (e) {
    Logger.log("Lead summary not available: " + e.message);
    return null;                                                  // the dashboard still works without it
  }
}

function buildData_(){
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_TAB);
  if (!sh) throw new Error('Tab "' + CONFIG.SHEET_TAB + '" not found.');
  var last = sh.getLastRow();
  var colText = {}, tsVals = [], paidVals = [], s1Vals = [], s2Vals = [];
  if (last >= 2){
    COLS.forEach(function(c){
      colText[c] = sh.getRange(c + "2:" + c + last).getDisplayValues().map(function(r){ return String(r[0]).trim(); });
    });
    tsVals = sh.getRange("A2:A" + last).getValues().map(function(r){ return r[0]; });
    paidVals = sh.getRange("Q2:Q" + last).getValues().map(function(r){ return r[0]; });
    s1Vals = sh.getRange("S2:S" + last).getValues().map(function(r){ return r[0]; });   // Step-1 check date
    s2Vals = sh.getRange("U2:U" + last).getValues().map(function(r){ return r[0]; });   // Step-2 check date & time
  }
  var dicts = {}, index = {};
  Object.keys(DICT_FIELDS).forEach(function(k){ dicts[k] = []; index[k] = {}; });
  function code(field, value){
    if (!(value in index[field])){ index[field][value] = dicts[field].length; dicts[field].push(value); }
    return index[field][value];
  }
  function ms(v){ return v instanceof Date ? v.getTime() : 0; }
  /* Dates written as text, e.g. "14-Oct-2026", "14-Oct-2026 14:32:03" or "14/10/2026 14:32" (India time) */
  var MON = {jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11};
  function anyMs(v){
    if (v instanceof Date) return v.getTime();
    var t = String(v || "").trim(); if (!t) return 0;
    var m = t.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3}|\d{1,2})[-\/\s](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i);
    if (!m) return 0;
    var mon = isNaN(m[2]) ? MON[m[2].toLowerCase()] : Number(m[2]) - 1, h = Number(m[4] || 0);
    if (m[7]){ var pm = /pm/i.test(m[7]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    if (mon === undefined) return 0;
    return Date.UTC(Number(m[3]), mon, Number(m[1]), h, Number(m[5] || 0), Number(m[6] || 0)) - 330 * 60000;   // IST -> UTC
  }

  var rows = [];
  var n = last >= 2 ? last - 1 : 0;
  for (var i = 0; i < n; i++){
    var name = colText.M[i], app = colText.C[i], tsText = colText.A[i];
    if (!tsText && !name && !app) continue;
    rows.push([ms(tsVals[i]), name, colText.L[i], code("claim", colText.E[i]), app, colText.N[i],
               colText.Q[i], ms(paidVals[i]), code("drona", colText.J[i]), code("final", colText.V[i]),
               code("fired", colText.W[i]), code("sarathi", colText.I[i]), code("month", colText.O[i]),
               code("rebuttal", colText.X[i]),                        // X: rebuttal status (Accepted / Rejected / Pending / blank)
               anyMs(s1Vals[i]), anyMs(s2Vals[i]),                    // S: Step-1 check date, U: Step-2 check date & time
               code("mode", colText.F[i])]);                          // F: Mode of conversion (e.g. Ameyo call)
  }
  var roster = [], rosterNote = "";
  try { roster = buildRoster_(); } catch (e) { rosterNote = String(e && e.message || e); }
  var lead = leadsWithBackup_();
  return {
    v: 2,
    updated: Utilities.formatDate(new Date(), "Asia/Kolkata", "dd-MMM-yyyy hh:mm a"),
    count: rows.length,
    roster: roster,
    rosterFields: ["uid", "name", "role", "coord", "sim", "skill", "tlUid", "tlName", "active", "lastSeen"],
    rosterNote: rosterNote,
    leads: lead.rows,                                             // counts per day and counselor UID (BigQuery, else last good copy)
    leadFields: ["day", "uid", "leads", "converted", "admitted"],
    leadsAsOf: lead.asOf, leadsStale: lead.stale,
    fields: ["ts", "name", "uid", "claim", "app", "astra", "paid", "paidTs",
             "drona", "final", "fired", "sarathi", "month", "rebuttal", "s1date", "s2date", "mode"],
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
/* ---------- Dashboard usage (who opened which page; private sheet in the owner's Drive) ---------- */
var USAGE_KEEP_DAYS = 90;
var PAGE_NAMES = {index: "Astra Claim Status", teams: "Team Performance", structure: "Team Structure", apps: "Team Leaders Stats"};
function usageBook_(){
  var props = PropertiesService.getScriptProperties(), id = props.getProperty("USAGE_ID"), ss = null;
  if (id){ try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss){
    ss = SpreadsheetApp.create("HisabKitab dashboard usage (private)");
    var v = ss.getSheets()[0]; v.setName("Visits");
    v.getRange(1, 1, 1, 5).setValues([["Date", "First opened", "Email", "UID", "Page"]]).setFontWeight("bold"); v.setFrozenRows(1);
    var sm = ss.insertSheet("Daily summary");
    sm.getRange("A1").setFormula('=IFERROR(QUERY(UNIQUE({Visits!A2:A, Visits!C2:C}), "select Col1, count(Col2) where Col1 is not null group by Col1 order by Col1 desc label Col1 \'Date\', count(Col2) \'People who opened\'", 0), "No visits yet")');
    ss.insertSheet("Not opened yet");
    props.setProperty("USAGE_ID", ss.getId());
  }
  return ss;
}
function logVisit_(email, page){
  page = PAGE_NAMES[String(page || "").replace(/[^a-z]/gi, "")] || "Other";
  var day = Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd");
  var cache = CacheService.getScriptCache(), key = "v:" + email + ":" + page + ":" + day;
  if (cache.get(key)) return;                                  // already recorded today for this page
  cache.put(key, "1", 21600);
  var lock = LockService.getScriptLock(); if (!lock.tryLock(5000)) return;
  try {
    var m = String(email).split("@")[0].match(/(\d{4,})/);
    usageBook_().getSheetByName("Visits").appendRow([day, Utilities.formatDate(new Date(), "Asia/Kolkata", "HH:mm"), email, m ? m[1] : "", page]);
  } finally { lock.releaseLock(); }
}
/* Daily: "Not opened yet" list (team members from TL Bifurcation with no visit at all) and 90-day clean-up */
function usageDaily(){
  var ss = usageBook_(), v = ss.getSheetByName("Visits"), last = v.getLastRow();
  var rows = last >= 2 ? v.getRange(2, 1, last - 1, 5).getValues() : [];
  var cutoff = Utilities.formatDate(new Date(Date.now() - USAGE_KEEP_DAYS * 864e5), "Asia/Kolkata", "yyyy-MM-dd");
  var keep = rows.filter(function(r){ var d = r[0] instanceof Date ? Utilities.formatDate(r[0], "Asia/Kolkata", "yyyy-MM-dd") : String(r[0]); return d >= cutoff; });
  if (keep.length !== rows.length){ v.getRange(2, 1, Math.max(rows.length, 1), 5).clearContent(); if (keep.length) v.getRange(2, 1, keep.length, 5).setValues(keep); }
  var seenEmail = {}, seenUid = {};
  keep.forEach(function(r){ seenEmail[String(r[2]).toLowerCase()] = true; if (r[3]) seenUid[String(r[3])] = true; });
  var emap = emailToUid_(), uidSeen = {};
  Object.keys(emap).forEach(function(e){ if (seenEmail[e]) uidSeen[emap[e]] = true; });
  var out = [["UID", "Name", "Role", "Coordinator", "Skill"]];
  readDuty_().forEach(function(r){ if (!uidSeen[r[0]] && !seenUid[r[0]]) out.push([r[0], r[1], r[2], r[3], r[5]]); });
  var n = ss.getSheetByName("Not opened yet"); n.clearContents();
  n.getRange(1, 1, out.length, 5).setValues(out); n.getRange(1, 1, 1, 5).setFontWeight("bold"); n.setFrozenRows(1);
  n.getRange(1, 7).setValue("Updated " + Utilities.formatDate(new Date(), "Asia/Kolkata", "dd-MMM-yyyy HH:mm") + " | " + (out.length - 1) + " people have not opened the dashboard in the last " + USAGE_KEEP_DAYS + " days");
}
/* Run ONCE: switches on the usage report (creates the private sheet and a daily 7 AM update) */
function setupUsage(){
  var ss = usageBook_();
  ScriptApp.getProjectTriggers().forEach(function(t){ if (t.getHandlerFunction() === "usageDaily") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("usageDaily").timeBased().atHour(7).everyDays(1).inTimezone("Asia/Kolkata").create();
  usageDaily();
  Logger.log("Usage report ON. Private sheet: " + ss.getUrl());
}

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
  {key: "enrolDate", test: /enrol+ment\s*date/i, date: true},
  {key: "examSlot",  test: /exam\s*slot/i},                 // shown as written; blank = slot booking pending
  {key: "intDate",   test: /interview\s*date/i},            // MBA / PhD only; blank = slot booking pending
  {key: "intResult", test: /interview\s*result/i}           // "Pass" = pass
];
var APP_DICT = ["form", "tl", "schol", "phase", "program", "pskill", "type", "elig", "enrol", "intResult"];

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

/* Check: is the rebuttal status (column X) being read? Run from the editor, see the Execution log */
function testRebuttal(){
  var d = buildData_(), fi = d.fields.indexOf("rebuttal"), ai = d.fields.indexOf("astra");
  if (fi < 0){ Logger.log("Column X is NOT being read."); return; }
  var n = 0;
  d.rows.forEach(function(r){ var v = d.dict.rebuttal[r[fi]]; if (v) n++; if (String(r[ai]) === "12") Logger.log("Astra ID 12 -> rebuttal: '" + v + "'"); });
  Logger.log("Claims with a rebuttal status: " + n);
}

/* Check: are the Step-1 (S) and Step-2 (U) check dates being read? Run from the editor, see the Execution log */
function testTAT(){
  var d = buildData_(), f1 = d.fields.indexOf("s1date"), f2 = d.fields.indexOf("s2date");
  if (f1 < 0){ Logger.log("Columns S and U are NOT being read."); return; }
  var n1 = 0, n2 = 0; d.rows.forEach(function(r){ if (r[f1]) n1++; if (r[f2]) n2++; });
  Logger.log("Claims: " + d.rows.length + " | with Step-1 date: " + n1 + " | with Step-2 date: " + n2);
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_TAB);
  var s = sh.getRange("S1:S6").getValues(), u = sh.getRange("U1:U6").getValues();
  for (var i = 0; i < 6; i++) Logger.log("Row " + (i + 1) + " | S: " + JSON.stringify(s[i][0]) + " | U: " + JSON.stringify(u[i][0]));
}

/* Last good copy of the lead summary (counts only), kept on a tab of the private usage spreadsheet.
   Saved at most once an hour; used whenever BigQuery cannot be read, so the dashboard keeps the old numbers. */
var LEAD_BACKUP_TAB = "Lead summary (last good)";
function leadsWithBackup_(){
  var props = PropertiesService.getScriptProperties();
  var rows = leadSummary_(), now = new Date();
  if (rows && rows.length){
    var last = Number(props.getProperty("LEADS_SAVED") || 0);
    if (Date.now() - last > 3600 * 1000){
      try {
        var sh = usageBook_().getSheetByName(LEAD_BACKUP_TAB) || usageBook_().insertSheet(LEAD_BACKUP_TAB);
        sh.clearContents();
        sh.getRange(1, 1, 1, 5).setValues([["day (ms)", "uid", "leads", "converted", "admitted"]]);
        sh.getRange(2, 1, rows.length, 5).setValues(rows);
        props.setProperty("LEADS_SAVED", String(Date.now()));
        props.setProperty("LEADS_ASOF", Utilities.formatDate(now, "Asia/Kolkata", "dd-MMM-yyyy hh:mm a"));
      } catch (e) { Logger.log("Lead backup not saved: " + e.message); }
    }
    return {rows: rows, asOf: Utilities.formatDate(now, "Asia/Kolkata", "dd-MMM-yyyy hh:mm a"), stale: false};
  }
  try {                                                           // BigQuery not readable: use the last good copy
    var b = usageBook_().getSheetByName(LEAD_BACKUP_TAB), n = b ? b.getLastRow() - 1 : 0;
    if (n > 0){
      var old = b.getRange(2, 1, n, 5).getValues().map(function(r){ return [Number(r[0]), String(r[1]), Number(r[2]) || 0, Number(r[3]) || 0, Number(r[4]) || 0]; });
      return {rows: old, asOf: props.getProperty("LEADS_ASOF") || "", stale: true};
    }
  } catch (e) { Logger.log("Lead backup not readable: " + e.message); }
  return {rows: null, asOf: "", stale: true};
}

/* Check: can the data service read the lead summary from BigQuery? Run from the editor, see the Execution log */
function testLeads(){
  var rows = leadSummary_();
  if (!rows){
    var b = leadsWithBackup_();
    Logger.log("BigQuery NOT available (see the message above). Backup copy: " + (b.rows ? b.rows.length + " rows, as of " + b.asOf : "none yet"));
    return;
  }
  var t = rows.reduce(function(a, r){ a.l += r[2]; a.c += r[3]; a.u[r[1]] = 1; return a; }, {l: 0, c: 0, u: {}});
  Logger.log("Lead summary rows: " + rows.length + " | leads: " + t.l + " | converted: " + t.c + " | counselors: " + Object.keys(t.u).length);
  PropertiesService.getScriptProperties().deleteProperty("LEADS_SAVED");      // save a fresh backup copy now
  var b = leadsWithBackup_();
  Logger.log("Backup copy saved (" + (b.rows ? b.rows.length : 0) + " rows) on the '" + LEAD_BACKUP_TAB + "' tab of the private usage sheet");
}
