"use strict";
/* =====================================================================
   Rwork core — shared state, data watches, UI helpers, router, render.
   Modules (js/m-*.js) call RW.register(...). Read MODULES.md first.
   Everything public lives on window.RW. Top-level helpers below are
   also globals (classic scripts share one scope) but modules written
   by other agents should use the RW.* names.
   ===================================================================== */

const RW = window.RW = {
  version: "2.0",
  modules: [], clientTabs: [], healthSignals: [],
  actions: {}, changes: {}, inputs: {},
  state: {}, map: {}, docs: {}, ready: {}, watches: [],
  route: { id: "dashboard", sub: "" },
  booted: false
};

/* ---------- constants ---------- */
const DEFAULT_SETTINGS = {
  companyName: "Rwork",
  leaveTypes: [
    { key: "casual", name: "Casual", quota: 8 },
    { key: "sick", name: "Sick", quota: 8 },
    { key: "earned", name: "Earned", quota: 0 }
  ],
  holidays: []
};
const TASK_STATUSES = ["To do", "In progress", "Review", "Done"];
const PRIORITIES = ["High", "Medium", "Low"];
const PROJECT_STATUSES = ["Planning", "Active", "On hold", "Completed"];
const TEAMS = ["HR", "Operations", "Management", "Creative", "Performance", "Development", "Content", "Other"];
const ROLES = [{ v: "employee", l: "Employee" }, { v: "hr", l: "HR admin" }, { v: "ops", l: "Operations admin" }, { v: "mgmt", l: "Management admin" }];
const SERVICES = ["SEO", "Social media", "Performance ads", "Website", "Content", "Branding", "Email"];
const CLIENT_STATUSES = ["Onboarding", "Active", "Paused", "Churned"];
const INVOICE_STATUSES = ["Draft", "Sent", "Paid", "Overdue"];
const NAV_GROUPS = ["Home", "Work", "Clients", "People", "Admin"];
RW.const = { DEFAULT_SETTINGS, TASK_STATUSES, PRIORITIES, PROJECT_STATUSES, TEAMS, ROLES, SERVICES, CLIENT_STATUSES, INVOICE_STATUSES, NAV_GROUPS };

/* Collections/docs every view can rely on. Modules add their own via `collections` / `docs`. */
const CORE_WATCHES = [
  { path: "org/settings", doc: true },
  "employees", "projects", "tasks", "leaves", "approvals", "clients",
  // read:"admin" in the db rules: a non-admin subscription would be refused, so only admins watch these.
  { path: "invoices", adminOnly: true }, { path: "billing", adminOnly: true }
];

/* ---------- app state ---------- */
const S = {
  db: null, user: null, isAdmin: false, isOwner: false, canWrite: true, viewerId: null, readOnly: false,
  meProfile: null, phase: "loading", stale: false, loadErrors: [],
  calMonth: null, clientTab: {}, ui: {},
  f: loadFilters()
};
// Data maps (id -> record) are views onto RW.map, filled by the watches.
["employees", "projects", "tasks", "leaves", "approvals", "clients", "invoices", "billing"].forEach(k =>
  Object.defineProperty(S, k, { get: () => RW.map[k] || {} }));
Object.defineProperty(S, "settingsDoc", { get: () => RW.docs["org/settings"] || null });
Object.defineProperty(S, "view", { get: () => RW.route.id });
RW.S = S;

function loadFilters() {
  const base = { search: "", status: "", priority: "", assignee: "", project: "", overdue: false, sort: "dueDate", dir: "asc", boardProject: "", boardAssignee: "", leaveStatus: "",
    cSearch: "", cStatus: "", cService: "", cManager: "", iMonth: "", iStatus: "", iClient: "" };
  try { const v = JSON.parse(localStorage.getItem("rwork.filters") || "{}"); return Object.assign(base, v); } catch (e) { return base; }
}
function saveFilters() { try { localStorage.setItem("rwork.filters", JSON.stringify(S.f)); } catch (e) {} }
/* Per-viewer UI preferences for modules (remembered filters). Never for shared data. */
RW.prefs = {
  get(key, dflt) { try { const v = JSON.parse(localStorage.getItem("rwork.pref." + key)); return v === null || v === undefined ? dflt : v; } catch (e) { return dflt; } },
  set(key, v) { try { localStorage.setItem("rwork.pref." + key, JSON.stringify(v)); } catch (e) {} }
};

/* ---------- utils ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
/* Date-only strings 'YYYY-MM-DD' are parsed as UTC midnight. Use getUTC* on the result. */
const parseD = s => new Date(s + "T00:00:00Z");
const fmtISO = d => d.toISOString().slice(0, 10);
function addDays(s, n) { const d = parseD(s); d.setUTCDate(d.getUTCDate() + n); return fmtISO(d); }
function validDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parseD(s).getTime()); }
function isWeekend(s) { const w = parseD(s).getUTCDay(); return w === 0 || w === 6; }
function daysBetween(a, b) { return Math.round((parseD(b) - parseD(a)) / 86400000); }
function workingDays(from, to, holidaySet, halfDay, year) {
  if (!validDate(from) || !validDate(to) || to < from) return 0;
  let n = 0, guard = 0;
  for (let d = from; d <= to && guard < 800; d = addDays(d, 1), guard++) {
    if (year && d.slice(0, 4) !== String(year)) continue;
    if (isWeekend(d) || holidaySet.has(d)) continue;
    n++;
  }
  if (halfDay && from === to && n === 1) return 0.5;
  return n;
}
const NICE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const NICE_SHORT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const MONTH_LABEL = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
function nice(s) { return validDate(s) ? NICE.format(parseD(s)) : "—"; }
function niceShort(s) { return validDate(s) ? NICE_SHORT.format(parseD(s)) : "—"; }
function monthLabel(ym) { return /^\d{4}-\d{2}$/.test(String(ym)) ? MONTH_LABEL.format(parseD(ym + "-01")) : "—"; }
function addMonths(ym, n) { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return fmtISO(d).slice(0, 7); }
function range(from, to) { if (!validDate(from)) return "—"; return from === to || !to ? nice(from) : `${niceShort(from)} to ${nice(to)}`; }
function fmtDays(n) { return (Math.round(n * 10) / 10) + (n === 1 ? " day" : " days"); }
function hashColor(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 45% 38%)`; }
function initials(name) { const p = String(name || "?").trim().split(/\s+/); return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase(); }
function av(emp) { if (!emp) return `<span class="av" style="background:var(--muted)">?</span>`; return `<span class="av" style="background:${hashColor(emp.id)}" title="${esc(emp.name)}">${esc(initials(emp.name))}</span>`; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function csv(rows) { return rows.map(r => r.map(v => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\n"); }
function num(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }
const INR = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
function fmtINR(n) { const v = Number(n); return Number.isFinite(v) ? "₹" + INR.format(v) : "—"; }
/* Only http(s) links are rendered as links. Returns a safe href or "". */
function safeUrl(u) { const s = String(u || "").trim(); return /^https?:\/\/[^\s]+$/i.test(s) ? s : ""; }
function safeColor(c) { return /^#[0-9a-f]{6}$/i.test(String(c || "")) ? c : ""; }

RW.date = { today: todayStr, parse: parseD, toISO: fmtISO, addDays, addMonths, valid: validDate, isWeekend, daysBetween, workingDays, fmt: nice, fmtShort: niceShort, range, monthLabel, fmtDays };

/* ---------- derived data ---------- */
function settings() {
  const d = S.settingsDoc || {};
  return {
    companyName: d.companyName || DEFAULT_SETTINGS.companyName,
    leaveTypes: Array.isArray(d.leaveTypes) && d.leaveTypes.length ? d.leaveTypes : DEFAULT_SETTINGS.leaveTypes,
    holidays: Array.isArray(d.holidays) ? d.holidays : []
  };
}
function holidaySet() { return new Set(settings().holidays.map(h => h.date)); }
function holidayMap() { const m = {}; settings().holidays.forEach(h => { m[h.date] = h.name; }); return m; }
function typeName(key) { const t = settings().leaveTypes.find(t => t.key === key); return t ? t.name : key; }
const emps = (all) => Object.values(S.employees).filter(e => all || e.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name)));
const empName = id => (S.employees[id] && S.employees[id].name) || "Unassigned";
const clientsSorted = () => Object.values(S.clients).sort((a, b) => String(a.name).localeCompare(String(b.name)));
const clientName = id => (S.clients[id] && S.clients[id].name) || "";
function me() { if (!S.viewerId) return null; const v = String(S.viewerId).toLowerCase(); return Object.values(S.employees).find(e => e.userId === S.viewerId) || Object.values(S.employees).find(e => e.active !== false && e.email && String(e.email).trim().toLowerCase() === v) || null; }
function roleLabel(r) { if (r === "admin") return "HR admin"; const x = ROLES.find(o => o.v === r); return x && r !== "employee" ? x.l : ""; }
function leaveStatus(id) { const a = S.approvals[id]; return a && (a.status === "approved" || a.status === "rejected") ? a.status : "pending"; }
function quotaFor(emp, type) {
  const o = emp && emp.leaveQuotaOverrides;
  if (o && o[type.key] !== undefined && o[type.key] !== null && o[type.key] !== "" && Number.isFinite(Number(o[type.key]))) return Number(o[type.key]);
  return num(type.quota, 0);
}
function leaveDays(l, year) { return workingDays(l.from, l.to, holidaySet(), !!l.halfDay, year); }
function balances(empId, year) {
  const emp = S.employees[empId];
  const out = {};
  settings().leaveTypes.forEach(t => { out[t.key] = { type: t, quota: quotaFor(emp, t), used: 0, pending: 0 }; });
  Object.values(S.leaves).forEach(l => {
    if (l.employeeId !== empId || !out[l.type]) return;
    const st = leaveStatus(l.id); if (st === "rejected") return;
    const d = leaveDays(l, year);
    if (st === "approved") out[l.type].used += d; else out[l.type].pending += d;
  });
  return out;
}
function leavesOverlapping(from, to, statuses) {
  return Object.values(S.leaves).filter(l => validDate(l.from) && validDate(l.to) && l.from <= to && l.to >= from && statuses.includes(leaveStatus(l.id)));
}
function onLeaveOn(date) { return isWeekend(date) || holidaySet().has(date) ? [] : leavesOverlapping(date, date, ["approved"]); }
function projectProgress(pid) {
  const ts = Object.values(S.tasks).filter(t => t.projectId === pid);
  const done = ts.filter(t => t.status === "Done").length;
  return { total: ts.length, done, pct: ts.length ? Math.round(done / ts.length * 100) : 0 };
}
function canWriteShared() { return !!S.db && S.canWrite && !S.readOnly; }
function canCreateTask() { return canWriteShared() && (S.isAdmin || !!me()); }
function canEditTask(t) { const m = me(); return canWriteShared() && (S.isAdmin || (m && t.assigneeId === m.id)); }
function adminWrite() { return !!S.db && S.isAdmin && !S.readOnly; }
function isOverdue(t) { return t.status !== "Done" && validDate(t.dueDate) && t.dueDate < todayStr(); }
function earnedMissing(emp) {
  const t = settings().leaveTypes.find(t => t.key === "earned");
  return !!t && quotaFor(emp, t) === 0;
}
function invoiceStatus(inv) { if (!inv) return "Draft"; if (inv.status === "Sent" && validDate(inv.dueDate) && inv.dueDate < todayStr()) return "Overdue"; return INVOICE_STATUSES.includes(inv.status) ? inv.status : "Draft"; }

RW.leave = { status: leaveStatus, days: leaveDays, balances, quotaFor, overlapping: leavesOverlapping, onLeaveOn, holidaySet, holidayMap, typeName, settings };

/* ---------- writes ---------- */
async function write(fn, okMsg) {
  if (!S.db) { toast("The shared database isn't available here.", "bad"); return false; }
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const r = await fn(); if (okMsg) toast(okMsg); return r === undefined ? true : (r || true); }
    catch (e) {
      const code = e && e.code;
      if (code === "unavailable" && attempt === 0) { await sleep(400 + Math.random() * 600); continue; }
      if (code === "invalid_argument") toast("This change wasn't saved. You may not have permission to edit this.", "bad");
      else if (code === "quota_exceeded") toast("The database is full. Delete old records, then try again.", "bad");
      else if (code === "resource_exhausted") toast("Too many changes at once. Wait a moment and try again.", "bad");
      else if (code === "revoked") { S.readOnly = true; toast("Your access changed. The app is now read-only.", "bad"); schedule(); }
      else if (e instanceof TypeError) { console.error("[Rwork] bad write", e); toast("Couldn't save (bad path).", "bad"); }
      else toast("Couldn't save. " + ((e && e.message) || "Try again."), "bad");
      return false;
    }
  }
  return false;
}
const col = name => S.db.collection(name);
function clean(o) { const r = {}; Object.keys(o).forEach(k => { if (o[k] !== undefined) r[k] = o[k]; }); return r; }
/* RW.write.*: resolve true / a DocumentReference (add) on success, false on failure (a toast was shown). */
RW.write = {
  set: (path, data, okMsg) => write(() => S.db.doc(path).set(clean(data)), okMsg),
  update: (path, data, okMsg) => write(() => S.db.doc(path).update(clean(data)), okMsg),
  add: (colPath, data, okMsg) => write(() => S.db.collection(colPath).add(clean(data)), okMsg),
  del: (path, okMsg) => write(() => S.db.doc(path).delete(), okMsg),
  run: write
};

/* ---------- toasts & modals ---------- */
function toast(msg, kind) {
  const t = document.createElement("div"); t.className = "toast" + (kind ? " " + kind : ""); t.textContent = msg;
  $("#toasts").appendChild(t); setTimeout(() => t.remove(), kind === "bad" ? 6000 : 3200);
}
let modalCleanup = null;
function modalOpen() { const r = $("#modalRoot"); return !!(r && r.firstChild); }
function closeModal() {
  const had = modalOpen();
  $("#modalRoot").innerHTML = "";
  if (modalCleanup) { const c = modalCleanup; modalCleanup = null; c(); }
  if (had && dirty) schedule();
}
/* body: HTML string (you escape) or a DOM Node. onSubmit(form) -> false keeps the dialog open. */
function openModal({ title, body, submitLabel = "Save", onSubmit, wide, danger, cancelLabel = "Cancel", onMount, noSubmit }) {
  closeModal();
  const root = $("#modalRoot");
  root.innerHTML = `<div class="overlay" data-overlay><form class="modal${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="mTitle" novalidate>
    <div class="modal-head"><h2 id="mTitle">${esc(title)}</h2><button type="button" class="btn ghost sm" data-close aria-label="Close">✕</button></div>
    <div class="modal-body"></div>
    <div class="modal-foot"><button type="button" class="btn" data-close>${esc(cancelLabel)}</button>${noSubmit ? "" : `<button type="submit" class="btn ${danger ? "danger solid" : "primary"}" id="mSubmit">${esc(submitLabel)}</button>`}</div>
  </form></div>`;
  const mb = root.querySelector(".modal-body");
  if (body instanceof Node) mb.appendChild(body); else mb.innerHTML = body || "";
  const form = root.querySelector("form");
  root.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", closeModal));
  root.querySelector("[data-overlay]").addEventListener("mousedown", e => { if (e.target.hasAttribute("data-overlay")) closeModal(); });
  const onKey = e => { if (e.key === "Escape") closeModal(); };
  document.addEventListener("keydown", onKey);
  modalCleanup = () => document.removeEventListener("keydown", onKey);
  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (!onSubmit) { closeModal(); return; }
    const btn = $("#mSubmit"); if (btn) btn.disabled = true;
    let ok = false;
    try { ok = await onSubmit(form); } catch (err) { console.error("[Rwork] modal submit failed", err); toast("Something went wrong. Try again.", "bad"); ok = false; }
    finally { if (btn) btn.disabled = false; }
    if (ok !== false && form.isConnected) closeModal();
  });
  if (onMount) onMount(form);
  const first = form.querySelector(".modal-body input:not([type=hidden]), .modal-body select, .modal-body textarea, #mSubmit");
  if (first) first.focus();
  return form;
}
function confirmDialog(message, label = "Delete") {
  return new Promise(res => {
    let done = false;
    openModal({ title: "Please confirm", body: `<p style="margin:0">${esc(message)}</p>`, submitLabel: label, danger: true, onSubmit: () => { done = true; res(true); } });
    const prev = modalCleanup;
    modalCleanup = () => { if (prev) prev(); if (!done) res(false); };
  });
}
async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied as CSV. Paste it into Excel or Google Sheets.`); }
  catch (e) {
    openModal({ title: `${what} as CSV`, body: `<p class="hint" style="margin:0">Your browser blocked the clipboard. Select all the text below and copy it.</p><textarea class="ta" id="csvText" readonly>${esc(text)}</textarea>`, noSubmit: true, cancelLabel: "Close", onMount: f => { const t = f.querySelector("#csvText"); t.focus(); t.select(); } });
  }
}

/* ---------- markup helpers ---------- */
function opts(list, sel, emptyLabel) {
  return (emptyLabel !== undefined ? `<option value="">${esc(emptyLabel)}</option>` : "") +
    list.map(o => { const v = typeof o === "string" ? o : o.v, l = typeof o === "string" ? o : o.l; return `<option value="${esc(v)}"${String(v) === String(sel ?? "") ? " selected" : ""}>${esc(l)}</option>`; }).join("");
}
/* Options for active employees; keeps `sel` even if inactive/missing so edits never drop data. */
function empOpts(sel, empty) {
  let h = opts(emps().map(e => ({ v: e.id, l: e.name })), sel, empty);
  if (sel && !emps().some(e => e.id === sel)) h += `<option value="${esc(sel)}" selected>${esc(S.employees[sel] ? S.employees[sel].name + " (inactive)" : "(Removed person)")}</option>`;
  return h;
}
function projOpts(sel, empty) {
  let h = opts(Object.values(S.projects).sort((a, b) => String(a.name).localeCompare(String(b.name))).map(p => ({ v: p.id, l: p.name })), sel, empty);
  if (sel && !S.projects[sel]) h += `<option value="${esc(sel)}" selected>(Deleted project)</option>`;
  return h;
}
function clientOpts(sel, empty) {
  let h = opts(clientsSorted().map(c => ({ v: c.id, l: c.name })), sel, empty);
  if (sel && !S.clients[sel]) h += `<option value="${esc(sel)}" selected>(Deleted client)</option>`;
  return h;
}
function pill(text, kind) { return `<span class="pill ${kind || ""}">${esc(text)}</span>`; }
function statusPill(s) { const k = { "Done": "good", "In progress": "accent", "Review": "warn", "To do": "" }[s] || ""; return `<span class="pill ${k}">${esc(s || "To do")}</span>`; }
function projPill(s) { const k = { "Active": "accent", "Completed": "good", "On hold": "warn", "Planning": "" }[s] || ""; return `<span class="pill ${k}">${esc(s || "Planning")}</span>`; }
function leavePill(st) { return `<span class="pill ${st === "approved" ? "good" : st === "rejected" ? "bad" : "warn"}">${st === "approved" ? "Approved" : st === "rejected" ? "Rejected" : "Pending"}</span>`; }
function prioHtml(p) { const c = p === "High" ? "var(--bad)" : p === "Medium" ? "var(--marigold)" : "var(--accent)"; return `<span class="prio"><span class="dot" style="background:${c}"></span>${esc(p || "Medium")}</span>`; }
function fv(form, name) { const el = form.elements[name]; return el ? String(el.value).trim() : ""; }
let fieldSeq = 0;
/* field({label,name,type,value,options,required,placeholder,hint,min,max,step,checked}) -> HTML.
   type: text|email|tel|url|number|date|month|time|color|textarea|select|checkbox|hidden. options for select: strings or {v,l}. */
function field(o) {
  const id = o.id || ("f" + (++fieldSeq) + "_" + String(o.name || "x").replace(/[^a-z0-9_]/gi, ""));
  const type = o.type || (o.options ? "select" : "text");
  const common = `id="${esc(id)}" name="${esc(o.name || "")}"${o.required ? " required" : ""}${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ""}${o.min !== undefined ? ` min="${esc(o.min)}"` : ""}${o.max !== undefined ? ` max="${esc(o.max)}"` : ""}${o.step !== undefined ? ` step="${esc(o.step)}"` : ""}${o.attrs || ""}`;
  if (type === "hidden") return `<input type="hidden" ${common} value="${esc(o.value ?? "")}">`;
  if (type === "checkbox") return `<label class="check"><input type="checkbox" ${common}${o.checked || o.value === true ? " checked" : ""}> ${esc(o.label || "")}</label>`;
  let input;
  if (type === "textarea") input = `<textarea ${common}>${esc(o.value ?? "")}</textarea>`;
  else if (type === "select") input = `<select ${common}>${o.optionsHtml || opts(o.options || [], o.value, o.empty)}</select>`;
  else input = `<input type="${esc(type)}" ${common} value="${esc(o.value ?? "")}">`;
  return `<div class="field"><label for="${esc(id)}">${esc(o.label || "")}</label>${input}${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ""}</div>`;
}
/* tableHTML(cols, rows, {empty, rowClass(row)}). col: {label, text(row) (auto-escaped) | html(row) (trusted), cls, thCls}. */
function tableHTML(cols, rows, o = {}) {
  if (!rows.length) return `<div class="empty">${esc(o.empty || "Nothing here yet.")}</div>`;
  return `<div class="tbl-wrap"><table><thead><tr>${cols.map(c => `<th class="${esc(c.thCls || "")}">${esc(c.label || "")}</th>`).join("")}</tr></thead><tbody>${rows.map(r =>
    `<tr class="${esc(o.rowClass ? o.rowClass(r) || "" : "")}">${cols.map(c => `<td class="${esc(c.cls || "")}">${c.html ? c.html(r) : esc(c.text ? c.text(r) : "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
/* h(tag, attrs, ...children): DOM builder. Strings become text nodes (safe). attrs: class, style (obj|str), dataset, on<Event> fns, html (TRUSTED innerHTML), others as attributes. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  kids.flat(Infinity).forEach(c => { if (c === null || c === undefined || c === false) return; el.append(c instanceof Node ? c : document.createTextNode(String(c))); });
  return el;
}
function csvCopy(rows, what) { return copyText(csv(rows), what || "Data"); }
function tabsHTML(tabs, current, act, extra = "") {
  return `<div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${current === k}" class="${current === k ? "on" : ""}" data-act="${esc(act)}" data-tab="${esc(k)}"${extra}>${l}</button>`).join("")}</div>`;
}

RW.ui = { esc, h, field, fv, opts, empOpts, projOpts, clientOpts, pill, statusPill, projPill, leavePill, prioHtml, av, initials, hashColor,
  modal: openModal, closeModal, confirm: confirmDialog, toast, tableHTML, tabsHTML, csv, csvCopy, copyText, fmtINR, safeUrl, safeColor, num, clean };

/* ---------- module registry ---------- */
RW.register = function (mod) {
  if (!mod || !/^[a-z][a-z0-9]*$/.test(mod.id || "")) { console.error("[Rwork] RW.register: id must be lowercase letters/digits", mod && mod.id); return; }
  if (RW.modules.some(m => m.id === mod.id)) { console.error("[Rwork] duplicate module id", mod.id); return; }
  RW.modules.push(Object.assign({ group: "Work", order: 50, collections: [], docs: [] }, mod));
  if (RW.booted) { (mod.collections || []).forEach(c => RW.watch(c)); (mod.docs || []).forEach(d => RW.watchDoc(d)); schedule(); }
};
RW.registerClientTab = t => { if (t && t.id && typeof t.render === "function") RW.clientTabs.push(Object.assign({ order: 50 }, t)); };
RW.registerHealthSignal = fn => { if (typeof fn === "function") RW.healthSignals.push(fn); };
/* Modules add their own CSS here instead of editing css/app.css. Prefix classes with the module id. */
RW.addStyle = (css, id) => { const st = document.createElement("style"); if (id) st.id = "style-" + id; st.textContent = String(css); document.head.appendChild(st); return st; };
RW.action = (name, fn) => { RW.actions[name] = fn; };
RW.onChange = (name, fn) => { RW.changes[name] = fn; };
RW.onInput = (name, fn) => { RW.inputs[name] = fn; };

/* ---------- context ---------- */
function buildCtx() {
  const ctx = {
    db: S.db, user: S.user, viewerId: S.viewerId,
    isAdmin: S.isAdmin, isOwner: S.isOwner,
    canWrite: canWriteShared(), adminWrite: adminWrite(), readOnly: S.readOnly || !S.canWrite,
    me: me(),
    employees: emps(), allEmployees: emps(true), employeeById: S.employees, empName,
    clients: clientsSorted(), clientById: S.clients, clientName,
    projects: Object.values(S.projects), projectById: S.projects,
    settings: settings(), today: todayStr(),
    state: RW.state, map: RW.map, docs: RW.docs,
    route: Object.assign({}, RW.route),
    can(what) { return what === "admin" ? this.adminWrite : what === "write" ? this.canWrite : false; }
  };
  return ctx;
}
Object.defineProperty(RW, "ctx", { get: buildCtx });

/* ---------- health & alerts ---------- */
RW.clientHealth = function (client, ctx) {
  ctx = ctx || buildCtx();
  const signals = [];
  RW.healthSignals.forEach(fn => {
    try { const r = fn(client, ctx); (Array.isArray(r) ? r : [r]).forEach(x => { if (x && x.label) signals.push({ label: String(x.label), level: x.level === "danger" ? "danger" : "warn" }); }); }
    catch (e) { console.error("[Rwork] health signal failed", e); }
  });
  const level = signals.some(s => s.level === "danger") ? "danger" : signals.length ? "warn" : "good";
  return { level, label: level === "danger" ? "At risk" : level === "warn" ? "Needs attention" : "Healthy", signals };
};
function healthHTML(hh) { return `<span class="health ${hh.level}" title="${esc(hh.signals.map(s => s.label).join("; ") || "No issues")}"><span class="dot"></span>${esc(hh.label)}</span>`; }
RW.ui.healthHTML = healthHTML;
RW.collectAlerts = function (ctx) {
  ctx = ctx || buildCtx();
  const out = [];
  RW.modules.forEach(m => {
    if (!m.alerts || (m.adminOnly && !S.isAdmin)) return;
    try { (m.alerts(ctx) || []).forEach(a => { if (a && a.text) out.push(Object.assign({ level: "warn", module: m.id }, a)); }); }
    catch (e) { console.error("[Rwork] alerts failed in " + m.id, e); }
  });
  return out.sort((a, b) => (a.level === "danger" ? 0 : 1) - (b.level === "danger" ? 0 : 1) || String(a.date || "9999").localeCompare(String(b.date || "9999")));
};

/* ---------- data watches ---------- */
function normWatch(spec, isDoc) {
  if (typeof spec === "string") spec = { path: spec };
  if (!spec || !spec.path) return null;
  const w = Object.assign({}, spec);
  if (isDoc) w.doc = true;
  w.key = w.key || w.path;
  return w;
}
RW.watch = function (spec) {
  const w = normWatch(spec, false); if (!w) return;
  if (w.adminOnly && RW.booted && !S.isAdmin) return;
  if (RW.watches.some(x => x.key === w.key)) return;
  RW.watches.push(w);
  if (RW.booted && S.db) startWatch(w, false);
};
RW.watchDoc = function (spec) {
  const w = normWatch(spec, true); if (!w) return;
  if (w.adminOnly && RW.booted && !S.isAdmin) return;
  if (RW.watches.some(x => x.key === w.key)) return;
  RW.watches.push(w);
  if (RW.booted && S.db) startWatch(w, false);
};
let loadTimer = null;
function allReady() { return RW.watches.filter(w => w.blocking).every(w => RW.ready[w.key]); }
function markReady(key) {
  RW.ready[key] = true;
  if (allReady() && (S.phase === "loading" || S.stale)) { clearTimeout(loadTimer); S.stale = false; S.phase = "ready"; schedule(); }
}
function startWatch(w, blocking) {
  w.blocking = !!blocking;
  RW.ready[w.key] = false;
  if (!w.doc) { RW.map[w.key] = RW.map[w.key] || {}; RW.state[w.key] = RW.state[w.key] || []; }
  const onErr = err => {
    RW.ready[w.key] = true;
    if (err && err.code === "revoked") S.readOnly = true;
    else if (!S.loadErrors.includes(w.key)) S.loadErrors.push(w.key === "org/settings" ? "settings" : w.key);
    if (w.lateTimer) clearTimeout(w.lateTimer);
    markReady(w.key); refresh();
  };
  let ref;
  try {
    if (w.doc) ref = S.db.doc(w.path);
    else {
      ref = S.db.collection(w.path);
      const wh = typeof w.where === "function" ? w.where() : w.where;
      (wh || []).forEach(c => { ref = ref.where(c[0], c[1], c[2]); });
      if (w.orderBy) ref = ref.orderBy(...[].concat(w.orderBy));
      if (w.limit) ref = ref.limit(w.limit);
    }
  } catch (e) { console.error("[Rwork] bad watch " + w.key, e); onErr({ code: "invalid_argument" }); return; }
  w.unsub = ref.onSnapshot(snap => {
    if (w.doc) RW.docs[w.key] = snap.exists ? snap.data() : null;
    else {
      const m = {}, arr = [];
      snap.docs.forEach(d => { const o = Object.assign({}, d.data(), { id: d.id }); m[d.id] = o; arr.push(o); });
      RW.map[w.key] = m; RW.state[w.key] = arr;
    }
    if (!snap.metadata.fromCache) markReady(w.key);
    refresh();
  }, onErr);
}

/* ---------- rendering ---------- */
let rafPending = false, dirty = false;
/* Force a render now (user-driven). */
function schedule() { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; render(); }); }
/* Data-driven re-render: deferred while a dialog is open or the user is typing in the view. */
function isBusy() {
  if (modalOpen()) return true;
  const a = document.activeElement, main = $("#main");
  return !!(a && main && main.contains(a) && a.matches("input,textarea,select,[contenteditable]") && !a.hasAttribute("data-live"));
}
function refresh() { if (isBusy()) { dirty = true; return; } schedule(); }
RW.render = schedule;
RW.refresh = refresh;
/* Redraw only the nav (badges, active item). Safe anytime, e.g. after a module changes a per-viewer pref a badge reads. */
RW.refreshNav = function () { const n = $("#nav"); if (n && RW.booted && S.phase !== "nodb") n.innerHTML = navHTML(); };

function navHTML() {
  const ctx = buildCtx();
  const mods = RW.modules.filter(m => !m.hidden && (!m.adminOnly || S.isAdmin))
    .sort((a, b) => NAV_GROUPS.indexOf(a.group) - NAV_GROUPS.indexOf(b.group) || (a.order - b.order) || a.title.localeCompare(b.title));
  let out = "", g = null;
  mods.forEach(m => {
    if (m.group !== g) { g = m.group; if (g !== "Home") out += `<div class="nav-group">${esc(g)}</div>`; }
    let b = 0; if (m.badge) { try { b = Number(m.badge(ctx)) || 0; } catch (e) { console.error("[Rwork] badge failed in " + m.id, e); } }
    out += `<a href="#${esc(m.id)}" data-view="${esc(m.id)}" class="${RW.route.id === m.id ? "active" : ""}">${m.icon || ""}<span>${esc(m.title)}</span>${b ? `<span class="badge">${b}</span>` : ""}</a>`;
  });
  return out;
}
function renderChrome() {
  $("#nav").innerHTML = navHTML();
  const s = settings();
  $("#brandSub").textContent = s.companyName && s.companyName !== "Rwork" ? s.companyName : "Workspace";
  $("#eyebrow").textContent = (s.companyName || "Rwork") + " Workspace";
  const m = me();
  $("#sideFoot").innerHTML = S.phase === "nodb" ? "Not connected" : `<span>Signed in as</span><strong>${esc(m ? m.name : (S.meProfile && S.meProfile.name) || "you")}</strong><span>${S.isAdmin ? "Admin" + (m && roleLabel(m.role) ? " · " + esc(roleLabel(m.role)) : "") : m ? esc(m.designation || "Employee") : "Not linked yet"}${S.readOnly || !S.canWrite ? ", view only" : ""}</span>`;
  const chip = $("#userChip");
  if (S.phase !== "nodb" && S.user) {
    chip.hidden = false;
    chip.innerHTML = "";
    const p = S.meProfile;
    const nm = (m && m.name) || (p && p.name) || "You";
    const fallback = () => h("span", { class: "av", style: { background: (p && p.color) || hashColor(nm) } }, initials(nm));
    if (p && p.avatarUrl) { const img = h("img", { src: p.avatarUrl, alt: "" }); img.addEventListener("error", () => img.replaceWith(fallback())); chip.append(img); }
    else chip.append(fallback());
    chip.append(h("span", { class: "nm" }, nm));
    if (S.isAdmin) chip.insertAdjacentHTML("beforeend", `<span class="pill accent">Admin</span>`);
  } else chip.hidden = true;
  const banner = $("#banner");
  banner.textContent = S.stale ? "The shared data can't be reached right now. What you see may be out of date." : (S.loadErrors.length ? "Some data couldn't load: " + S.loadErrors.join(", ") + ". Refresh the page to try again." : "");
}
function render() {
  dirty = false;
  const main = $("#main");
  renderChrome();
  if (S.phase === "nodb") {
    $("#pageTitle").textContent = "Rwork"; $("#topActions").innerHTML = "";
    main.innerHTML = `<div class="center-msg"><h2>Sign in to use Rwork</h2><p class="muted">The shared database couldn't be reached. Check your internet connection and refresh the page.</p></div>`;
    return;
  }
  const mod = RW.modules.find(m => m.id === RW.route.id) || RW.modules.find(m => m.id === "dashboard");
  if (S.phase === "loading" && !S.stale) {
    $("#pageTitle").textContent = mod ? mod.title : "Rwork"; $("#topActions").innerHTML = "";
    main.innerHTML = `<div class="center-msg"><p class="muted">Loading your workspace…</p></div>`; return;
  }
  if (!mod) { main.innerHTML = `<div class="empty">No modules loaded.</div>`; return; }
  // remember focus, caret and data-keep values
  const a = document.activeElement; let fid = null, ss = null, se = null;
  if (a && a.id && main.contains(a)) { fid = a.id; try { ss = a.selectionStart; se = a.selectionEnd; } catch (e) {} }
  const kept = {}; main.querySelectorAll("[data-keep][id]").forEach(el => { kept[el.id] = el.type === "checkbox" ? el.checked : el.value; });
  const scroll = main.scrollTop;
  const el = document.createElement("div"); el.className = "stack";
  let r = {};
  if (mod.adminOnly && !S.isAdmin) r = { html: `<div class="empty">Only admins (HR and Operations) can open ${esc(mod.title)}.</div>` };
  else {
    try { r = mod.render(el, buildCtx(), Object.assign({}, RW.route)) || {}; }
    catch (e) { console.error("[Rwork] module " + mod.id + " failed to render", e); r = { html: `<div class="view-error"><strong>${esc(mod.title)} couldn't be shown.</strong> Try refreshing the page.</div>` }; }
  }
  if (r.html !== undefined && r.html !== null) el.innerHTML = r.html;
  $("#pageTitle").textContent = r.title || mod.title;
  const ta = $("#topActions");
  if (r.actions instanceof Node) ta.replaceChildren(r.actions); else ta.innerHTML = r.actions || "";
  main.replaceChildren(el);
  main.scrollTop = scroll;
  Object.keys(kept).forEach(id => { const x = document.getElementById(id); if (x && main.contains(x)) { if (x.type === "checkbox") x.checked = kept[id]; else x.value = kept[id]; } });
  if (fid) { const x = document.getElementById(fid); if (x) { x.focus(); try { if (ss !== null) x.setSelectionRange(ss, se); } catch (e) {} } }
  // Horizontally scrolling tab bars (narrow screens): keep the selected tab visible.
  el.querySelectorAll(".tabs").forEach(t => { const on = t.querySelector(".on"); if (on && t.scrollWidth > t.clientWidth) { const a = t.getBoundingClientRect(), b = on.getBoundingClientRect(); t.scrollLeft += (b.left - a.left) - (a.width - b.width) / 2; } });
  if (r.after) { try { r.after(el); } catch (e) { console.error("[Rwork] after() failed in " + mod.id, e); } }
}

/* ---------- routing ---------- */
function parseHash() {
  let hsh = location.hash.replace(/^#/, "");
  try { hsh = decodeURIComponent(hsh); } catch (e) {}
  const i = hsh.indexOf("-");
  return i < 0 ? { id: hsh, sub: "" } : { id: hsh.slice(0, i), sub: hsh.slice(i + 1) };
}
function onHash() {
  let { id, sub } = parseHash();
  if (!RW.modules.some(m => m.id === id)) { id = "dashboard"; sub = ""; }
  RW.route = { id, sub };
  closeModal(); schedule();
  const main = $("#main"); if (main) main.scrollTop = 0;
}
/* Navigate: RW.go("clients", "abc") -> #clients-abc */
RW.go = function (id, sub) {
  const target = id + (sub ? "-" + sub : "");
  if (location.hash.replace(/^#/, "") === target) { RW.route = { id, sub: sub || "" }; schedule(); }
  else location.hash = target;
};

/* ---------- events ---------- */
document.addEventListener("click", e => {
  const th = e.target.closest("th[data-sort]");
  if (th) { const k = th.dataset.sort; if (S.f.sort === k) S.f.dir = S.f.dir === "asc" ? "desc" : "asc"; else { S.f.sort = k; S.f.dir = "asc"; } saveFilters(); schedule(); return; }
  const el = e.target.closest("[data-act]"); if (!el || el.closest("#modalRoot")) return;
  const fn = RW.actions[el.dataset.act]; if (!fn) return;
  /* Links with data-act never navigate by themselves: a hashchange would close any dialog the action opened.
     If the link has a "#..." href and the action didn't open a dialog, follow the href afterwards. */
  const isA = el.tagName === "A", href = isA ? el.getAttribute("href") || "" : "";
  if (el.tagName === "BUTTON" || isA) e.preventDefault();
  if ($("#app").classList.contains("nav-open")) $("#app").classList.remove("nav-open");
  const follow = () => { if (/^#[A-Za-z0-9-]+$/.test(href) && !modalOpen()) { if (location.hash === href) schedule(); else location.hash = href; } };
  try {
    const r = fn(el, e, buildCtx());
    if (r && typeof r.then === "function") r.then(follow, err => console.error("[Rwork] action " + el.dataset.act, err));
    else follow();
  }
  catch (err) { console.error("[Rwork] action " + el.dataset.act, err); }
});
document.addEventListener("change", e => {
  const el = e.target; if (el.closest("#modalRoot") || !el.dataset) return;
  const k = el.dataset.change; if (!k) return;
  if (k === "filter") { S.f[el.dataset.key] = el.value; saveFilters(); schedule(); }
  else if (k === "filterCheck") { S.f[el.dataset.key] = el.checked; saveFilters(); schedule(); }
  else if (RW.changes[k]) { try { const r = RW.changes[k](el, e, buildCtx()); if (r && r.catch) r.catch(err => console.error(err)); } catch (err) { console.error("[Rwork] change " + k, err); } }
});
document.addEventListener("input", e => {
  const el = e.target; if (el.closest("#modalRoot") || !el.dataset) return;
  const k = el.dataset.input; if (!k) return;
  if (k === "filter") { S.f[el.dataset.key] = el.value; saveFilters(); schedule(); }
  else if (RW.inputs[k]) { try { RW.inputs[k](el, e, buildCtx()); } catch (err) { console.error("[Rwork] input " + k, err); } }
});
document.addEventListener("focusout", () => { setTimeout(() => { if (dirty && !isBusy()) schedule(); }, 0); });
document.addEventListener("click", e => { const app = $("#app"); if (app && app.classList.contains("nav-open") && !e.target.closest("#side") && !e.target.closest("#menuBtn")) app.classList.remove("nav-open"); });

/* ---------- boot ---------- */
RW.boot = async function () {
  if (RW.booted) return;
  $("#menuBtn").addEventListener("click", () => $("#app").classList.toggle("nav-open"));
  $("#nav").addEventListener("click", e => { if (e.target.closest("a")) $("#app").classList.remove("nav-open"); });
  window.addEventListener("hashchange", onHash);
  onHash();
  if (!window.claude || typeof window.claude.use !== "function") { S.phase = "nodb"; RW.booted = true; render(); return; }
  const safe = f => Promise.resolve().then(f).catch(() => null);
  const db = await safe(() => window.claude.use("db"));
  const user = await safe(() => window.claude.use("user"));
  S.user = user;
  if (user) {
    S.isAdmin = !!(await safe(() => user.canEdit()));
    S.isOwner = !!(await safe(() => user.isOwner()));
    S.viewerId = (await safe(() => user.id())) || null;
    const cw = await safe(() => user.can("data.write"));
    S.canWrite = cw !== false;
    S.meProfile = await safe(() => user.me());
  }
  RW.booted = true;
  if (!db) { S.phase = "nodb"; render(); return; }
  S.db = db;
  // Core + module watches (deduped by key). All boot-time watches gate the loading screen.
  const specs = [];
  CORE_WATCHES.forEach(c => specs.push(normWatch(c, typeof c === "object" && c.doc)));
  RW.modules.forEach(m => {
    (m.collections || []).forEach(c => specs.push(normWatch(c, false)));
    (m.docs || []).forEach(d => specs.push(normWatch(d, true)));
  });
  specs.forEach(w => { if (w && !(w.adminOnly && !S.isAdmin) && !RW.watches.some(x => x.key === w.key)) RW.watches.push(w); });
  loadTimer = setTimeout(() => { if (S.phase === "loading") { S.stale = true; S.phase = "ready"; schedule(); } }, 10000);
  if (!S.isAdmin) RW.watches = RW.watches.filter(w => !w.adminOnly);
  RW.watches.forEach(w => startWatch(w, true));
  schedule();
};
