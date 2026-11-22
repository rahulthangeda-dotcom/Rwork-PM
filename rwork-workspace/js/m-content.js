"use strict";
/* Content calendar & post tracker.
   Collection: posts (everyone reads; Contributors write — UI gates editing to linked employees/admins).
   Views: #content (calendar) · #content-tracker · #content-board · #content-plan
   Extends: client tab "Content", health signals, alerts, dashboard widget, nav badge. */
(function () {
  const U = RW.ui, D = RW.date, esc = U.esc;
  const PLATFORMS = ["Instagram", "Facebook", "LinkedIn", "X", "YouTube", "Pinterest", "Blog", "Email", "Google Business"];
  const FORMATS = ["Static", "Carousel", "Reel", "Story", "Video", "Article", "Newsletter"];
  const STATUSES = ["Idea", "Drafting", "Design", "Internal review", "Sent to client", "Client approved", "Changes requested", "Scheduled", "Published"];
  const METRICS = ["reach", "likes", "comments", "shares", "saves", "clicks"];
  const DONE = new Set(["Scheduled", "Published"]);
  const PCOLOR = { Instagram: "#c13584", Facebook: "#1877f2", LinkedIn: "#0a66c2", X: "#6b7280", YouTube: "#e62117", Pinterest: "#bd081c", Blog: "#0d8a6a", Email: "#b7791f", "Google Business": "#34a853" };
  const SKIND = { Idea: "", Drafting: "", Design: "accent", "Internal review": "warn", "Sent to client": "warn", "Client approved": "good", "Changes requested": "bad", Scheduled: "accent", Published: "good" };
  RW.const.POST_PLATFORMS = PLATFORMS; RW.const.POST_FORMATS = FORMATS; RW.const.POST_STATUSES = STATUSES;

  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h3M8 17h6"/></svg>';

  /* ---------- per-viewer UI state ---------- */
  const st = { month: null, mode: RW.prefs.get("content.mode", "month"), week: null, sort: "publishDate", dir: "asc", planMonth: null };
  const F = () => RW.S.f;

  /* ---------- helpers ---------- */
  const posts = () => (RW.state.posts || []);
  const post = id => (RW.map.posts || {})[id];
  const statusOf = p => STATUSES.includes(p.status) ? p.status : "Idea";
  const pill = s => U.pill(s, SKIND[s] || "");
  const pcol = p => PCOLOR[p] || "#6b7280";
  const canCreate = ctx => ctx.canWrite && (ctx.isAdmin || !!ctx.me);
  const canEdit = ctx => canCreate(ctx);
  const canDelete = (ctx, p) => ctx.canWrite && (ctx.isAdmin || (ctx.me && (p.createdBy === ctx.me.id || p.ownerId === ctx.me.id)));
  const isOverduePost = (p, today) => D.valid(p.publishDate) && p.publishDate < today && statusOf(p) !== "Published";
  const mondayOf = s => { const w = (D.parse(s).getUTCDay() + 6) % 7; return D.addDays(s, -w); };
  const sortByDate = (a, b) => String(a.publishDate || "9999").localeCompare(String(b.publishDate || "9999")) || String(a.publishTime || "").localeCompare(String(b.publishTime || "")) || String(a.title || "").localeCompare(String(b.title || ""));
  function sentAge(p, today) {
    const ts = p.sentAt || p.updatedAt; if (!ts) return 0;
    const d = String(ts).slice(0, 10); return D.valid(d) ? D.daysBetween(d, today) : 0;
  }
  function filtered(ctx, opt = {}) {
    const f = F();
    return posts().filter(p => {
      if (f.contentClient && p.clientId !== f.contentClient) return false;
      if (f.contentPlatform && p.platform !== f.contentPlatform) return false;
      if (!opt.ignoreStatus && f.contentStatus) {
        if (f.contentStatus === "__open" ? statusOf(p) === "Published" : statusOf(p) !== f.contentStatus) return false;
      }
      if (f.contentOwner === "__me") { const m = ctx.me; if (!m || ![p.ownerId, p.copywriterId, p.designerId].includes(m.id)) return false; }
      else if (f.contentOwner && ![p.ownerId, p.copywriterId, p.designerId].includes(f.contentOwner)) return false;
      const q = String(f.contentSearch || "").trim().toLowerCase();
      if (q && !`${p.title || ""} ${p.caption || ""} ${p.hashtags || ""} ${ctx.clientName(p.clientId)}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }
  function statusPatch(p, status) {
    const now = new Date().toISOString();
    const patch = { status, updatedAt: now };
    if (status === "Sent to client" && statusOf(p) !== "Sent to client") patch.sentAt = now;
    if (status === "Published" && !p.publishedAt) patch.publishedAt = now;
    return patch;
  }
  async function setStatus(p, status) {
    if (!STATUSES.includes(status) || statusOf(p) === status) return true;
    return RW.write.update("posts/" + p.id, statusPatch(p, status), `Moved to ${status}.`);
  }

  /* ---------- styles ---------- */
  RW.addStyle(`
  .content-chip{display:block;font-size:.72rem;padding:2px 6px 2px 5px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-left:3px solid var(--pc,var(--muted));cursor:pointer;text-align:left;width:100%;font-family:inherit;line-height:1.35}
  .content-chip.pub{opacity:.6;text-decoration:line-through}
  .content-chip.late{border-color:var(--bad);border-left-color:var(--bad)}
  .content-chip:hover{background:var(--surface)}
  .content-day{cursor:default}
  .content-day .content-add{font-size:.7rem;margin-left:auto;padding:0 6px;line-height:1.4;opacity:0;border:1px dashed var(--line);border-radius:4px;background:none;color:var(--muted);cursor:pointer}
  .content-day:hover .content-add,.content-add:focus{opacity:1}
  .content-dayhead{display:flex;align-items:center;gap:4px}
  .content-more{font-size:.7rem;background:none;border:0;color:var(--accent);cursor:pointer;padding:0;text-align:left}
  .content-dot{display:inline-block;width:9px;height:9px;border-radius:99px;background:var(--pc,var(--muted));margin-right:6px;flex:none}
  .content-legend{display:flex;flex-wrap:wrap;gap:10px;font-size:.75rem;color:var(--muted)}
  .content-legend span{display:inline-flex;align-items:center}
  .content-week{display:grid;grid-template-columns:repeat(7,minmax(150px,1fr));gap:10px;overflow-x:auto;padding-bottom:6px}
  .content-wcol{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md,10px);padding:8px;display:flex;flex-direction:column;gap:6px;min-height:160px}
  .content-wcol.today{border-color:var(--accent)}
  .content-wcol h3{font-size:.82rem;margin:0;display:flex;justify-content:space-between;gap:6px}
  .content-wcard{border:1px solid var(--line);border-left:3px solid var(--pc,var(--muted));border-radius:6px;padding:6px 8px;background:var(--bg);cursor:pointer;display:flex;flex-direction:column;gap:3px;font-size:.8rem;text-align:left;font-family:inherit;color:inherit;width:100%}
  .content-wcard strong{overflow-wrap:anywhere}
  .content-sheet td,.content-sheet th{padding:5px 8px;font-size:.82rem;white-space:nowrap}
  .content-sheet td.wrap{white-space:normal;min-width:180px;max-width:320px}
  .content-sheet select,.content-sheet input[type=date]{font-size:.8rem;padding:3px 4px;max-width:160px}
  .content-link{background:none;border:0;padding:0;font:inherit;color:var(--accent);cursor:pointer;text-align:left;font-weight:600}
  .content-sort{background:none;border:0;font:inherit;font-weight:600;color:inherit;cursor:pointer;padding:0}
  .content-board{display:grid;grid-template-columns:repeat(${STATUSES.length},minmax(220px,1fr));gap:12px;overflow-x:auto;padding-bottom:6px}
  .content-col{background:var(--bg);border:1px solid var(--line);border-radius:var(--r-md,10px);padding:8px;display:flex;flex-direction:column;gap:8px;min-height:140px}
  .content-col.over{outline:2px dashed var(--accent)}
  .content-col-head{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:.82rem}
  .content-card{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--pc,var(--muted));border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:5px;font-size:.82rem}
  .content-card .t{font-weight:600;overflow-wrap:anywhere;background:none;border:0;padding:0;text-align:left;color:inherit;font:inherit;cursor:pointer}
  .content-card select{font-size:.78rem;padding:3px}
  .content-plan td.num,.content-plan th.num{text-align:center}
  .content-bulk{display:flex;flex-direction:column;gap:6px}
  .content-brow{display:grid;grid-template-columns:130px 140px 120px 1fr auto;gap:6px;align-items:center}
  .content-brow input,.content-brow select{min-width:0}
  .content-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
  @media (max-width:640px){.content-brow{grid-template-columns:1fr 1fr}.content-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
  `, "content");

  /* ---------- filters bar ---------- */
  function filtersHTML(ctx, opt = {}) {
    const f = F();
    const statusSel = opt.noStatus ? "" : `<select id="ctStatus" aria-label="Status" data-change="filter" data-key="contentStatus"><option value="">All statuses</option><option value="__open"${f.contentStatus === "__open" ? " selected" : ""}>Not published</option>${U.opts(STATUSES, f.contentStatus)}</select>`;
    const ownerSel = `<select id="ctOwner" aria-label="Person" data-change="filter" data-key="contentOwner"><option value="">Everyone</option>${ctx.me ? `<option value="__me"${f.contentOwner === "__me" ? " selected" : ""}>Only me</option>` : ""}${ctx.employees.map(e => `<option value="${esc(e.id)}"${f.contentOwner === e.id ? " selected" : ""}>${esc(e.name)}</option>`).join("")}</select>`;
    return `<div class="filters">
      <input id="ctSearch" type="search" placeholder="Search posts" aria-label="Search posts" data-input="filter" data-key="contentSearch" value="${esc(f.contentSearch || "")}">
      <select id="ctClient" aria-label="Client" data-change="filter" data-key="contentClient">${U.clientOpts(f.contentClient, "All clients")}</select>
      <select id="ctPlatform" aria-label="Platform" data-change="filter" data-key="contentPlatform">${U.opts(PLATFORMS, f.contentPlatform, "All platforms")}</select>
      ${statusSel}${ownerSel}
    </div>`;
  }
  function tabs(cur) {
    return U.tabsHTML([["calendar", "Calendar"], ["tracker", "Tracker sheet"], ["board", "Approvals board"], ["plan", "Monthly plan"]], cur, "content.tab");
  }
  function topActions(ctx) {
    if (!canCreate(ctx)) return "";
    return `<button class="btn" data-act="content.bulk">Bulk plan month</button><button class="btn primary" data-act="content.new">New post</button>`;
  }
  function notes(ctx) {
    let h = "";
    if (!ctx.isAdmin && !ctx.me && ctx.canWrite) h += `<div class="calc warn">Your account isn't linked to an employee profile yet, so you can view content but not edit it. Ask HR to link your account.</div>`;
    else if (ctx.readOnly) h += `<div class="calc">You have view-only access.</div>`;
    return h;
  }
  function emptyState(ctx) {
    if (posts().length) return "";
    const hint = !ctx.clients.length && ctx.isAdmin ? ` Add clients first under <a href="#clients">Clients</a>, then plan their content here.` : canCreate(ctx) ? " Use <strong>New post</strong> or <strong>Bulk plan month</strong> to plan a client's content." : "";
    return `<div class="empty">No posts yet.${hint}</div>`;
  }

  /* ---------- calendar ---------- */
  function chip(p, today) {
    const s = statusOf(p), late = isOverduePost(p, today);
    return `<button type="button" class="content-chip${s === "Published" ? " pub" : ""}${late ? " late" : ""}" style="--pc:${pcol(p.platform)}" data-act="content.open" data-id="${esc(p.id)}" title="${esc(`${RW.ctx.clientName(p.clientId) || "No client"} · ${p.platform || ""} · ${s}${late ? " (overdue)" : ""}`)}">${p.publishTime ? esc(p.publishTime) + " " : ""}${esc(p.title || "(untitled)")}</button>`;
  }
  function legend() { return `<div class="content-legend">${PLATFORMS.map(p => `<span><i class="content-dot" style="--pc:${pcol(p)}"></i>${esc(p)}</span>`).join("")}</div>`; }
  function vCalendar(ctx) {
    const today = ctx.today;
    if (!st.month) st.month = today.slice(0, 7);
    if (!st.week) st.week = mondayOf(today);
    const list = filtered(ctx).filter(p => D.valid(p.publishDate)).sort(sortByDate);
    const byDay = {}; list.forEach(p => { (byDay[p.publishDate] = byDay[p.publishDate] || []).push(p); });
    const add = canCreate(ctx);
    const modeTabs = `<div class="tabs" role="tablist"><button role="tab" aria-selected="${st.mode === "month"}" class="${st.mode === "month" ? "on" : ""}" data-act="content.mode" data-mode="month">Month</button><button role="tab" aria-selected="${st.mode === "week"}" class="${st.mode === "week" ? "on" : ""}" data-act="content.mode" data-mode="week">Week</button></div>`;
    let body, label;
    if (st.mode === "week") {
      label = `Week of ${D.fmt(st.week)}`;
      body = `<div class="content-week">${[0, 1, 2, 3, 4, 5, 6].map(i => {
        const d = D.addDays(st.week, i), ps = byDay[d] || [];
        return `<div class="content-wcol${d === today ? " today" : ""}"><h3><span>${esc(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i])} ${esc(D.fmtShort(d))}</span>${add ? `<button type="button" class="btn ghost sm" data-act="content.addOn" data-date="${d}" aria-label="Add post on ${esc(D.fmt(d))}">+</button>` : ""}</h3>
          ${ps.map(p => `<button type="button" class="content-wcard" style="--pc:${pcol(p.platform)}" data-act="content.open" data-id="${esc(p.id)}"><strong>${esc(p.title || "(untitled)")}</strong><span class="small muted">${esc(ctx.clientName(p.clientId) || "No client")} · ${esc(p.platform || "")}${p.format ? " · " + esc(p.format) : ""}${p.publishTime ? " · " + esc(p.publishTime) : ""}</span><span>${pill(statusOf(p))}${isOverduePost(p, today) ? " " + U.pill("Overdue", "bad") : ""}</span></button>`).join("") || `<span class="hint">Nothing planned</span>`}</div>`;
      }).join("")}</div>`;
    } else {
      label = D.monthLabel(st.month);
      const [y, mo] = st.month.split("-").map(Number);
      const first = `${st.month}-01`;
      const startDow = (D.parse(first).getUTCDay() + 6) % 7;
      const gridStart = D.addDays(first, -startDow);
      const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const cells = Math.ceil((startDow + lastDay) / 7) * 7;
      let g = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => `<div class="dow">${d}</div>`).join("");
      for (let i = 0; i < cells; i++) {
        const d = D.addDays(gridStart, i), ps = byDay[d] || [];
        const cls = ["day", "content-day", d.slice(0, 7) !== st.month ? "out" : "", D.isWeekend(d) ? "we" : "", d === today ? "today" : ""].join(" ");
        g += `<div class="${cls}" data-date="${d}"><div class="content-dayhead"><span class="d">${Number(d.slice(8))}</span>${add ? `<button type="button" class="content-add" data-act="content.addOn" data-date="${d}" aria-label="Add post on ${esc(D.fmt(d))}">+</button>` : ""}</div>${ps.slice(0, 4).map(p => chip(p, today)).join("")}${ps.length > 4 ? `<button type="button" class="content-more" data-act="content.weekOf" data-date="${d}">+${ps.length - 4} more</button>` : ""}</div>`;
      }
      body = `<div class="cal">${g}</div>`;
    }
    return `${filtersHTML(ctx)}
      <div class="cal-head">${modeTabs}<button class="btn sm" data-act="content.prev" aria-label="Previous">‹ Prev</button><h2 style="min-width:170px;text-align:center;margin:0">${esc(label)}</h2><button class="btn sm" data-act="content.next" aria-label="Next">Next ›</button><button class="btn sm ghost" data-act="content.today">Today</button></div>
      ${body}${legend()}`;
  }

  /* ---------- tracker sheet ---------- */
  const COLS = [
    ["publishDate", "Date"], ["client", "Client"], ["title", "Post"], ["platform", "Platform"], ["format", "Format"],
    ["status", "Status"], ["ownerId", "Owner"], ["copywriterId", "Copy"], ["designerId", "Design"], ["links", "Links"]
  ];
  function sortVal(p, k, ctx) {
    if (k === "client") return ctx.clientName(p.clientId).toLowerCase();
    if (k === "status") return STATUSES.indexOf(statusOf(p));
    if (["ownerId", "copywriterId", "designerId"].includes(k)) return p[k] ? ctx.empName(p[k]).toLowerCase() : "~";
    if (k === "publishDate") return (p.publishDate || "9999") + (p.publishTime || "");
    return String(p[k] || "~").toLowerCase();
  }
  function trackerRows(ctx) {
    const rows = filtered(ctx);
    const k = st.sort, dir = st.dir === "desc" ? -1 : 1;
    return rows.sort((a, b) => { const x = sortVal(a, k, ctx), y = sortVal(b, k, ctx); return (x < y ? -1 : x > y ? 1 : 0) * dir || sortByDate(a, b); });
  }
  function personCell(p, field, ed) {
    if (!ed) return esc(p[field] ? RW.ctx.empName(p[field]) : "—");
    return `<select aria-label="${esc(field)}" data-change="content.cell" data-id="${esc(p.id)}" data-field="${field}">${U.empOpts(p[field], "—")}</select>`;
  }
  function vTracker(ctx) {
    const rows = trackerRows(ctx), ed = canEdit(ctx), today = ctx.today;
    const th = COLS.map(([k, l]) => k === "links" ? `<th>${l}</th>` : `<th><button type="button" class="content-sort" data-act="content.sort" data-key="${k}">${esc(l)}${st.sort === k ? (st.dir === "asc" ? " ▲" : " ▼") : ""}</button></th>`).join("");
    const body = rows.map(p => {
      const s = statusOf(p), late = isOverduePost(p, today);
      const asset = U.safeUrl(p.assetLink), pub = U.safeUrl(p.publishedUrl);
      return `<tr class="${late ? "overdue" : ""}">
        <td>${ed ? `<input type="date" aria-label="Publish date" data-change="content.cell" data-id="${esc(p.id)}" data-field="publishDate" value="${esc(p.publishDate || "")}">` : esc(D.fmt(p.publishDate))}${late ? ` <span class="pill bad">Overdue</span>` : ""}</td>
        <td>${esc(ctx.clientName(p.clientId) || "—")}</td>
        <td class="wrap"><button type="button" class="content-link" data-act="content.open" data-id="${esc(p.id)}">${esc(p.title || "(untitled)")}</button></td>
        <td><span class="content-dot" style="--pc:${pcol(p.platform)}"></span>${esc(p.platform || "—")}</td>
        <td>${esc(p.format || "—")}</td>
        <td>${ed ? `<select aria-label="Status" data-change="content.cell" data-id="${esc(p.id)}" data-field="status">${U.opts(STATUSES, s)}</select>` : pill(s)}</td>
        <td>${personCell(p, "ownerId", ed)}</td><td>${personCell(p, "copywriterId", ed)}</td><td>${personCell(p, "designerId", ed)}</td>
        <td>${asset ? `<a href="${esc(asset)}" target="_blank" rel="noopener noreferrer">Asset</a>` : ""}${asset && pub ? " · " : ""}${pub ? `<a href="${esc(pub)}" target="_blank" rel="noopener noreferrer">Live</a>` : ""}${!asset && !pub ? "—" : ""}</td>
      </tr>`;
    }).join("");
    const table = rows.length ? `<div class="tbl-wrap"><table class="content-sheet"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>` : `<div class="empty">${posts().length ? "No posts match these filters." : "No posts yet."}</div>`;
    return `${filtersHTML(ctx)}<div class="filters" style="justify-content:space-between"><span class="muted small">${rows.length} post${rows.length === 1 ? "" : "s"}</span><button class="btn sm" data-act="content.csv">Copy as CSV</button></div>${table}`;
  }

  /* ---------- approvals board ---------- */
  function vBoard(ctx) {
    const list = filtered(ctx, { ignoreStatus: true }), ed = canEdit(ctx), today = ctx.today;
    const cols = STATUSES.map(s => {
      const cs = list.filter(p => statusOf(p) === s).sort(sortByDate);
      const shown = s === "Published" ? cs.slice(-30).reverse() : cs;
      return `<div class="content-col" data-col="${esc(s)}"><div class="content-col-head"><span>${esc(s)}</span><span class="pill num">${cs.length}</span></div>
        ${shown.map(p => `<div class="content-card" style="--pc:${pcol(p.platform)}" data-id="${esc(p.id)}"${ed ? ' draggable="true"' : ""}>
          <button type="button" class="t" data-act="content.open" data-id="${esc(p.id)}">${esc(p.title || "(untitled)")}</button>
          <span class="small muted">${esc(ctx.clientName(p.clientId) || "No client")} · ${esc(p.platform || "")} · ${esc(D.fmtShort(p.publishDate))}</span>
          ${isOverduePost(p, today) ? U.pill("Overdue", "bad") : s === "Sent to client" && sentAge(p, today) > 3 ? U.pill(`Waiting ${sentAge(p, today)} days`, "warn") : ""}
          ${p.ownerId ? `<span class="small">${U.av(ctx.employeeById[p.ownerId])} ${esc(ctx.empName(p.ownerId))}</span>` : ""}
          ${ed ? `<select aria-label="Move to status" data-change="content.cell" data-id="${esc(p.id)}" data-field="status">${U.opts(STATUSES, s)}</select>` : ""}
        </div>`).join("") || `<div class="hint" style="padding:6px">None</div>`}
        ${s === "Published" && cs.length > 30 ? `<span class="hint">Showing the latest 30.</span>` : ""}</div>`;
    }).join("");
    return `${filtersHTML(ctx, { noStatus: true })}${ed ? `<p class="hint" style="margin:0">Drag a card to another column, or use its status menu.</p>` : ""}<div class="content-board" id="contentBoard">${cols}</div>`;
  }
  function wireBoard(root) {
    const board = root.querySelector("#contentBoard"); if (!board) return;
    board.querySelectorAll('.content-card[draggable="true"]').forEach(c => c.addEventListener("dragstart", e => { try { e.dataTransfer.setData("text/plain", c.dataset.id); e.dataTransfer.effectAllowed = "move"; } catch (x) {} }));
    board.querySelectorAll(".content-col").forEach(colEl => {
      colEl.addEventListener("dragover", e => { e.preventDefault(); colEl.classList.add("over"); });
      colEl.addEventListener("dragleave", () => colEl.classList.remove("over"));
      colEl.addEventListener("drop", async e => {
        e.preventDefault(); colEl.classList.remove("over");
        let id = ""; try { id = e.dataTransfer.getData("text/plain"); } catch (x) {}
        const p = post(id); if (!p) return;
        const ok = await setStatus(p, colEl.dataset.col);
        if (!ok) RW.render();
      });
    });
  }

  /* ---------- monthly plan summary ---------- */
  function vPlan(ctx) {
    if (!st.planMonth) st.planMonth = ctx.today.slice(0, 7);
    const f = F(), m = st.planMonth;
    const inMonth = posts().filter(p => String(p.publishDate || "").slice(0, 7) === m && (!f.contentClient || p.clientId === f.contentClient));
    const clientIds = [...new Set(inMonth.map(p => p.clientId || ""))].sort((a, b) => (ctx.clientName(a) || "~").localeCompare(ctx.clientName(b) || "~"));
    const plats = PLATFORMS.filter(pl => inMonth.some(p => p.platform === pl));
    const cell = list => { const pub = list.filter(p => statusOf(p) === "Published").length; return list.length ? `<span class="num">${pub}/${list.length}</span>` : `<span class="muted">—</span>`; };
    const rows = clientIds.map(cid => {
      const cl = inMonth.filter(p => (p.clientId || "") === cid);
      const ready = cl.filter(p => DONE.has(statusOf(p))).length, waiting = cl.filter(p => statusOf(p) === "Sent to client").length;
      return `<tr><td>${esc(ctx.clientName(cid) || "No client")}</td>${plats.map(pl => `<td class="num">${cell(cl.filter(p => p.platform === pl))}</td>`).join("")}<td class="num">${cell(cl)}</td><td class="num">${ready}</td><td class="num">${waiting || "—"}</td><td><div class="bar"><i style="width:${cl.length ? Math.round(cl.filter(p => statusOf(p) === "Published").length / cl.length * 100) : 0}%"></i></div></td></tr>`;
    }).join("");
    const tot = inMonth.length, pubN = inMonth.filter(p => statusOf(p) === "Published").length;
    const late = inMonth.filter(p => isOverduePost(p, ctx.today)).length;
    const table = clientIds.length ? `<div class="tbl-wrap"><table class="content-plan"><thead><tr><th>Client</th>${plats.map(pl => `<th class="num"><span class="content-dot" style="--pc:${pcol(pl)}"></span>${esc(pl)}</th>`).join("")}<th class="num">Total</th><th class="num">Scheduled or live</th><th class="num">With client</th><th style="min-width:110px">Published</th></tr></thead><tbody>${rows}</tbody></table></div><p class="hint" style="margin:0">Cells show published / planned.</p>` : `<div class="empty">No posts planned for ${esc(D.monthLabel(m))}.${canCreate(ctx) ? " Use Bulk plan month to add them." : ""}</div>`;
    const cleanup = ctx.adminWrite ? `<div class="panel"><div class="panel-head"><h2>Tidy up</h2></div><p class="hint" style="margin:0 0 8px">The workspace database has a size limit. Remove published posts older than 12 months once you've exported them.</p><button class="btn sm" data-act="content.cleanup">Delete published posts older than 12 months</button></div>` : "";
    return `<div class="filters">
        <button class="btn sm" data-act="content.planPrev" aria-label="Previous month">‹</button><strong style="min-width:150px;text-align:center">${esc(D.monthLabel(m))}</strong><button class="btn sm" data-act="content.planNext" aria-label="Next month">›</button>
        <select id="ctPlanClient" aria-label="Client" data-change="filter" data-key="contentClient">${U.clientOpts(f.contentClient, "All clients")}</select>
      </div>
      <div class="tiles"><div class="tile"><div class="v">${tot}</div><div class="l">Planned</div></div><div class="tile"><div class="v">${pubN}</div><div class="l">Published</div></div><div class="tile"><div class="v">${inMonth.filter(p => statusOf(p) === "Sent to client").length}</div><div class="l">Awaiting client</div></div><div class="tile${late ? " alert" : ""}"><div class="v">${late}</div><div class="l">Overdue</div></div></div>
      ${table}${cleanup}`;
  }

  /* ---------- main render ---------- */
  function render(el, ctx, route) {
    const sub = ["tracker", "board", "plan"].includes(route.sub) ? route.sub : "calendar";
    let body;
    if (sub === "tracker") body = vTracker(ctx);
    else if (sub === "board") body = vBoard(ctx);
    else if (sub === "plan") body = vPlan(ctx);
    else body = vCalendar(ctx);
    el.innerHTML = tabs(sub) + notes(ctx) + (sub !== "plan" ? emptyState(ctx) : "") + body;
    return { actions: topActions(ctx), after: sub === "board" ? wireBoard : undefined };
  }

  /* ---------- forms ---------- */
  function postForm(p, defaults) {
    const ctx = RW.ctx;
    if (!p && !canCreate(ctx)) { U.toast("Ask HR to link your account before adding posts.", "bad"); return; }
    const x = p || Object.assign({ status: "Idea", platform: "Instagram", format: "Static", ownerId: ctx.me ? ctx.me.id : "" }, defaults || {});
    const ed = canEdit(ctx);
    const mt = x.metrics || {};
    const asset = U.safeUrl(x.assetLink), live = U.safeUrl(x.publishedUrl);
    const body = `<div class="fgrid">
        ${U.field({ label: "Client", name: "clientId", type: "select", optionsHtml: U.clientOpts(x.clientId, "Choose a client") })}
        ${U.field({ label: "Post title / topic", name: "title", value: x.title, required: true, placeholder: "e.g. Diwali offer carousel" })}
        ${U.field({ label: "Platform", name: "platform", options: PLATFORMS, value: x.platform })}
        ${U.field({ label: "Format", name: "format", options: FORMATS, value: x.format })}
        ${U.field({ label: "Publish date", name: "publishDate", type: "date", value: x.publishDate })}
        ${U.field({ label: "Publish time", name: "publishTime", type: "time", value: x.publishTime })}
        ${U.field({ label: "Status", name: "status", options: STATUSES, value: statusOf(x) })}
        ${U.field({ label: "Owner", name: "ownerId", type: "select", optionsHtml: U.empOpts(x.ownerId, "Not assigned") })}
        ${U.field({ label: "Copywriter", name: "copywriterId", type: "select", optionsHtml: U.empOpts(x.copywriterId, "Not assigned") })}
        ${U.field({ label: "Designer", name: "designerId", type: "select", optionsHtml: U.empOpts(x.designerId, "Not assigned") })}
      </div>
      ${U.field({ label: "Caption", name: "caption", type: "textarea", value: x.caption })}
      <div class="fgrid">
        ${U.field({ label: "Hashtags", name: "hashtags", value: x.hashtags, placeholder: "#brand #offer" })}
        ${U.field({ label: "Asset link (Drive / Canva)", name: "assetLink", type: "url", value: x.assetLink, placeholder: "https://…" })}
      </div>
      ${asset || live ? `<p class="small" style="margin:0">${asset ? `<a href="${esc(asset)}" target="_blank" rel="noopener noreferrer">Open asset</a>` : ""}${asset && live ? " · " : ""}${live ? `<a href="${esc(live)}" target="_blank" rel="noopener noreferrer">Open live post</a>` : ""}</p>` : ""}
      ${U.field({ label: "Client feedback", name: "clientFeedback", type: "textarea", value: x.clientFeedback, placeholder: "Changes the client asked for" })}
      <div id="ctPubBox"${statusOf(x) === "Published" ? "" : " hidden"}>
        ${U.field({ label: "Published post link", name: "publishedUrl", type: "url", value: x.publishedUrl, placeholder: "https://…" })}
        <span class="flabel">Results</span>
        <div class="content-metrics">${METRICS.map(k => U.field({ label: k[0].toUpperCase() + k.slice(1), name: "m_" + k, type: "number", min: 0, step: 1, value: mt[k] ?? "" })).join("")}</div>
      </div>
      ${p ? `<p class="hint" style="margin:0">Last updated ${esc(D.fmt(String(p.updatedAt || p.createdAt || "").slice(0, 10)))}${p.sentAt ? ` · sent to client ${esc(D.fmt(String(p.sentAt).slice(0, 10)))}` : ""}</p>` : ""}
      ${p && canDelete(ctx, p) ? `<button type="button" class="btn ghost sm danger" id="ctDelete" style="align-self:flex-start">Delete post</button>` : ""}`;
    U.modal({
      title: p ? (ed ? "Edit post" : "Post details") : "New post", wide: true, body,
      submitLabel: p ? "Save changes" : "Add post", noSubmit: !ed, cancelLabel: ed ? "Cancel" : "Close",
      onMount(form) {
        if (!ed) form.querySelectorAll("input,select,textarea").forEach(i => { i.disabled = true; });
        const s = form.elements.status, box = form.querySelector("#ctPubBox");
        if (s && box) s.addEventListener("change", () => { box.hidden = s.value !== "Published"; });
        const del = form.querySelector("#ctDelete");
        if (del) del.addEventListener("click", async () => {
          if (await U.confirm(`Delete the post "${p.title || "untitled"}"?`, "Delete post")) await RW.write.del("posts/" + p.id, "Post deleted.");
        });
      },
      onSubmit: async form => {
        const v = n => U.fv(form, n);
        const title = v("title"); if (!title) { U.toast("Enter a title for the post.", "bad"); return false; }
        const clientId = v("clientId"); if (!clientId) { U.toast("Choose a client.", "bad"); return false; }
        const date = v("publishDate"); if (date && !D.valid(date)) { U.toast("Enter a valid publish date.", "bad"); return false; }
        for (const n of ["assetLink", "publishedUrl"]) { const u = v(n); if (u && !U.safeUrl(u)) { U.toast("Links must start with https://", "bad"); return false; } }
        const status = STATUSES.includes(v("status")) ? v("status") : "Idea";
        const metrics = {}; let anyM = false;
        METRICS.forEach(k => { const raw = v("m_" + k); if (raw !== "") { const n = Number(raw); if (Number.isFinite(n) && n >= 0) { metrics[k] = n; anyM = true; } } });
        const now = new Date().toISOString();
        const data = {
          clientId, title, platform: PLATFORMS.includes(v("platform")) ? v("platform") : "Instagram", format: FORMATS.includes(v("format")) ? v("format") : "Static",
          publishDate: date, publishTime: v("publishTime"), status, ownerId: v("ownerId"), copywriterId: v("copywriterId"), designerId: v("designerId"),
          caption: v("caption"), hashtags: v("hashtags"), assetLink: v("assetLink"), clientFeedback: v("clientFeedback"), publishedUrl: v("publishedUrl"),
          metrics: anyM ? metrics : (p && p.metrics) || {}, updatedAt: now
        };
        if (p) {
          const base = Object.assign({}, p); delete base.id;
          Object.assign(base, data, statusPatch(p, status));
          return RW.write.set("posts/" + p.id, base, "Post saved.");
        }
        Object.assign(data, { createdAt: now, createdBy: ctx.me ? ctx.me.id : "", createdByUser: ctx.viewerId || "" });
        if (status === "Sent to client") data.sentAt = now;
        if (status === "Published") data.publishedAt = now;
        return !!(await RW.write.add("posts", data, "Post added."));
      }
    });
  }

  function bulkRow(month, i) {
    const d = month + "-" + String(Math.min(28, 1 + i * 3)).padStart(2, "0");
    return `<div class="content-brow"><input type="date" name="bDate" aria-label="Date" value="${esc(d)}"><select name="bPlatform" aria-label="Platform">${U.opts(PLATFORMS, "Instagram")}</select><select name="bFormat" aria-label="Format">${U.opts(FORMATS, "Static")}</select><input name="bTitle" aria-label="Topic" placeholder="Topic (leave blank to skip)"><button type="button" class="btn ghost sm" data-rm aria-label="Remove row">✕</button></div>`;
  }
  function bulkForm(defaults) {
    const ctx = RW.ctx;
    if (!canCreate(ctx)) { U.toast("Ask HR to link your account before adding posts.", "bad"); return; }
    if (!ctx.clients.length) { U.toast("Add a client first.", "bad"); return; }
    const month = (defaults && defaults.month) || D.addMonths(ctx.today.slice(0, 7), 1);
    const n = 8;
    U.modal({
      title: "Bulk plan a month", wide: true, submitLabel: "Add posts",
      body: `<div class="fgrid">
          ${U.field({ label: "Client", name: "clientId", type: "select", optionsHtml: U.clientOpts((defaults && defaults.clientId) || F().contentClient, "Choose a client") })}
          ${U.field({ label: "Month", name: "month", type: "month", value: month })}
          ${U.field({ label: "Owner", name: "ownerId", type: "select", optionsHtml: U.empOpts(ctx.me ? ctx.me.id : "", "Not assigned") })}
          ${U.field({ label: "Start status", name: "status", options: ["Idea", "Drafting"], value: "Idea" })}
        </div>
        <span class="hint">One row per post. Rows with no topic are skipped.</span>
        <div class="content-bulk" id="ctBulkRows">${Array.from({ length: n }, (_, i) => bulkRow(month, i)).join("")}</div>
        <button type="button" class="btn sm" id="ctBulkAdd" style="align-self:flex-start">Add row</button>`,
      onMount(form) {
        const box = form.querySelector("#ctBulkRows");
        form.querySelector("#ctBulkAdd").addEventListener("click", () => { const m = U.fv(form, "month") || month; box.insertAdjacentHTML("beforeend", bulkRow(m, box.children.length)); });
        box.addEventListener("click", e => { const b = e.target.closest("[data-rm]"); if (b) b.closest(".content-brow").remove(); });
        form.elements.month.addEventListener("change", () => {
          const m = U.fv(form, "month"); if (!/^\d{4}-\d{2}$/.test(m)) return;
          box.querySelectorAll('[name="bDate"]').forEach(i => { if (/^\d{4}-\d{2}-\d{2}$/.test(i.value)) { const day = i.value.slice(8); const cand = m + "-" + day; i.value = D.valid(cand) && cand.slice(0, 7) === m ? cand : m + "-28"; } });
        });
      },
      onSubmit: async form => {
        const clientId = U.fv(form, "clientId"); if (!clientId) { U.toast("Choose a client.", "bad"); return false; }
        const rows = [...form.querySelectorAll(".content-brow")].map(r => ({ date: r.querySelector('[name="bDate"]').value, platform: r.querySelector('[name="bPlatform"]').value, format: r.querySelector('[name="bFormat"]').value, title: r.querySelector('[name="bTitle"]').value.trim() })).filter(r => r.title);
        if (!rows.length) { U.toast("Enter a topic in at least one row.", "bad"); return false; }
        if (rows.some(r => r.date && !D.valid(r.date))) { U.toast("One of the dates isn't valid.", "bad"); return false; }
        const status = U.fv(form, "status") === "Drafting" ? "Drafting" : "Idea", ownerId = U.fv(form, "ownerId");
        let made = 0;
        for (const r of rows) {
          const now = new Date().toISOString();
          const ok = await RW.write.add("posts", { clientId, title: r.title, platform: PLATFORMS.includes(r.platform) ? r.platform : "Instagram", format: FORMATS.includes(r.format) ? r.format : "Static", publishDate: r.date, publishTime: "", status, ownerId, copywriterId: "", designerId: "", caption: "", hashtags: "", assetLink: "", clientFeedback: "", publishedUrl: "", metrics: {}, createdAt: now, updatedAt: now, createdBy: ctx.me ? ctx.me.id : "", createdByUser: ctx.viewerId || "" });
          if (!ok) break; made++;
        }
        if (made) U.toast(`${made} post${made === 1 ? "" : "s"} added for ${ctx.clientName(clientId)}.`);
        return made === rows.length;
      }
    });
  }

  /* ---------- actions ---------- */
  RW.action("content.tab", el => RW.go("content", el.dataset.tab === "calendar" ? "" : el.dataset.tab));
  RW.action("content.new", () => postForm(null));
  RW.action("content.bulk", () => bulkForm());
  RW.action("content.addOn", el => postForm(null, { publishDate: el.dataset.date }));
  RW.action("content.open", el => { const p = post(el.dataset.id); if (p) postForm(p); });
  RW.action("content.mode", el => { st.mode = el.dataset.mode === "week" ? "week" : "month"; RW.prefs.set("content.mode", st.mode); if (st.mode === "week" && st.month && st.week.slice(0, 7) !== st.month) st.week = mondayOf(st.month === RW.ctx.today.slice(0, 7) ? RW.ctx.today : st.month + "-01"); RW.render(); });
  RW.action("content.weekOf", el => { st.mode = "week"; st.week = mondayOf(el.dataset.date); RW.render(); });
  RW.action("content.prev", () => { if (st.mode === "week") { st.week = D.addDays(st.week, -7); st.month = st.week.slice(0, 7); } else st.month = D.addMonths(st.month, -1); RW.render(); });
  RW.action("content.next", () => { if (st.mode === "week") { st.week = D.addDays(st.week, 7); st.month = st.week.slice(0, 7); } else st.month = D.addMonths(st.month, 1); RW.render(); });
  RW.action("content.today", () => { const t = RW.ctx.today; st.month = t.slice(0, 7); st.week = mondayOf(t); RW.render(); });
  RW.action("content.planPrev", () => { st.planMonth = D.addMonths(st.planMonth, -1); RW.render(); });
  RW.action("content.planNext", () => { st.planMonth = D.addMonths(st.planMonth, 1); RW.render(); });
  RW.action("content.sort", el => { const k = el.dataset.key; if (st.sort === k) st.dir = st.dir === "asc" ? "desc" : "asc"; else { st.sort = k; st.dir = "asc"; } RW.render(); });
  RW.action("content.csv", () => {
    const ctx = RW.ctx;
    const rows = [["Publish date", "Time", "Client", "Title", "Platform", "Format", "Status", "Owner", "Copywriter", "Designer", "Caption", "Hashtags", "Asset link", "Client feedback", "Published URL", ...METRICS.map(m => m[0].toUpperCase() + m.slice(1))]];
    trackerRows(ctx).forEach(p => rows.push([p.publishDate || "", p.publishTime || "", ctx.clientName(p.clientId), p.title || "", p.platform || "", p.format || "", statusOf(p), p.ownerId ? ctx.empName(p.ownerId) : "", p.copywriterId ? ctx.empName(p.copywriterId) : "", p.designerId ? ctx.empName(p.designerId) : "", p.caption || "", p.hashtags || "", p.assetLink || "", p.clientFeedback || "", p.publishedUrl || "", ...METRICS.map(m => (p.metrics || {})[m] ?? "")]));
    return U.csvCopy(rows, "Posts");
  });
  RW.action("content.cleanup", async () => {
    const ctx = RW.ctx; if (!ctx.adminWrite) return;
    const cutoff = D.addDays(ctx.today, -365);
    const old = posts().filter(p => statusOf(p) === "Published" && D.valid(p.publishDate) && p.publishDate < cutoff);
    if (!old.length) { U.toast("No published posts older than 12 months."); return; }
    if (!(await U.confirm(`Delete ${old.length} published post${old.length === 1 ? "" : "s"} dated before ${D.fmt(cutoff)}? Copy the tracker as CSV first if you need a record.`, "Delete posts"))) return;
    let n = 0; for (const p of old) { if (!(await RW.write.del("posts/" + p.id))) break; n++; }
    U.toast(`${n} old post${n === 1 ? "" : "s"} deleted.`);
  });
  RW.action("content.clientCal", el => { RW.S.f.contentClient = el.dataset.client || ""; RW.go("content", el.dataset.view || ""); });
  RW.action("content.clientNew", el => postForm(null, { clientId: el.dataset.client }));
  RW.action("content.clientBulk", el => bulkForm({ clientId: el.dataset.client }));
  RW.onChange("content.cell", async el => {
    const ctx = RW.ctx, p = post(el.dataset.id), field = el.dataset.field;
    if (!p || !canEdit(ctx)) { RW.render(); return; }
    const v = el.value;
    let patch;
    if (field === "status") { if (!STATUSES.includes(v) || v === statusOf(p)) return; patch = statusPatch(p, v); }
    else if (field === "publishDate") { if (v && !D.valid(v)) { RW.render(); return; } if ((p.publishDate || "") === v) return; patch = { publishDate: v, updatedAt: new Date().toISOString() }; }
    else if (["ownerId", "copywriterId", "designerId"].includes(field)) { if ((p[field] || "") === v) return; patch = { [field]: v, updatedAt: new Date().toISOString() }; }
    else return;
    el.disabled = true;
    const ok = await RW.write.update("posts/" + p.id, patch, field === "status" ? `Moved to ${v}.` : "Saved.");
    el.disabled = false;
    if (!ok) RW.render();
  });

  /* ---------- extensions ---------- */
  function clientTab(el, client, ctx) {
    const ps = posts().filter(p => p.clientId === client.id);
    const today = ctx.today, m = today.slice(0, 7);
    const month = ps.filter(p => String(p.publishDate || "").slice(0, 7) === m);
    const upcoming = ps.filter(p => statusOf(p) !== "Published" && (!D.valid(p.publishDate) || p.publishDate >= D.addDays(today, -30))).sort(sortByDate).slice(0, 12);
    const waiting = ps.filter(p => statusOf(p) === "Sent to client").length;
    const add = canCreate(ctx);
    el.innerHTML = `<div class="filters">${add ? `<button class="btn primary sm" data-act="content.clientNew" data-client="${esc(client.id)}">New post</button><button class="btn sm" data-act="content.clientBulk" data-client="${esc(client.id)}">Bulk plan month</button>` : ""}<button class="btn sm" data-act="content.clientCal" data-client="${esc(client.id)}">Open calendar</button><button class="btn sm" data-act="content.clientCal" data-client="${esc(client.id)}" data-view="tracker">Open tracker</button></div>
      <div class="tiles"><div class="tile"><div class="v">${month.length}</div><div class="l">Planned this month</div></div><div class="tile"><div class="v">${month.filter(p => statusOf(p) === "Published").length}</div><div class="l">Published this month</div></div><div class="tile${waiting ? " alert" : ""}"><div class="v">${waiting}</div><div class="l">Awaiting client approval</div></div></div>
      <div class="panel"><div class="panel-head"><h2>Upcoming and in progress</h2></div>${U.tableHTML([
        { label: "Date", text: p => D.fmt(p.publishDate) },
        { label: "Post", html: p => `<button type="button" class="content-link" data-act="content.open" data-id="${esc(p.id)}">${esc(p.title || "(untitled)")}</button>` },
        { label: "Platform", html: p => `<span class="content-dot" style="--pc:${pcol(p.platform)}"></span>${esc(p.platform || "")}` },
        { label: "Status", html: p => pill(statusOf(p)) + (isOverduePost(p, today) ? " " + U.pill("Overdue", "bad") : "") },
        { label: "Owner", text: p => p.ownerId ? ctx.empName(p.ownerId) : "—" }
      ], upcoming, { empty: "No content planned for this client yet." })}</div>`;
  }
  RW.registerClientTab({ id: "content", title: "Content", order: 20, render: clientTab });

  RW.registerHealthSignal((client, ctx) => {
    const today = ctx.today, ps = posts().filter(p => p.clientId === client.id), out = [];
    const waiting = ps.filter(p => statusOf(p) === "Sent to client" && sentAge(p, today) > 3).length;
    if (waiting) out.push({ label: `${waiting} post${waiting === 1 ? "" : "s"} awaiting client approval for over 3 days`, level: "warn" });
    const late = ps.filter(p => isOverduePost(p, today)).length;
    if (late) out.push({ label: `${late} post${late === 1 ? "" : "s"} past publish date, not published`, level: late >= 3 ? "danger" : "warn" });
    return out;
  });

  function alerts(ctx) {
    const today = ctx.today, tomorrow = D.addDays(today, 1), out = [];
    const soon = posts().filter(p => (p.publishDate === today || p.publishDate === tomorrow) && !DONE.has(statusOf(p))).sort(sortByDate);
    soon.slice(0, 10).forEach(p => out.push({ level: "warn", date: p.publishDate, href: "#content-tracker", text: `${ctx.clientName(p.clientId) || "Post"}: "${p.title || "untitled"}" goes out ${p.publishDate === today ? "today" : "tomorrow"} and isn't scheduled (${statusOf(p)})` }));
    if (soon.length > 10) out.push({ level: "warn", date: tomorrow, href: "#content-tracker", text: `${soon.length - 10} more posts due today or tomorrow aren't scheduled` });
    const late = posts().filter(p => isOverduePost(p, today));
    if (late.length) out.push({ level: "danger", date: late.map(p => p.publishDate).sort()[0], href: "#content-tracker", text: `${late.length} post${late.length === 1 ? " is" : "s are"} past the publish date and not published` });
    return out;
  }

  function dashboardWidgets(ctx) {
    return [{
      title: "Content due this week", href: "#content", linkLabel: "Open content calendar", order: 30,
      render(body) {
        const today = ctx.today, end = D.addDays(today, 6);
        const due = posts().filter(p => D.valid(p.publishDate) && p.publishDate >= today && p.publishDate <= end && statusOf(p) !== "Published").sort(sortByDate);
        if (!due.length) { body.innerHTML = `<div class="empty">Nothing due in the next 7 days.</div>`; return; }
        body.innerHTML = `<div class="list">${due.slice(0, 8).map(p => `<div class="row"><span class="content-dot" style="--pc:${pcol(p.platform)}"></span><div class="grow"><div class="title">${esc(p.title || "(untitled)")}</div><div class="small muted">${esc(ctx.clientName(p.clientId) || "No client")} · ${esc(p.platform || "")} · ${esc(D.fmtShort(p.publishDate))}</div></div>${pill(statusOf(p))}</div>`).join("")}</div>${due.length > 8 ? `<p class="hint">+${due.length - 8} more</p>` : ""}`;
      }
    }];
  }

  RW.register({
    id: "content", title: "Content calendar", icon: ICON, group: "Clients", order: 20,
    collections: ["posts"], render,
    badge: () => posts().filter(p => statusOf(p) === "Internal review").length,
    alerts, dashboardWidgets
  });
})();
