"use strict";
/* Timesheets & attendance.
   Collection `timelogs`: ONE doc per employee per day, id `<YYYY-MM-DD>_<employeeId>`:
     { day, employeeId, checkIn "HH:MM", checkOut "HH:MM", mode "Office"|"WFH"|"Field",
       entries:[{ id, clientId?, projectId?, taskId?, hours, note, billable }], updatedBy, updatedAt }
   Doc `org/timeSettings` (admin writes): { officeStart "10:00", graceMins 15, dailyTargetHours 8 }.
   Watched window: day >= first day of the month two months back (about 3 months of data).
   The UI lets a viewer edit only their own days; admins edit anyone's. The db rule for
   `timelogs` is the default (Contributors write), so the UI is the only guard on that. */
(function () {
  const U = RW.ui, D = RW.date, esc = U.esc;
  const KEY = "timelogs";
  const MODES = ["Office", "WFH", "Field"];
  const DEF = { officeStart: "10:00", graceMins: 15, dailyTargetHours: 8 };
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  /* ---------- per-viewer UI state (closure only) ---------- */
  const ui = { weekStart: null, empId: "", month: null };

  /* ---------- helpers ---------- */
  const pad = n => String(n).padStart(2, "0");
  const nowHM = () => { const d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  const logId = (day, empId) => day + "_" + empId;
  const windowStart = () => D.addMonths(D.today().slice(0, 7), -2) + "-01";
  const mondayOf = s => { const w = D.parse(s).getUTCDay(); return D.addDays(s, -((w + 6) % 7)); };
  const monthEnd = ym => D.addDays(D.addMonths(ym, 1) + "-01", -1);
  const daysIn = (from, to) => { const out = []; for (let d = from, g = 0; d <= to && g < 400; d = D.addDays(d, 1), g++) out.push(d); return out; };
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const r2 = n => Math.round(n * 100) / 100;
  const fmtH = n => { const v = r2(n || 0); return (Number.isInteger(v) ? v : v.toFixed(2).replace(/0$/, "")) + "h"; };
  const pct = (a, b) => b > 0 ? Math.round(a / b * 100) : 0;
  function hmToMin(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
  function minToHM(n) { n = ((n % 1440) + 1440) % 1440; return pad(Math.floor(n / 60)) + ":" + pad(n % 60); }

  function timeSettings() {
    const d = RW.docs["org/timeSettings"] || {};
    const os = hmToMin(d.officeStart) !== null ? d.officeStart : DEF.officeStart;
    const g = Number(d.graceMins), t = Number(d.dailyTargetHours);
    return { officeStart: os, graceMins: Number.isFinite(g) && g >= 0 ? g : DEF.graceMins, dailyTargetHours: Number.isFinite(t) && t > 0 ? t : DEF.dailyTargetHours };
  }
  const lateAfter = () => { const t = timeSettings(); return minToHM(hmToMin(t.officeStart) + t.graceMins); };
  const isLate = log => !!(log && log.checkIn && hmToMin(log.checkIn) !== null && hmToMin(log.checkIn) > hmToMin(lateAfter()));

  /* Latest known copy of a day doc: local pending write wins until the snapshot catches up. */
  const pend = {};
  function getLog(day, empId) {
    const id = logId(day, empId);
    const snap = (RW.map[KEY] || {})[id] || null;
    const p = pend[id];
    if (p && (!snap || String(snap.updatedAt || "") < String(p.updatedAt))) return p;
    return snap;
  }
  const entriesOf = log => (log && Array.isArray(log.entries) ? log.entries : []);
  const hoursOf = log => r2(entriesOf(log).reduce((s, e) => s + (Number(e.hours) || 0), 0));
  const billableOf = log => r2(entriesOf(log).filter(e => e.billable).reduce((s, e) => s + (Number(e.hours) || 0), 0));
  const logged = log => !!(log && (log.checkIn || entriesOf(log).length));

  /* One write at a time per doc: chain writes per id. */
  const chains = {};
  function saveLog(day, empId, patch, okMsg) {
    const id = logId(day, empId);
    const run = async () => {
      const cur = getLog(day, empId);
      const base = cur ? JSON.parse(JSON.stringify(cur)) : { day, employeeId: empId, entries: [] };
      delete base.id;
      const next = Object.assign(base, typeof patch === "function" ? patch(base) : patch, {
        day, employeeId: empId, updatedBy: RW.S.viewerId || "", updatedAt: new Date().toISOString()
      });
      if (!Array.isArray(next.entries)) next.entries = [];
      const prev = pend[id];
      pend[id] = Object.assign({ id }, next);
      RW.render();
      const ok = await RW.write.set(KEY + "/" + id, next, okMsg);
      if (!ok) { if (prev) pend[id] = prev; else delete pend[id]; RW.render(); }
      return ok;
    };
    const p = (chains[id] || Promise.resolve()).then(run, run);
    chains[id] = p.catch(() => false);
    return p;
  }

  function canEditDay(ctx, empId) { return !!(ctx.canWrite && (ctx.isAdmin || (ctx.me && ctx.me.id === empId))); }

  /* Approved leave per "emp|day" over a range. */
  function leaveIndex(ctx, from, to) {
    const idx = new Map();
    (ctx.state.leaves || []).forEach(l => {
      if (!D.valid(l.from) || !D.valid(l.to) || l.to < from || l.from > to) return;
      if (RW.leave.status(l.id) !== "approved") return;
      const a = l.from < from ? from : l.from, b = l.to > to ? to : l.to;
      daysIn(a, b).forEach(d => idx.set(l.employeeId + "|" + d, l));
    });
    return idx;
  }

  /* Attendance for one person-day. code: P | WFH | F | L | HL (half leave) | H | A | "" */
  function dayInfo(emp, day, idx, hol, today) {
    const log = getLog(day, emp.id);
    const weekend = D.isWeekend(day), holiday = hol.has(day);
    const lv = idx.get(emp.id + "|" + day) || null;
    const fullLeave = !!(lv && !lv.halfDay && !weekend && !holiday);
    const halfLeave = !!(lv && lv.halfDay && !weekend && !holiday);
    let code = "";
    if (fullLeave) code = "L";
    else if (logged(log)) code = log.mode === "WFH" ? "WFH" : log.mode === "Field" ? "F" : "P";
    else if (halfLeave) code = "HL";
    else if (holiday) code = "H";
    else if (weekend) code = "";
    else if (emp.joinDate && D.valid(emp.joinDate) && day < emp.joinDate) code = "";
    else if (day < today) code = "A";
    const working = !weekend && !holiday && !fullLeave && !(emp.joinDate && D.valid(emp.joinDate) && day < emp.joinDate);
    return { code, weekend, holiday, leave: lv, halfLeave, fullLeave, log, working, late: !weekend && isLate(log) };
  }
  const CODE_LABEL = { P: "Present", WFH: "Work from home", F: "Field", L: "On leave", HL: "Half-day leave", H: "Holiday", A: "Absent" };
  const CODE_SHORT = { P: "P", WFH: "WFH", F: "F", L: "L", HL: "½L", H: "H", A: "A" };

  /* Working days (expected) for utilisation, month-to-date. Half-day leave = 0.5. */
  function expectedDays(emp, from, to, idx, hol) {
    let n = 0;
    daysIn(from, to).forEach(d => {
      if (D.isWeekend(d) || hol.has(d)) return;
      if (emp.joinDate && D.valid(emp.joinDate) && d < emp.joinDate) return;
      const lv = idx.get(emp.id + "|" + d);
      if (lv && !lv.halfDay) return;
      n += lv && lv.halfDay ? 0.5 : 1;
    });
    return n;
  }

  function prevWorkingDay(today, hol) {
    let d = D.addDays(today, -1);
    for (let i = 0; i < 10 && (D.isWeekend(d) || hol.has(d)); i++) d = D.addDays(d, -1);
    return d;
  }
  /* Employees with no time entries on a working day (not on full leave, joined). */
  function missingOn(ctx, day, idx, hol) {
    return ctx.employees.filter(e => { const i = dayInfo(e, day, idx, hol, ctx.today); return i.working && hoursOf(i.log) === 0; });
  }

  /* ---------- pickers ---------- */
  function projList(clientId, sel) {
    let list = Object.values(RW.map.projects || {}).filter(p => !clientId || p.clientId === clientId)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    let h = U.opts(list.map(p => ({ v: p.id, l: p.name })), sel, clientId ? "No project" : "No project");
    if (sel && !list.some(p => p.id === sel)) h += `<option value="${esc(sel)}" selected>${esc((RW.map.projects || {})[sel] ? RW.map.projects[sel].name : "(Deleted project)")}</option>`;
    return h;
  }
  function taskList(projectId, sel, empId) {
    if (!projectId) return `<option value="">No task</option>` + (sel ? `<option value="${esc(sel)}" selected>(Task)</option>` : "");
    const list = Object.values(RW.map.tasks || {}).filter(t => t.projectId === projectId && (t.status !== "Done" || t.id === sel))
      .sort((a, b) => (a.assigneeId === empId ? 0 : 1) - (b.assigneeId === empId ? 0 : 1) || String(a.title).localeCompare(String(b.title)));
    let h = U.opts(list.map(t => ({ v: t.id, l: t.title + (t.assigneeId === empId ? " (mine)" : "") })), sel, "No task");
    if (sel && !list.some(t => t.id === sel)) h += `<option value="${esc(sel)}" selected>(Deleted task)</option>`;
    return h;
  }
  function entryFields(p, e, empId) {
    e = e || {};
    return `<div class="fgrid">
      <div class="field"><label for="${p}Client">Client</label><select id="${p}Client" name="clientId" data-keep>${U.clientOpts(e.clientId || "", "Internal / no client")}</select></div>
      <div class="field"><label for="${p}Project">Project</label><select id="${p}Project" name="projectId" data-keep>${projList(e.clientId || "", e.projectId || "")}</select></div>
      <div class="field"><label for="${p}Task">Task</label><select id="${p}Task" name="taskId" data-keep>${taskList(e.projectId || "", e.taskId || "", empId)}</select></div>
      <div class="field"><label for="${p}Hours">Hours</label><input id="${p}Hours" name="hours" type="number" min="0.25" max="24" step="0.25" value="${esc(e.hours ?? "")}" placeholder="e.g. 1.5" required data-keep></div>
    </div>
    <div class="field"><label for="${p}Note">What did you work on?</label><input id="${p}Note" name="note" type="text" maxlength="300" value="${esc(e.note || "")}" placeholder="e.g. Diwali reel edits" data-keep></div>
    <label class="check"><input type="checkbox" id="${p}Bill" name="billable"${e.billable === false ? "" : (e.billable || e.clientId || !e.id) ? " checked" : ""} data-keep> Billable to the client</label>`;
  }
  function wirePickers(root, p, empId) {
    const c = root.querySelector("#" + p + "Client"), pr = root.querySelector("#" + p + "Project"), tk = root.querySelector("#" + p + "Task"), b = root.querySelector("#" + p + "Bill");
    if (!c || !pr || !tk) return;
    c.addEventListener("change", () => { pr.innerHTML = projList(c.value, ""); tk.innerHTML = taskList("", "", empId); if (b) b.checked = !!c.value; });
    pr.addEventListener("change", () => {
      tk.innerHTML = taskList(pr.value, "", empId);
      const proj = (RW.map.projects || {})[pr.value];
      if (proj && proj.clientId && !c.value) { c.value = proj.clientId; if (b) b.checked = true; }
    });
  }
  function readEntry(root, p, prevId) {
    const g = n => { const el = root.querySelector("#" + p + n); return el ? String(el.value).trim() : ""; };
    const hours = Number(g("Hours"));
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return { err: "Enter hours between 0.25 and 24." };
    const hq = Math.round(hours * 4) / 4;
    if (Math.abs(hq - hours) > 1e-9) return { err: "Hours go in quarter steps (0.25, 0.5, 0.75…)." };
    const bill = root.querySelector("#" + p + "Bill");
    return { entry: U.clean({ id: prevId || rid(), clientId: g("Client") || undefined, projectId: g("Project") || undefined, taskId: g("Task") || undefined, hours: hq, note: g("Note"), billable: !!(bill && bill.checked) }) };
  }
  function addEntryChecked(day, empId, entry, replaceId) {
    const cur = getLog(day, empId);
    const others = entriesOf(cur).filter(x => x.id !== replaceId);
    const total = others.reduce((s, x) => s + (Number(x.hours) || 0), 0) + entry.hours;
    if (total > 24) { U.toast("That makes more than 24 hours on one day.", "bad"); return Promise.resolve(false); }
    return saveLog(day, empId, base => ({ entries: replaceId ? entriesOf(base).map(x => x.id === replaceId ? entry : x) : entriesOf(base).concat([entry]) }), replaceId ? "Entry updated." : "Time logged.");
  }

  function entryLabel(e) {
    const ctx = RW.ctx;
    const parts = [e.clientId ? (ctx.clientName(e.clientId) || "(Deleted client)") : "Internal"];
    const p = e.projectId && (RW.map.projects || {})[e.projectId]; if (p) parts.push(p.name);
    const t = e.taskId && (RW.map.tasks || {})[e.taskId]; if (t) parts.push(t.title);
    return parts.join(" · ");
  }
  function entryChip(e, day, empId, editable) {
    return `<div class="time-entry"><span class="time-h">${esc(fmtH(e.hours))}</span><span class="grow"><span class="time-lbl">${esc(entryLabel(e))}</span>${e.note ? `<span class="muted small"> — ${esc(e.note)}</span>` : ""}${e.billable ? "" : ` <span class="pill">Non-billable</span>`}</span>${editable ? `<button type="button" class="btn ghost sm" data-act="time.editEntry" data-day="${esc(day)}" data-emp="${esc(empId)}" data-id="${esc(e.id)}" aria-label="Edit entry">Edit</button><button type="button" class="btn ghost sm" data-act="time.delEntry" data-day="${esc(day)}" data-emp="${esc(empId)}" data-id="${esc(e.id)}" aria-label="Delete entry">✕</button>` : ""}</div>`;
  }

  /* ---------- dialogs ---------- */
  function openEntryForm(day, empId, entry) {
    const ctx = RW.ctx;
    if (!canEditDay(ctx, empId)) { U.toast("You can only change your own timesheet.", "bad"); return; }
    U.modal({
      title: (entry ? "Edit time · " : "Log time · ") + D.fmt(day) + (ctx.me && ctx.me.id === empId ? "" : " · " + ctx.empName(empId)),
      submitLabel: entry ? "Save" : "Add entry",
      body: entryFields("te", entry, empId),
      onMount: f => wirePickers(f, "te", empId),
      onSubmit: async f => {
        const r = readEntry(f, "te", entry && entry.id);
        if (r.err) { U.toast(r.err, "bad"); return false; }
        return addEntryChecked(day, empId, r.entry, entry && entry.id);
      }
    });
  }
  function openDayForm(day, empId) {
    const ctx = RW.ctx;
    if (!canEditDay(ctx, empId)) { U.toast("You can only change your own timesheet.", "bad"); return; }
    const log = getLog(day, empId) || {};
    U.modal({
      title: "Attendance · " + D.fmt(day) + (ctx.me && ctx.me.id === empId ? "" : " · " + ctx.empName(empId)),
      body: `<div class="fgrid">${U.field({ label: "Check in", name: "checkIn", type: "time", value: log.checkIn || "" })}${U.field({ label: "Check out", name: "checkOut", type: "time", value: log.checkOut || "" })}</div>
        ${U.field({ label: "Working from", name: "mode", options: MODES.map(m => ({ v: m, l: m === "WFH" ? "Home (WFH)" : m })), value: log.mode || "Office" })}
        <p class="hint" style="margin:0">Leave both times empty to clear attendance for this day. Time entries are kept.</p>`,
      onSubmit: async f => {
        const ci = U.fv(f, "checkIn"), co = U.fv(f, "checkOut"), mode = U.fv(f, "mode");
        if (co && !ci) { U.toast("Add a check-in time first.", "bad"); return false; }
        if (ci && co && hmToMin(co) < hmToMin(ci)) { U.toast("Check-out is before check-in.", "bad"); return false; }
        return saveLog(day, empId, { checkIn: ci || "", checkOut: co || "", mode: MODES.includes(mode) ? mode : "Office" }, "Attendance saved.");
      }
    });
  }
  function openSettings() {
    const ctx = RW.ctx;
    if (!ctx.adminWrite) return;
    const t = timeSettings();
    U.modal({
      title: "Timesheet settings",
      body: `<div class="fgrid">${U.field({ label: "Office start time", name: "officeStart", type: "time", value: t.officeStart, required: true })}${U.field({ label: "Grace period (minutes)", name: "graceMins", type: "number", min: 0, max: 180, step: 1, value: t.graceMins })}</div>
        ${U.field({ label: "Daily target hours", name: "dailyTargetHours", type: "number", min: 1, max: 16, step: 0.5, value: t.dailyTargetHours, hint: "Used for utilisation: working days × target hours." })}
        <div class="calc">Check-ins after ${esc(lateAfter())} are marked late.</div>
        <hr class="time-hr"><p class="small muted" style="margin:0">Old timesheets use database space (one record per person per day). You can delete logs older than a cutoff.</p>
        <div class="filters"><select id="tCleanMonths" aria-label="Cleanup age"><option value="12">Older than 12 months</option><option value="18">Older than 18 months</option><option value="24">Older than 24 months</option></select><button type="button" class="btn sm danger" id="tCleanBtn">Delete old logs</button></div>`,
      onMount: f => {
        const btn = f.querySelector("#tCleanBtn");
        btn.addEventListener("click", async () => {
          const months = Number(f.querySelector("#tCleanMonths").value) || 12;
          const cutoff = D.addMonths(ctx.today.slice(0, 7), -months) + "-01";
          btn.disabled = true;
          const n = await cleanup(cutoff);
          btn.disabled = false;
          if (n !== false) U.toast(n ? `Deleted ${n} old day logs from before ${D.fmt(cutoff)}.` : "No logs that old.");
        });
      },
      onSubmit: async f => {
        const os = U.fv(f, "officeStart"), g = Number(U.fv(f, "graceMins")), tt = Number(U.fv(f, "dailyTargetHours"));
        if (hmToMin(os) === null) { U.toast("Enter the office start time.", "bad"); return false; }
        if (!Number.isFinite(g) || g < 0 || g > 180) { U.toast("Grace period must be 0–180 minutes.", "bad"); return false; }
        if (!Number.isFinite(tt) || tt <= 0 || tt > 16) { U.toast("Daily target must be between 1 and 16 hours.", "bad"); return false; }
        return RW.write.set("org/timeSettings", { officeStart: os, graceMins: Math.round(g), dailyTargetHours: tt }, "Timesheet settings saved.");
      }
    });
  }
  async function cleanup(cutoff) {
    const db = RW.S.db; if (!db) return false;
    let total = 0;
    for (let round = 0; round < 20; round++) {
      let snap;
      try { snap = await db.collection(KEY).where("day", "<", cutoff).limit(200).get(); }
      catch (e) { U.toast("Couldn't read old logs. Try again later.", "bad"); return false; }
      if (!snap.docs.length) break;
      for (const d of snap.docs) { const ok = await RW.write.del(KEY + "/" + d.id); if (!ok) return total; total++; }
      if (snap.docs.length < 200) break;
    }
    return total;
  }

  /* ---------- actions ---------- */
  RW.action("time.tab", el => { const t = el.dataset.tab; RW.go("time", t === "my" ? "" : t); });
  RW.action("time.checkIn", el => {
    const ctx = RW.ctx, emp = el.dataset.emp;
    if (!canEditDay(ctx, emp)) return;
    const log = getLog(ctx.today, emp);
    const mode = (log && log.mode) || RW.prefs.get("time.mode", "Office");
    return saveLog(ctx.today, emp, { checkIn: nowHM(), mode: MODES.includes(mode) ? mode : "Office" }, "Checked in at " + nowHM() + ".");
  });
  RW.action("time.checkOut", el => {
    const ctx = RW.ctx, emp = el.dataset.emp;
    if (!canEditDay(ctx, emp)) return;
    const log = getLog(ctx.today, emp);
    if (!log || !log.checkIn) { U.toast("Check in first.", "bad"); return; }
    let t = nowHM(); if (hmToMin(t) < hmToMin(log.checkIn)) t = log.checkIn;
    return saveLog(ctx.today, emp, { checkOut: t }, "Checked out at " + t + ".");
  });
  RW.action("time.undoOut", el => { const ctx = RW.ctx, emp = el.dataset.emp; if (!canEditDay(ctx, emp)) return; return saveLog(ctx.today, emp, { checkOut: "" }, "Check-out removed."); });
  RW.action("time.mode", el => {
    const ctx = RW.ctx, emp = el.dataset.emp, mode = el.dataset.mode;
    if (!canEditDay(ctx, emp) || !MODES.includes(mode)) return;
    RW.prefs.set("time.mode", mode);
    const log = getLog(ctx.today, emp);
    if (!log) { RW.render(); return; } // remembered for check-in
    if (log.mode === mode) return;
    return saveLog(ctx.today, emp, { mode });
  });
  RW.action("time.addEntry", el => openEntryForm(el.dataset.day, el.dataset.emp, null));
  RW.action("time.editEntry", el => { const e = entriesOf(getLog(el.dataset.day, el.dataset.emp)).find(x => x.id === el.dataset.id); if (e) openEntryForm(el.dataset.day, el.dataset.emp, e); });
  RW.action("time.delEntry", async el => {
    const { day, emp, id } = el.dataset;
    if (!canEditDay(RW.ctx, emp)) return;
    if (!(await U.confirm("Delete this time entry?", "Delete"))) return;
    return saveLog(day, emp, base => ({ entries: entriesOf(base).filter(x => x.id !== id) }), "Entry deleted.");
  });
  RW.action("time.editDay", el => openDayForm(el.dataset.day, el.dataset.emp));
  RW.action("time.week", el => { const n = Number(el.dataset.step) || 0; ui.weekStart = n === 0 ? mondayOf(D.today()) : D.addDays(ui.weekStart || mondayOf(D.today()), 7 * n); RW.render(); });
  RW.action("time.month", el => { const n = Number(el.dataset.step) || 0; const cur = ui.month || D.today().slice(0, 7); ui.month = n === 0 ? D.today().slice(0, 7) : D.addMonths(cur, n); RW.render(); });
  RW.action("time.settings", () => openSettings());
  RW.action("time.copyWeek", async el => {
    const ctx = RW.ctx, emp = el.dataset.emp;
    if (!canEditDay(ctx, emp)) return;
    const ws = ui.weekStart || mondayOf(ctx.today);
    const hol = RW.leave.holidaySet(), idx = leaveIndex(ctx, D.addDays(ws, -7), D.addDays(ws, 6));
    const empRec = ctx.employeeById[emp] || { id: emp };
    const plan = [];
    for (let i = 0; i < 7; i++) {
      const day = D.addDays(ws, i), src = D.addDays(day, -7);
      const srcE = entriesOf(getLog(src, emp)); if (!srcE.length) continue;
      const info = dayInfo(empRec, day, idx, hol, ctx.today);
      if (!info.working || entriesOf(info.log).length) continue;
      plan.push({ day, entries: srcE.map(e => Object.assign({}, e, { id: rid() })) });
    }
    if (!plan.length) { U.toast("Nothing to copy. Last week has no entries for this week's empty working days.", "bad"); return; }
    if (!(await U.confirm(`Copy last week's entries into ${plan.length} empty day${plan.length === 1 ? "" : "s"} this week?`, "Copy entries"))) return;
    let n = 0;
    for (const p of plan) { const ok = await saveLog(p.day, emp, base => ({ entries: entriesOf(base).concat(p.entries) })); if (!ok) break; n++; }
    if (n) U.toast(`Copied entries into ${n} day${n === 1 ? "" : "s"}.`);
  });
  RW.onChange("time.emp", el => { ui.empId = el.value; RW.render(); });
  RW.action("time.csv", el => {
    const kind = el.dataset.kind, ctx = RW.ctx;
    const ym = ui.month || ctx.today.slice(0, 7);
    if (kind === "att") U.csvCopy(attendanceRows(ctx, ym).csv, "Attendance");
    else if (kind === "util") U.csvCopy(utilRows(ctx, ym).csv, "Utilisation");
    else if (kind === "clients") U.csvCopy(clientHours(ctx, ym).csv, "Client hours");
    else if (kind === "week") U.csvCopy(weekCsv(ctx, el.dataset.emp), "Timesheet");
  });

  /* ---------- report builders ---------- */
  function attendanceRows(ctx, ym) {
    const from = ym + "-01", to = monthEnd(ym), days = daysIn(from, to);
    const hol = RW.leave.holidaySet(), idx = leaveIndex(ctx, from, to);
    const rows = ctx.employees.map(e => {
      const cells = days.map(d => dayInfo(e, d, idx, hol, ctx.today));
      const cnt = k => cells.filter(c => c.code === k).length;
      return { emp: e, cells, P: cnt("P") + cnt("F"), WFH: cnt("WFH"), L: cnt("L") + cnt("HL") * 0.5, A: cnt("A"), late: cells.filter(c => c.late).length };
    });
    const csv = [["Employee"].concat(days.map(d => d.slice(8)), ["Present", "WFH", "Leave", "Absent", "Late"])]
      .concat(rows.map(r => [r.emp.name].concat(r.cells.map(c => (CODE_SHORT[c.code] || "") + (c.late ? "*" : "")), [r.P, r.WFH, r.L, r.A, r.late])));
    return { days, rows, csv };
  }
  function utilRows(ctx, ym) {
    const from = ym + "-01", end = monthEnd(ym), to = end < ctx.today ? end : ctx.today;
    const hol = RW.leave.holidaySet(), idx = leaveIndex(ctx, from, end), t = timeSettings();
    const rows = ctx.employees.map(e => {
      let hours = 0, bill = 0;
      daysIn(from, end).forEach(d => { const l = getLog(d, e.id); hours += hoursOf(l); bill += billableOf(l); });
      const exp = to >= from ? expectedDays(e, from, to, idx, hol) : 0;
      const target = r2(exp * t.dailyTargetHours);
      return { emp: e, hours: r2(hours), bill: r2(bill), billPct: pct(bill, hours), exp, target, util: pct(hours, target) };
    });
    const csv = [["Employee", "Team", "Expected days", "Target hours", "Logged hours", "Billable hours", "Billable %", "Utilisation %"]]
      .concat(rows.map(r => [r.emp.name, r.emp.team || "", r.exp, r.target, r.hours, r.bill, r.billPct, r.util]));
    return { rows, csv, to };
  }
  function clientHours(ctx, ym, onlyClient) {
    const from = ym + "-01", to = monthEnd(ym);
    const byClient = {}, empSet = new Set();
    (ctx.state[KEY] || []).forEach(snapLog => {
      if (!snapLog.day || snapLog.day < from || snapLog.day > to) return;
      const l = getLog(snapLog.day, snapLog.employeeId) || snapLog;
      entriesOf(l).forEach(e => {
        const c = e.clientId || "";
        if (onlyClient && c !== onlyClient) return;
        const row = byClient[c] = byClient[c] || { clientId: c, total: 0, bill: 0, byEmp: {}, byProj: {} };
        const hrs = Number(e.hours) || 0;
        row.total += hrs; if (e.billable) row.bill += hrs;
        row.byEmp[l.employeeId] = (row.byEmp[l.employeeId] || 0) + hrs;
        const pk = e.projectId || ""; row.byProj[pk] = (row.byProj[pk] || 0) + hrs;
        empSet.add(l.employeeId);
      });
    });
    const rows = Object.values(byClient).sort((a, b) => b.total - a.total);
    const empIds = [...empSet].sort((a, b) => ctx.empName(a).localeCompare(ctx.empName(b)));
    const cname = id => id ? (ctx.clientName(id) || "(Deleted client)") : "Internal / no client";
    const csv = [["Client", "Total hours", "Billable hours"].concat(empIds.map(ctx.empName))]
      .concat(rows.map(r => [cname(r.clientId), r2(r.total), r2(r.bill)].concat(empIds.map(i => r2(r.byEmp[i] || 0)))));
    return { rows, empIds, csv, cname };
  }
  function weekCsv(ctx, emp) {
    const ws = ui.weekStart || mondayOf(ctx.today);
    const out = [["Date", "Check in", "Check out", "Mode", "Client", "Project", "Task", "Hours", "Billable", "Note"]];
    for (let i = 0; i < 7; i++) {
      const d = D.addDays(ws, i), l = getLog(d, emp);
      const es = entriesOf(l);
      if (!es.length && l) out.push([d, l.checkIn || "", l.checkOut || "", l.mode || "", "", "", "", "", "", ""]);
      es.forEach(e => out.push([d, (l && l.checkIn) || "", (l && l.checkOut) || "", (l && l.mode) || "", e.clientId ? ctx.clientName(e.clientId) : "Internal",
        e.projectId && ctx.projectById[e.projectId] ? ctx.projectById[e.projectId].name : "", e.taskId && RW.map.tasks && RW.map.tasks[e.taskId] ? RW.map.tasks[e.taskId].title : "", e.hours, e.billable ? "Yes" : "No", e.note || ""]));
    }
    return out;
  }

  /* ---------- views ---------- */
  function tabs(ctx, cur) {
    const t = [["my", "My timesheet"]];
    if (ctx.isAdmin) t.push(["attendance", "Attendance register"], ["utilisation", "Utilisation"], ["clients", "Client hours"]);
    return t.length > 1 ? U.tabsHTML(t.map(([k, l]) => [k, esc(l)]), cur, "time.tab") : "";
  }
  function monthNav(ym) {
    const min = D.addMonths(D.today().slice(0, 7), -2), max = D.today().slice(0, 7);
    return `<div class="filters time-nav"><button type="button" class="btn sm" data-act="time.month" data-step="-1"${ym <= min ? " disabled" : ""} aria-label="Previous month">‹</button><strong>${esc(D.monthLabel(ym))}</strong><button type="button" class="btn sm" data-act="time.month" data-step="1"${ym >= max ? " disabled" : ""} aria-label="Next month">›</button>${ym !== max ? `<button type="button" class="btn ghost sm" data-act="time.month" data-step="0">This month</button>` : ""}</div>`;
  }
  function clampMonth() {
    const min = D.addMonths(D.today().slice(0, 7), -2), max = D.today().slice(0, 7);
    if (!ui.month || ui.month < min) ui.month = ui.month && ui.month < min ? min : max;
    if (ui.month > max) ui.month = max;
    return ui.month;
  }

  function viewMy(ctx) {
    const isAdmin = ctx.isAdmin;
    if (!ctx.me && !isAdmin) return `<div class="start"><strong>Your account isn't linked to an employee profile yet.</strong><p class="muted" style="margin:6px 0 0">Ask HR to add your profile on the People page with the email you sign in with. Then you can check in and log your hours here.</p></div>`;
    if (!ctx.employees.length) return `<div class="empty">No people yet. ${isAdmin ? "Add employees on the People page first." : ""}</div>`;
    let empId = ui.empId && ctx.employeeById[ui.empId] ? ui.empId : (ctx.me ? ctx.me.id : ctx.employees[0].id);
    if (!isAdmin) empId = ctx.me.id;
    const emp = ctx.employeeById[empId];
    const mine = !!(ctx.me && ctx.me.id === empId);
    const editable = canEditDay(ctx, empId);
    const today = ctx.today, hol = RW.leave.holidaySet(), hmap = RW.leave.holidayMap();
    if (!ui.weekStart) ui.weekStart = mondayOf(today);
    const ws = ui.weekStart, we = D.addDays(ws, 6);
    const idx = leaveIndex(ctx, ws < today ? ws : today, we > today ? we : today);
    const tInfo = dayInfo(emp, today, idx, hol, today);
    const tl = tInfo.log;
    const modeNow = (tl && tl.mode) || RW.prefs.get("time.mode", "Office");

    let out = "";
    if (isAdmin) out += `<div class="filters"><label class="small muted" for="timeEmp">Timesheet for</label><select id="timeEmp" data-change="time.emp">${U.empOpts(empId)}</select>${!ctx.me ? `<span class="small muted">Your own account isn't linked to a profile, so pick a person.</span>` : ""}</div>`;

    // Today panel
    let status;
    if (tInfo.fullLeave) status = U.pill("On leave today", "warn");
    else if (tInfo.holiday) status = U.pill("Holiday: " + (hmap[today] || ""), "accent");
    else if (tInfo.weekend) status = U.pill("Weekend", "");
    else status = "";
    const btns = !editable ? "" : !tl || !tl.checkIn
      ? `<button type="button" class="btn primary time-big" data-act="time.checkIn" data-emp="${esc(empId)}">Check in</button>`
      : !tl.checkOut ? `<button type="button" class="btn primary time-big" data-act="time.checkOut" data-emp="${esc(empId)}">Check out</button>`
      : `<button type="button" class="btn ghost sm" data-act="time.undoOut" data-emp="${esc(empId)}">Undo check-out</button>`;
    const modeBtns = MODES.map(m => `<button type="button" class="btn sm ${modeNow === m ? "primary" : ""}" aria-pressed="${modeNow === m}" data-act="time.mode" data-mode="${esc(m)}" data-emp="${esc(empId)}"${editable ? "" : " disabled"}>${m === "WFH" ? "WFH" : esc(m)}</button>`).join("");
    const todayEntries = entriesOf(tl);
    out += `<section class="panel"><div class="panel-head"><h2>${mine ? "My day" : esc(emp.name) + "'s day"} · ${esc(D.fmt(today))}</h2>${status}</div>
      <div class="time-today">
        <div class="time-clock">${btns}
          <div class="time-times"><div><span class="small muted">In</span><strong>${esc((tl && tl.checkIn) || "—")}</strong>${tInfo.late ? ` ${U.pill("Late", "bad")}` : ""}</div><div><span class="small muted">Out</span><strong>${esc((tl && tl.checkOut) || "—")}</strong></div><div><span class="small muted">Logged</span><strong>${esc(fmtH(hoursOf(tl)))}</strong></div></div>
          <div class="time-modes" role="group" aria-label="Working from">${modeBtns}</div>
          ${editable ? `<button type="button" class="btn ghost sm" data-act="time.editDay" data-day="${esc(today)}" data-emp="${esc(empId)}">Edit times</button>` : ""}
        </div>
        <div class="time-quick">
          ${editable ? `<form id="timeQuick" class="time-qform" novalidate><h3 class="time-sub">Quick add for today</h3>${entryFields("tq", null, empId)}<div><button type="submit" class="btn primary">Add entry</button></div></form>` : `<p class="muted small">View only.</p>`}
          <div class="time-list">${todayEntries.length ? todayEntries.map(e => entryChip(e, today, empId, editable)).join("") : `<div class="empty small">No time logged today yet.</div>`}</div>
        </div>
      </div></section>`;

    // Week grid
    let wkTotal = 0, wkBill = 0;
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const d = D.addDays(ws, i), info = dayInfo(emp, d, idx, hol, today), l = info.log;
      const hrs = hoursOf(l); wkTotal += hrs; wkBill += billableOf(l);
      const flag = info.code ? `<span class="time-code c-${esc(info.code)}" title="${esc(CODE_LABEL[info.code] || "")}">${esc(CODE_SHORT[info.code])}</span>` : "";
      const note = info.holiday ? `<span class="small muted">${esc(hmap[d] || "Holiday")}</span>` : info.fullLeave ? `<span class="small muted">${esc(RW.leave.typeName(info.leave.type))} leave</span>` : info.halfLeave ? `<span class="small muted">Half-day leave</span>` : "";
      const missing = info.working && d < today && hrs === 0;
      rows.push(`<tr class="${info.weekend ? "time-wkend" : ""}${d === today ? " time-todayrow" : ""}">
        <td class="time-dcell"><strong>${esc(D.parse(d).toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" }))}</strong> <span class="muted small">${esc(D.fmtShort(d))}</span><div>${flag} ${note}</div></td>
        <td class="num">${esc((l && l.checkIn) || "—")}${info.late ? ` <span class="pill bad">Late</span>` : ""}<br><span class="muted small">${esc((l && l.checkOut) || "")}</span></td>
        <td>${entriesOf(l).map(e => entryChip(e, d, empId, editable)).join("") || (missing ? `<span class="pill warn">No time logged</span>` : `<span class="muted small">—</span>`)}</td>
        <td class="num"><strong>${hrs ? esc(fmtH(hrs)) : "—"}</strong></td>
        <td class="time-rowact">${editable ? `<button type="button" class="btn sm" data-act="time.addEntry" data-day="${esc(d)}" data-emp="${esc(empId)}">+ Time</button><button type="button" class="btn ghost sm" data-act="time.editDay" data-day="${esc(d)}" data-emp="${esc(empId)}">In/out</button>` : ""}</td></tr>`);
    }
    const winStart = windowStart();
    const t = timeSettings();
    out += `<section class="panel"><div class="panel-head"><h2>Week of ${esc(D.fmt(ws))}</h2>
        <div class="filters time-nav"><button type="button" class="btn sm" data-act="time.week" data-step="-1"${ws <= winStart ? " disabled" : ""} aria-label="Previous week">‹</button><button type="button" class="btn sm" data-act="time.week" data-step="0">This week</button><button type="button" class="btn sm" data-act="time.week" data-step="1" aria-label="Next week">›</button>
        ${editable ? `<button type="button" class="btn sm" data-act="time.copyWeek" data-emp="${esc(empId)}">Copy last week's rows</button>` : ""}<button type="button" class="btn ghost sm" data-act="time.csv" data-kind="week" data-emp="${esc(empId)}">Copy CSV</button></div></div>
      <div class="tbl-wrap"><table class="time-week"><thead><tr><th>Day</th><th>In / out</th><th>Entries</th><th class="num">Hours</th><th></th></tr></thead><tbody>${rows.join("")}</tbody>
      <tfoot><tr><td colspan="3"><strong>Week total</strong> <span class="muted small">· billable ${esc(fmtH(wkBill))} · target ${esc(fmtH(expectedDays(emp, ws, we, idx, hol) * t.dailyTargetHours))}</span></td><td class="num"><strong>${esc(fmtH(wkTotal))}</strong></td><td></td></tr></tfoot></table></div>
      ${ws < winStart ? `<p class="small muted">Only the last three months are loaded here.</p>` : ""}</section>`;
    return out;
  }

  function viewAttendance(ctx) {
    const ym = clampMonth();
    const { days, rows } = attendanceRows(ctx, ym);
    const hol = RW.leave.holidaySet();
    if (!rows.length) return monthNav(ym) + `<div class="empty">No people yet. Add employees on the People page.</div>`;
    const head = `<tr><th class="time-sticky">Employee</th>${days.map(d => `<th class="time-dh${D.isWeekend(d) || hol.has(d) ? " time-wk" : ""}${d === ctx.today ? " time-tcol" : ""}" title="${esc(D.fmt(d))}">${esc(String(Number(d.slice(8))))}<br><span>${esc(D.parse(d).toLocaleDateString("en-IN", { weekday: "narrow", timeZone: "UTC" }))}</span></th>`).join("")}<th class="num">P</th><th class="num">WFH</th><th class="num">L</th><th class="num">A</th><th class="num">Late</th></tr>`;
    const body = rows.map(r => `<tr><td class="time-sticky">${U.av(r.emp)} ${esc(r.emp.name)}</td>${r.cells.map((c, i) => {
      const d = days[i];
      const tip = [D.fmt(d), CODE_LABEL[c.code], c.log && c.log.checkIn ? "In " + c.log.checkIn : "", c.log && c.log.checkOut ? "Out " + c.log.checkOut : "", c.late ? "Late" : ""].filter(Boolean).join(" · ");
      return `<td class="time-ac${c.weekend || c.holiday ? " time-wk" : ""}${c.late ? " time-late" : ""}" title="${esc(tip)}">${c.code ? `<span class="time-code c-${esc(c.code)}">${esc(CODE_SHORT[c.code])}</span>` : ""}</td>`;
    }).join("")}<td class="num">${r.P}</td><td class="num">${r.WFH}</td><td class="num">${r.L}</td><td class="num${r.A ? " overdue" : ""}">${r.A}</td><td class="num${r.late ? " overdue" : ""}">${r.late}</td></tr>`).join("");
    return monthNav(ym) + `<section class="panel"><div class="panel-head"><h2>Attendance register · ${esc(D.monthLabel(ym))}</h2><button type="button" class="btn sm" data-act="time.csv" data-kind="att">Copy CSV</button></div>
      <div class="time-legend small">${["P", "WFH", "F", "L", "HL", "H", "A"].map(k => `<span><span class="time-code c-${k}">${CODE_SHORT[k]}</span> ${esc(CODE_LABEL[k])}</span>`).join("")}<span><span class="time-code time-late-dot"></span> Late check-in (after ${esc(lateAfter())})</span></div>
      <div class="tbl-wrap time-reg"><table><thead>${head}</thead><tbody>${body}</tbody></table></div></section>`;
  }

  function viewUtil(ctx) {
    const ym = clampMonth();
    const { rows, to } = utilRows(ctx, ym);
    const t = timeSettings();
    if (!rows.length) return monthNav(ym) + `<div class="empty">No people yet.</div>`;
    const tot = rows.reduce((a, r) => ({ h: a.h + r.hours, b: a.b + r.bill, t: a.t + r.target }), { h: 0, b: 0, t: 0 });
    const tiles = `<div class="tiles"><div class="tile"><div class="v">${esc(fmtH(tot.h))}</div><div class="l">Logged</div></div><div class="tile"><div class="v">${pct(tot.b, tot.h)}%</div><div class="l">Billable</div></div><div class="tile"><div class="v">${pct(tot.h, tot.t)}%</div><div class="l">Team utilisation</div></div></div>`;
    const tbl = U.tableHTML([
      { label: "Employee", html: r => `${U.av(r.emp)} ${esc(r.emp.name)}<div class="small muted">${esc(r.emp.team || "")}</div>` },
      { label: "Expected days", text: r => String(r.exp), cls: "num" },
      { label: "Target", text: r => fmtH(r.target), cls: "num" },
      { label: "Logged", text: r => fmtH(r.hours), cls: "num" },
      { label: "Billable", html: r => `${esc(fmtH(r.bill))} <span class="muted small">(${r.billPct}%)</span>`, cls: "num" },
      { label: "Utilisation", html: r => `<div class="time-util"><span class="bar"><i style="width:${Math.min(100, r.util)}%"></i></span><span class="${r.target && r.util < 70 ? "overdue" : ""}">${r.util}%</span></div>` }
    ], rows.sort((a, b) => b.util - a.util));
    return monthNav(ym) + tiles + `<section class="panel"><div class="panel-head"><h2>Utilisation · ${esc(D.monthLabel(ym))}</h2><button type="button" class="btn sm" data-act="time.csv" data-kind="util">Copy CSV</button></div>
      <p class="small muted" style="margin:0 0 8px">Target = working days up to ${esc(D.fmt(to))} (excluding weekends, holidays and approved leave) × ${esc(String(t.dailyTargetHours))} hours.</p>${tbl}</section>`;
  }

  function viewClients(ctx) {
    const ym = clampMonth();
    const r = clientHours(ctx, ym);
    if (!r.rows.length) return monthNav(ym) + `<div class="empty">No time logged in ${esc(D.monthLabel(ym))} yet.</div>`;
    const head = `<tr><th>Client</th><th class="num">Total</th><th class="num">Billable</th>${r.empIds.map(i => `<th class="num">${esc(ctx.empName(i))}</th>`).join("")}</tr>`;
    const body = r.rows.map(x => `<tr><td>${x.clientId && ctx.clientById[x.clientId] ? `<a href="#clients-${esc(x.clientId)}">${esc(r.cname(x.clientId))}</a>` : esc(r.cname(x.clientId))}</td><td class="num"><strong>${esc(fmtH(x.total))}</strong></td><td class="num">${esc(fmtH(x.bill))}</td>${r.empIds.map(i => `<td class="num">${x.byEmp[i] ? esc(fmtH(x.byEmp[i])) : `<span class="muted">—</span>`}</td>`).join("")}</tr>`).join("");
    return monthNav(ym) + `<section class="panel"><div class="panel-head"><h2>Hours by client · ${esc(D.monthLabel(ym))}</h2><button type="button" class="btn sm" data-act="time.csv" data-kind="clients">Copy CSV</button></div>
      <p class="small muted" style="margin:0 0 8px">Compare these hours with each client's retainer to see where the team's time goes.</p>
      <div class="tbl-wrap"><table>${"<thead>" + head + "</thead>"}<tbody>${body}</tbody></table></div></section>`;
  }

  function render(el, ctx, route) {
    const sub = ["attendance", "utilisation", "clients"].includes(route.sub) && ctx.isAdmin ? route.sub : "my";
    let html = tabs(ctx, sub);
    if (sub === "attendance") html += viewAttendance(ctx);
    else if (sub === "utilisation") html += viewUtil(ctx);
    else if (sub === "clients") html += viewClients(ctx);
    else html += viewMy(ctx);
    const actions = ctx.adminWrite ? `<button type="button" class="btn" data-act="time.settings">Timesheet settings</button>` : "";
    return {
      html, actions,
      title: sub === "attendance" ? "Attendance register" : sub === "utilisation" ? "Utilisation" : sub === "clients" ? "Client hours" : "Timesheets",
      after(root) {
        const f = root.querySelector("#timeQuick");
        if (!f) return;
        const c = RW.ctx;
        const empId = c.isAdmin && ui.empId && c.employeeById[ui.empId] ? ui.empId : (c.me ? c.me.id : (c.employees[0] && c.employees[0].id));
        wirePickers(f, "tq", empId);
        f.addEventListener("submit", async e => {
          e.preventDefault();
          const r = readEntry(f, "tq");
          if (r.err) { U.toast(r.err, "bad"); return; }
          const btn = f.querySelector("button[type=submit]"); if (btn) btn.disabled = true;
          const ok = await addEntryChecked(c.today, empId, r.entry);
          if (btn) btn.disabled = false;
          if (ok) { ["tqHours", "tqNote"].forEach(id => { const x = document.getElementById(id); if (x) x.value = ""; }); }
        });
      }
    };
  }

  /* ---------- dashboard / alerts / badge / client tab ---------- */
  function whoIsIn(ctx) {
    const today = ctx.today, hol = RW.leave.holidaySet(), idx = leaveIndex(ctx, today, today);
    const groups = { in: [], wfh: [], leave: [], out: [], notyet: [] };
    ctx.employees.forEach(e => {
      const i = dayInfo(e, today, idx, hol, today);
      if (i.fullLeave) groups.leave.push({ e, i });
      else if (i.log && i.log.checkIn && i.log.checkOut) groups.out.push({ e, i });
      else if (i.log && i.log.checkIn) (i.log.mode === "WFH" ? groups.wfh : groups.in).push({ e, i });
      else if (!i.weekend && !i.holiday) groups.notyet.push({ e, i });
    });
    return groups;
  }
  function widget(ctx) {
    if (!ctx.employees.length) return [];
    return [{
      title: "Who's in today", href: "#time", linkLabel: ctx.isAdmin ? "Attendance" : "My timesheet", order: 15,
      render(body, c) {
        const today = c.today, hol = RW.leave.holidaySet();
        if (D.isWeekend(today) || hol.has(today)) { body.innerHTML = `<div class="empty small">${hol.has(today) ? "Holiday: " + esc(RW.leave.holidayMap()[today] || "") : "It's the weekend."}</div>`; return; }
        const g = whoIsIn(c);
        const rows = [];
        g.in.forEach(x => rows.push(`<div class="row">${U.av(x.e)}<span class="grow">${esc(x.e.name)}</span>${U.pill((x.i.log.mode === "Field" ? "Field " : "In ") + x.i.log.checkIn, x.i.late ? "warn" : "good")}</div>`));
        g.wfh.forEach(x => rows.push(`<div class="row">${U.av(x.e)}<span class="grow">${esc(x.e.name)}</span>${U.pill("WFH " + x.i.log.checkIn, "accent")}</div>`));
        g.leave.forEach(x => rows.push(`<div class="row">${U.av(x.e)}<span class="grow">${esc(x.e.name)}</span>${U.pill("On leave", "warn")}</div>`));
        g.out.forEach(x => rows.push(`<div class="row">${U.av(x.e)}<span class="grow">${esc(x.e.name)}</span>${U.pill("Left " + x.i.log.checkOut, "")}</div>`));
        g.notyet.forEach(x => rows.push(`<div class="row">${U.av(x.e)}<span class="grow">${esc(x.e.name)}</span><span class="muted small">Not in yet</span></div>`));
        const sum = `<p class="small muted" style="margin:0 0 6px">${g.in.length} in office · ${g.wfh.length} WFH · ${g.leave.length} on leave · ${g.notyet.length} not in yet</p>`;
        body.innerHTML = sum + `<div class="list">${rows.slice(0, 8).join("")}</div>` + (rows.length > 8 ? `<p class="small muted" style="margin:6px 0 0">+${rows.length - 8} more</p>` : "");
      }
    }];
  }
  function alerts(ctx) {
    if (!ctx.isAdmin || !ctx.employees.length) return [];
    const hol = RW.leave.holidaySet(), day = prevWorkingDay(ctx.today, hol);
    if (day < windowStart()) return [];
    const miss = missingOn(ctx, day, leaveIndex(ctx, day, day), hol);
    return miss.length ? [{ level: "warn", text: `${miss.length} ${miss.length === 1 ? "person" : "people"} didn't log time on ${D.fmt(day)}`, date: day, href: "#time-attendance" }] : [];
  }
  function badge(ctx) {
    if (!ctx.me) return 0;
    const ws = mondayOf(ctx.today), hol = RW.leave.holidaySet(), idx = leaveIndex(ctx, ws, ctx.today);
    let n = 0;
    for (let d = ws; d < ctx.today; d = D.addDays(d, 1)) { const i = dayInfo(ctx.me, d, idx, hol, ctx.today); if (i.working && hoursOf(i.log) === 0) n++; }
    return n;
  }

  RW.registerClientTab({
    id: "hours", title: "Hours", order: 60,
    render(el, client, ctx) {
      const ym = ctx.today.slice(0, 7), prev = D.addMonths(ym, -1);
      const cur = clientHours(ctx, ym, client.id).rows[0], last = clientHours(ctx, prev, client.id).rows[0];
      const emptyRow = { total: 0, bill: 0, byEmp: {}, byProj: {} };
      const c = cur || emptyRow, l = last || emptyRow;
      const people = Object.entries(c.byEmp).sort((a, b) => b[1] - a[1]);
      const projs = Object.entries(c.byProj).sort((a, b) => b[1] - a[1]);
      const recent = [];
      (ctx.state[KEY] || []).forEach(s => entriesOf(getLog(s.day, s.employeeId) || s).forEach(e => { if (e.clientId === client.id) recent.push({ day: s.day, emp: s.employeeId, e }); }));
      recent.sort((a, b) => b.day.localeCompare(a.day));
      el.innerHTML = `<div class="tiles"><div class="tile"><div class="v">${esc(fmtH(c.total))}</div><div class="l">${esc(D.monthLabel(ym))}</div></div><div class="tile"><div class="v">${esc(fmtH(c.bill))}</div><div class="l">Billable this month</div></div><div class="tile"><div class="v">${esc(fmtH(l.total))}</div><div class="l">${esc(D.monthLabel(prev))}</div></div></div>
        <div class="grid2"><section class="panel"><div class="panel-head"><h2>By person (this month)</h2></div>${people.length ? `<div class="list">${people.map(([id, hrs]) => `<div class="row">${U.av(ctx.employeeById[id])}<span class="grow">${esc(ctx.empName(id))}</span><strong>${esc(fmtH(hrs))}</strong></div>`).join("")}</div>` : `<div class="empty small">No hours this month.</div>`}</section>
        <section class="panel"><div class="panel-head"><h2>By project (this month)</h2></div>${projs.length ? `<div class="list">${projs.map(([id, hrs]) => `<div class="row"><span class="grow">${esc(id && ctx.projectById[id] ? ctx.projectById[id].name : id ? "(Deleted project)" : "No project")}</span><strong>${esc(fmtH(hrs))}</strong></div>`).join("")}</div>` : `<div class="empty small">No hours this month.</div>`}</section></div>
        <section class="panel"><div class="panel-head"><h2>Recent entries</h2></div>${recent.length ? `<div class="list">${recent.slice(0, 10).map(x => `<div class="row"><span class="muted small time-rd">${esc(D.fmtShort(x.day))}</span><span class="grow">${esc(ctx.empName(x.emp))} · ${esc(entryLabel(x.e))}${x.e.note ? ` <span class="muted small">— ${esc(x.e.note)}</span>` : ""}</span><strong>${esc(fmtH(x.e.hours))}</strong></div>`).join("")}</div>` : `<div class="empty small">No time logged for this client in the last three months.</div>`}</section>`;
    }
  });

  RW.register({
    id: "time", title: "Timesheets", icon: ICON, group: "Work", order: 40,
    collections: [{ path: KEY, key: KEY, where: () => [["day", ">=", windowStart()]] }],
    docs: ["org/timeSettings"],
    render, badge, alerts, dashboardWidgets: widget
  });

  /* exposed for tests */
  RW.time = { dayInfo, expectedDays, leaveIndex, hoursOf, billableOf, utilRows, attendanceRows, clientHours, mondayOf, isLate, lateAfter, timeSettings, missingOn, prevWorkingDay };

  RW.addStyle(`
    .time-today{display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:20px}
    @media (max-width:760px){.time-today{grid-template-columns:1fr}}
    .time-clock{display:flex;flex-direction:column;gap:12px;align-items:flex-start}
    .time-big{font-size:1.05rem;padding:14px 28px;min-width:180px;justify-content:center}
    .time-times{display:flex;gap:18px;flex-wrap:wrap}
    .time-times>div{display:flex;flex-direction:column;gap:2px}
    .time-times strong{font-size:1.15rem;font-variant-numeric:tabular-nums}
    .time-modes{display:flex;gap:6px;flex-wrap:wrap}
    .time-quick{display:flex;flex-direction:column;gap:14px;min-width:0}
    .time-qform{display:flex;flex-direction:column;gap:10px;border:1px solid var(--line);border-radius:12px;padding:12px}
    .time-sub{margin:0;font-size:.95rem}
    .time-list{display:flex;flex-direction:column;gap:6px}
    .time-entry{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);border-radius:10px;background:var(--surface);margin:3px 0;min-width:0}
    .time-entry .grow{min-width:0;overflow-wrap:anywhere}
    .time-h{font-weight:700;font-variant-numeric:tabular-nums;min-width:3.2em}
    .time-lbl{font-weight:500}
    table.time-week td{vertical-align:top}
    .time-wkend td{background:color-mix(in srgb,var(--muted) 7%,transparent)}
    .time-todayrow td{box-shadow:inset 0 0 0 9999px color-mix(in srgb,var(--accent) 6%,transparent)}
    .time-dcell{white-space:nowrap}
    .time-rowact{white-space:nowrap;text-align:right}
    .time-rowact .btn{margin-left:4px}
    .time-nav{align-items:center;gap:8px;margin:0}
    .time-code{display:inline-flex;align-items:center;justify-content:center;min-width:1.9em;height:1.6em;padding:0 3px;border-radius:6px;font-size:.72rem;font-weight:700;line-height:1}
    .time-code.c-P{background:var(--good-soft);color:var(--good)}
    .time-code.c-F{background:var(--good-soft);color:var(--good)}
    .time-code.c-WFH{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
    .time-code.c-L,.time-code.c-HL{background:color-mix(in srgb,var(--marigold) 22%,transparent);color:var(--ink)}
    .time-code.c-H{background:color-mix(in srgb,var(--marigold) 12%,transparent);color:var(--muted)}
    .time-code.c-A{background:var(--bad-soft);color:var(--bad)}
    .time-late-dot{min-width:.7em;height:.7em;border-radius:50%;background:var(--bad);padding:0}
    .time-legend{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 10px;align-items:center}
    .time-legend>span{display:inline-flex;gap:5px;align-items:center}
    .time-reg table{font-size:.8rem}
    .time-reg th,.time-reg td{padding:4px 3px;text-align:center}
    .time-reg td.time-sticky,.time-reg th.time-sticky{position:sticky;left:0;background:var(--surface);text-align:left;white-space:nowrap;z-index:1;padding-right:10px}
    .time-dh span{font-weight:400;color:var(--muted)}
    .time-wk{background:color-mix(in srgb,var(--muted) 9%,transparent)}
    .time-tcol{box-shadow:inset 0 -3px 0 var(--accent)}
    .time-ac.time-late{box-shadow:inset 0 0 0 2px var(--bad);border-radius:6px}
    .time-util{display:flex;align-items:center;gap:8px;min-width:140px}
    .time-util .bar{flex:1;min-width:60px}
    .time-hr{border:0;border-top:1px solid var(--line);margin:4px 0}
    .time-rd{min-width:4.5em}
  `, "time");
})();
