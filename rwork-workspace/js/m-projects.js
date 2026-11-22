"use strict";
/* Projects, kanban Board and Tasks table. Collections: projects (admin writes), tasks (contributors write). */
(function () {
  const I = {
    projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h6l2 2h10v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>',
    board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="7" rx="1"/></svg>',
    tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6h12M9 12h12M9 18h12"/><path d="M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/></svg>'
  };
  const projClient = p => (p.clientId && S.clients[p.clientId] ? S.clients[p.clientId].name : (p.client || ""));

  function projectForm(p, defaults) {
    const pr = p || Object.assign({ status: "Active", memberIds: [] }, defaults || {});
    const members = emps(true).filter(e => e.active !== false || (pr.memberIds || []).includes(e.id)).map(e => `<label class="check"><input type="checkbox" name="m" value="${esc(e.id)}"${(pr.memberIds || []).includes(e.id) ? " checked" : ""}> ${esc(e.name)}</label>`).join("") || `<span class="hint">Add people first to assign members.</span>`;
    openModal({
      title: p ? "Edit project" : "New project", wide: true, submitLabel: p ? "Save changes" : "Create project",
      body: `<div class="fgrid">
        <div class="field"><label for="pName">Project name</label><input id="pName" name="name" required value="${esc(pr.name)}"></div>
        <div class="field"><label for="pClientId">Client</label><select id="pClientId" name="clientId">${clientOpts(pr.clientId, "Internal / no client")}</select>${!pr.clientId && pr.client ? `<span class="hint">Previously entered as: ${esc(pr.client)}</span>` : ""}</div>
        <div class="field"><label for="pStatus">Status</label><select id="pStatus" name="status">${opts(PROJECT_STATUSES, pr.status)}</select></div>
        <div class="field"></div>
        <div class="field"><label for="pStart">Start date</label><input id="pStart" name="startDate" type="date" value="${esc(pr.startDate)}"></div>
        <div class="field"><label for="pDue">Due date</label><input id="pDue" name="dueDate" type="date" value="${esc(pr.dueDate)}"></div>
      </div>
      <div class="field"><label for="pDesc">Description</label><textarea id="pDesc" name="description">${esc(pr.description)}</textarea></div>
      <div class="field"><span class="flabel">Team members</span><div class="members">${members}</div></div>`,
      onSubmit: async form => {
        const name = fv(form, "name"); if (!name) { toast("Enter a project name.", "bad"); return false; }
        const s = fv(form, "startDate"), d = fv(form, "dueDate");
        if (s && d && d < s) { toast("The due date is before the start date.", "bad"); return false; }
        const clientId = fv(form, "clientId");
        const data = { name, clientId, client: clientId ? clientName(clientId) : (pr.client || ""), status: fv(form, "status"), startDate: s, dueDate: d, description: fv(form, "description"),
          memberIds: [...form.querySelectorAll('input[name="m"]:checked')].map(i => i.value), createdAt: p ? (p.createdAt || new Date().toISOString()) : new Date().toISOString() };
        return write(() => p ? col("projects").doc(p.id).set(data) : col("projects").add(data), p ? "Project updated." : "Project created.");
      }
    });
  }

  function taskForm(t, defaults) {
    const tk = t || Object.assign({ status: "To do", priority: "Medium" }, defaults || {});
    const m = me();
    if (!t && !S.isAdmin && m && !tk.assigneeId) tk.assigneeId = m.id;
    if (!Object.keys(S.projects).length) { toast(S.isAdmin ? "Create a project first, then add tasks to it." : "There are no projects yet. Ask an admin to create one.", "bad"); return; }
    const isNew = !t;
    openModal({
      title: isNew ? "New task" : "Edit task", wide: true, submitLabel: isNew ? "Create task" : "Save changes",
      body: `<div class="field"><label for="tTitle">Task</label><input id="tTitle" name="title" required value="${esc(tk.title)}" placeholder="What needs doing?"></div>
      <div class="fgrid">
        <div class="field"><label for="tProj">Project</label><select id="tProj" name="projectId">${projOpts(tk.projectId)}</select></div>
        <div class="field"><label for="tAssn">Assignee</label><select id="tAssn" name="assigneeId">${empOpts(tk.assigneeId, "Unassigned")}</select></div>
        <div class="field"><label for="tStatus">Status</label><select id="tStatus" name="status">${opts(TASK_STATUSES, tk.status)}</select></div>
        <div class="field"><label for="tPrio">Priority</label><select id="tPrio" name="priority">${opts(PRIORITIES, tk.priority)}</select></div>
        <div class="field"><label for="tDue">Due date</label><input id="tDue" name="dueDate" type="date" value="${esc(tk.dueDate)}"></div>
      </div>
      <div class="field"><label for="tDesc">Details</label><textarea id="tDesc" name="description">${esc(tk.description)}</textarea></div>
      ${!isNew && (S.isAdmin || canEditTask(t)) ? `<button type="button" class="btn danger sm" id="tDelete" style="align-self:flex-start">Delete task</button>` : ""}`,
      onMount: form => {
        const del = $("#tDelete", form);
        if (del) del.addEventListener("click", async () => {
          if (await confirmDialog(`Delete the task "${t.title}"?`)) await write(() => col("tasks").doc(t.id).delete(), "Task deleted.");
        });
      },
      onSubmit: async form => {
        const title = fv(form, "title"); if (!title) { toast("Enter a task name.", "bad"); return false; }
        const data = { title, projectId: fv(form, "projectId"), assigneeId: fv(form, "assigneeId"), status: fv(form, "status"), priority: fv(form, "priority"),
          dueDate: fv(form, "dueDate"), description: fv(form, "description"), createdAt: t ? (t.createdAt || new Date().toISOString()) : new Date().toISOString(), updatedAt: new Date().toISOString() };
        return write(() => t ? col("tasks").doc(t.id).set(data) : col("tasks").add(data), t ? "Task updated." : "Task created.");
      }
    });
  }
  RW.openTaskForm = taskForm; RW.openProjectForm = projectForm;

  function projectCard(p) {
    const g = projectProgress(p.id);
    const mem = (p.memberIds || []).map(id => S.employees[id]).filter(Boolean);
    const late = p.status !== "Completed" && validDate(p.dueDate) && p.dueDate < todayStr();
    const cn = projClient(p);
    return `<button class="pcard" data-act="openProject" data-id="${esc(p.id)}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;width:100%"><h3 style="overflow-wrap:anywhere">${esc(p.name)}</h3>${projPill(p.status)}</div>
      ${cn ? `<div class="small muted">${esc(cn)}</div>` : ""}
      <div class="bar" style="width:100%"><i style="width:${g.pct}%"></i></div>
      <div class="meta" style="width:100%"><span class="num">${g.pct}% done, ${g.total} tasks</span><span class="num ${late ? "overdue" : ""}">${p.dueDate ? "Due " + esc(niceShort(p.dueDate)) : ""}</span></div>
      <div class="avs">${mem.slice(0, 6).map(av).join("")}${mem.length > 6 ? `<span class="small muted" style="margin-left:6px">+${mem.length - 6}</span>` : ""}</div>
    </button>`;
  }
  RW.ui.projectCard = projectCard;

  function vProjects(el, ctx, route) {
    if (route.sub) { const p = S.projects[route.sub]; if (p) return vProjectDetail(p); return { html: `<div class="empty">This project doesn't exist any more. <a href="#projects">See all projects</a>.</div>`, title: "Project not found" }; }
    const list = Object.values(S.projects).sort((a, b) => PROJECT_STATUSES.indexOf(a.status) - PROJECT_STATUSES.indexOf(b.status) || String(a.name).localeCompare(String(b.name)));
    const actions = adminWrite() ? `<button class="btn primary" data-act="newProject">New project</button>` : "";
    const html = list.length ? `<div class="cards">${list.map(projectCard).join("")}</div>` : `<div class="empty">${adminWrite() ? "No projects yet. Create your first project to start adding tasks." : "No projects yet. Admins will add them here."}</div>`;
    return { html, actions };
  }
  function vProjectDetail(p) {
    const g = projectProgress(p.id);
    const ts = Object.values(S.tasks).filter(t => t.projectId === p.id).sort((a, b) => TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
    const mem = (p.memberIds || []).map(id => S.employees[id]).filter(Boolean);
    const actions = `<a class="btn" href="#projects">All projects</a>${canCreateTask() ? `<button class="btn primary" data-act="newTask" data-project="${esc(p.id)}">Add task</button>` : ""}${adminWrite() ? `<button class="btn" data-act="editProject" data-id="${esc(p.id)}">Edit</button><button class="btn danger" data-act="deleteProject" data-id="${esc(p.id)}">Delete</button>` : ""}`;
    const client = p.clientId && S.clients[p.clientId];
    const html = `<section class="panel stack" style="gap:12px">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h2 style="font-size:1.4rem">${esc(p.name)}</h2>${projPill(p.status)}</div>
        ${p.description ? `<p style="margin:0;max-width:70ch;white-space:pre-wrap">${esc(p.description)}</p>` : ""}
        <div class="tiles">
          <div class="tile"><span class="l">Client</span><strong>${client ? `<a href="#clients-${esc(client.id)}">${esc(client.name)}</a>` : esc(p.client || "Internal")}</strong></div>
          <div class="tile"><span class="l">Timeline</span><strong class="num">${p.startDate ? esc(niceShort(p.startDate)) : "—"} to ${p.dueDate ? esc(nice(p.dueDate)) : "—"}</strong></div>
          <div class="tile"><span class="l">Progress</span><strong class="num">${g.done} of ${g.total} tasks (${g.pct}%)</strong><div class="bar"><i style="width:${g.pct}%"></i></div></div>
        </div>
        <div><div class="small muted" style="margin-bottom:6px">Team</div>${mem.length ? `<div style="display:flex;flex-wrap:wrap;gap:10px">${mem.map(e => `<span style="display:inline-flex;align-items:center;gap:6px">${av(e)}<span class="small">${esc(e.name)}</span></span>`).join("")}</div>` : `<span class="small muted">No members assigned.</span>`}</div>
      </section>
      <section><div class="panel-head"><h2>Tasks</h2></div>${taskTable(ts, false)}</section>`;
    return { html, actions, title: p.name };
  }

  function taskCard(t) {
    const edit = canEditTask(t);
    return `<div class="tcard p-${esc(t.priority || "Medium")}" data-id="${esc(t.id)}" ${edit ? 'draggable="true"' : ""}>
      <div class="t">${esc(t.title)}</div>
      <div class="meta"><span>${esc((S.projects[t.projectId] || {}).name || "No project")}</span><span class="num ${isOverdue(t) ? "overdue" : ""}">${t.dueDate ? esc(niceShort(t.dueDate)) : ""}</span></div>
      <div class="meta"><span style="display:inline-flex;align-items:center;gap:6px">${t.assigneeId && S.employees[t.assigneeId] ? av(S.employees[t.assigneeId]) + esc(empName(t.assigneeId)) : "Unassigned"}</span>
        ${edit ? `<select aria-label="Status" data-change="taskStatus" data-id="${esc(t.id)}">${opts(TASK_STATUSES, t.status)}</select>` : ""}</div>
      <button class="btn ghost sm" style="align-self:flex-start;padding:0" data-act="openTask" data-id="${esc(t.id)}">${edit ? "Edit" : "Details"}</button>
    </div>`;
  }
  function vBoard() {
    const f = S.f;
    let ts = Object.values(S.tasks);
    if (f.boardProject) ts = ts.filter(t => t.projectId === f.boardProject);
    if (f.boardAssignee === "__me") { const m = me(); ts = ts.filter(t => m && t.assigneeId === m.id); }
    else if (f.boardAssignee) ts = ts.filter(t => t.assigneeId === f.boardAssignee);
    const prioRank = p => PRIORITIES.indexOf(p) < 0 ? 1 : PRIORITIES.indexOf(p);
    const actions = canCreateTask() ? `<button class="btn primary" data-act="newTask" ${f.boardProject ? `data-project="${esc(f.boardProject)}"` : ""}>New task</button>` : "";
    const html = `<div class="filters">
        <select id="bProj" aria-label="Project" data-change="filter" data-key="boardProject">${opts(Object.values(S.projects).sort((a, b) => String(a.name).localeCompare(String(b.name))).map(p => ({ v: p.id, l: p.name })), f.boardProject, "All projects")}</select>
        <select id="bAssn" aria-label="Assignee" data-change="filter" data-key="boardAssignee"><option value="">Everyone</option>${me() ? `<option value="__me"${f.boardAssignee === "__me" ? " selected" : ""}>Only me</option>` : ""}${emps().map(e => `<option value="${esc(e.id)}"${f.boardAssignee === e.id ? " selected" : ""}>${esc(e.name)}</option>`).join("")}</select>
        <span class="hint">Drag cards between columns, or change the status on the card.</span>
      </div>
      <div class="board" id="board">${TASK_STATUSES.map(s => { const c = ts.filter(t => (t.status || "To do") === s).sort((a, b) => prioRank(a.priority) - prioRank(b.priority) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999")); return `<div class="col" data-col="${esc(s)}"><div class="col-head"><span>${esc(s)}</span><span class="pill num">${c.length}</span></div>${c.map(taskCard).join("") || `<div class="hint" style="padding:8px">No tasks</div>`}</div>`; }).join("")}</div>`;
    return { html, actions, after: wireBoard };
  }
  function wireBoard() {
    const board = $("#board"); if (!board) return;
    board.querySelectorAll('.tcard[draggable="true"]').forEach(c => c.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", c.dataset.id); e.dataTransfer.effectAllowed = "move"; }));
    board.querySelectorAll(".col").forEach(colEl => {
      colEl.addEventListener("dragover", e => { e.preventDefault(); colEl.classList.add("drop"); });
      colEl.addEventListener("dragleave", e => { if (!colEl.contains(e.relatedTarget)) colEl.classList.remove("drop"); });
      colEl.addEventListener("drop", e => { e.preventDefault(); colEl.classList.remove("drop"); const id = e.dataTransfer.getData("text/plain"); setTaskStatus(id, colEl.dataset.col); });
    });
  }
  async function setTaskStatus(id, status) {
    const t = S.tasks[id]; if (!t || t.status === status || !TASK_STATUSES.includes(status)) return;
    if (!canEditTask(t)) { toast("You can only move tasks assigned to you.", "bad"); return; }
    const ok = await write(() => col("tasks").doc(id).update({ status, updatedAt: new Date().toISOString() }), `Moved to ${status}.`);
    if (!ok) schedule();
  }

  function filteredTasks() {
    const f = S.f, q = f.search.toLowerCase();
    let ts = Object.values(S.tasks).filter(t =>
      (!q || [t.title, t.description, (S.projects[t.projectId] || {}).name, empName(t.assigneeId)].join(" ").toLowerCase().includes(q)) &&
      (!f.status || t.status === f.status) && (!f.priority || t.priority === f.priority) &&
      (!f.assignee || t.assigneeId === f.assignee) && (!f.project || t.projectId === f.project) && (!f.overdue || isOverdue(t)));
    const key = f.sort, dir = f.dir === "desc" ? -1 : 1;
    const val = t => key === "project" ? ((S.projects[t.projectId] || {}).name || "") : key === "assignee" ? empName(t.assigneeId) : key === "priority" ? PRIORITIES.indexOf(t.priority) : key === "status" ? TASK_STATUSES.indexOf(t.status) : key === "dueDate" ? (t.dueDate || "9999") : String(t[key] || "").toLowerCase();
    ts.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    return ts;
  }
  function taskTable(ts, sortable) {
    if (!ts.length) return `<div class="empty">${Object.keys(S.tasks).length ? "No tasks match these filters." : "No tasks yet."}</div>`;
    const th = (k, l) => sortable ? `<th data-sort="${k}" aria-sort="${S.f.sort === k ? (S.f.dir === "asc" ? "ascending" : "descending") : "none"}">${l}${S.f.sort === k ? (S.f.dir === "asc" ? " ▲" : " ▼") : ""}</th>` : `<th>${l}</th>`;
    return `<div class="tbl-wrap"><table><thead><tr>${th("title", "Task")}${th("project", "Project")}${th("assignee", "Assignee")}${th("status", "Status")}${th("priority", "Priority")}${th("dueDate", "Due")}</tr></thead><tbody>
      ${ts.map(t => `<tr><td class="wrap-text"><button class="btn ghost sm" style="padding:0;text-align:left;white-space:normal" data-act="openTask" data-id="${esc(t.id)}">${esc(t.title)}</button></td>
        <td>${esc((S.projects[t.projectId] || {}).name || "—")}</td><td>${esc(empName(t.assigneeId))}</td><td>${statusPill(t.status)}</td><td>${prioHtml(t.priority)}</td>
        <td class="num ${isOverdue(t) ? "overdue" : ""}">${t.dueDate ? esc(nice(t.dueDate)) : "—"}</td></tr>`).join("")}
    </tbody></table></div>`;
  }
  RW.ui.taskTable = taskTable;
  function vTasks() {
    const f = S.f, ts = filteredTasks();
    const actions = `<button class="btn" data-act="exportTasks">Export CSV</button>${canCreateTask() ? `<button class="btn primary" data-act="newTask">New task</button>` : ""}`;
    const html = `<div class="filters">
        <input type="search" id="fSearch" placeholder="Search tasks" aria-label="Search tasks" value="${esc(f.search)}" data-input="filter" data-key="search">
        <select id="fStatus" aria-label="Status" data-change="filter" data-key="status">${opts(TASK_STATUSES, f.status, "Any status")}</select>
        <select id="fPrio" aria-label="Priority" data-change="filter" data-key="priority">${opts(PRIORITIES, f.priority, "Any priority")}</select>
        <select id="fAssn" aria-label="Assignee" data-change="filter" data-key="assignee">${empOpts(f.assignee, "Anyone")}</select>
        <select id="fProj" aria-label="Project" data-change="filter" data-key="project">${projOpts(f.project, "All projects")}</select>
        <label class="check"><input type="checkbox" id="fOver" data-change="filterCheck" data-key="overdue"${f.overdue ? " checked" : ""}> Overdue only</label>
      </div>
      <div class="small muted num">${ts.length} of ${Object.keys(S.tasks).length} tasks</div>
      ${taskTable(ts, true)}`;
    return { html, actions };
  }
  function showTask(t) {
    openModal({ title: t.title, noSubmit: true, cancelLabel: "Close", wide: true,
      body: `<div class="fgrid"><div><div class="small muted">Project</div>${esc((S.projects[t.projectId] || {}).name || "—")}</div><div><div class="small muted">Assignee</div>${esc(empName(t.assigneeId))}</div>
        <div><div class="small muted">Status</div>${statusPill(t.status)}</div><div><div class="small muted">Priority</div>${prioHtml(t.priority)}</div><div><div class="small muted">Due</div>${t.dueDate ? esc(nice(t.dueDate)) : "—"}</div></div>
        ${t.description ? `<p style="white-space:pre-wrap;margin:0">${esc(t.description)}</p>` : ""}<p class="hint" style="margin:0">Only the assignee or an admin can edit this task.</p>` });
  }

  Object.assign(RW.actions, {
    newProject: el => projectForm(null, el.dataset.client ? { clientId: el.dataset.client } : null),
    editProject: el => projectForm(S.projects[el.dataset.id]),
    deleteProject: async el => {
      const p = S.projects[el.dataset.id]; if (!p) return;
      const ts = Object.values(S.tasks).filter(t => t.projectId === p.id);
      if (!(await confirmDialog(`Delete "${p.name}"${ts.length ? ` and its ${ts.length} tasks` : ""}? This can't be undone.`))) return;
      for (const t of ts) { const ok = await write(() => col("tasks").doc(t.id).delete()); if (!ok) return; }
      if (await write(() => col("projects").doc(p.id).delete(), "Project deleted.")) RW.go("projects");
    },
    openProject: el => RW.go("projects", el.dataset.id),
    newTask: el => taskForm(null, el.dataset.project ? { projectId: el.dataset.project } : null),
    openTask: el => { const t = S.tasks[el.dataset.id]; if (!t) return; if (canEditTask(t)) taskForm(t); else showTask(t); },
    exportTasks: () => { const ts = filteredTasks(); copyText(csv([["Task", "Project", "Client", "Assignee", "Status", "Priority", "Due date", "Details"], ...ts.map(t => { const p = S.projects[t.projectId] || {}; return [t.title, p.name || "", projClient(p), empName(t.assigneeId), t.status, t.priority, t.dueDate || "", t.description || ""]; })]), "Tasks"); },
    showOverdue: () => { S.f.overdue = true; saveFilters(); }
  });
  RW.changes.taskStatus = el => setTaskStatus(el.dataset.id, el.value);

  RW.register({ id: "projects", title: "Projects", icon: I.projects, group: "Work", order: 10, render: vProjects,
    alerts: ctx => {
      const out = [];
      const late = Object.values(S.projects).filter(p => p.status !== "Completed" && validDate(p.dueDate) && p.dueDate < ctx.today);
      late.forEach(p => out.push({ level: "warn", text: `Project "${p.name}" is past its due date`, date: p.dueDate, href: "#projects-" + p.id }));
      return out;
    } });
  RW.register({ id: "board", title: "Board", icon: I.board, group: "Work", order: 20, render: vBoard });
  RW.register({ id: "tasks", title: "Tasks", icon: I.tasks, group: "Work", order: 30, render: vTasks,
    badge: ctx => { const m = ctx.me; return m ? Object.values(S.tasks).filter(t => t.assigneeId === m.id && isOverdue(t)).length : 0; } });
})();
