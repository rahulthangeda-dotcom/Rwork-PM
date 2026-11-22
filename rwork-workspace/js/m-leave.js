"use strict";
/* Leave (apply / approvals / balances / all requests) and the leave Calendar.
   Collections: leaves (contributors write), approvals (admin writes; doc id = leave id). */
(function () {
  const I = {
    leave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>'
  };
  const isOwnRequest = l => { const m = me(); return !!(m && l.employeeId === m.id); };

  function leaveForm() {
    const m = me();
    if (!S.isAdmin && !m) { toast("Your account isn't linked to an employee profile yet. Ask HR.", "bad"); return; }
    if (!emps().length) { toast("Add people first.", "bad"); return; }
    const types = settings().leaveTypes;
    const t0 = todayStr();
    openModal({
      title: "Apply for leave", submitLabel: "Submit request",
      body: `${S.isAdmin ? `<div class="field"><label for="lEmp">Employee</label><select id="lEmp" name="employeeId">${empOpts(m ? m.id : emps()[0].id)}</select><span class="hint">Admins can apply for themselves or on behalf of anyone.</span></div>` : `<input type="hidden" name="employeeId" value="${esc(m.id)}">`}
        <div class="field"><label for="lType">Leave type</label><select id="lType" name="type">${opts(types.map(t => ({ v: t.key, l: t.name })), types[0] && types[0].key)}</select></div>
        <div class="fgrid">
          <div class="field"><label for="lFrom">From</label><input id="lFrom" name="from" type="date" required value="${t0}"></div>
          <div class="field"><label for="lTo">To</label><input id="lTo" name="to" type="date" required value="${t0}"></div>
        </div>
        <label class="check"><input type="checkbox" id="lHalf" name="halfDay"> Half day (single date only)</label>
        <div class="field"><label for="lReason">Reason</label><textarea id="lReason" name="reason" placeholder="Optional"></textarea></div>
        <div class="calc" id="lCalc" aria-live="polite"></div>`,
      onMount: form => {
        const upd = () => {
          const from = form.elements.from.value, half = form.elements.halfDay.checked;
          if (half) form.elements.to.value = from;
          form.elements.to.disabled = half;
          const r = evalLeave(form);
          const c = $("#lCalc", form); c.className = "calc" + (r.level ? " " + r.level : ""); c.textContent = r.msg;
        };
        form.addEventListener("input", upd); form.addEventListener("change", upd); upd();
      },
      onSubmit: async form => {
        const r = evalLeave(form);
        if (r.level === "bad") { toast(r.msg, "bad"); return false; }
        const f = form.elements;
        const data = { employeeId: f.employeeId.value, type: f.type.value, from: f.from.value, to: f.halfDay.checked ? f.from.value : f.to.value,
          halfDay: f.halfDay.checked, days: r.days, reason: fv(form, "reason"), createdAt: new Date().toISOString(), createdBy: S.viewerId || "" };
        return write(() => col("leaves").add(data), "Leave request submitted.");
      }
    });
  }
  function evalLeave(form) {
    const f = form.elements;
    const empId = f.employeeId.value, type = f.type.value, from = f.from.value, half = f.halfDay.checked, to = half ? from : f.to.value;
    if (!validDate(from) || !validDate(to)) return { level: "bad", msg: "Choose the start and end dates.", days: 0 };
    if (to < from) return { level: "bad", msg: "The end date is before the start date.", days: 0 };
    const days = workingDays(from, to, holidaySet(), half);
    if (days <= 0) return { level: "bad", msg: "These dates are all weekends or holidays. No leave is needed.", days: 0 };
    const clash = leavesOverlapping(from, to, ["approved", "pending"]).find(l => l.employeeId === empId);
    if (clash) return { level: "bad", msg: `This overlaps an existing request (${range(clash.from, clash.to)}).`, days };
    const year = from.slice(0, 4);
    const b = balances(empId, year)[type];
    if (!b) return { level: "", msg: `${fmtDays(days)} of leave.`, days };
    const left = b.quota - b.used - b.pending - workingDays(from, to, holidaySet(), half, year);
    const base = `${fmtDays(days)} of ${b.type.name.toLowerCase()} leave, excluding weekends and holidays.`;
    if (left < 0) return { level: "warn", msg: `${base} This is ${fmtDays(-left)} more than the remaining balance, so it may be rejected.`, days };
    return { level: "", msg: `${base} ${fmtDays(left)} left after this request.`, days };
  }

  function decisionForm(l, status, override) {
    const approve = status === "approved";
    openModal({
      title: approve ? (override ? "Approve your own leave (owner override)" : "Approve leave") : "Reject leave", submitLabel: approve ? "Approve" : "Reject", danger: !approve,
      body: `<p style="margin:0"><strong>${esc(empName(l.employeeId))}</strong>, ${esc(typeName(l.type))} leave, ${esc(range(l.from, l.to))} (${esc(fmtDays(leaveDays(l)))})</p>
        ${l.reason ? `<p class="muted" style="margin:0">Reason: ${esc(l.reason)}</p>` : ""}
        ${override ? `<p class="calc warn" style="margin:0">Normally another admin approves an admin's leave. As the workspace owner you can approve your own.</p>` : ""}
        <div class="field"><label for="dNote">Note to employee</label><textarea id="dNote" name="note" placeholder="Optional"></textarea></div>`,
      onSubmit: form => write(() => col("approvals").doc(l.id).set({ status, note: fv(form, "note"), decidedAt: new Date().toISOString(), decidedBy: S.viewerId || "", selfApproved: !!override }), approve ? "Leave approved." : "Leave rejected.")
    });
  }

  function balanceCards(empId) {
    const year = todayStr().slice(0, 4);
    const b = balances(empId, year);
    return `<div class="bal">${Object.values(b).map(x => { const left = x.quota - x.used; const pct = x.quota ? Math.min(100, x.used / x.quota * 100) : 0; return `<div class="bcard"><span class="small muted">${esc(x.type.name)}</span><span class="v">${esc(Math.round(left * 10) / 10)}<small> of ${esc(x.quota)} left</small></span><div class="bar"><i style="width:${pct}%"></i></div><span class="small muted num">${esc(fmtDays(x.used))} used${x.pending ? `, ${esc(fmtDays(x.pending))} pending` : ""}</span></div>`; }).join("")}</div>`;
  }
  function leaveTable(list, o) {
    if (!list.length) return `<div class="empty">${o.empty}</div>`;
    const m = me();
    const adm = S.isAdmin && !S.readOnly && !!S.db;
    return `<div class="tbl-wrap"><table><thead><tr>${o.showEmp ? "<th>Employee</th>" : ""}<th>Type</th><th>Dates</th><th>Days</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map(l => { const st = leaveStatus(l.id), a = S.approvals[l.id]; const mine = m && l.employeeId === m.id;
        let act = "";
        if (st === "pending" && adm) {
          if (mine) {
            act += `<button class="btn sm" disabled title="Another admin must approve">Approve</button> <button class="btn sm danger" disabled title="Another admin must approve">Reject</button> `;
            if (S.isOwner) act += `<button class="btn sm" data-act="approveOwn" data-id="${esc(l.id)}">Approve my own (owner override)</button> `;
          } else act += `<button class="btn sm" data-act="approve" data-id="${esc(l.id)}">Approve</button> <button class="btn sm danger" data-act="reject" data-id="${esc(l.id)}">Reject</button> `;
        }
        if (st === "pending" && (mine || S.isAdmin) && canWriteShared()) act += `<button class="btn sm ghost" data-act="cancelLeave" data-id="${esc(l.id)}">Cancel</button>`;
        if (st !== "pending" && adm && (!mine || S.isOwner)) act += `<button class="btn sm ghost" data-act="reopenLeave" data-id="${esc(l.id)}">Undo decision</button>`;
        return `<tr>${o.showEmp ? `<td>${esc(empName(l.employeeId))}${mine ? ` <span class="pill">You</span>` : ""}</td>` : ""}<td>${esc(typeName(l.type))}${l.halfDay ? " (half day)" : ""}</td><td class="num">${esc(range(l.from, l.to))}</td><td class="num">${esc(leaveDays(l))}</td>
          <td class="wrap-text">${esc(l.reason || "—")}${a && a.note ? `<div class="small muted">Admin note: ${esc(a.note)}</div>` : ""}</td><td>${leavePill(st)}</td><td style="white-space:nowrap">${act}</td></tr>`; }).join("")}
    </tbody></table></div>`;
  }
  const notLinkedNote = () => `<div class="start"><h2>Your account isn't linked to an employee profile yet</h2><p style="margin:6px 0 0">Ask HR to open People and add your profile with the email you sign in with. Until then you can browse, but you can't apply for leave or update tasks.</p></div>`;
  RW.ui.notLinkedNote = notLinkedNote;

  function vLeave(el, ctx, route) {
    const m = me();
    const tabs = [["mine", "My leave"]];
    if (S.isAdmin) tabs.push(["approvals", "Approvals"], ["balances", "Team balances"], ["all", "All requests"]);
    const tab = tabs.some(t => t[0] === route.sub) ? route.sub : "mine";
    const canApply = canWriteShared() && (S.isAdmin || m);
    const actions = `<button class="btn" data-act="exportLeaves">Export CSV</button>${canApply ? `<button class="btn primary" data-act="applyLeave">Apply for leave</button>` : ""}`;
    let body = "";
    const byNewest = (a, b) => String(b.from).localeCompare(String(a.from));
    if (tab === "mine") {
      if (!m) body = S.isAdmin ? `<div class="empty">Your own account isn't linked to an employee profile. Link it in People to track your own leave. You can still apply on behalf of anyone with Apply for leave.</div>` : notLinkedNote();
      else body = `<section class="stack" style="gap:12px"><h2>Balance for ${esc(todayStr().slice(0, 4))}</h2>${balanceCards(m.id)}</section>
        ${S.isAdmin ? `<p class="hint" style="margin:0">Your own requests are approved by another admin.</p>` : ""}
        <section class="stack" style="gap:12px"><h2>My requests</h2>${leaveTable(Object.values(S.leaves).filter(l => l.employeeId === m.id).sort(byNewest), { empty: "You haven't requested any leave yet." })}</section>`;
    } else if (tab === "approvals") {
      const p = Object.values(S.leaves).filter(l => leaveStatus(l.id) === "pending").sort((a, b) => String(a.from).localeCompare(String(b.from)));
      body = leaveTable(p, { showEmp: true, empty: "No requests waiting for review." });
    } else if (tab === "balances") {
      const year = todayStr().slice(0, 4), types = settings().leaveTypes;
      const list = emps();
      body = list.length ? `<p class="small muted" style="margin:0">Days left for ${esc(year)}, shown as left of quota. Pending requests are not deducted yet.</p><div class="tbl-wrap"><table><thead><tr><th>Employee</th>${types.map(t => `<th>${esc(t.name)}</th>`).join("")}<th>Pending</th></tr></thead><tbody>
        ${list.map(e => { const b = balances(e.id, year); const pend = Object.values(b).reduce((s, x) => s + x.pending, 0); return `<tr><td>${esc(e.name)}</td>${types.map(t => { const x = b[t.key]; const left = x.quota - x.used; return `<td class="num ${left < 0 ? "overdue" : ""}">${esc(Math.round(left * 10) / 10)} / ${esc(x.quota)}</td>`; }).join("")}<td class="num">${pend ? esc(fmtDays(pend)) : "—"}</td></tr>`; }).join("")}
        </tbody></table></div>` : `<div class="empty">Add people to see their balances.</div>`;
    } else {
      const st = S.f.leaveStatus;
      const list = Object.values(S.leaves).filter(l => !st || leaveStatus(l.id) === st).sort(byNewest);
      body = `<div class="filters"><select id="lfStatus" aria-label="Status" data-change="filter" data-key="leaveStatus">${opts([{ v: "pending", l: "Pending" }, { v: "approved", l: "Approved" }, { v: "rejected", l: "Rejected" }], st, "All statuses")}</select></div>${leaveTable(list, { showEmp: true, empty: "No leave requests yet." })}`;
    }
    const pendingCount = Object.values(S.leaves).filter(l => leaveStatus(l.id) === "pending").length;
    const html = `${tabs.length > 1 ? tabsHTML(tabs.map(([k, l]) => [k, esc(l) + (k === "approvals" && pendingCount ? ` (${pendingCount})` : "")]), tab, "leaveTab") : ""}<div class="stack">${body}</div>`;
    return { html, actions };
  }

  function vCalendar() {
    if (!S.calMonth) S.calMonth = todayStr().slice(0, 7);
    const [y, mo] = S.calMonth.split("-").map(Number);
    const first = `${y}-${pad(mo)}-01`;
    const startDow = (parseD(first).getUTCDay() + 6) % 7;
    const gridStart = addDays(first, -startDow);
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const cells = Math.ceil((startDow + lastDay) / 7) * 7;
    const gridEnd = addDays(gridStart, cells - 1);
    const hm = holidayMap(), t = todayStr();
    const lv = leavesOverlapping(gridStart, gridEnd, ["approved", "pending"]);
    let g = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => `<div class="dow">${d}</div>`).join("");
    for (let i = 0; i < cells; i++) {
      const d = addDays(gridStart, i), we = isWeekend(d), hol = hm[d];
      const cls = ["day", d.slice(0, 7) !== S.calMonth ? "out" : "", we ? "we" : "", hol ? "hol" : "", d === t ? "today" : ""].join(" ");
      const chips = (we || hol) ? [] : lv.filter(l => l.from <= d && l.to >= d);
      g += `<div class="${cls}"><span class="d">${Number(d.slice(8))}</span>${hol ? `<span class="hn">${esc(hol)}</span>` : ""}${chips.slice(0, 4).map(l => { const st = leaveStatus(l.id); return `<span class="chip ${st}" title="${esc(empName(l.employeeId))}: ${esc(typeName(l.type))} (${st})">${esc(empName(l.employeeId).split(" ")[0])}${l.halfDay ? " ½" : ""}</span>`; }).join("")}${chips.length > 4 ? `<span class="small muted">+${chips.length - 4} more</span>` : ""}</div>`;
    }
    const html = `<div class="cal-head"><button class="btn sm" data-act="calPrev" aria-label="Previous month">‹ Prev</button><h2 style="min-width:160px;text-align:center">${esc(monthLabel(S.calMonth))}</h2><button class="btn sm" data-act="calNext" aria-label="Next month">Next ›</button><button class="btn sm ghost" data-act="calToday">Today</button>
      <div class="legend" style="margin-left:auto"><span><i class="sw" style="background:var(--marigold)"></i>Approved</span><span><i class="sw chip pending" style="padding:0"></i>Pending</span><span><i class="sw" style="background:var(--marigold-soft);border:1px solid var(--line)"></i>Holiday</span><span><i class="sw" style="background:var(--bg);border:1px solid var(--line)"></i>Weekend</span></div></div>
      <div class="cal">${g}</div>`;
    return { html };
  }

  Object.assign(RW.actions, {
    applyLeave: () => leaveForm(),
    approve: el => { const l = S.leaves[el.dataset.id]; if (!l) return; if (isOwnRequest(l)) { toast("Another admin must approve your own leave.", "bad"); return; } decisionForm(l, "approved"); },
    reject: el => { const l = S.leaves[el.dataset.id]; if (!l) return; if (isOwnRequest(l)) { toast("Another admin must decide on your own leave.", "bad"); return; } decisionForm(l, "rejected"); },
    approveOwn: el => { const l = S.leaves[el.dataset.id]; if (!l || !S.isOwner) return; decisionForm(l, "approved", true); },
    cancelLeave: async el => { const l = S.leaves[el.dataset.id]; if (!l) return; if (await confirmDialog(`Cancel the leave request for ${range(l.from, l.to)}?`, "Cancel request")) await write(() => col("leaves").doc(l.id).delete(), "Leave request cancelled."); },
    reopenLeave: async el => { const l = S.leaves[el.dataset.id]; if (!l) return; if (isOwnRequest(l) && !S.isOwner) { toast("Another admin must change a decision on your own leave.", "bad"); return; } if (await confirmDialog("Move this request back to pending?", "Move to pending")) await write(() => col("approvals").doc(l.id).delete(), "Request moved back to pending."); },
    leaveTab: el => RW.go("leave", el.dataset.tab === "mine" ? "" : el.dataset.tab),
    exportLeaves: () => { const ls = Object.values(S.leaves).filter(l => S.isAdmin || (me() && l.employeeId === me().id)).sort((a, b) => String(a.from).localeCompare(String(b.from))); copyText(csv([["Employee", "Type", "From", "To", "Half day", "Days", "Status", "Reason", "Admin note"], ...ls.map(l => [empName(l.employeeId), typeName(l.type), l.from, l.to, l.halfDay ? "Yes" : "No", leaveDays(l), leaveStatus(l.id), l.reason || "", (S.approvals[l.id] || {}).note || ""])]), "Leave requests"); },
    calPrev: () => { S.calMonth = addMonths(S.calMonth, -1); schedule(); },
    calNext: () => { S.calMonth = addMonths(S.calMonth, 1); schedule(); },
    calToday: () => { S.calMonth = todayStr().slice(0, 7); schedule(); }
  });

  const pendingForMe = () => { const m = me(); return Object.values(S.leaves).filter(l => leaveStatus(l.id) === "pending" && !(m && l.employeeId === m.id)); };
  RW.register({ id: "leave", title: "Leave", icon: I.leave, group: "People", order: 10, render: vLeave,
    badge: () => S.isAdmin ? pendingForMe().length : 0,
    alerts: ctx => {
      const out = [];
      if (ctx.isAdmin) { const p = pendingForMe(); if (p.length) out.push({ level: "warn", text: `${p.length} leave request${p.length === 1 ? "" : "s"} waiting for approval`, href: "#leave-approvals" }); }
      return out;
    } });
  RW.register({ id: "calendar", title: "Leave calendar", icon: I.calendar, group: "People", order: 20, render: vCalendar });
})();
