"use strict";
/* Clients (CRM), client detail tabs, health, links library, and Invoices.
   Collections: clients (admin writes, everyone reads),
                billing/<clientId> {monthlyRetainer, billingDay} (admin read + write),
                invoices (admin read + write). */
(function () {
  const I = {
    clients: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/></svg>',
    invoices: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>'
  };
  const statusKind = s => ({ Active: "good", Onboarding: "accent", Paused: "warn", Churned: "" }[s] || "");
  const invKind = s => ({ Paid: "good", Sent: "accent", Overdue: "bad", Draft: "" }[s] || "");
  const retainerOf = c => num((S.billing[c.id] || {}).monthlyRetainer, 0);
  const billingDayOf = c => num((S.billing[c.id] || {}).billingDay, 0);
  const isLive = c => c.status === "Active" || c.status === "Onboarding";
  function clientAv(c, lg) { const col = safeColor(c.logoColor) || hashColor(c.id || c.name); return `<span class="cav${lg ? " lg" : ""}" style="background:${col}" aria-hidden="true">${esc(initials(c.name))}</span>`; }
  RW.ui.clientAv = clientAv;
  const clientProjects = c => Object.values(S.projects).filter(p => p.clientId === c.id);
  const clientInvoices = c => Object.values(S.invoices).filter(i => i.clientId === c.id).sort((a, b) => String(b.month).localeCompare(String(a.month)));
  function contractDaysLeft(c) { return validDate(c.contractEnd) ? daysBetween(todayStr(), c.contractEnd) : null; }

  /* ---- core health signals ---- */
  RW.registerHealthSignal((c, ctx) => {
    const pids = new Set(clientProjects(c).map(p => p.id));
    const n = Object.values(S.tasks).filter(t => pids.has(t.projectId) && isOverdue(t)).length;
    return n ? { label: `${n} overdue task${n === 1 ? "" : "s"}`, level: n >= 3 ? "danger" : "warn" } : null;
  });
  RW.registerHealthSignal(c => {
    const n = clientInvoices(c).filter(i => invoiceStatus(i) === "Overdue").length;
    return n ? { label: `${n} overdue invoice${n === 1 ? "" : "s"}`, level: "danger" } : null;
  });
  RW.registerHealthSignal(c => {
    if (!isLive(c)) return null;
    const d = contractDaysLeft(c); if (d === null) return null;
    if (d < 0) return { label: "Contract has ended", level: "danger" };
    if (d <= 30) return { label: `Contract ends in ${d} day${d === 1 ? "" : "s"}`, level: "warn" };
    return null;
  });

  /* ---- forms ---- */
  function linkRow(l) { return `<div class="link-row"><input name="lkLabel" aria-label="Link name" placeholder="e.g. Brand kit" value="${esc(l.label || "")}"><input name="lkUrl" aria-label="Link address" type="url" placeholder="https://drive.google.com/..." value="${esc(l.url || "")}"><button type="button" class="btn ghost sm danger" data-rm>Remove</button></div>`; }
  function readLinks(form) {
    const out = [];
    for (const r of form.querySelectorAll(".link-row")) {
      const label = r.querySelector('[name="lkLabel"]').value.trim(), url = r.querySelector('[name="lkUrl"]').value.trim();
      if (!label && !url) continue;
      if (!safeUrl(url)) { toast(`"${label || url}" needs a full web address starting with https://`, "bad"); return null; }
      out.push({ label: label || url, url });
    }
    return out;
  }
  function wireLinks(form) {
    const box = $("#lkRows", form);
    $("#lkAdd", form).addEventListener("click", () => { box.insertAdjacentHTML("beforeend", linkRow({})); box.lastElementChild.querySelector("input").focus(); });
    box.addEventListener("click", e => { const b = e.target.closest("[data-rm]"); if (b) b.closest(".link-row").remove(); });
  }

  function clientForm(c) {
    const x = c || { status: "Onboarding", services: [], teamIds: [], links: [] };
    const bill = c ? (S.billing[c.id] || {}) : {};
    const team = emps(true).filter(e => e.active !== false || (x.teamIds || []).includes(e.id)).map(e => `<label class="check"><input type="checkbox" name="team" value="${esc(e.id)}"${(x.teamIds || []).includes(e.id) ? " checked" : ""}> ${esc(e.name)}</label>`).join("") || `<span class="hint">Add people first.</span>`;
    const svc = SERVICES.map(s => `<label class="check"><input type="checkbox" name="svc" value="${esc(s)}"${(x.services || []).includes(s) ? " checked" : ""}> ${esc(s)}</label>`).join("");
    openModal({
      title: c ? "Edit client" : "Add client", wide: true, submitLabel: c ? "Save changes" : "Add client",
      body: `<div class="fgrid">
          <div class="field"><label for="cName">Client name</label><input id="cName" name="name" required value="${esc(x.name)}"></div>
          <div class="field"><label for="cInd">Industry</label><input id="cInd" name="industry" value="${esc(x.industry)}" placeholder="e.g. Real estate"></div>
          <div class="field"><label for="cStatus">Status</label><select id="cStatus" name="status">${opts(CLIENT_STATUSES, x.status)}</select></div>
          <div class="field"><label for="cColor">Brand colour</label><input id="cColor" name="logoColor" type="color" value="${esc(safeColor(x.logoColor) || "#0d6b5b")}"></div>
          <div class="field"><label for="cContact">Contact person</label><input id="cContact" name="contactName" value="${esc(x.contactName)}"></div>
          <div class="field"><label for="cCEmail">Contact email</label><input id="cCEmail" name="contactEmail" type="email" value="${esc(x.contactEmail)}"></div>
          <div class="field"><label for="cCPhone">Contact phone</label><input id="cCPhone" name="contactPhone" type="tel" value="${esc(x.contactPhone)}"></div>
          <div class="field"><label for="cAM">Account manager</label><select id="cAM" name="accountManagerId">${empOpts(x.accountManagerId, "Not assigned")}</select></div>
          <div class="field"><label for="cStart">Contract start</label><input id="cStart" name="contractStart" type="date" value="${esc(x.contractStart)}"></div>
          <div class="field"><label for="cEnd">Contract end / renewal</label><input id="cEnd" name="contractEnd" type="date" value="${esc(x.contractEnd)}"></div>
          <div class="field"><label for="cRet">Monthly retainer (₹)</label><input id="cRet" name="monthlyRetainer" type="number" min="0" step="1" inputmode="numeric" value="${esc(bill.monthlyRetainer ?? "")}"><span class="hint">Only admins can see billing.</span></div>
          <div class="field"><label for="cBill">Billing day of month</label><input id="cBill" name="billingDay" type="number" min="1" max="28" step="1" value="${esc(bill.billingDay ?? "")}" placeholder="e.g. 5"></div>
        </div>
        <div class="field"><span class="flabel">Services</span><div class="checks">${svc}</div></div>
        <div class="field"><span class="flabel">Client team</span><div class="members">${team}</div></div>
        <div class="field"><label for="cNotes">Notes</label><textarea id="cNotes" name="notes" placeholder="Goals, preferences, approval contacts…">${esc(x.notes)}</textarea></div>
        <div class="field"><span class="flabel">Links library</span><span class="hint">Drive folders, brand kit, reports, ad accounts. No passwords: keep those in a password manager.</span>
          <div id="lkRows" style="display:flex;flex-direction:column;gap:8px">${(x.links || []).map(linkRow).join("")}</div>
          <button type="button" class="btn sm" id="lkAdd" style="align-self:flex-start">Add link</button></div>`,
      onMount: wireLinks,
      onSubmit: async form => {
        const name = fv(form, "name"); if (!name) { toast("Enter the client's name.", "bad"); return false; }
        const cs = fv(form, "contractStart"), ce = fv(form, "contractEnd");
        if (cs && ce && ce < cs) { toast("The contract end is before the start.", "bad"); return false; }
        const links = readLinks(form); if (!links) return false;
        const ret = fv(form, "monthlyRetainer"), bd = fv(form, "billingDay");
        if (ret !== "" && !(Number(ret) >= 0)) { toast("Enter a valid retainer amount.", "bad"); return false; }
        if (bd !== "" && !(Number(bd) >= 1 && Number(bd) <= 28)) { toast("Billing day must be between 1 and 28.", "bad"); return false; }
        const data = {
          name, industry: fv(form, "industry"), status: fv(form, "status"), logoColor: safeColor(fv(form, "logoColor")),
          contactName: fv(form, "contactName"), contactEmail: fv(form, "contactEmail"), contactPhone: fv(form, "contactPhone"),
          accountManagerId: fv(form, "accountManagerId"), teamIds: [...form.querySelectorAll('input[name="team"]:checked')].map(i => i.value),
          services: [...form.querySelectorAll('input[name="svc"]:checked')].map(i => i.value),
          contractStart: cs, contractEnd: ce, notes: fv(form, "notes"), links,
          createdAt: c ? (c.createdAt || new Date().toISOString()) : new Date().toISOString(), updatedAt: new Date().toISOString()
        };
        let ref = null;
        const ok = await write(async () => { if (c) await col("clients").doc(c.id).set(data); else ref = await col("clients").add(data); });
        if (!ok) return false;
        const id = c ? c.id : ref && ref.id;
        const newBill = { monthlyRetainer: ret === "" ? 0 : Number(ret), billingDay: bd === "" ? 0 : Number(bd), updatedAt: new Date().toISOString() };
        const oldBill = S.billing[id] || {};
        if (id && (num(oldBill.monthlyRetainer, 0) !== newBill.monthlyRetainer || num(oldBill.billingDay, 0) !== newBill.billingDay)) await write(() => col("billing").doc(id).set(newBill));
        toast(c ? "Client updated." : "Client added.");
        return true;
      }
    });
  }

  function linksForm(c) {
    openModal({
      title: `Links for ${c.name}`, wide: true, submitLabel: "Save links",
      body: `<span class="hint">Drive folders, brand kit, reports, ad accounts. No passwords.</span><div id="lkRows" style="display:flex;flex-direction:column;gap:8px">${(c.links || []).map(linkRow).join("") || linkRow({})}</div><button type="button" class="btn sm" id="lkAdd" style="align-self:flex-start">Add link</button>`,
      onMount: wireLinks,
      onSubmit: async form => { const links = readLinks(form); if (!links) return false; return write(() => col("clients").doc(c.id).update({ links, updatedAt: new Date().toISOString() }), "Links saved."); }
    });
  }

  function invoiceForm(inv, defaults) {
    const x = inv || Object.assign({ status: "Draft", month: todayStr().slice(0, 7) }, defaults || {});
    if (!inv && x.clientId && x.amount === undefined) { const c = S.clients[x.clientId]; if (c) x.amount = retainerOf(c) || ""; }
    if (!clientsSorted().length) { toast("Add a client first.", "bad"); return; }
    openModal({
      title: inv ? "Edit invoice" : "New invoice", submitLabel: inv ? "Save changes" : "Create invoice",
      body: `<div class="fgrid">
          <div class="field"><label for="iClient">Client</label><select id="iClient" name="clientId">${clientOpts(x.clientId)}</select></div>
          <div class="field"><label for="iMonth">For month</label><input id="iMonth" name="month" type="month" required value="${esc(x.month)}"></div>
          <div class="field"><label for="iAmt">Amount (₹)</label><input id="iAmt" name="amount" type="number" min="0" step="1" required value="${esc(x.amount ?? "")}"></div>
          <div class="field"><label for="iStatus">Status</label><select id="iStatus" name="status">${opts(INVOICE_STATUSES, x.status)}</select></div>
          <div class="field"><label for="iDue">Due date</label><input id="iDue" name="dueDate" type="date" value="${esc(x.dueDate)}"></div>
          <div class="field"><label for="iPaid">Paid on</label><input id="iPaid" name="paidDate" type="date" value="${esc(x.paidDate)}"></div>
          <div class="field"><label for="iNo">Invoice number</label><input id="iNo" name="number" value="${esc(x.number)}" placeholder="Optional"></div>
        </div>
        <div class="field"><label for="iNotes">Notes</label><textarea id="iNotes" name="notes">${esc(x.notes)}</textarea></div>`,
      onMount: form => {
        form.elements.clientId.addEventListener("change", () => { const c = S.clients[form.elements.clientId.value]; if (c && !form.elements.amount.value) form.elements.amount.value = retainerOf(c) || ""; });
        form.elements.status.addEventListener("change", () => { if (form.elements.status.value === "Paid" && !form.elements.paidDate.value) form.elements.paidDate.value = todayStr(); });
      },
      onSubmit: async form => {
        const clientId = fv(form, "clientId"), month = fv(form, "month"), amount = Number(fv(form, "amount"));
        if (!clientId) { toast("Choose a client.", "bad"); return false; }
        if (!/^\d{4}-\d{2}$/.test(month)) { toast("Choose the month.", "bad"); return false; }
        if (!Number.isFinite(amount) || amount < 0) { toast("Enter a valid amount.", "bad"); return false; }
        const data = { clientId, month, amount, status: fv(form, "status"), dueDate: fv(form, "dueDate"), paidDate: fv(form, "paidDate"), number: fv(form, "number"), notes: fv(form, "notes"),
          createdAt: inv ? (inv.createdAt || new Date().toISOString()) : new Date().toISOString(), updatedAt: new Date().toISOString() };
        return write(() => inv ? col("invoices").doc(inv.id).set(data) : col("invoices").add(data), inv ? "Invoice updated." : "Invoice created.");
      }
    });
  }

  /* ---- views ---- */
  function clientCard(c, ctx) {
    const hh = RW.clientHealth(c, ctx);
    const am = S.employees[c.accountManagerId];
    const d = contractDaysLeft(c);
    return `<button class="ccard" data-act="openClient" data-id="${esc(c.id)}">
      <div class="hd">${clientAv(c)}<div class="grow"><h3>${esc(c.name)}</h3><div class="small muted">${esc(c.industry || "—")}</div></div>${pill(c.status || "Active", statusKind(c.status))}</div>
      ${(c.services || []).length ? `<div class="chips">${c.services.map(s => pill(s)).join("")}</div>` : ""}
      <div class="meta" style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;width:100%;font-size:.85rem;color:var(--muted)">
        <span style="display:inline-flex;align-items:center;gap:6px">${am ? av(am) + esc(am.name) : "No account manager"}</span>
        ${healthHTML(hh)}</div>
      <div class="small muted num" style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;width:100%"><span>${d === null ? "No contract end date" : d < 0 ? `Contract ended ${esc(nice(c.contractEnd))}` : `Renews ${esc(nice(c.contractEnd))}`}</span>${S.isAdmin && retainerOf(c) ? `<span class="money">${esc(fmtINR(retainerOf(c)))}/mo</span>` : ""}</div>
    </button>`;
  }
  function filteredClients(ctx) {
    const f = S.f, q = (f.cSearch || "").toLowerCase();
    return ctx.clients.filter(c =>
      (!q || [c.name, c.industry, c.contactName, empName(c.accountManagerId)].join(" ").toLowerCase().includes(q)) &&
      (!f.cStatus || c.status === f.cStatus) && (!f.cService || (c.services || []).includes(f.cService)) && (!f.cManager || c.accountManagerId === f.cManager));
  }
  function vClients(el, ctx, route) {
    if (route.sub) { const c = S.clients[route.sub]; return c ? vClientDetail(c, ctx, el) : { html: `<div class="empty">This client doesn't exist any more. <a href="#clients">See all clients</a>.</div>`, title: "Client not found" }; }
    const f = S.f;
    const list = filteredClients(ctx).sort((a, b) => CLIENT_STATUSES.indexOf(a.status) - CLIENT_STATUSES.indexOf(b.status) || String(a.name).localeCompare(String(b.name)));
    const live = ctx.clients.filter(isLive);
    const renewing = live.filter(c => { const d = contractDaysLeft(c); return d !== null && d <= 30; });
    const atRisk = live.filter(c => RW.clientHealth(c, ctx).level === "danger");
    const actions = `<button class="btn" data-act="exportClients">Export CSV</button>${adminWrite() ? `<button class="btn primary" data-act="newClient">Add client</button>` : ""}`;
    const html = `<div class="tiles">
        <div class="tile"><span class="v">${live.length}</span><span class="l">Active and onboarding</span></div>
        ${S.isAdmin ? `<div class="tile"><span class="v money" style="font-size:1.5rem">${esc(fmtINR(live.reduce((s, c) => s + retainerOf(c), 0)))}</span><span class="l">Monthly retainers</span></div>` : ""}
        <div class="tile${renewing.length ? " leave" : ""}"><span class="v">${renewing.length}</span><span class="l">Renewals in 30 days</span></div>
        <div class="tile${atRisk.length ? " alert" : ""}"><span class="v">${atRisk.length}</span><span class="l">Clients at risk</span></div>
      </div>
      <div class="filters">
        <input type="search" id="cfSearch" placeholder="Search clients" aria-label="Search clients" value="${esc(f.cSearch)}" data-input="filter" data-key="cSearch">
        <select id="cfStatus" aria-label="Status" data-change="filter" data-key="cStatus">${opts(CLIENT_STATUSES, f.cStatus, "Any status")}</select>
        <select id="cfService" aria-label="Service" data-change="filter" data-key="cService">${opts(SERVICES, f.cService, "Any service")}</select>
        <select id="cfManager" aria-label="Account manager" data-change="filter" data-key="cManager">${empOpts(f.cManager, "Any account manager")}</select>
      </div>
      ${list.length ? `<div class="cards">${list.map(c => clientCard(c, ctx)).join("")}</div>` : `<div class="empty">${ctx.clients.length ? "No clients match these filters." : adminWrite() ? "No clients yet. Add your first client to link projects, content and campaigns to them." : "No clients yet."}</div>`}`;
    return { html, actions };
  }

  function vClientDetail(c, ctx, el) {
    const tabs = [["overview", "Overview"], ["projects", "Projects"]];
    if (S.isAdmin) tabs.push(["invoices", "Invoices"]);
    tabs.push(["links", "Links"]);
    const extra = RW.clientTabs.slice().sort((a, b) => a.order - b.order).filter(t => !t.adminOnly || S.isAdmin);
    extra.forEach(t => tabs.push(["x:" + t.id, esc(t.title)]));
    let tab = S.clientTab[c.id] || "overview";
    if (!tabs.some(t => t[0] === tab)) tab = "overview";
    const hh = RW.clientHealth(c, ctx);
    const am = S.employees[c.accountManagerId];
    const actions = `<a class="btn" href="#clients">All clients</a>${adminWrite() ? `<button class="btn" data-act="editClient" data-id="${esc(c.id)}">Edit</button><button class="btn danger" data-act="deleteClient" data-id="${esc(c.id)}">Delete</button>` : ""}`;
    const head = `<section class="panel"><div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">${clientAv(c, true)}<div style="flex:1;min-width:min(180px,100%)"><h2 style="font-size:1.4rem;overflow-wrap:anywhere">${esc(c.name)}</h2><div class="small muted">${esc(c.industry || "")}${c.industry && am ? " · " : ""}${am ? "Account manager: " + esc(am.name) : ""}</div></div>${pill(c.status || "Active", statusKind(c.status))}${healthHTML(hh)}</div></section>`;
    el.insertAdjacentHTML("beforeend", head + tabsHTML(tabs.map(([k, l]) => [k, k.startsWith("x:") ? l : esc(l)]), tab, "clientTab", ` data-client="${esc(c.id)}"`));
    const body = h("div", { class: "stack" }); el.append(body);
    if (tab === "overview") {
      const d = contractDaysLeft(c);
      const teamEmps = (c.teamIds || []).map(id => S.employees[id]).filter(Boolean);
      body.innerHTML = `<section class="panel"><div class="kv">
          <div><span class="k">Contact person</span><span>${esc(c.contactName || "—")}</span></div>
          <div><span class="k">Email</span><span>${esc(c.contactEmail || "—")}</span></div>
          <div><span class="k">Phone</span><span>${esc(c.contactPhone || "—")}</span></div>
          <div><span class="k">Services</span><span class="chips">${(c.services || []).map(s => pill(s)).join("") || "—"}</span></div>
          <div><span class="k">Contract</span><span class="num">${c.contractStart ? esc(nice(c.contractStart)) : "—"} to ${c.contractEnd ? esc(nice(c.contractEnd)) : "—"}${d !== null ? ` <span class="pill ${d < 0 ? "bad" : d <= 30 ? "warn" : ""}">${d < 0 ? "Ended" : d + " days left"}</span>` : ""}</span></div>
          ${S.isAdmin ? `<div><span class="k">Monthly retainer</span><span class="money">${retainerOf(c) ? esc(fmtINR(retainerOf(c))) : "—"}${billingDayOf(c) ? ` <span class="small muted">billed on day ${esc(billingDayOf(c))}</span>` : ""}</span></div>` : ""}
        </div></section>
        <section class="panel"><div class="panel-head"><h2>Team</h2></div>${teamEmps.length || am ? `<div style="display:flex;flex-wrap:wrap;gap:12px">${(am ? [am] : []).concat(teamEmps.filter(e => !am || e.id !== am.id)).map(e => `<span style="display:inline-flex;align-items:center;gap:6px">${av(e)}<span class="small">${esc(e.name)}${am && e.id === am.id ? " (account manager)" : ""}</span></span>`).join("")}</div>` : `<div class="empty">No team assigned.</div>`}</section>
        <section class="panel"><div class="panel-head"><h2>Health</h2>${healthHTML(hh)}</div>${hh.signals.length ? `<div class="alerts">${hh.signals.map(s => `<div class="alert ${s.level}"><span class="grow">${esc(s.label)}</span></div>`).join("")}</div>` : `<div class="empty">No issues found.</div>`}</section>
        ${c.notes ? `<section class="panel"><div class="panel-head"><h2>Notes</h2></div><p style="margin:0;white-space:pre-wrap">${esc(c.notes)}</p></section>` : ""}`;
    } else if (tab === "projects") {
      const ps = clientProjects(c);
      body.innerHTML = `<div class="panel-head"><h2>Projects</h2>${adminWrite() ? `<button class="btn sm primary" data-act="newProject" data-client="${esc(c.id)}">New project for ${esc(c.name)}</button>` : ""}</div>
        ${ps.length ? `<div class="cards">${ps.map(p => RW.ui.projectCard ? RW.ui.projectCard(p) : esc(p.name)).join("")}</div>` : `<div class="empty">No projects for this client yet.</div>`}`;
    } else if (tab === "invoices") {
      body.innerHTML = `<div class="panel-head"><h2>Invoices</h2>${adminWrite() ? `<button class="btn sm primary" data-act="newInvoice" data-client="${esc(c.id)}">New invoice</button>` : ""}</div>${invoiceTable(clientInvoices(c), false)}`;
    } else if (tab === "links") {
      const links = (c.links || []);
      body.innerHTML = `<section class="panel"><div class="panel-head"><h2>Links library</h2>${adminWrite() ? `<button class="btn sm" data-act="editLinks" data-id="${esc(c.id)}">Edit links</button>` : ""}</div>
        ${links.length ? `<div class="links">${links.map(l => { const u = safeUrl(l.url); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(l.label || u)}</a>` : `<span>${esc(l.label)} <span class="muted small">(invalid link)</span></span>`; }).join("")}</div>` : `<div class="empty">No links yet. Add Drive folders, the brand kit and monthly reports.</div>`}
        <p class="hint" style="margin:10px 0 0">Keep passwords in a password manager, not here.</p></section>`;
    } else {
      const t = extra.find(x => "x:" + x.id === tab);
      try { t.render(body, c, ctx); } catch (e) { console.error("[Rwork] client tab " + t.id + " failed", e); body.innerHTML = `<div class="view-error">This tab couldn't be shown.</div>`; }
    }
    return { actions, title: c.name };
  }

  function invoiceTable(list, showClient) {
    if (!list.length) return `<div class="empty">No invoices yet.</div>`;
    const ed = adminWrite();
    return `<div class="tbl-wrap"><table><thead><tr>${showClient ? "<th>Client</th>" : ""}<th>Month</th><th>Number</th><th>Amount</th><th>Due</th><th>Status</th><th>Paid on</th><th></th></tr></thead><tbody>
      ${list.map(i => { const st = invoiceStatus(i); return `<tr>${showClient ? `<td><a href="#clients-${esc(i.clientId)}">${esc(clientName(i.clientId) || "(Deleted client)")}</a></td>` : ""}<td>${esc(monthLabel(i.month))}</td><td>${esc(i.number || "—")}</td><td class="money">${esc(fmtINR(i.amount))}</td>
        <td class="num ${st === "Overdue" ? "overdue" : ""}">${i.dueDate ? esc(nice(i.dueDate)) : "—"}</td><td>${pill(st, invKind(st))}</td><td class="num">${i.paidDate ? esc(nice(i.paidDate)) : "—"}</td>
        <td style="white-space:nowrap">${ed ? `${st === "Draft" ? `<button class="btn sm" data-act="invSent" data-id="${esc(i.id)}">Mark sent</button> ` : ""}${st === "Sent" || st === "Overdue" ? `<button class="btn sm" data-act="invPaid" data-id="${esc(i.id)}">Mark paid</button> ` : ""}<button class="btn sm ghost" data-act="editInvoice" data-id="${esc(i.id)}">Edit</button>` : ""}</td></tr>`; }).join("")}
    </tbody></table></div>`;
  }

  function vInvoices(el, ctx) {
    const f = S.f, thisMonth = ctx.today.slice(0, 7);
    const all = Object.values(S.invoices);
    const list = all.filter(i => (!f.iMonth || i.month === f.iMonth) && (!f.iStatus || invoiceStatus(i) === f.iStatus) && (!f.iClient || i.clientId === f.iClient))
      .sort((a, b) => String(b.month).localeCompare(String(a.month)) || clientName(a.clientId).localeCompare(clientName(b.clientId)));
    const mon = all.filter(i => i.month === thisMonth);
    const sum = arr => arr.reduce((s, i) => s + num(i.amount, 0), 0);
    const outstanding = all.filter(i => ["Sent", "Overdue"].includes(invoiceStatus(i)));
    const overdue = all.filter(i => invoiceStatus(i) === "Overdue");
    const months = [...new Set(all.map(i => i.month).concat([thisMonth]))].filter(Boolean).sort().reverse();
    const missing = ctx.clients.filter(c => isLive(c) && retainerOf(c) > 0 && !mon.some(i => i.clientId === c.id));
    const actions = `<button class="btn" data-act="exportInvoices">Export CSV</button>${adminWrite() ? `${missing.length ? `<button class="btn" data-act="genInvoices">Create ${esc(monthLabel(thisMonth))} drafts (${missing.length})</button>` : ""}<button class="btn primary" data-act="newInvoice">New invoice</button>` : ""}`;
    const html = `<div class="tiles">
        <div class="tile"><span class="v money" style="font-size:1.5rem">${esc(fmtINR(sum(mon)))}</span><span class="l">Billed for ${esc(monthLabel(thisMonth))}</span></div>
        <div class="tile"><span class="v money" style="font-size:1.5rem">${esc(fmtINR(sum(mon.filter(i => invoiceStatus(i) === "Paid"))))}</span><span class="l">Received for ${esc(monthLabel(thisMonth))}</span></div>
        <div class="tile"><span class="v money" style="font-size:1.5rem">${esc(fmtINR(sum(outstanding)))}</span><span class="l">Outstanding (${outstanding.length})</span></div>
        <div class="tile${overdue.length ? " alert" : ""}"><span class="v money" style="font-size:1.5rem">${esc(fmtINR(sum(overdue)))}</span><span class="l">Overdue (${overdue.length})</span></div>
      </div>
      <div class="filters">
        <select id="ifMonth" aria-label="Month" data-change="filter" data-key="iMonth">${opts(months.map(m => ({ v: m, l: monthLabel(m) })), f.iMonth, "All months")}</select>
        <select id="ifStatus" aria-label="Status" data-change="filter" data-key="iStatus">${opts(INVOICE_STATUSES, f.iStatus, "Any status")}</select>
        <select id="ifClient" aria-label="Client" data-change="filter" data-key="iClient">${clientOpts(f.iClient, "All clients")}</select>
      </div>
      ${invoiceTable(list, true)}`;
    return { html, actions };
  }

  async function genInvoices() {
    const ctx = RW.ctx, month = ctx.today.slice(0, 7);
    const mon = Object.values(S.invoices).filter(i => i.month === month);
    const missing = ctx.clients.filter(c => isLive(c) && retainerOf(c) > 0 && !mon.some(i => i.clientId === c.id));
    if (!missing.length) { toast("Every active client already has an invoice this month."); return; }
    if (!(await confirmDialog(`Create ${missing.length} draft invoice${missing.length === 1 ? "" : "s"} for ${monthLabel(month)} from the monthly retainers?`, "Create drafts"))) return;
    let n = 0;
    for (const c of missing) {
      const bd = billingDayOf(c) || 1;
      const ok = await write(() => col("invoices").add({ clientId: c.id, month, amount: retainerOf(c), status: "Draft", dueDate: `${month}-${pad(Math.min(28, bd))}`, paidDate: "", number: "", notes: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
      if (!ok) break; n++;
    }
    if (n) toast(`${n} draft invoice${n === 1 ? "" : "s"} created.`);
  }

  Object.assign(RW.actions, {
    newClient: () => clientForm(),
    editClient: el => { const c = S.clients[el.dataset.id]; if (c) clientForm(c); },
    openClient: el => RW.go("clients", el.dataset.id),
    clientTab: el => { S.clientTab[el.dataset.client] = el.dataset.tab; schedule(); },
    editLinks: el => { const c = S.clients[el.dataset.id]; if (c) linksForm(c); },
    deleteClient: async el => {
      const c = S.clients[el.dataset.id]; if (!c) return;
      const ps = clientProjects(c).length;
      if (!(await confirmDialog(`Delete the client "${c.name}"? ${ps ? `Its ${ps} project${ps === 1 ? "" : "s"} will stay but show no client. ` : ""}This can't be undone.`))) return;
      if (await write(() => col("clients").doc(c.id).delete(), "Client deleted.")) { if (S.billing[c.id]) await write(() => col("billing").doc(c.id).delete()); RW.go("clients"); }
    },
    newInvoice: el => invoiceForm(null, el.dataset.client ? { clientId: el.dataset.client } : null),
    editInvoice: el => { const i = S.invoices[el.dataset.id]; if (!i) return; invoiceForm(i); },
    invSent: async el => { const i = S.invoices[el.dataset.id]; if (i) await write(() => col("invoices").doc(i.id).update({ status: "Sent", updatedAt: new Date().toISOString() }), "Marked as sent."); },
    invPaid: async el => { const i = S.invoices[el.dataset.id]; if (i) await write(() => col("invoices").doc(i.id).update({ status: "Paid", paidDate: todayStr(), updatedAt: new Date().toISOString() }), "Marked as paid."); },
    genInvoices,
    exportClients: () => { const ctx = RW.ctx; copyText(csv([["Client", "Industry", "Status", "Services", "Account manager", "Contact", "Email", "Phone", "Contract start", "Contract end", ...(S.isAdmin ? ["Monthly retainer (INR)"] : []), "Health"], ...filteredClients(ctx).map(c => [c.name, c.industry || "", c.status || "", (c.services || []).join("; "), empName(c.accountManagerId), c.contactName || "", c.contactEmail || "", c.contactPhone || "", c.contractStart || "", c.contractEnd || "", ...(S.isAdmin ? [retainerOf(c)] : []), RW.clientHealth(c, ctx).label])]), "Clients"); },
    exportInvoices: () => { const ls = Object.values(S.invoices).sort((a, b) => String(a.month).localeCompare(String(b.month))); copyText(csv([["Client", "Month", "Number", "Amount (INR)", "Due date", "Status", "Paid on", "Notes"], ...ls.map(i => [clientName(i.clientId), i.month, i.number || "", num(i.amount, 0), i.dueDate || "", invoiceStatus(i), i.paidDate || "", i.notes || ""])]), "Invoices"); }
  });

  RW.register({
    id: "clients", title: "Clients", icon: I.clients, group: "Clients", order: 10,
    render: vClients,
    alerts: ctx => {
      const out = [];
      ctx.clients.filter(isLive).forEach(c => {
        const d = contractDaysLeft(c); if (d === null) return;
        if (d < 0) out.push({ level: "danger", text: `${c.name}: contract ended, renew or update the status`, date: c.contractEnd, href: "#clients-" + c.id });
        else if (d <= 30) out.push({ level: "warn", text: `${c.name}: contract renews in ${d} day${d === 1 ? "" : "s"}`, date: c.contractEnd, href: "#clients-" + c.id });
      });
      return out;
    },
    dashboardWidgets: ctx => ctx.clients.length ? [{
      title: "Client health", href: "#clients", linkLabel: "All clients", order: 10,
      render(body) {
        const rows = ctx.clients.filter(isLive).map(c => ({ c, hh: RW.clientHealth(c, ctx) })).sort((a, b) => ["danger", "warn", "good"].indexOf(a.hh.level) - ["danger", "warn", "good"].indexOf(b.hh.level) || a.c.name.localeCompare(b.c.name));
        body.innerHTML = rows.length ? `<div class="list">${rows.slice(0, 8).map(({ c, hh }) => `<div class="row">${clientAv(c)}<div class="grow"><a class="title" href="#clients-${esc(c.id)}">${esc(c.name)}</a><div class="small muted">${esc(hh.signals.map(s => s.label).join(", ") || "No issues")}</div></div>${healthHTML(hh)}</div>`).join("")}</div>` : `<div class="empty">No active clients.</div>`;
      }
    }] : []
  });
  RW.register({
    id: "invoices", title: "Invoices", icon: I.invoices, group: "Clients", order: 90, adminOnly: true, render: vInvoices,
    badge: () => Object.values(S.invoices).filter(i => invoiceStatus(i) === "Overdue").length,
    alerts: ctx => {
      const out = [];
      Object.values(S.invoices).filter(i => invoiceStatus(i) === "Overdue").forEach(i => out.push({ level: "danger", text: `Invoice overdue: ${clientName(i.clientId) || "client"}, ${monthLabel(i.month)} (${fmtINR(i.amount)})`, date: i.dueDate, href: "#invoices" }));
      const month = ctx.today.slice(0, 7), day = Number(ctx.today.slice(8));
      ctx.clients.filter(c => isLive(c) && retainerOf(c) > 0 && billingDayOf(c) && day >= billingDayOf(c) && !Object.values(S.invoices).some(i => i.clientId === c.id && i.month === month))
        .forEach(c => out.push({ level: "warn", text: `${c.name}: no invoice yet for ${monthLabel(month)} (billing day ${billingDayOf(c)})`, href: "#invoices" }));
      return out;
    }
  });
})();
