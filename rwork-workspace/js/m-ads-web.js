"use strict";
/* =====================================================================
   Ads campaigns & Websites tracker.
   Collections:
     campaigns            one doc per campaign (admin writes, everyone reads)
     adstats              ONE doc per campaign per month: adstats/<campaignId>_<YYYY-MM>
                          {campaignId, month, spend, impressions, clicks, leads, conversions,
                           revenue, updatedBy, updatedAt}   (Contributors write: performance team logs numbers)
     websites             one doc per site (admin writes, everyone reads). No credentials, ever.
     webchecks            webchecks/<siteId> {items:[{text, done, doneBy, doneAt}]}
                          launch checklist; Contributors write so the dev team can tick items.
   Views: #ads (campaigns), #ads-clients (per-client summary), #ads-<campaignId> (detail)
          #websites (sites), #websites-renewals (90-day timeline), #websites-<siteId> (detail)
   ===================================================================== */
(function () {
  const U = RW.ui, D = RW.date;
  const { esc, field, fv, opts, empOpts, clientOpts, pill, tableHTML, tabsHTML, fmtINR, safeUrl, csvCopy, num } = U;

  const PLATFORMS = ["Meta", "Google Search", "Google Display", "YouTube", "LinkedIn", "Other"];
  const OBJECTIVES = ["Leads", "Traffic", "Sales", "Awareness", "App installs"];
  const C_STATUSES = ["Draft", "Live", "Paused", "Ended"];
  const W_TYPES = ["Corporate", "E-commerce", "Landing page", "Blog", "Microsite"];
  const W_PLATFORMS = ["WordPress", "Shopify", "Webflow", "Custom", "Wix", "Other"];
  const W_STATUSES = ["Planning", "Design", "Development", "Content", "QA", "Live", "Maintenance"];
  const W_PLANS = ["None", "Basic", "Standard", "Premium"];
  const RENEWALS = [["domainRenewal", "Domain renewal"], ["hostingRenewal", "Hosting renewal"], ["sslExpiry", "SSL certificate expiry"]];
  const LAUNCH_CHECKLIST = ["Domain connected and DNS verified", "SSL certificate active (https)", "Mobile and tablet layout checked", "Page speed tested (aim for 80+)",
    "Meta titles and descriptions set", "Google Analytics (GA4) installed", "Search Console verified and sitemap submitted", "Contact forms tested end to end",
    "Favicon and social share preview", "Backups configured", "Client sign-off received"];
  const METRICS = [["spend", "Spend (₹)"], ["impressions", "Impressions"], ["clicks", "Clicks"], ["leads", "Leads"], ["conversions", "Conversions"], ["revenue", "Revenue (₹)"]];

  const NUM = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  const fmtN = v => (Number.isFinite(v) ? NUM.format(v) : "—");
  const fmtPct = v => (v === null || !Number.isFinite(v) ? "—" : (Math.round(v * 1000) / 10).toFixed(1) + "%");
  const fmtMoney = v => (v === null || !Number.isFinite(v) ? "—" : fmtINR(Math.round(v)));
  const fmtX = v => (v === null || !Number.isFinite(v) ? "—" : (Math.round(v * 100) / 100).toFixed(2) + "×");
  const pad = n => String(n).padStart(2, "0");
  const thisMonth = () => D.today().slice(0, 7);
  const dim = ym => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
  const monthEnd = ym => ym + "-" + pad(dim(ym));
  const idOK = s => /^[A-Za-z0-9_\-.~:@+]+$/.test(String(s || ""));

  /* ---------------- pure logic (exposed for tests) ---------------- */
  const div = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : null);
  function kpis(st) {
    const s = st || {};
    const spend = num(s.spend, 0), impressions = num(s.impressions, 0), clicks = num(s.clicks, 0),
      leads = num(s.leads, 0), conversions = num(s.conversions, 0), revenue = num(s.revenue, 0);
    return { spend, impressions, clicks, leads, conversions, revenue,
      ctr: div(clicks, impressions), cpc: div(spend, clicks), cpl: div(spend, leads),
      cvr: div(conversions, clicks), roas: div(revenue, spend) };
  }
  function sumStats(list) {
    const t = { spend: 0, impressions: 0, clicks: 0, leads: 0, conversions: 0, revenue: 0 };
    list.forEach(s => { if (s) METRICS.forEach(([k]) => { t[k] += num(s[k], 0); }); });
    return t;
  }
  /* Budget pacing for one campaign in month ym, as of `today`.
     Expected spend = monthly budget × fraction of the campaign's active days in that month that have elapsed. */
  function pacing(c, spend, ym, today) {
    const budget = num(c && c.monthlyBudget, 0);
    spend = num(spend, 0);
    if (!(budget > 0)) return null;
    const mS = ym + "-01", mE = monthEnd(ym);
    const ws = D.valid(c.startDate) && c.startDate > mS ? c.startDate : mS;
    const we = D.valid(c.endDate) && c.endDate < mE ? c.endDate : mE;
    const used = spend / budget;
    if (we < ws) return { budget, spend, used, expected: 0, frac: 0, pace: null, state: spend > budget ? "overbudget" : "inactive" };
    const total = D.daysBetween(ws, we) + 1;
    const elapsed = today < ws ? 0 : today > we ? total : D.daysBetween(ws, today) + 1;
    const frac = elapsed / total, expected = budget * frac;
    const pace = expected > 0 ? spend / expected : (spend > 0 ? Infinity : null);
    let state = "ok";
    if (spend > budget) state = "overbudget";
    else if (pace !== null && pace > 1.1) state = "over";
    else if (pace !== null && pace < 0.8 && frac >= 0.2 && c.status === "Live") state = "under";
    return { budget, spend, used, expected, frac, pace, state };
  }
  function runsInMonth(c, ym) {
    const mS = ym + "-01", mE = monthEnd(ym);
    return !(D.valid(c.startDate) && c.startDate > mE) && !(D.valid(c.endDate) && c.endDate < mS);
  }
  function renewalItems(site) {
    return RENEWALS.filter(([k]) => D.valid(site[k])).map(([k, label]) => ({ key: k, label, date: site[k], site }));
  }
  function renewalState(date, today) {
    const d = D.daysBetween(today, date);
    return { days: d, level: d < 0 ? "danger" : d <= 30 ? "warn" : "" };
  }
  RW.adsweb = { kpis, pacing, sumStats, runsInMonth, renewalItems, renewalState };

  /* ---------------- data access ---------------- */
  const campaigns = () => Object.values(RW.map.campaigns || {}).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const statFor = (cid, ym) => (RW.map.adstats || {})[cid + "_" + ym] || null;
  const statsOf = cid => (RW.state.adstats || []).filter(s => s.campaignId === cid).sort((a, b) => String(b.month).localeCompare(String(a.month)));
  const sites = () => Object.values(RW.map.websites || {}).sort((a, b) => String(a.url).localeCompare(String(b.url)));
  const checksOf = sid => { const d = (RW.map.webchecks || {})[sid]; return d && Array.isArray(d.items) ? d.items : []; };
  const canLog = ctx => ctx.canWrite && (ctx.isAdmin || !!ctx.me);
  const host = u => String(u || "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
  const siteLink = (u, label) => { const s = safeUrl(u); return s ? `<a href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(label || host(u))}</a>` : esc(label || u || "—"); };

  /* ---------------- styles ---------------- */
  RW.addStyle(`
    .ads-bar{position:relative;height:8px;border-radius:99px;background:var(--line);overflow:hidden;min-width:90px}
    .ads-bar>i{position:absolute;left:0;top:0;bottom:0;border-radius:99px;background:var(--accent)}
    .ads-bar>b{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--ink);opacity:.55}
    .ads-bar.over>i,.ads-bar.overbudget>i{background:var(--bad)} .ads-bar.under>i{background:var(--warn)}
    .ads-pace{display:flex;flex-direction:column;gap:4px;min-width:120px} .ads-pace .small{white-space:nowrap}
    .ads-month{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .ads-month input{width:auto}
    .ads-kpis td.num,.ads-kpis th{white-space:nowrap}
    .web-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:14px}
    .web-card{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--surface);cursor:pointer;text-align:left;font:inherit;color:inherit}
    .web-card:hover{border-color:var(--accent)} .web-card .t{font-weight:600;word-break:break-all}
    .web-note{font-size:.85rem;color:var(--muted)}
    .web-tl-month{font-weight:600;margin:6px 0 2px}
    .web-check{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)}
    .web-check:last-child{border-bottom:0} .web-check.done span{text-decoration:line-through;color:var(--muted)}
    .web-check .grow{flex:1}
  `, "adsweb");

  /* ---------------- icons ---------------- */
  const IC = {
    ads: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14"/></svg>',
    web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>'
  };

  /* =====================================================================
     ADS
     ===================================================================== */
  let adsMonth = null;
  const getMonth = () => (adsMonth && /^\d{4}-\d{2}$/.test(adsMonth) ? adsMonth : thisMonth());
  const cStatusKind = s => ({ Live: "good", Paused: "warn", Ended: "", Draft: "accent" }[s] || "");
  const paceLabel = p => !p ? "No budget" : p.state === "overbudget" ? "Over budget" : p.state === "over" ? "Overspending" : p.state === "under" ? "Underspending" : p.state === "inactive" ? "Not running" : "On pace";

  function paceHTML(p) {
    if (!p) return `<span class="muted small">No budget set</span>`;
    const w = Math.min(100, Math.round(p.used * 100)), mark = Math.min(100, Math.round(p.frac * 100));
    const kind = p.state === "ok" ? "good" : p.state === "under" ? "warn" : p.state === "inactive" ? "" : "bad";
    return `<div class="ads-pace"><div class="ads-bar ${esc(p.state)}" title="Spent ${esc(fmtMoney(p.spend))} of ${esc(fmtMoney(p.budget))}; expected by now ${esc(fmtMoney(p.expected))}"><i style="width:${w}%"></i><b style="left:${mark}%"></b></div>
      <span class="small">${esc(Math.round(p.used * 100) + "% of budget")} · ${pill(paceLabel(p), kind)}</span></div>`;
  }

  function campaignForm(c, ctx) {
    const x = c || { status: "Draft", platform: "Meta", objective: "Leads" };
    U.modal({
      title: c ? "Edit campaign" : "New campaign", wide: true, submitLabel: c ? "Save changes" : "Create campaign",
      body: `<div class="fgrid">
        ${field({ label: "Campaign name", name: "name", value: x.name, required: true, placeholder: "e.g. Diwali lead gen" })}
        ${field({ label: "Client", name: "clientId", type: "select", optionsHtml: clientOpts(x.clientId, "Choose a client") })}
        ${field({ label: "Platform", name: "platform", options: PLATFORMS, value: x.platform })}
        ${field({ label: "Objective", name: "objective", options: OBJECTIVES, value: x.objective })}
        ${field({ label: "Status", name: "status", options: C_STATUSES, value: x.status })}
        ${field({ label: "Owner", name: "ownerId", type: "select", optionsHtml: empOpts(x.ownerId, "Not assigned") })}
        ${field({ label: "Start date", name: "startDate", type: "date", value: x.startDate })}
        ${field({ label: "End date", name: "endDate", type: "date", value: x.endDate, hint: "Leave empty for always-on campaigns." })}
        ${field({ label: "Monthly budget (₹)", name: "monthlyBudget", type: "number", min: 0, step: 1, value: x.monthlyBudget ?? "" })}
        ${field({ label: "Landing page URL", name: "landingUrl", type: "url", value: x.landingUrl, placeholder: "https://" })}
      </div>${field({ label: "Notes", name: "notes", type: "textarea", value: x.notes, placeholder: "Audience, creatives, targeting notes…" })}`,
      onSubmit: async form => {
        const name = fv(form, "name"); if (!name) { U.toast("Enter a campaign name.", "bad"); return false; }
        const clientId = fv(form, "clientId"); if (!clientId) { U.toast("Choose the client.", "bad"); return false; }
        const sd = fv(form, "startDate"), ed = fv(form, "endDate");
        if (sd && ed && ed < sd) { U.toast("The end date is before the start date.", "bad"); return false; }
        const b = fv(form, "monthlyBudget"); if (b !== "" && !(Number(b) >= 0)) { U.toast("Enter a valid budget.", "bad"); return false; }
        const lu = fv(form, "landingUrl"); if (lu && !safeUrl(lu)) { U.toast("The landing page needs a full address starting with https://", "bad"); return false; }
        const data = { name, clientId, platform: fv(form, "platform"), objective: fv(form, "objective"), status: fv(form, "status"), ownerId: fv(form, "ownerId"),
          startDate: sd, endDate: ed, monthlyBudget: b === "" ? 0 : Number(b), landingUrl: lu, notes: fv(form, "notes"),
          createdAt: c ? (c.createdAt || new Date().toISOString()) : new Date().toISOString(), updatedAt: new Date().toISOString() };
        return c ? RW.write.set("campaigns/" + c.id, data, "Campaign saved.") : !!(await RW.write.add("campaigns", data, "Campaign created."));
      }
    });
  }

  function logForm(c, ym) {
    const ctx = RW.ctx;
    const cur = statFor(c.id, ym) || {};
    U.modal({
      title: `Log numbers: ${c.name}`, submitLabel: "Save numbers",
      body: `<p class="hint" style="margin:0">Enter the month-to-date totals from the ad platform. Saving replaces the numbers for that month.</p>
        <div class="fgrid">${field({ label: "Month", name: "month", type: "month", value: ym, required: true })}
        ${METRICS.map(([k, l]) => field({ label: l, name: k, type: "number", min: 0, step: k === "spend" || k === "revenue" ? "0.01" : 1, value: cur[k] ?? "" })).join("")}</div>`,
      onMount: form => {
        form.elements.month.addEventListener("change", () => {
          const m = fv(form, "month"); if (!/^\d{4}-\d{2}$/.test(m)) return;
          const s = statFor(c.id, m) || {}; METRICS.forEach(([k]) => { form.elements[k].value = s[k] ?? ""; });
        });
      },
      onSubmit: async form => {
        const m = fv(form, "month"); if (!/^\d{4}-\d{2}$/.test(m)) { U.toast("Choose a month.", "bad"); return false; }
        if (m > thisMonth()) { U.toast("You can't log numbers for a future month.", "bad"); return false; }
        const data = { campaignId: c.id, clientId: c.clientId || "", month: m, updatedBy: (ctx.me && ctx.me.id) || "", updatedByUser: ctx.viewerId || "", updatedAt: new Date().toISOString() };
        for (const [k, l] of METRICS) {
          const v = fv(form, k);
          if (v !== "" && !(Number(v) >= 0)) { U.toast(`${l} must be a positive number.`, "bad"); return false; }
          data[k] = v === "" ? 0 : Number(v);
        }
        if (data.clicks > data.impressions && data.impressions > 0) { U.toast("Clicks can't be more than impressions.", "bad"); return false; }
        if (!idOK(c.id)) return false;
        return RW.write.set(`adstats/${c.id}_${m}`, data, "Numbers saved.");
      }
    });
  }

  function campaignRows(ctx, ym) {
    const f = RW.S.f;
    return campaigns().filter(c =>
      (!f.adsClient || c.clientId === f.adsClient) && (!f.adsPlatform || c.platform === f.adsPlatform) && (!f.adsStatus || c.status === f.adsStatus) &&
      (f.adsAll || runsInMonth(c, ym)) &&
      (!f.adsSearch || (String(c.name) + " " + ctx.clientName(c.clientId)).toLowerCase().includes(String(f.adsSearch).toLowerCase())));
  }

  function kpiTable(ctx, list, ym, opt = {}) {
    const today = ctx.today;
    const cols = [
      { label: "Campaign", html: c => `<a href="#ads-${esc(c.id)}"><strong>${esc(c.name)}</strong></a>${opt.noClient ? "" : `<div class="small muted">${esc(ctx.clientName(c.clientId) || "No client")}</div>`}` },
      { label: "Platform", text: c => c.platform || "—" },
      { label: "Status", html: c => pill(c.status || "Draft", cStatusKind(c.status)) },
      { label: "Budget", cls: "num", text: c => fmtMoney(num(c.monthlyBudget, 0) || null) },
      { label: "Spend", cls: "num", text: c => fmtMoney(kpis(statFor(c.id, ym)).spend) },
      { label: "Pacing", html: c => paceHTML(pacing(c, kpis(statFor(c.id, ym)).spend, ym, today)) },
      { label: "Leads", cls: "num", text: c => fmtN(kpis(statFor(c.id, ym)).leads) },
      { label: "CPL", cls: "num", text: c => fmtMoney(kpis(statFor(c.id, ym)).cpl) },
      { label: "CTR", cls: "num", text: c => fmtPct(kpis(statFor(c.id, ym)).ctr) },
      { label: "CPC", cls: "num", text: c => fmtMoney(kpis(statFor(c.id, ym)).cpc) },
      { label: "ROAS", cls: "num", text: c => fmtX(kpis(statFor(c.id, ym)).roas) }
    ];
    if (!opt.noActions) cols.push({ label: "", html: c => {
      let b = "";
      if (canLog(ctx)) b += `<button class="btn sm" data-act="ads.log" data-id="${esc(c.id)}">Log numbers</button> `;
      if (ctx.adminWrite) b += `<button class="btn ghost sm" data-act="ads.edit" data-id="${esc(c.id)}">Edit</button>`;
      return b;
    } });
    return `<div class="ads-kpis">${tableHTML(cols, list, { empty: opt.empty || "No campaigns for this month." })}</div>`;
  }

  function monthPicker(ym) {
    return `<div class="ads-month"><button class="btn ghost sm" data-act="ads.prev" aria-label="Previous month">‹</button>
      <input type="month" id="adsMonth" data-change="ads.month" value="${esc(ym)}" aria-label="Month">
      <button class="btn ghost sm" data-act="ads.next" aria-label="Next month"${ym >= thisMonth() ? " disabled" : ""}>›</button>
      ${ym !== thisMonth() ? `<button class="btn ghost sm" data-act="ads.thisMonth">This month</button>` : ""}</div>`;
  }

  function adsTotals(list, ym) {
    const st = sumStats(list.map(c => statFor(c.id, ym)));
    const k = kpis(st);
    const budget = list.reduce((a, c) => a + num(c.monthlyBudget, 0), 0);
    return { k, budget };
  }

  function renderAds(el, ctx, route) {
    const ym = getMonth();
    const sub = route.sub || "";
    if (sub && sub !== "clients") return renderCampaign(el, ctx, sub, ym);
    const tab = sub === "clients" ? "clients" : "campaigns";
    let html = tabsHTML([["campaigns", "Campaigns"], ["clients", "By client"]], tab, "ads.tab");
    const all = campaigns();
    const actions = (ctx.adminWrite ? `<button class="btn primary" data-act="ads.new">New campaign</button> ` : "") +
      (all.length ? `<button class="btn" data-act="ads.csv">Copy CSV</button>` : "");
    if (!all.length) {
      html += `<div class="start"><h3>No ad campaigns yet</h3><p class="muted">${ctx.adminWrite
        ? "Add each client's campaigns on Meta, Google or LinkedIn with a monthly budget. The performance team then logs spend, clicks and leads every week, and Rwork works out CPL, ROAS and budget pacing."
        : "When Operations adds your clients' ad campaigns, you'll log spend and results here."}</p>
        ${ctx.adminWrite ? `<button class="btn primary" data-act="ads.new">New campaign</button>` : ""}</div>`;
      return { html, actions };
    }
    if (!ctx.me && !ctx.isAdmin) html += `<div class="calc warn">Your account isn't linked to an employee profile yet, so you can view campaigns but not log numbers. Ask HR to link it.</div>`;
    const f = RW.S.f;
    if (tab === "campaigns") {
      const list = campaignRows(ctx, ym);
      const t = adsTotals(list, ym);
      const flagged = list.map(c => pacing(c, kpis(statFor(c.id, ym)).spend, ym, ctx.today)).filter(p => p && (p.state === "over" || p.state === "overbudget")).length;
      html += `<div class="filters">${monthPicker(ym)}
        <input type="search" placeholder="Search campaigns" data-input="filter" data-key="adsSearch" id="adsSearch" data-keep value="${esc(f.adsSearch || "")}">
        <select data-change="filter" data-key="adsClient" aria-label="Client">${clientOpts(f.adsClient || "", "All clients")}</select>
        <select data-change="filter" data-key="adsPlatform" aria-label="Platform">${opts(PLATFORMS, f.adsPlatform || "", "All platforms")}</select>
        <select data-change="filter" data-key="adsStatus" aria-label="Status">${opts(C_STATUSES, f.adsStatus || "", "All statuses")}</select>
        <label class="check"><input type="checkbox" data-change="filterCheck" data-key="adsAll"${f.adsAll ? " checked" : ""}> Include campaigns not running this month</label></div>
        <div class="tiles">
          <div class="tile"><div class="v">${esc(fmtMoney(t.k.spend))}</div><div class="l">Spend in ${esc(D.monthLabel(ym))}</div></div>
          <div class="tile"><div class="v">${esc(t.budget ? Math.round(t.k.spend / t.budget * 100) + "%" : "—")}</div><div class="l">of ${esc(fmtMoney(t.budget || null))} budget</div></div>
          <div class="tile"><div class="v">${esc(fmtN(t.k.leads))}</div><div class="l">Leads · CPL ${esc(fmtMoney(t.k.cpl))}</div></div>
          <div class="tile"><div class="v">${esc(fmtX(t.k.roas))}</div><div class="l">ROAS</div></div>
          <div class="tile${flagged ? " alert" : ""}"><div class="v">${flagged}</div><div class="l">Overspending</div></div>
        </div>
        <div class="panel"><div class="panel-head"><h3>Campaigns · ${esc(D.monthLabel(ym))}</h3></div>${kpiTable(ctx, list, ym, { empty: "No campaigns match. Try another month or tick “Include campaigns not running this month”." })}</div>`;
    } else {
      const rows = ctx.clients.map(cl => {
        const cs = campaigns().filter(c => c.clientId === cl.id && runsInMonth(c, ym));
        return { cl, cs, t: adsTotals(cs, ym) };
      }).filter(r => r.cs.length);
      html += `<div class="filters">${monthPicker(ym)}</div>
        <div class="panel"><div class="panel-head"><h3>Ads by client · ${esc(D.monthLabel(ym))}</h3></div>${tableHTML([
          { label: "Client", html: r => `<a href="#clients-${esc(r.cl.id)}"><strong>${esc(r.cl.name)}</strong></a>` },
          { label: "Campaigns", cls: "num", text: r => r.cs.length },
          { label: "Budget", cls: "num", text: r => fmtMoney(r.t.budget || null) },
          { label: "Spend", cls: "num", text: r => fmtMoney(r.t.k.spend) },
          { label: "Used", html: r => r.t.budget ? `<div class="ads-bar${r.t.k.spend > r.t.budget ? " overbudget" : ""}"><i style="width:${Math.min(100, Math.round(r.t.k.spend / r.t.budget * 100))}%"></i></div>` : "—" },
          { label: "Leads", cls: "num", text: r => fmtN(r.t.k.leads) },
          { label: "CPL", cls: "num", text: r => fmtMoney(r.t.k.cpl) },
          { label: "Conversions", cls: "num", text: r => fmtN(r.t.k.conversions) },
          { label: "ROAS", cls: "num", text: r => fmtX(r.t.k.roas) }
        ], rows, { empty: "No campaigns ran this month." })}</div>`;
    }
    return { html, actions };
  }

  function renderCampaign(el, ctx, cid, ym) {
    const c = (RW.map.campaigns || {})[cid];
    if (!c) return { html: `<div class="empty">This campaign doesn't exist any more. <a href="#ads">Back to campaigns</a></div>`, title: "Campaign" };
    const hist = statsOf(c.id);
    const cur = kpis(statFor(c.id, thisMonth()));
    const p = pacing(c, cur.spend, thisMonth(), ctx.today);
    const actions = (canLog(ctx) ? `<button class="btn primary" data-act="ads.log" data-id="${esc(c.id)}">Log numbers</button> ` : "") +
      (ctx.adminWrite ? `<button class="btn" data-act="ads.edit" data-id="${esc(c.id)}">Edit</button> <button class="btn ghost danger" data-act="ads.del" data-id="${esc(c.id)}">Delete</button>` : "");
    const lu = safeUrl(c.landingUrl);
    const html = `<div><a href="#ads">← All campaigns</a></div>
      <div class="panel"><div class="panel-head"><h3>${esc(c.name)}</h3>${pill(c.status || "Draft", cStatusKind(c.status))}</div>
        <div class="fgrid">
          <div><span class="muted small">Client</span><div>${c.clientId && ctx.clientById[c.clientId] ? `<a href="#clients-${esc(c.clientId)}">${esc(ctx.clientName(c.clientId))}</a>` : "—"}</div></div>
          <div><span class="muted small">Platform · objective</span><div>${esc(c.platform || "—")} · ${esc(c.objective || "—")}</div></div>
          <div><span class="muted small">Dates</span><div>${esc(D.valid(c.startDate) ? D.fmt(c.startDate) : "—")} → ${esc(D.valid(c.endDate) ? D.fmt(c.endDate) : "Ongoing")}</div></div>
          <div><span class="muted small">Owner</span><div>${esc(c.ownerId ? ctx.empName(c.ownerId) : "Not assigned")}</div></div>
          <div><span class="muted small">Monthly budget</span><div>${esc(fmtMoney(num(c.monthlyBudget, 0) || null))}</div></div>
          <div><span class="muted small">Landing page</span><div>${lu ? `<a href="${esc(lu)}" target="_blank" rel="noopener noreferrer">${esc(host(lu))}</a>` : "—"}</div></div>
        </div>
        ${c.notes ? `<p style="white-space:pre-wrap;margin:12px 0 0">${esc(c.notes)}</p>` : ""}
      </div>
      <div class="panel"><div class="panel-head"><h3>This month's pacing</h3></div>${paceHTML(p)}</div>
      <div class="panel"><div class="panel-head"><h3>Monthly results</h3></div>${tableHTML([
        { label: "Month", text: s => D.monthLabel(s.month) },
        { label: "Spend", cls: "num", text: s => fmtMoney(kpis(s).spend) },
        { label: "Impressions", cls: "num", text: s => fmtN(kpis(s).impressions) },
        { label: "Clicks", cls: "num", text: s => fmtN(kpis(s).clicks) },
        { label: "CTR", cls: "num", text: s => fmtPct(kpis(s).ctr) },
        { label: "CPC", cls: "num", text: s => fmtMoney(kpis(s).cpc) },
        { label: "Leads", cls: "num", text: s => fmtN(kpis(s).leads) },
        { label: "CPL", cls: "num", text: s => fmtMoney(kpis(s).cpl) },
        { label: "Conv. rate", cls: "num", text: s => fmtPct(kpis(s).cvr) },
        { label: "ROAS", cls: "num", text: s => fmtX(kpis(s).roas) },
        { label: "Updated", text: s => (s.updatedBy ? ctx.empName(s.updatedBy) + ", " : "") + (s.updatedAt ? D.fmt(String(s.updatedAt).slice(0, 10)) : "") }
      ], hist, { empty: "No numbers logged yet." })}</div>`;
    return { html, actions, title: c.name };
  }

  Object.assign(RW.actions, {
    "ads.new": () => campaignForm(null, RW.ctx),
    "ads.edit": el => { const c = (RW.map.campaigns || {})[el.dataset.id]; if (c) campaignForm(c, RW.ctx); },
    "ads.log": el => { const c = (RW.map.campaigns || {})[el.dataset.id]; if (c) logForm(c, getMonth()); },
    "ads.del": async el => {
      const c = (RW.map.campaigns || {})[el.dataset.id]; if (!c) return;
      if (!(await U.confirm(`Delete the campaign “${c.name}”? Its logged numbers are deleted too.`, "Delete campaign"))) return;
      const ok = await RW.write.del("campaigns/" + c.id, "Campaign deleted.");
      if (!ok) return;
      for (const s of statsOf(c.id)) { if (!(await RW.write.del("adstats/" + s.id))) break; }
      RW.go("ads");
    },
    "ads.tab": el => RW.go("ads", el.dataset.tab === "clients" ? "clients" : ""),
    "ads.prev": () => { adsMonth = D.addMonths(getMonth(), -1); RW.render(); },
    "ads.next": () => { const n = D.addMonths(getMonth(), 1); if (n <= thisMonth()) { adsMonth = n; RW.render(); } },
    "ads.thisMonth": () => { adsMonth = null; RW.render(); },
    "ads.csv": () => {
      const ym = getMonth(), ctx = RW.ctx;
      const rows = [["Month", "Client", "Campaign", "Platform", "Objective", "Status", "Budget", "Spend", "Impressions", "Clicks", "CTR %", "CPC", "Leads", "CPL", "Conversions", "Revenue", "ROAS"]];
      campaignRows(ctx, ym).forEach(c => {
        const k = kpis(statFor(c.id, ym)), r = v => (v === null ? "" : Math.round(v * 100) / 100);
        rows.push([ym, ctx.clientName(c.clientId), c.name, c.platform, c.objective, c.status, num(c.monthlyBudget, 0), k.spend, k.impressions, k.clicks, k.ctr === null ? "" : r(k.ctr * 100), r(k.cpc), k.leads, r(k.cpl), k.conversions, k.revenue, r(k.roas)]);
      });
      csvCopy(rows, "Ad campaigns");
    }
  });
  RW.onChange("ads.month", el => { if (/^\d{4}-\d{2}$/.test(el.value) && el.value <= thisMonth()) { adsMonth = el.value; RW.render(); } else RW.render(); });

  RW.register({
    id: "ads", title: "Ads", icon: IC.ads, group: "Clients", order: 30,
    collections: ["campaigns", { path: "adstats", key: "adstats", where: () => [["month", ">=", D.addMonths(D.today().slice(0, 7), -12)]] }],
    render: renderAds,
    badge: ctx => { const ym = thisMonth(); return campaigns().filter(c => c.status === "Live" && (p => p && (p.state === "over" || p.state === "overbudget"))(pacing(c, kpis(statFor(c.id, ym)).spend, ym, ctx.today))).length; },
    alerts: ctx => {
      const out = [], ym = thisMonth();
      campaigns().forEach(c => {
        if (c.status === "Live" && D.valid(c.endDate)) {
          const d = D.daysBetween(ctx.today, c.endDate);
          if (d >= 0 && d <= 7) out.push({ level: "warn", text: `Ad campaign ends ${d === 0 ? "today" : `in ${d} day${d === 1 ? "" : "s"}`}: ${c.name} (${ctx.clientName(c.clientId) || "no client"})`, date: c.endDate, href: "#ads-" + c.id });
          else if (d < 0) out.push({ level: "warn", text: `Ad campaign past its end date but still Live: ${c.name}`, date: c.endDate, href: "#ads-" + c.id });
        }
        if (c.status === "Live") {
          const p = pacing(c, kpis(statFor(c.id, ym)).spend, ym, ctx.today);
          if (p && p.state === "overbudget") out.push({ level: "danger", text: `Ad spend over the monthly budget: ${c.name} (${fmtMoney(p.spend)} of ${fmtMoney(p.budget)})`, href: "#ads-" + c.id });
        }
      });
      return out;
    },
    dashboardWidgets: ctx => {
      if (!campaigns().length) return [];
      return [{
        title: "Ads this month", href: "#ads", linkLabel: "All campaigns", order: 40,
        render(body) {
          const ym = thisMonth();
          const live = campaigns().filter(c => runsInMonth(c, ym) && c.status !== "Draft");
          const t = adsTotals(live, ym);
          const ranked = live.map(c => ({ c, k: kpis(statFor(c.id, ym)) })).filter(r => r.k.cpl !== null).sort((a, b) => a.k.cpl - b.k.cpl).slice(0, 5);
          const pct = t.budget ? Math.min(100, Math.round(t.k.spend / t.budget * 100)) : 0;
          body.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><strong>${esc(fmtMoney(t.k.spend))}</strong><span class="muted small">of ${esc(fmtMoney(t.budget || null))} budget · ${esc(fmtN(t.k.leads))} leads</span></div>
            <div class="ads-bar${t.budget && t.k.spend > t.budget ? " overbudget" : ""}" style="margin:8px 0 12px"><i style="width:${pct}%"></i></div>
            ${ranked.length ? `<div class="small muted">Lowest cost per lead</div><div class="list">${ranked.map(r => `<div class="row"><div class="grow"><a href="#ads-${esc(r.c.id)}">${esc(r.c.name)}</a> <span class="muted small">${esc(ctx.clientName(r.c.clientId))}</span></div><span class="num">${esc(fmtMoney(r.k.cpl))}</span></div>`).join("")}</div>` : `<div class="muted small">No leads logged this month yet.</div>`}`;
        }
      }];
    }
  });

  RW.registerClientTab({
    id: "ads", title: "Ads", order: 30,
    render(el, client, ctx) {
      const ym = thisMonth();
      const cs = campaigns().filter(c => c.clientId === client.id);
      const running = cs.filter(c => runsInMonth(c, ym));
      const t = adsTotals(running, ym);
      el.innerHTML = `<div class="tiles"><div class="tile"><div class="v">${esc(fmtMoney(t.k.spend))}</div><div class="l">Spend this month</div></div>
          <div class="tile"><div class="v">${esc(fmtMoney(t.budget || null))}</div><div class="l">Budget</div></div>
          <div class="tile"><div class="v">${esc(fmtN(t.k.leads))}</div><div class="l">Leads · CPL ${esc(fmtMoney(t.k.cpl))}</div></div>
          <div class="tile"><div class="v">${esc(fmtX(t.k.roas))}</div><div class="l">ROAS</div></div></div>
        <div class="panel"><div class="panel-head"><h3>Campaigns · ${esc(D.monthLabel(ym))}</h3>${ctx.adminWrite ? `<button class="btn sm" data-act="ads.newFor" data-client="${esc(client.id)}">New campaign</button>` : ""}</div>
        ${kpiTable(ctx, running, ym, { noClient: true, empty: cs.length ? "No campaigns running this month." : "No ad campaigns for this client yet." })}</div>`;
    }
  });
  // "New campaign" from a client tab: prefill the client
  RW.action("ads.newFor", el => {
    campaignForm(null, RW.ctx);
    const f = document.querySelector("#modalRoot form");
    if (f && f.elements.clientId) f.elements.clientId.value = el.dataset.client || "";
  });

  RW.registerHealthSignal((client, ctx) => {
    const ym = thisMonth(), out = [];
    const live = campaigns().filter(c => c.clientId === client.id && c.status === "Live" && runsInMonth(c, ym));
    const over = live.filter(c => { const p = pacing(c, kpis(statFor(c.id, ym)).spend, ym, ctx.today); return p && (p.state === "over" || p.state === "overbudget"); });
    if (over.length) out.push({ label: `${over.length} ad campaign${over.length === 1 ? "" : "s"} overspending`, level: over.some(c => pacing(c, kpis(statFor(c.id, ym)).spend, ym, ctx.today).state === "overbudget") ? "danger" : "warn" });
    const started = live.filter(c => !D.valid(c.startDate) || c.startDate <= ctx.today);
    const missing = started.filter(c => !statFor(c.id, ym));
    if (missing.length) out.push({ label: `${missing.length} live campaign${missing.length === 1 ? " has" : "s have"} no numbers this month`, level: "warn" });
    return out;
  });

  /* =====================================================================
     WEBSITES
     ===================================================================== */
  const wStatusKind = s => ({ Live: "good", Maintenance: "accent", QA: "warn", Planning: "" }[s] || "");
  const viewMode = () => RW.prefs.get("web.view", "table") === "cards" ? "cards" : "table";
  const nextRenewal = (site, today) => renewalItems(site).sort((a, b) => a.date.localeCompare(b.date)).find(x => x.date >= today) || null;
  const expired = (site, today) => renewalItems(site).filter(x => x.date < today);
  function renewalCell(site, today) {
    const ex = expired(site, today);
    if (ex.length) return pill(`${ex[0].label.replace(/ (renewal|expiry)$/i, "")} expired ${D.fmtShort(ex[0].date)}`, "bad");
    const n = nextRenewal(site, today);
    if (!n) return `<span class="muted">—</span>`;
    const r = renewalState(n.date, today);
    return `${esc(n.label.replace(/ (renewal|expiry)$/i, ""))} · ${r.level ? pill(D.fmtShort(n.date), "warn") : esc(D.fmtShort(n.date))}`;
  }
  function checkProgress(sid) { const it = checksOf(sid); const d = it.filter(i => i.done).length; return { total: it.length, done: d, pct: it.length ? Math.round(d / it.length * 100) : 0 }; }

  function siteForm(site) {
    const x = site || { type: "Corporate", platform: "WordPress", status: "Planning", maintenancePlan: "None" };
    U.modal({
      title: site ? "Edit website" : "Add website", wide: true, submitLabel: site ? "Save changes" : "Add website",
      body: `<div class="calc">Keep logins and passwords in your password manager, not in Rwork.</div>
      <div class="fgrid">
        ${field({ label: "Website address", name: "url", type: "url", value: x.url, required: true, placeholder: "https://example.com" })}
        ${field({ label: "Client", name: "clientId", type: "select", optionsHtml: clientOpts(x.clientId, "Choose a client") })}
        ${field({ label: "Type", name: "type", options: W_TYPES, value: x.type })}
        ${field({ label: "Platform", name: "platform", options: W_PLATFORMS, value: x.platform })}
        ${field({ label: "Status", name: "status", options: W_STATUSES, value: x.status })}
        ${field({ label: "Owner", name: "ownerId", type: "select", optionsHtml: empOpts(x.ownerId, "Not assigned") })}
        ${field({ label: "Domain registrar", name: "domainRegistrar", value: x.domainRegistrar, placeholder: "e.g. GoDaddy" })}
        ${field({ label: "Domain renewal date", name: "domainRenewal", type: "date", value: x.domainRenewal })}
        ${field({ label: "Hosting provider", name: "hostingProvider", value: x.hostingProvider, placeholder: "e.g. Hostinger, AWS" })}
        ${field({ label: "Hosting renewal date", name: "hostingRenewal", type: "date", value: x.hostingRenewal })}
        ${field({ label: "SSL expiry date", name: "sslExpiry", type: "date", value: x.sslExpiry })}
        ${field({ label: "Maintenance plan", name: "maintenancePlan", options: W_PLANS, value: x.maintenancePlan })}
        ${field({ label: "Go-live date", name: "goLiveDate", type: "date", value: x.goLiveDate })}
        ${field({ label: "Last backup", name: "lastBackup", type: "date", value: x.lastBackup })}
        ${field({ label: "Last updated (plugins/theme)", name: "lastUpdated", type: "date", value: x.lastUpdated })}
      </div>${field({ label: "Notes", name: "notes", type: "textarea", value: x.notes, placeholder: "Scope, pages, integrations… (no passwords)" })}`,
      onSubmit: async form => {
        let url = fv(form, "url");
        if (url && !/^[a-z]+:\/\//i.test(url)) url = "https://" + url;
        if (!safeUrl(url)) { U.toast("Enter the website address, e.g. https://example.com", "bad"); return false; }
        const clientId = fv(form, "clientId"); if (!clientId) { U.toast("Choose the client.", "bad"); return false; }
        const data = { url, clientId };
        ["type", "platform", "status", "ownerId", "domainRegistrar", "domainRenewal", "hostingProvider", "hostingRenewal", "sslExpiry", "maintenancePlan", "goLiveDate", "lastBackup", "lastUpdated", "notes"].forEach(k => { data[k] = fv(form, k); });
        if (/password|passwd|pwd\s*[:=]/i.test(data.notes)) { U.toast("Please don't store passwords in Rwork. Use your password manager.", "bad"); return false; }
        data.createdAt = site ? (site.createdAt || new Date().toISOString()) : new Date().toISOString();
        data.updatedAt = new Date().toISOString();
        if (site) return RW.write.set("websites/" + site.id, data, "Website saved.");
        const ref = await RW.write.add("websites", data, "Website added.");
        if (!ref) return false;
        if (ref.id) await RW.write.set("webchecks/" + ref.id, { siteId: ref.id, items: LAUNCH_CHECKLIST.map(t => ({ text: t, done: false })), updatedAt: new Date().toISOString() });
        return true;
      }
    });
  }

  function sitesFiltered(ctx) {
    const f = RW.S.f;
    return sites().filter(s => (!f.webClient || s.clientId === f.webClient) && (!f.webStatus || s.status === f.webStatus) &&
      (!f.webSearch || (String(s.url) + " " + ctx.clientName(s.clientId) + " " + (s.platform || "")).toLowerCase().includes(String(f.webSearch).toLowerCase())));
  }

  function sitesTable(ctx, list, opt = {}) {
    return tableHTML([
      { label: "Website", html: s => `<a href="#websites-${esc(s.id)}"><strong>${esc(host(s.url))}</strong></a>${opt.noClient ? "" : `<div class="small muted">${esc(ctx.clientName(s.clientId) || "No client")}</div>`}` },
      { label: "Type", text: s => s.type || "—" },
      { label: "Platform", text: s => s.platform || "—" },
      { label: "Status", html: s => pill(s.status || "Planning", wStatusKind(s.status)) },
      { label: "Owner", text: s => s.ownerId ? ctx.empName(s.ownerId) : "—" },
      { label: "Next renewal", html: s => renewalCell(s, ctx.today) },
      { label: "Maintenance", text: s => s.maintenancePlan || "None" },
      { label: "Launch checklist", html: s => { const p = checkProgress(s.id); return p.total ? `<div class="bar" title="${p.done} of ${p.total}"><i style="width:${p.pct}%"></i></div><span class="small muted">${p.done}/${p.total}</span>` : "—"; } }
    ], list, { empty: opt.empty || "No websites match." });
  }

  function sitesCards(ctx, list) {
    if (!list.length) return `<div class="empty">No websites match.</div>`;
    return `<div class="web-cards">${list.map(s => { const p = checkProgress(s.id); return `<button class="web-card" data-act="web.open" data-id="${esc(s.id)}">
      <div style="display:flex;justify-content:space-between;gap:8px"><span class="t">${esc(host(s.url))}</span>${pill(s.status || "Planning", wStatusKind(s.status))}</div>
      <div class="small muted">${esc(ctx.clientName(s.clientId) || "No client")} · ${esc(s.platform || "—")} · ${esc(s.type || "—")}</div>
      <div class="small">${renewalCell(s, ctx.today)}</div>
      ${p.total ? `<div class="bar"><i style="width:${p.pct}%"></i></div><div class="small muted">Launch checklist ${p.done}/${p.total}</div>` : ""}</button>`; }).join("")}</div>`;
  }

  function timelineItems(ctx, days) {
    const end = D.addDays(ctx.today, days);
    const items = [];
    sites().forEach(s => renewalItems(s).forEach(r => { if (r.date <= end) items.push(r); }));
    return items.sort((a, b) => a.date.localeCompare(b.date));
  }
  function timelineHTML(ctx, items) {
    if (!items.length) return `<div class="empty">No renewals in the next 90 days.</div>`;
    const over = items.filter(i => i.date < ctx.today), up = items.filter(i => i.date >= ctx.today);
    const row = i => { const r = renewalState(i.date, ctx.today); return `<div class="row"><div class="grow"><a href="#websites-${esc(i.site.id)}"><strong>${esc(host(i.site.url))}</strong></a> <span class="muted small">${esc(ctx.clientName(i.site.clientId))}</span><div class="small">${esc(i.label)}${i.key === "domainRenewal" && i.site.domainRegistrar ? " · " + esc(i.site.domainRegistrar) : i.key === "hostingRenewal" && i.site.hostingProvider ? " · " + esc(i.site.hostingProvider) : ""}</div></div>
      <div style="text-align:right"><div>${esc(D.fmt(i.date))}</div>${r.days < 0 ? pill(`${-r.days} day${r.days === -1 ? "" : "s"} overdue`, "bad") : r.days <= 30 ? pill(r.days === 0 ? "Today" : `in ${r.days} day${r.days === 1 ? "" : "s"}`, "warn") : `<span class="small muted">in ${r.days} days</span>`}</div></div>`; };
    let out = "";
    if (over.length) out += `<div class="web-tl-month" style="color:var(--bad)">Expired / overdue</div><div class="list">${over.map(row).join("")}</div>`;
    let m = null, buf = [];
    const flush = () => { if (buf.length) out += `<div class="web-tl-month">${esc(D.monthLabel(m))}</div><div class="list">${buf.join("")}</div>`; buf = []; };
    up.forEach(i => { const im = i.date.slice(0, 7); if (im !== m) { flush(); m = im; } buf.push(row(i)); });
    flush();
    return out;
  }

  function renderWebsites(el, ctx, route) {
    const sub = route.sub || "";
    if (sub && sub !== "renewals") return renderSite(el, ctx, sub);
    const tab = sub === "renewals" ? "renewals" : "sites";
    const all = sites();
    const actions = ctx.adminWrite ? `<button class="btn primary" data-act="web.new">Add website</button>` : "";
    let html = tabsHTML([["sites", "Websites"], ["renewals", "Renewals (90 days)"]], tab, "web.tab");
    if (!all.length) {
      html += `<div class="start"><h3>No websites yet</h3><p class="muted">${ctx.adminWrite
        ? "Add each client website with its platform, build status, and domain, hosting and SSL dates. Rwork warns you 30 days before anything expires and gives every new site a launch checklist."
        : "When Operations adds client websites, their build status and renewals show here."}</p>${ctx.adminWrite ? `<button class="btn primary" data-act="web.new">Add website</button>` : ""}</div>`;
      return { html, actions };
    }
    if (tab === "renewals") { html += `<div class="panel">${timelineHTML(ctx, timelineItems(ctx, 90))}</div>`; return { html, actions }; }
    const f = RW.S.f, list = sitesFiltered(ctx), mode = viewMode();
    const exp = all.filter(s => expired(s, ctx.today).length).length;
    const soon = all.filter(s => renewalItems(s).some(r => { const x = renewalState(r.date, ctx.today); return x.days >= 0 && x.days <= 30; })).length;
    html += `<div class="tiles">
        <div class="tile"><div class="v">${all.length}</div><div class="l">Websites</div></div>
        <div class="tile"><div class="v">${all.filter(s => s.status === "Live" || s.status === "Maintenance").length}</div><div class="l">Live</div></div>
        <div class="tile"><div class="v">${all.filter(s => !["Live", "Maintenance"].includes(s.status)).length}</div><div class="l">In build</div></div>
        <div class="tile${soon ? " alert" : ""}"><div class="v">${soon}</div><div class="l">Renewals in 30 days</div></div>
        <div class="tile${exp ? " alert" : ""}"><div class="v">${exp}</div><div class="l">Expired items</div></div></div>
      <div class="filters">
        <input type="search" placeholder="Search websites" data-input="filter" data-key="webSearch" id="webSearch" data-keep value="${esc(f.webSearch || "")}">
        <select data-change="filter" data-key="webClient" aria-label="Client">${clientOpts(f.webClient || "", "All clients")}</select>
        <select data-change="filter" data-key="webStatus" aria-label="Status">${opts(W_STATUSES, f.webStatus || "", "All statuses")}</select>
        <span style="flex:1"></span>
        <button class="btn sm${mode === "table" ? " primary" : ""}" data-act="web.view" data-mode="table">Table</button>
        <button class="btn sm${mode === "cards" ? " primary" : ""}" data-act="web.view" data-mode="cards">Cards</button></div>
      ${mode === "cards" ? sitesCards(ctx, list) : `<div class="panel">${sitesTable(ctx, list)}</div>`}
      <p class="web-note">Logins and passwords aren't stored here. Keep them in your password manager.</p>`;
    return { html, actions };
  }

  function renderSite(el, ctx, sid) {
    const s = (RW.map.websites || {})[sid];
    if (!s) return { html: `<div class="empty">This website doesn't exist any more. <a href="#websites">Back to websites</a></div>`, title: "Website" };
    const items = checksOf(s.id), p = checkProgress(s.id);
    const canTick = ctx.canWrite && (ctx.isAdmin || !!ctx.me);
    const actions = ctx.adminWrite ? `<button class="btn" data-act="web.edit" data-id="${esc(s.id)}">Edit</button> <button class="btn ghost danger" data-act="web.del" data-id="${esc(s.id)}">Delete</button>` : "";
    const ren = RENEWALS.map(([k, l]) => {
      if (!D.valid(s[k])) return `<div class="row"><div class="grow">${esc(l)}</div><span class="muted">Not entered</span></div>`;
      const r = renewalState(s[k], ctx.today);
      return `<div class="row"><div class="grow">${esc(l)}</div><span>${esc(D.fmt(s[k]))}</span> ${r.days < 0 ? pill("Expired", "bad") : r.days <= 30 ? pill(`in ${r.days} day${r.days === 1 ? "" : "s"}`, "warn") : ""}</div>`;
    }).join("");
    const info = [["Client", s.clientId && ctx.clientById[s.clientId] ? `<a href="#clients-${esc(s.clientId)}">${esc(ctx.clientName(s.clientId))}</a>` : "—"],
      ["Type · platform", esc((s.type || "—") + " · " + (s.platform || "—"))], ["Owner", esc(s.ownerId ? ctx.empName(s.ownerId) : "Not assigned")],
      ["Domain registrar", esc(s.domainRegistrar || "—")], ["Hosting provider", esc(s.hostingProvider || "—")], ["Maintenance plan", esc(s.maintenancePlan || "None")],
      ["Go-live", esc(D.valid(s.goLiveDate) ? D.fmt(s.goLiveDate) : "—")], ["Last backup", esc(D.valid(s.lastBackup) ? D.fmt(s.lastBackup) : "—")], ["Last updated", esc(D.valid(s.lastUpdated) ? D.fmt(s.lastUpdated) : "—")]]
      .map(([l, v]) => `<div><span class="muted small">${esc(l)}</span><div>${v}</div></div>`).join("");
    const checks = items.length ? items.map((it, i) => `<div class="web-check${it.done ? " done" : ""}"><input type="checkbox" id="webck${i}" data-change="web.tick" data-site="${esc(s.id)}" data-i="${i}"${it.done ? " checked" : ""}${canTick ? "" : " disabled"}>
        <label class="grow" for="webck${i}"><span>${esc(it.text)}</span>${it.done && it.doneBy ? ` <span class="small muted">· ${esc(ctx.empName(it.doneBy))}${it.doneAt ? ", " + esc(D.fmtShort(String(it.doneAt).slice(0, 10))) : ""}</span>` : ""}</label>
        ${ctx.adminWrite ? `<button class="btn ghost sm" data-act="web.rmCheck" data-site="${esc(s.id)}" data-i="${i}" aria-label="Remove item">✕</button>` : ""}</div>`).join("")
      : `<div class="empty">No checklist items.</div>`;
    const html = `<div><a href="#websites">← All websites</a></div>
      <div class="panel"><div class="panel-head"><h3>${siteLink(s.url)}</h3>${pill(s.status || "Planning", wStatusKind(s.status))}</div>
        <div class="fgrid">${info}</div>${s.notes ? `<p style="white-space:pre-wrap;margin:12px 0 0">${esc(s.notes)}</p>` : ""}
        <p class="web-note" style="margin:12px 0 0">Keep logins in your password manager.</p></div>
      <div class="grid2">
        <div class="panel"><div class="panel-head"><h3>Renewals</h3></div><div class="list">${ren}</div></div>
        <div class="panel"><div class="panel-head"><h3>Launch checklist</h3><span class="small muted">${p.done}/${p.total}</span></div>
          ${p.total ? `<div class="bar" style="margin-bottom:8px"><i style="width:${p.pct}%"></i></div>` : ""}${checks}
          ${canTick ? `<div style="display:flex;gap:8px;margin-top:10px"><input id="webNewCheck" data-keep placeholder="Add a checklist item" aria-label="New checklist item" style="flex:1"><button class="btn sm" data-act="web.addCheck" data-site="${esc(s.id)}">Add</button></div>` : ""}
          ${!ctx.me && !ctx.isAdmin ? `<p class="hint">Ask HR to link your account to tick items.</p>` : ""}</div>
      </div>`;
    return { html, actions, title: host(s.url) };
  }

  let checkBusy = false;
  async function saveChecks(sid, items) {
    if (checkBusy) { U.toast("Still saving the last change…"); return false; }
    checkBusy = true;
    try { return await RW.write.set("webchecks/" + sid, { siteId: sid, items, updatedAt: new Date().toISOString() }); }
    finally { checkBusy = false; RW.render(); }
  }
  RW.onChange("web.tick", async el => {
    const ctx = RW.ctx, sid = el.dataset.site, i = Number(el.dataset.i);
    if (!(ctx.canWrite && (ctx.isAdmin || ctx.me))) { RW.render(); return; }
    const items = checksOf(sid).map(x => Object.assign({}, x));
    if (!items[i]) return;
    items[i].done = el.checked;
    if (el.checked) { items[i].doneBy = (ctx.me && ctx.me.id) || ""; items[i].doneAt = new Date().toISOString(); } else { delete items[i].doneBy; delete items[i].doneAt; }
    await saveChecks(sid, items);
  });
  Object.assign(RW.actions, {
    "web.new": () => siteForm(null),
    "web.edit": el => { const s = (RW.map.websites || {})[el.dataset.id]; if (s) siteForm(s); },
    "web.open": el => RW.go("websites", el.dataset.id),
    "web.tab": el => RW.go("websites", el.dataset.tab === "renewals" ? "renewals" : ""),
    "web.view": el => { RW.prefs.set("web.view", el.dataset.mode === "cards" ? "cards" : "table"); RW.render(); },
    "web.del": async el => {
      const s = (RW.map.websites || {})[el.dataset.id]; if (!s) return;
      if (!(await U.confirm(`Delete ${host(s.url)} from the websites tracker?`, "Delete website"))) return;
      if (!(await RW.write.del("websites/" + s.id, "Website deleted."))) return;
      if ((RW.map.webchecks || {})[s.id]) await RW.write.del("webchecks/" + s.id);
      RW.go("websites");
    },
    "web.addCheck": async el => {
      const inp = document.getElementById("webNewCheck"); const t = inp ? inp.value.trim() : "";
      if (!t) { U.toast("Type the checklist item first.", "bad"); return; }
      const sid = el.dataset.site;
      const items = checksOf(sid).map(x => Object.assign({}, x)); items.push({ text: t.slice(0, 200), done: false });
      if (await saveChecks(sid, items)) { const x = document.getElementById("webNewCheck"); if (x) x.value = ""; }
    },
    "web.rmCheck": async el => {
      if (!RW.ctx.adminWrite) return;
      const sid = el.dataset.site, i = Number(el.dataset.i);
      const items = checksOf(sid).filter((x, j) => j !== i).map(x => Object.assign({}, x));
      await saveChecks(sid, items);
    }
  });

  RW.register({
    id: "websites", title: "Websites", icon: IC.web, group: "Clients", order: 40,
    collections: ["websites", "webchecks"],
    render: renderWebsites,
    badge: ctx => sites().filter(s => expired(s, ctx.today).length).length,
    alerts: ctx => {
      const out = [];
      sites().forEach(s => renewalItems(s).forEach(r => {
        const st = renewalState(r.date, ctx.today);
        const who = `${host(s.url)}${ctx.clientName(s.clientId) ? " (" + ctx.clientName(s.clientId) + ")" : ""}`;
        if (st.days < 0) out.push({ level: "danger", text: `${r.label} passed on ${D.fmt(r.date)}: ${who}`, date: r.date, href: "#websites-" + s.id });
        else if (st.days <= 30) out.push({ level: "warn", text: `${r.label} ${st.days === 0 ? "today" : `in ${st.days} day${st.days === 1 ? "" : "s"}`}: ${who}`, date: r.date, href: "#websites-" + s.id });
      }));
      return out;
    },
    dashboardWidgets: ctx => {
      if (!sites().length) return [];
      return [{
        title: "Upcoming renewals", href: "#websites-renewals", linkLabel: "Renewals timeline", order: 41,
        render(body) {
          const items = timelineItems(ctx, 60).slice(0, 8);
          body.innerHTML = items.length ? `<div class="list">${items.map(i => { const r = renewalState(i.date, ctx.today); return `<div class="row"><div class="grow"><a href="#websites-${esc(i.site.id)}">${esc(host(i.site.url))}</a><div class="small muted">${esc(i.label)}</div></div>${r.days < 0 ? pill("Expired", "bad") : r.days <= 30 ? pill(D.fmtShort(i.date), "warn") : `<span class="small">${esc(D.fmtShort(i.date))}</span>`}</div>`; }).join("")}</div>`
            : `<div class="muted small">Nothing renews in the next 60 days.</div>`;
        }
      }];
    }
  });

  RW.registerClientTab({
    id: "websites", title: "Websites", order: 40,
    render(el, client, ctx) {
      const list = sites().filter(s => s.clientId === client.id);
      el.innerHTML = `<div class="panel"><div class="panel-head"><h3>Websites</h3>${ctx.adminWrite ? `<button class="btn sm" data-act="web.newFor" data-client="${esc(client.id)}">Add website</button>` : ""}</div>
        ${sitesTable(ctx, list, { noClient: true, empty: "No websites for this client yet." })}</div>`;
    }
  });
  RW.action("web.newFor", el => {
    siteForm(null);
    const f = document.querySelector("#modalRoot form");
    if (f && f.elements.clientId) f.elements.clientId.value = el.dataset.client || "";
  });

  RW.registerHealthSignal((client, ctx) => {
    const ex = [];
    sites().filter(s => s.clientId === client.id).forEach(s => expired(s, ctx.today).forEach(r => ex.push(r)));
    return ex.length ? { label: `${ex.length} website renewal${ex.length === 1 ? "" : "s"} expired`, level: "danger" } : null;
  });
})();
