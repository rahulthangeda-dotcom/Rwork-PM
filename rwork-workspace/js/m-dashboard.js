"use strict";
/* Dashboard: setup checklist, KPI tiles, Alerts & renewals (from every module's alerts()),
   my tasks, leave this week, project progress, then every module's dashboardWidgets(). */
(function () {
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>';

  function alertsPanel(ctx) {
    const list = RW.collectAlerts(ctx);
    const items = list.slice(0, 12).map(a => {
      const inner = `<span class="dot" style="margin-top:7px;background:${a.level === "danger" ? "var(--bad)" : "var(--warn)"}"></span><span class="grow">${esc(a.text)}</span>${a.date && validDate(a.date) ? `<span class="small muted num" style="white-space:nowrap">${esc(niceShort(a.date))}</span>` : ""}`;
      return a.href && /^#[A-Za-z0-9-]*$/.test(a.href) ? `<a class="alert ${a.level === "danger" ? "danger" : "warn"}" href="${esc(a.href)}">${inner}</a>` : `<div class="alert ${a.level === "danger" ? "danger" : "warn"}">${inner}</div>`;
    }).join("");
    return `<section class="panel"><div class="panel-head"><h2>Alerts &amp; renewals</h2>${list.length ? `<span class="pill ${list.some(a => a.level === "danger") ? "bad" : "warn"} num">${list.length}</span>` : ""}</div>
      ${items ? `<div class="alerts">${items}</div>${list.length > 12 ? `<p class="hint" style="margin:8px 0 0">${list.length - 12} more not shown.</p>` : ""}` : `<div class="empty">All clear. No renewals, overdue invoices or approvals need attention.</div>`}</section>`;
  }

  function vDashboard(el, ctx) {
    const t = ctx.today, wk = addDays(t, 6);
    const all = Object.values(S.tasks), open = all.filter(x => x.status !== "Done"), overdue = open.filter(isOverdue);
    const projects = Object.values(S.projects), active = projects.filter(p => p.status === "Active");
    const onLeave = onLeaveOn(t);
    const activeClients = ctx.clients.filter(c => c.status === "Active" || c.status === "Onboarding");
    const m = ctx.me;
    let html = "";
    if (S.isAdmin && (!emps(true).length || !projects.length || !ctx.clients.length)) {
      html += `<div class="start"><h2>Set up ${esc(settings().companyName)} in five steps</h2><ol>
        <li><a href="#settings">Check the leave policy</a>: Casual 8 and Sick 8 days a year by default. Add holidays.</li>
        <li><a href="#people">Add your team</a>, with their login email, and enter each person's earned leave.</li>
        <li><a href="#clients">Add your clients</a> with contacts, services, contract dates and retainers.</li>
        <li><a href="#projects">Create projects</a> for each client and choose the members.</li>
        <li><a href="#board">Add tasks</a> and assign them.</li></ol>
        <p class="hint" style="margin:10px 0 0">Then send everyone the app's web address. Each person clicks "First time? Set your password" with the email you entered. Give HR and Operations an admin role in People.</p></div>`;
    }
    if (!S.isAdmin && !m) html += RW.ui.notLinkedNote ? RW.ui.notLinkedNote() : "";
    const pendingApprovals = Object.values(S.leaves).filter(l => leaveStatus(l.id) === "pending" && !(m && l.employeeId === m.id)).length;
    html += `<div class="tiles">
      <a class="tile" href="#clients"><span class="v">${activeClients.length}</span><span class="l">Active clients</span></a>
      <a class="tile" href="#projects"><span class="v">${active.length}</span><span class="l">Active projects</span></a>
      <a class="tile" href="#tasks"><span class="v">${open.length}</span><span class="l">Open tasks</span></a>
      <a class="tile${overdue.length ? " alert" : ""}" href="#tasks" data-act="showOverdue"><span class="v">${overdue.length}</span><span class="l">Overdue tasks</span></a>
      <a class="tile leave" href="#calendar"><span class="v">${onLeave.length}</span><span class="l">On leave today</span></a>
      ${S.isAdmin ? `<a class="tile${pendingApprovals ? " leave" : ""}" href="#leave-approvals"><span class="v">${pendingApprovals}</span><span class="l">Leave requests to review</span></a>` : ""}
    </div>`;
    html += alertsPanel(ctx);
    let tl, tlTitle;
    if (m) { tlTitle = "My open tasks"; tl = open.filter(x => x.assigneeId === m.id); }
    else { tlTitle = "Overdue and due this week"; tl = open.filter(x => validDate(x.dueDate) && x.dueDate <= wk); }
    tl.sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
    const taskRows = tl.slice(0, 8).map(x => `<div class="row"><div class="grow"><div class="title">${esc(x.title)}</div><div class="small muted">${esc((S.projects[x.projectId] || {}).name || "No project")}${m ? "" : " / " + esc(empName(x.assigneeId))}</div></div>
      <span class="small num ${isOverdue(x) ? "overdue" : "muted"}">${x.dueDate ? (isOverdue(x) ? "Overdue, " : "Due ") + esc(niceShort(x.dueDate)) : "No date"}</span>${statusPill(x.status)}</div>`).join("");
    const weekLeaves = leavesOverlapping(t, wk, ["approved", "pending"]).sort((a, b) => a.from.localeCompare(b.from));
    const leaveRows = weekLeaves.slice(0, 8).map(l => `<div class="row">${av(S.employees[l.employeeId])}<div class="grow"><div class="title">${esc(empName(l.employeeId))}</div><div class="small muted">${esc(typeName(l.type))}, ${esc(range(l.from, l.to))}</div></div>${leavePill(leaveStatus(l.id))}</div>`).join("");
    html += `<div class="grid2">
      <section class="panel"><div class="panel-head"><h2>${tlTitle}</h2><a href="#board" class="small">Open board</a></div>${taskRows ? `<div class="list">${taskRows}</div>` : `<div class="empty">Nothing here. You're all caught up.</div>`}</section>
      <section class="panel"><div class="panel-head"><h2>Leave in the next 7 days</h2><a href="#calendar" class="small">Open calendar</a></div>${leaveRows ? `<div class="list">${leaveRows}</div>` : `<div class="empty">Nobody is on leave this week.</div>`}</section>
    </div>`;
    const pr = projects.filter(p => p.status !== "Completed").sort((a, b) => String(a.name).localeCompare(String(b.name)));
    html += `<section class="panel"><div class="panel-head"><h2>Project progress</h2><a href="#projects" class="small">All projects</a></div>${pr.length ? `<div class="list">${pr.map(p => { const g = projectProgress(p.id); return `<div class="row"><div class="grow" style="display:flex;flex-direction:column;gap:6px"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><button class="btn ghost sm" style="padding:0;font-size:.95rem" data-act="openProject" data-id="${esc(p.id)}">${esc(p.name)}</button><span class="small muted num">${g.done} of ${g.total} tasks done</span></div><div class="bar" role="img" aria-label="${g.pct}% done"><i style="width:${g.pct}%"></i></div></div>${projPill(p.status)}</div>`; }).join("")}</div>` : `<div class="empty">${S.isAdmin ? "No projects yet. Create one from Projects." : "No projects yet."}</div>`}</section>`;
    el.innerHTML = html;
    // Module widgets
    const widgets = [];
    RW.modules.forEach(mod => {
      if (!mod.dashboardWidgets || (mod.adminOnly && !S.isAdmin)) return;
      try { (mod.dashboardWidgets(ctx) || []).forEach(w => { if (w && typeof w.render === "function") widgets.push(Object.assign({ order: mod.order, mod: mod.id }, w)); }); }
      catch (e) { console.error("[Rwork] dashboardWidgets failed in " + mod.id, e); }
    });
    if (widgets.length) {
      const grid = h("div", { class: "widgets" });
      widgets.sort((a, b) => (a.order || 50) - (b.order || 50)).forEach(w => {
        const sec = h("section", { class: "panel" + (w.wide ? " wide" : "") });
        const head = h("div", { class: "panel-head" }, h("h2", null, w.title || ""));
        if (w.href && /^#[A-Za-z0-9-]*$/.test(w.href)) head.append(h("a", { href: w.href, class: "small" }, w.linkLabel || "Open"));
        const body = h("div");
        sec.append(head, body); grid.append(sec);
        try { w.render(body, ctx); } catch (e) { console.error("[Rwork] widget failed in " + w.mod, e); body.textContent = "This widget couldn't load."; }
      });
      el.append(grid);
    }
    return {};
  }
  RW.register({ id: "dashboard", title: "Dashboard", icon: ICON, group: "Home", order: 0, render: vDashboard });
})();
