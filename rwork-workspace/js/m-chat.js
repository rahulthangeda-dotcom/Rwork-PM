/* Team chat & announcements module.
   Collections:
   - channels/<id>        {name, topic, clientId?, createdBy, archived}            admin writes
   - announcements/<id>   {title, body, pinned, audience:'all'|team, createdBy, createdUid, createdAt, updatedAt}   admin writes
   - chat/<day>_<empId>   {day, authorId, authorUid, msgs:[{id, ch, t, u?, text, edited?, deleted?, mentions:[empId]}]}
     One doc per author per day (capacity). Only the author writes it (UI-enforced); admins may tombstone others' messages.
   Routes: #chat (general), #chat-<channelId>, #chat-announcements */
(function () {
  "use strict";
  const { esc, h, field, fv, opts, modal, confirm, toast, safeUrl, av, tabsHTML, clientOpts } = RW.ui;
  const D = RW.date;
  const WINDOW_DAYS = 30, PRUNE_DAYS = 90, MAX_LEN = 4000, ANN = "announcements";
  const DEFAULT_CHANNELS = [
    { id: "general", name: "general", topic: "Company-wide conversation" },
    { id: "random", name: "random", topic: "Off-topic, fun and everything else" },
    { id: "creative", name: "creative", topic: "Design, video and copy" },
    { id: "performance", name: "performance", topic: "Ads, analytics and SEO" }
  ];
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 10.5h7M8.5 13.5h4.5"/></svg>';

  /* ---------- per-viewer UI state (never shared) ---------- */
  const U = { drafts: {}, stick: true, lastScroll: null, lastCh: null, mention: null, local: {}, chains: {}, prof: {}, profBusy: false, lastCount: -1 };
  const prefGet = (k, d) => RW.prefs.get("chat." + k, d);
  const prefSet = (k, v) => RW.prefs.set("chat." + k, v);

  /* ---------- helpers ---------- */
  const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nowISO = () => new Date().toISOString();
  const dayOf = iso => { const d = new Date(iso); if (isNaN(d)) return ""; const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const TIME = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });
  const fmtTime = iso => { const d = new Date(iso); return isNaN(d) ? "" : TIME.format(d); };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const slug = s => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  function dayLabel(day, today) {
    if (day === today) return "Today";
    if (day === D.addDays(today, -1)) return "Yesterday";
    return D.fmt(day);
  }

  function channelsAll(ctx) {
    const list = (ctx.state.channels || []).slice();
    if (!list.some(c => c.id === "general")) list.unshift({ id: "general", name: "general", topic: "Company-wide conversation", virtual: true });
    return list.sort((a, b) => (a.id === "general" ? -1 : b.id === "general" ? 1 : 0) || (!!a.clientId - !!b.clientId) || String(a.name).localeCompare(String(b.name)));
  }
  const channelById = (ctx, id) => channelsAll(ctx).find(c => c.id === id) || null;

  /* Merge message arrays by id; the newer version (u || t) wins, so edits and tombstones stick. */
  function mergeMsgs(a, b) {
    const m = new Map();
    [].concat(a || [], b || []).forEach(x => {
      if (!x || !x.id) return;
      const cur = m.get(x.id);
      if (!cur || String(x.u || x.t || "") >= String(cur.u || cur.t || "")) m.set(x.id, x);
    });
    return [...m.values()].sort((x, y) => String(x.t).localeCompare(String(y.t)));
  }
  /* All chat docs: snapshot (windowed) merged with this tab's unconfirmed local copies. */
  function chatDocs(ctx) {
    const out = {};
    (ctx.state.chatRecent || []).forEach(d => { out[d.id] = d; });
    Object.keys(U.local).forEach(id => {
      const l = U.local[id], s = out[id];
      out[id] = Object.assign({}, s || {}, { day: l.day, authorId: (s && s.authorId) || l.authorId, msgs: mergeMsgs(s && s.msgs, l.msgs) });
    });
    return out;
  }
  function timeline(ctx) {
    const docs = chatDocs(ctx), all = [];
    Object.keys(docs).forEach(docId => {
      const d = docs[docId];
      (Array.isArray(d.msgs) ? d.msgs : []).forEach(m => { if (m && m.id && typeof m.t === "string") all.push(Object.assign({}, m, { docId, authorId: d.authorId, day: d.day })); });
    });
    return all.sort((x, y) => String(x.t).localeCompare(String(y.t)) || String(x.id).localeCompare(String(y.id)));
  }
  const channelMsgs = (ctx, ch) => timeline(ctx).filter(m => m.ch === ch && !m.deleted);

  function mentionsIn(text, ctx) {
    const low = String(text).toLowerCase();
    return ctx.employees.filter(e => e.name && new RegExp("(^|\\s)@" + reEsc(String(e.name).toLowerCase()) + "(?![\\w])").test(low)).map(e => e.id);
  }
  /* Escaped rich text: newlines, safe http(s) links, @mention highlights. */
  function richText(text, mentionIds, ctx) {
    const meId = ctx.me && ctx.me.id;
    const names = (mentionIds || []).map(id => ctx.employeeById[id]).filter(e => e && e.name).sort((a, b) => b.name.length - a.name.length);
    const byName = {}; names.forEach(e => { byName[e.name.toLowerCase()] = e.id; });
    const re = new RegExp("(https?:\\/\\/[^\\s<>\"']+)" + (names.length ? "|@(" + names.map(e => reEsc(e.name)).join("|") + ")" : ""), "gi");
    const s = String(text || ""); let out = "", last = 0, m;
    const txt = t => esc(t).replace(/\n/g, "<br>");
    while ((m = re.exec(s))) {
      out += txt(s.slice(last, m.index));
      if (m[1]) {
        let u = m[1], trail = "";
        const tm = /[.,;:!?)\]]+$/.exec(u); if (tm) { trail = tm[0]; u = u.slice(0, -trail.length); }
        const safe = safeUrl(u);
        out += safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>` : esc(u);
        out += esc(trail);
      } else {
        const id = byName[m[2].toLowerCase()];
        out += `<span class="chat-mention${id && id === meId ? " me" : ""}">@${esc(m[2])}</span>`;
      }
      last = re.lastIndex;
    }
    return out + txt(s.slice(last));
  }

  /* ---------- profiles (avatars) ---------- */
  function ensureProfiles(ctx, uids) {
    if (!ctx.user || typeof ctx.user.profiles !== "function") return;
    const missing = [...new Set(uids.filter(u => u && !(u in U.prof)))];
    if (!missing.length || U.profBusy) return;
    U.profBusy = true;
    Promise.resolve().then(() => ctx.user.profiles(missing)).then(r => {
      missing.forEach(u => { U.prof[u] = (r && r[u]) || {}; });
    }).catch(() => { missing.forEach(u => { U.prof[u] = {}; }); })
      .finally(() => { U.profBusy = false; RW.refresh(); });
  }
  function avatarHTML(emp) {
    const p = emp && emp.userId ? U.prof[emp.userId] : null;
    const url = p && typeof p.avatarUrl === "string" && /^(data:image\/|blob:|https?:|\/)/i.test(p.avatarUrl) ? p.avatarUrl : "";
    if (url && !/^data:image\/svg/i.test(url)) return `<span class="chat-avwrap">${av(emp)}<img class="chat-avimg" src="${esc(url)}" alt=""></span>`;
    return av(emp);
  }

  /* ---------- writes (one queue per chat doc) ---------- */
  function queue(docId, day, authorId, mutate) {
    const prev = U.chains[docId] || Promise.resolve();
    const run = prev.then(async () => {
      const snap = (RW.map.chatRecent || {})[docId];
      const loc = U.local[docId];
      const before = mergeMsgs(snap && snap.msgs, loc && loc.msgs);
      const after = mutate(before.slice());
      if (!after) return false;
      const owner = (snap && snap.authorId) || (loc && loc.authorId) || authorId;
      U.local[docId] = { day, authorId: owner, msgs: after };
      RW.render();
      const ctx = RW.ctx;
      const data = { day, authorId: owner, msgs: after };
      if (owner === (ctx.me && ctx.me.id) && ctx.viewerId) data.authorUid = ctx.viewerId;
      else if (snap && snap.authorUid) data.authorUid = snap.authorUid;
      const ok = await RW.write.set("chat/" + docId, data);
      if (!ok) { U.local[docId] = loc ? Object.assign({}, loc, { msgs: before }) : { day, authorId: owner, msgs: before }; RW.render(); }
      return ok;
    });
    U.chains[docId] = run.catch(() => false);
    return run;
  }
  function sendMessage(ctx, ch, text) {
    const meE = ctx.me;
    if (!meE || !ctx.canWrite) { toast("Your account isn't linked to an employee profile yet. Ask HR.", "bad"); return Promise.resolve(false); }
    const t = nowISO(), day = dayOf(t), docId = day + "_" + meE.id;
    const msg = { id: uid(), ch, t, text, mentions: mentionsIn(text, ctx) };
    U.stick = true;
    return queue(docId, day, meE.id, msgs => { msgs.push(msg); return msgs; });
  }
  function editMessage(m, patch) {
    return queue(m.docId, m.day, m.authorId, msgs => {
      const i = msgs.findIndex(x => x.id === m.id); if (i < 0) return null;
      msgs[i] = Object.assign({}, msgs[i], patch, { u: nowISO() });
      return msgs;
    });
  }
  const canModify = (ctx, m) => ctx.canWrite && ((ctx.me && m.authorId === ctx.me.id) || ctx.adminWrite);
  const canEditText = (ctx, m) => ctx.canWrite && ctx.me && m.authorId === ctx.me.id;

  /* ---------- unread ---------- */
  function unreadFor(ctx, ch, tl) {
    const lr = prefGet("lastRead", {})[ch] || "";
    const meId = ctx.me && ctx.me.id;
    let n = 0, mention = false;
    tl.forEach(m => { if (m.ch === ch && !m.deleted && m.t > lr && m.authorId !== meId) { n++; if (meId && (m.mentions || []).includes(meId)) mention = true; } });
    return { n, mention };
  }
  function markRead(ch, msgs) {
    if (!msgs.length) return;
    const lr = prefGet("lastRead", {}); const last = msgs[msgs.length - 1].t;
    if ((lr[ch] || "") < last) { lr[ch] = last; prefSet("lastRead", lr); }
  }

  /* ---------- announcements ---------- */
  function visibleAnns(ctx) {
    const team = ctx.me && ctx.me.team;
    return (ctx.state.announcements || []).filter(a => ctx.isAdmin || !a.audience || a.audience === "all" || a.audience === team)
      .slice().sort((a, b) => (!!b.pinned - !!a.pinned) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }
  function annBadge(ctx) {
    const cutoff = new Date(Date.now() - 3 * 86400000).toISOString(), seen = prefGet("annRead", "");
    return visibleAnns(ctx).filter(a => String(a.createdAt || "") > cutoff && String(a.createdAt || "") > seen).length;
  }
  function annCard(a, ctx, compact) {
    const aud = !a.audience || a.audience === "all" ? "Everyone" : a.audience;
    const by = a.createdBy && ctx.employeeById[a.createdBy] ? ctx.employeeById[a.createdBy].name : "Admin";
    const body = String(a.body || "");
    return `<article class="chat-ann${a.pinned ? " pinned" : ""}">
      <div class="chat-ann-head"><h3>${esc(a.title || "Announcement")}</h3>${a.pinned ? RW.ui.pill("Pinned", "accent") : ""}${ctx.isAdmin ? RW.ui.pill(aud, "") : ""}</div>
      <div class="chat-ann-body">${richText(compact && body.length > 220 ? body.slice(0, 220) + "…" : body, [], ctx)}</div>
      <div class="chat-ann-meta muted small">Posted by ${esc(by)} · ${esc(D.fmt(dayOf(a.createdAt)))}${a.updatedAt && a.updatedAt !== a.createdAt ? " · edited" : ""}</div>
      ${!compact && ctx.adminWrite ? `<div class="chat-ann-acts"><button class="btn sm ghost" data-act="chat.annEdit" data-id="${esc(a.id)}">Edit</button><button class="btn sm ghost" data-act="chat.annPin" data-id="${esc(a.id)}">${a.pinned ? "Unpin" : "Pin"}</button><button class="btn sm ghost" data-act="chat.annDel" data-id="${esc(a.id)}">Delete</button></div>` : ""}
    </article>`;
  }
  function annForm(a) {
    const ctx = RW.ctx;
    if (!ctx.adminWrite) return;
    modal({
      title: a ? "Edit announcement" : "New announcement", submitLabel: a ? "Save" : "Post",
      body: field({ label: "Title", name: "title", value: a ? a.title : "", required: true }) +
        field({ label: "Message", name: "body", type: "textarea", value: a ? a.body : "", required: true }) +
        `<div class="fgrid">${field({ label: "Audience", name: "audience", type: "select", value: a ? a.audience || "all" : "all", options: [{ v: "all", l: "Everyone" }].concat(RW.const.TEAMS.map(t => ({ v: t, l: t + " team" }))) })}
        <div class="field"><label>&nbsp;</label>${field({ label: "Pin to the top and the dashboard", name: "pinned", type: "checkbox", checked: a ? !!a.pinned : false })}</div></div>`,
      onSubmit: async form => {
        const title = fv(form, "title").slice(0, 160), body = fv(form, "body").slice(0, 8000);
        if (!title || !body) { toast("Add a title and a message.", "bad"); return false; }
        const t = nowISO();
        const data = { title, body, audience: fv(form, "audience") || "all", pinned: !!form.elements.pinned.checked };
        if (a) return RW.write.update("announcements/" + a.id, Object.assign(data, { updatedAt: t }), "Announcement updated.");
        const c = RW.ctx;
        return RW.write.add("announcements", Object.assign(data, { createdBy: (c.me && c.me.id) || "", createdUid: c.viewerId || "", createdAt: t, updatedAt: t }), "Announcement posted.");
      }
    });
  }

  /* ---------- channel admin ---------- */
  function channelForm(ch) {
    const ctx = RW.ctx;
    if (!ctx.adminWrite) return;
    const isReal = ch && !ch.virtual;
    modal({
      title: isReal ? "Channel settings" : "New channel", submitLabel: isReal ? "Save" : "Create channel",
      body: field({ label: "Name", name: "name", value: ch ? ch.name : "", required: true, placeholder: "e.g. social-team", hint: "Lowercase letters, numbers and hyphens." }) +
        field({ label: "Topic", name: "topic", value: ch ? ch.topic || "" : "", placeholder: "What is this channel for?" }) +
        `<div class="field"><label for="chClient">Client (optional)</label><select id="chClient" name="clientId">${clientOpts(ch ? ch.clientId || "" : "", "No client")}</select></div>` +
        (isReal && ch.id !== "general" ? field({ label: "Archived (read-only, hidden from the main list)", name: "archived", type: "checkbox", checked: !!ch.archived }) : ""),
      onSubmit: async form => {
        const name = slug(fv(form, "name"));
        if (!name) { toast("Give the channel a name.", "bad"); return false; }
        const dup = channelsAll(RW.ctx).find(c => c.name === name && (!ch || c.id !== ch.id));
        if (dup) { toast(`#${name} already exists.`, "bad"); return false; }
        const data = { name, topic: fv(form, "topic").slice(0, 200), clientId: fv(form, "clientId") || "", archived: !!(form.elements.archived && form.elements.archived.checked) };
        if (ch) {
          if (ch.virtual) return RW.write.set("channels/" + ch.id, Object.assign({ createdBy: (ctx.me && ctx.me.id) || "" }, data), "Channel saved.");
          return RW.write.update("channels/" + ch.id, data, "Channel saved.");
        }
        const r = await RW.write.add("channels", Object.assign({ createdBy: (ctx.me && ctx.me.id) || "" }, data), `#${name} created.`);
        if (r && r.id) setTimeout(() => RW.go("chat", r.id), 0);
        return !!r;
      }
    });
  }
  async function createDefaults() {
    const ctx = RW.ctx; if (!ctx.adminWrite) return;
    const have = new Set((ctx.state.channels || []).map(c => c.id));
    let n = 0;
    for (const c of DEFAULT_CHANNELS) {
      if (have.has(c.id)) continue;
      if (await RW.write.set("channels/" + c.id, { name: c.name, topic: c.topic, clientId: "", archived: false, createdBy: (ctx.me && ctx.me.id) || "" })) n++;
      else break;
    }
    toast(n ? `Created ${n} channel${n === 1 ? "" : "s"}.` : "The default channels already exist.");
  }
  async function createClientChannel(client, ctx, quiet) {
    const existing = (ctx.state.channels || []).find(c => c.clientId === client.id);
    if (existing) return existing.id;
    let name = slug(client.name) || "client", base = name, i = 2;
    const names = new Set(channelsAll(ctx).map(c => c.name));
    while (names.has(name)) name = (base + "-" + i++).slice(0, 40);
    const id = "client_" + client.id;
    const ok = await RW.write.set("channels/" + id, { name, topic: `Work for ${String(client.name || "").slice(0, 120)}`, clientId: client.id, archived: false, createdBy: (ctx.me && ctx.me.id) || "" }, quiet ? undefined : `#${name} created.`);
    return ok ? id : null;
  }
  async function createClientChannels() {
    const ctx = RW.ctx; if (!ctx.adminWrite) return;
    const todo = ctx.clients.filter(c => c.status !== "Churned" && !(ctx.state.channels || []).some(ch => ch.clientId === c.id));
    if (!todo.length) { toast(ctx.clients.length ? "Every client already has a channel." : "Add clients first."); return; }
    let n = 0;
    for (const c of todo) { if (await createClientChannel(c, RW.ctx, true)) n++; else break; }
    if (n) toast(`Created ${n} client channel${n === 1 ? "" : "s"}.`);
  }
  async function pruneOld() {
    const ctx = RW.ctx; if (!ctx.adminWrite || !ctx.db) return;
    const cut = D.addDays(ctx.today, -PRUNE_DAYS);
    if (!(await confirm(`Delete all chat messages from before ${D.fmt(cut)} (older than ${PRUNE_DAYS} days)? This can't be undone. Announcements are kept.`, "Delete old messages"))) return;
    let snap;
    try { snap = await ctx.db.collection("chat").where("day", "<", cut).limit(1000).get(); }
    catch (e) { toast("Couldn't look up old messages. Try again.", "bad"); return; }
    let n = 0;
    for (const d of snap.docs) { if (await RW.write.del("chat/" + d.id)) n++; else break; }
    toast(n ? `Deleted ${n} old day${n === 1 ? "" : "s"} of messages.` : "There were no messages older than " + PRUNE_DAYS + " days.");
  }
  function manageDialog() {
    const ctx = RW.ctx; if (!ctx.adminWrite) return;
    modal({
      title: "Manage chat", noSubmit: true, cancelLabel: "Close",
      body: `<div class="stack" style="gap:14px">
        <div><strong>Default channels</strong><p class="hint" style="margin:4px 0 8px">#general, #random, #creative and #performance.</p><button type="button" class="btn sm" id="chatMgDefaults">Create default channels</button></div>
        <div><strong>Client channels</strong><p class="hint" style="margin:4px 0 8px">One channel for each client that doesn't have one yet (churned clients are skipped).</p><button type="button" class="btn sm" id="chatMgClients">Create channel for each client</button></div>
        <div><strong>Clean up</strong><p class="hint" style="margin:4px 0 8px">The database has a fixed size. Delete messages older than ${PRUNE_DAYS} days every few months.</p><button type="button" class="btn sm danger" id="chatMgPrune">Delete messages older than ${PRUNE_DAYS} days</button></div>
      </div>`,
      onMount: f => {
        f.querySelector("#chatMgDefaults").addEventListener("click", async e => { e.target.disabled = true; await createDefaults(); e.target.disabled = false; });
        f.querySelector("#chatMgClients").addEventListener("click", async e => { e.target.disabled = true; await createClientChannels(); e.target.disabled = false; });
        f.querySelector("#chatMgPrune").addEventListener("click", () => { RW.ui.closeModal(); pruneOld(); });
      }
    });
  }

  /* ---------- rendering ---------- */
  function msgHTML(m, prev, ctx) {
    const emp = ctx.employeeById[m.authorId];
    const grouped = prev && prev.authorId === m.authorId && dayOf(prev.t) === dayOf(m.t) && (new Date(m.t) - new Date(prev.t)) < 5 * 60000;
    const meId = ctx.me && ctx.me.id;
    const acts = [];
    if (canEditText(ctx, m)) acts.push(`<button class="btn sm ghost" data-act="chat.edit" data-id="${esc(m.id)}" title="Edit">Edit</button>`);
    if (canModify(ctx, m)) acts.push(`<button class="btn sm ghost" data-act="chat.del" data-id="${esc(m.id)}" title="Delete">Delete</button>`);
    return `<div class="chat-msg${grouped ? " grouped" : ""}${meId && (m.mentions || []).includes(meId) ? " mentioned" : ""}" data-mid="${esc(m.id)}">
      <div class="chat-av">${grouped ? `<span class="chat-time-s">${esc(fmtTime(m.t))}</span>` : avatarHTML(emp)}</div>
      <div class="chat-body">${grouped ? "" : `<div class="chat-meta"><strong>${esc(emp ? emp.name : "Former employee")}</strong><span class="muted small">${esc(fmtTime(m.t))}</span></div>`}
        <div class="chat-text">${richText(m.text, m.mentions, ctx)}${m.edited ? ` <span class="muted small">(edited)</span>` : ""}</div></div>
      ${acts.length ? `<div class="chat-acts">${acts.join("")}</div>` : ""}
    </div>`;
  }
  function sideHTML(ctx, chans, cur, tl) {
    const item = c => {
      const u = unreadFor(ctx, c.id, tl);
      return `<a href="#chat-${esc(c.id)}" class="chat-ch${c.id === cur ? " on" : ""}${u.n ? " unread" : ""}"><span class="hash">#</span><span class="nm">${esc(c.name)}</span>${u.mention ? `<span class="chat-at" title="You were mentioned">@</span>` : u.n ? `<span class="chat-dot" title="${u.n} unread"></span>` : ""}</a>`;
    };
    const live = chans.filter(c => !c.archived), team = live.filter(c => !c.clientId), cl = live.filter(c => c.clientId), arch = chans.filter(c => c.archived);
    return `<div class="chat-sec">Channels</div>${team.map(item).join("")}
      ${cl.length ? `<div class="chat-sec">Clients</div>${cl.map(item).join("")}` : ""}
      ${arch.length ? `<details class="chat-arch"${arch.some(c => c.id === cur) ? " open" : ""}><summary class="chat-sec">Archived (${arch.length})</summary>${arch.map(item).join("")}</details>` : ""}
      ${ctx.adminWrite ? `<button class="btn sm ghost chat-newch" data-act="chat.newChannel">+ New channel</button>` : ""}`;
  }
  function renderChat(el, ctx, chId) {
    const chans = channelsAll(ctx);
    let ch = chans.find(c => c.id === chId) || chans[0];
    const tl = timeline(ctx);
    const msgs = tl.filter(m => m.ch === ch.id && !m.deleted);
    markRead(ch.id, msgs);
    const uids = []; msgs.forEach(m => { const e = ctx.employeeById[m.authorId]; if (e && e.userId) uids.push(e.userId); });
    ensureProfiles(ctx, uids);
    if (U.lastCh !== ch.id) { U.stick = true; U.lastScroll = null; U.lastCh = ch.id; U.mention = null; }
    const client = ch.clientId ? ctx.clientById[ch.clientId] : null;
    let list = "", prev = null, lastDay = "";
    msgs.forEach(m => {
      const d = dayOf(m.t);
      if (d !== lastDay) { list += `<div class="chat-daysep"><span>${esc(dayLabel(d, ctx.today))}</span></div>`; lastDay = d; prev = null; }
      list += msgHTML(m, prev, ctx); prev = m;
    });
    if (!msgs.length) list = `<div class="chat-empty"><strong>This is the start of #${esc(ch.name)}.</strong><span class="muted">${esc(ch.topic || "Say hello to the team.")}</span><span class="muted small">Messages from the last ${WINDOW_DAYS} days are shown here.</span></div>`;
    const firstTime = !(ctx.state.channels || []).length;
    const start = firstTime && ctx.adminWrite ? `<div class="start chat-start"><strong>Set up team chat</strong><p class="muted" style="margin:4px 0 10px">Create the standard channels, and one channel per client so each account team has a place to talk.</p><div class="chips"><button class="btn sm primary" data-act="chat.defaults">Create default channels</button><button class="btn sm" data-act="chat.clientChannels">Create channel for each client</button></div></div>` : "";
    let composer;
    if (!ctx.db || ctx.readOnly) composer = `<div class="chat-note muted">You have view-only access, so you can read messages but not post.</div>`;
    else if (!ctx.me) composer = `<div class="chat-note muted">${ctx.isAdmin ? "Link your own account to an employee profile in People to post messages." : "Your account isn't linked to an employee profile yet. Ask HR to link it so you can post."}</div>`;
    else if (ch.archived) composer = `<div class="chat-note muted">This channel is archived, so it's read-only.</div>`;
    else composer = `<div class="chat-compose"><div class="chat-menu" id="chatMention" role="listbox" hidden></div>
        <textarea id="chatInput" data-live data-keep data-input="chat.typing" rows="1" maxlength="${MAX_LEN}" placeholder="Message #${esc(ch.name)}  (Enter to send, Shift+Enter for a new line, @ to mention)" aria-label="Message #${esc(ch.name)}"></textarea>
        <button class="btn primary" data-act="chat.send">Send</button></div>`;
    el.innerHTML = `${start}<div class="chat-wrap">
      <aside class="chat-side" aria-label="Channels">${sideHTML(ctx, chans, ch.id, tl)}</aside>
      <section class="chat-main">
        <div class="chat-head"><select class="chat-pick" data-change="chat.pick" aria-label="Channel">${opts(chans.map(c => ({ v: c.id, l: "#" + c.name + (c.archived ? " (archived)" : "") })), ch.id)}</select>
          <div class="chat-title"><strong>#${esc(ch.name)}</strong>${client ? ` <a class="pill accent" href="#clients-${esc(client.id)}">${esc(client.name)}</a>` : ""}<span class="muted small">${esc(ch.topic || "")}</span></div>
          ${ctx.adminWrite ? `<button class="btn sm ghost" data-act="chat.editChannel" data-id="${esc(ch.id)}">Settings</button>` : ""}</div>
        <div class="chat-list" id="chatList" aria-live="polite">${list}</div>
        ${composer}
      </section></div>`;
    return {
      after(root) {
        const lst = root.querySelector("#chatList");
        if (lst) {
          if (U.stick || U.lastScroll === null) lst.scrollTop = lst.scrollHeight; else lst.scrollTop = U.lastScroll;
          lst.addEventListener("scroll", () => { U.lastScroll = lst.scrollTop; U.stick = lst.scrollHeight - lst.scrollTop - lst.clientHeight < 40; });
        }
        root.querySelectorAll("img.chat-avimg").forEach(img => img.addEventListener("error", () => img.remove()));
        const ta = root.querySelector("#chatInput");
        if (ta) {
          if (!ta.value && U.drafts[ch.id]) ta.value = U.drafts[ch.id];
          autoGrow(ta);
          ta.addEventListener("keydown", e => onKey(e, ta, ch.id));
          if (U.mention) updateMention(ta);
        }
        const menu = root.querySelector("#chatMention");
        if (menu) menu.addEventListener("mousedown", e => e.preventDefault());
      }
    };
  }
  function autoGrow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight || 40, 180) + "px"; }

  /* ---------- composer: send + mentions ---------- */
  function curChannel() { const ctx = RW.ctx; const chans = channelsAll(ctx); return (chans.find(c => c.id === ctx.route.sub) || chans[0]).id; }
  async function doSend(ta, chId) {
    const text = ta.value.replace(/\s+$/, "").replace(/^\s*\n/, "");
    if (!text.trim()) return;
    if (text.length > MAX_LEN) { toast(`Messages can be up to ${MAX_LEN} characters.`, "bad"); return; }
    ta.value = ""; U.drafts[chId] = ""; U.mention = null; autoGrow(ta); hideMenu();
    const ok = await sendMessage(RW.ctx, chId, text);
    if (!ok) { const t = document.getElementById("chatInput"); if (t && !t.value) { t.value = text; U.drafts[chId] = text; } }
  }
  function onKey(e, ta, chId) {
    const M = U.mention;
    if (M && M.items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); M.sel = (M.sel + (e.key === "ArrowDown" ? 1 : -1) + M.items.length) % M.items.length; drawMenu(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertMention(ta, M.items[M.sel]); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); U.mention = null; hideMenu(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(ta, chId); }
  }
  function updateMention(ta) {
    const caret = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    const before = ta.value.slice(0, caret);
    const m = /(^|\s)@([^\s@]{0,30})$/.exec(before);
    if (!m) { U.mention = null; hideMenu(); return; }
    const q = m[2].toLowerCase();
    const emps = RW.ctx.employees.filter(e => e.name && String(e.name).toLowerCase().includes(q))
      .sort((a, b) => (String(b.name).toLowerCase().startsWith(q) - String(a.name).toLowerCase().startsWith(q)) || String(a.name).localeCompare(String(b.name))).slice(0, 6);
    U.mention = { start: caret - m[2].length - 1, end: caret, items: emps, sel: U.mention && U.mention.sel < emps.length ? U.mention.sel : 0 };
    drawMenu();
  }
  function drawMenu() {
    const menu = document.getElementById("chatMention"); if (!menu) return;
    const M = U.mention;
    if (!M || !M.items.length) { hideMenu(); return; }
    menu.replaceChildren(...M.items.map((e, i) => h("button", { type: "button", class: "chat-mi" + (i === M.sel ? " on" : ""), role: "option", "aria-selected": i === M.sel ? "true" : "false", dataset: { act: "chat.pickMention", id: e.id } },
      h("span", { html: av(e) }), h("span", null, e.name), e.designation ? h("span", { class: "muted small" }, e.designation) : null)));
    menu.hidden = false;
  }
  function hideMenu() { const menu = document.getElementById("chatMention"); if (menu) { menu.hidden = true; menu.replaceChildren(); } }
  function insertMention(ta, emp) {
    const M = U.mention; if (!M || !emp) return;
    const ins = "@" + emp.name + " ";
    ta.value = ta.value.slice(0, M.start) + ins + ta.value.slice(M.end);
    const pos = M.start + ins.length;
    try { ta.setSelectionRange(pos, pos); } catch (e) {}
    U.mention = null; hideMenu();
    U.drafts[curChannel()] = ta.value; ta.focus(); autoGrow(ta);
  }

  function findMsg(ctx, id) { return timeline(ctx).find(m => m.id === id) || null; }

  RW.onInput("chat.typing", el => { U.drafts[curChannel()] = el.value; autoGrow(el); updateMention(el); });
  RW.onChange("chat.pick", el => RW.go("chat", el.value));
  RW.action("chat.send", () => { const ta = document.getElementById("chatInput"); if (ta) doSend(ta, curChannel()); });
  RW.action("chat.pickMention", el => { const ta = document.getElementById("chatInput"); const e = RW.ctx.employeeById[el.dataset.id]; if (ta && e) insertMention(ta, e); });
  RW.action("chat.tab", el => RW.go("chat", el.dataset.tab === "ann" ? ANN : (U.lastCh || "")));
  RW.action("chat.newChannel", () => channelForm(null));
  RW.action("chat.editChannel", el => { const c = channelById(RW.ctx, el.dataset.id); if (c) channelForm(c); });
  RW.action("chat.defaults", createDefaults);
  RW.action("chat.clientChannels", createClientChannels);
  RW.action("chat.manage", manageDialog);
  RW.action("chat.createClientChannel", async el => { const ctx = RW.ctx; const c = ctx.clientById[el.dataset.client]; if (!c || !ctx.adminWrite) return; const id = await createClientChannel(c, ctx); if (id) RW.go("chat", id); });
  RW.action("chat.edit", el => {
    const ctx = RW.ctx, m = findMsg(ctx, el.dataset.id);
    if (!m || !canEditText(ctx, m)) return;
    modal({
      title: "Edit message", submitLabel: "Save",
      body: `<div class="field"><label for="chatEditTa">Message</label><textarea id="chatEditTa" name="text" maxlength="${MAX_LEN}">${esc(m.text)}</textarea></div>`,
      onSubmit: async form => {
        const text = String(form.elements.text.value).trim();
        if (!text) { toast("A message can't be empty. Delete it instead.", "bad"); return false; }
        if (text === m.text) return true;
        return editMessage(m, { text, edited: true, mentions: mentionsIn(text, RW.ctx) });
      }
    });
  });
  RW.action("chat.del", async el => {
    const ctx = RW.ctx, m = findMsg(ctx, el.dataset.id);
    if (!m || !canModify(ctx, m)) return;
    if (!(await confirm("Delete this message? This can't be undone.", "Delete message"))) return;
    await editMessage(m, { deleted: true, text: "", mentions: [] });
  });
  RW.action("chat.annNew", () => annForm(null));
  RW.action("chat.annEdit", el => { const a = (RW.map.announcements || {})[el.dataset.id]; if (a) annForm(a); });
  RW.action("chat.annPin", el => { const a = (RW.map.announcements || {})[el.dataset.id]; if (a && RW.ctx.adminWrite) RW.write.update("announcements/" + a.id, { pinned: !a.pinned }, a.pinned ? "Unpinned." : "Pinned."); });
  RW.action("chat.annDel", async el => {
    const a = (RW.map.announcements || {})[el.dataset.id]; if (!a || !RW.ctx.adminWrite) return;
    if (await confirm(`Delete the announcement "${a.title || ""}"?`, "Delete")) RW.write.del("announcements/" + a.id, "Announcement deleted.");
  });

  RW.addStyle(`
    .chat-wrap{display:grid;grid-template-columns:220px 1fr;height:calc(100vh - 210px);height:calc(100dvh - 210px);min-height:420px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);overflow:hidden}
    .chat-side{border-right:1px solid var(--line);padding:12px 8px;overflow:auto;display:flex;flex-direction:column;gap:2px;background:var(--bg)}
    .chat-sec{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:10px 8px 4px;cursor:default}
    .chat-arch summary{cursor:pointer;list-style:none}
    .chat-ch{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;color:var(--ink);text-decoration:none;min-width:0}
    .chat-ch:hover{background:var(--accent-soft)}
    .chat-ch.on{background:var(--brand);color:var(--brand-ink)}
    .chat-ch .hash{opacity:.6}.chat-ch .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .chat-ch.unread .nm{font-weight:700}
    .chat-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex:none}
    .chat-at{font-size:.72rem;font-weight:700;background:var(--bad);color:#fff;border-radius:99px;padding:0 6px;flex:none}
    .chat-newch{margin-top:8px;align-self:flex-start}
    .chat-main{display:flex;flex-direction:column;min-width:0;min-height:0}
    .chat-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line)}
    .chat-title{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
    .chat-pick{display:none}
    .chat-list{flex:1;overflow:auto;padding:8px 16px 12px;min-height:0}
    .chat-daysep{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:.78rem;font-weight:600;margin:14px 0 6px}
    .chat-daysep::before,.chat-daysep::after{content:"";flex:1;border-top:1px solid var(--line)}
    .chat-msg{display:grid;grid-template-columns:36px 1fr auto;gap:10px;padding:6px 6px;border-radius:8px;position:relative}
    .chat-msg.grouped{padding-top:1px}
    .chat-msg:hover{background:var(--bg)}
    .chat-msg.mentioned{background:var(--warn-soft)}
    .chat-av{display:flex;justify-content:center;padding-top:2px}
    .chat-avwrap{position:relative;display:inline-block;width:28px;height:28px}
    .chat-avwrap .chat-avimg{position:absolute;inset:0;width:28px;height:28px;border-radius:50%;object-fit:cover}
    .chat-time-s{font-size:.66rem;color:var(--muted);visibility:hidden;padding-top:3px;white-space:nowrap}
    .chat-msg:hover .chat-time-s{visibility:visible}
    .chat-meta{display:flex;align-items:baseline;gap:8px}
    .chat-body{min-width:0}
    .chat-text{overflow-wrap:anywhere;line-height:1.45}
    .chat-text a{color:var(--accent)}
    .chat-mention{background:var(--accent-soft);color:var(--accent);border-radius:4px;padding:0 3px;font-weight:600}
    .chat-mention.me{background:var(--warn-soft);color:var(--ink)}
    .chat-acts{display:flex;gap:2px;opacity:0;align-self:start}
    .chat-msg:hover .chat-acts,.chat-msg:focus-within .chat-acts{opacity:1}
    @media (hover:none){.chat-acts{opacity:.8}}
    .chat-empty{display:flex;flex-direction:column;gap:4px;padding:28px 6px}
    .chat-compose{position:relative;display:flex;gap:8px;align-items:flex-end;padding:12px 16px;border-top:1px solid var(--line)}
    .chat-compose textarea{flex:1;resize:none;min-height:40px;max-height:180px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:var(--surface);color:var(--ink)}
    .chat-note{padding:14px 16px;border-top:1px solid var(--line)}
    .chat-menu{position:absolute;left:16px;bottom:calc(100% - 4px);min-width:240px;max-width:calc(100% - 32px);background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:4px;z-index:5}
    .chat-mi{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;padding:6px 8px;border-radius:6px;cursor:pointer;color:var(--ink);text-align:left;font:inherit}
    .chat-mi.on,.chat-mi:hover{background:var(--accent-soft)}
    .chat-anns{display:flex;flex-direction:column;gap:12px}
    .chat-ann{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:16px 18px}
    .chat-ann.pinned{border-color:var(--accent);box-shadow:inset 3px 0 0 var(--accent)}
    .chat-ann-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .chat-ann-head h3{margin:0;font-size:1.05rem;flex:1;min-width:0;overflow-wrap:anywhere}
    .chat-ann-body{margin:8px 0;overflow-wrap:anywhere;line-height:1.5}
    .chat-ann-acts{display:flex;gap:4px;margin-top:8px}
    .chat-widget .chat-ann{padding:10px 12px;border-radius:var(--r-md)}
    .chat-widget .chat-ann + .chat-ann{margin-top:8px}
    .chat-ctab .chat-msg{grid-template-columns:36px 1fr}
    @media (max-width:760px){
      .chat-wrap{grid-template-columns:1fr;height:calc(100dvh - 230px)}
      .chat-side{display:none}
      .chat-pick{display:block;max-width:45%}
      .chat-title .muted{display:none}
      .chat-list{padding:8px 10px}
      .chat-compose{padding:10px}
    }
  `, "chat");

  RW.register({
    id: "chat", title: "Team chat", icon: ICON, group: "Work", order: 5,
    collections: ["channels", "announcements",
      { path: "chat", key: "chatRecent", where: () => [["day", ">=", RW.date.addDays(RW.date.today(), -WINDOW_DAYS)]], orderBy: ["day", "desc"], limit: 1000 }],
    render(el, ctx, route) {
      const isAnn = route.sub === ANN;
      const nAnn = visibleAnns(ctx).length;
      const tabs = tabsHTML([["chat", "Chat"], ["ann", "Announcements" + (nAnn ? ` <span class="muted">(${nAnn})</span>` : "")]], isAnn ? "ann" : "chat", "chat.tab");
      const actions = (ctx.adminWrite ? (isAnn ? `<button class="btn primary" data-act="chat.annNew">New announcement</button>` : `<button class="btn" data-act="chat.manage">Manage chat</button>`) : "");
      if (isAnn) {
        const list = visibleAnns(ctx);
        el.innerHTML = tabs + (list.length ? `<div class="chat-anns">${list.map(a => annCard(a, ctx, false)).join("")}</div>`
          : `<div class="empty">No announcements yet.${ctx.adminWrite ? " Use New announcement to share news, policies or holidays with the team." : ""}</div>`);
        const newest = list.reduce((m, a) => String(a.createdAt || "") > m ? String(a.createdAt) : m, "");
        return { title: "Announcements", actions, after() { if (newest && newest > prefGet("annRead", "")) { prefSet("annRead", newest); renderChromeSoon(); } } };
      }
      const wrap = document.createElement("div"); wrap.className = "stack";
      const r = renderChat(wrap, ctx, route.sub);
      el.insertAdjacentHTML("beforeend", tabs);
      el.append(...wrap.childNodes);
      return { actions, after: r.after };
    },
    badge: ctx => annBadge(ctx),
    dashboardWidgets: ctx => {
      const cutoff = new Date(Date.now() - 3 * 86400000).toISOString();
      const list = visibleAnns(ctx).filter(a => a.pinned || String(a.createdAt || "") > cutoff).slice(0, 3);
      if (!list.length) return [];
      return [{ title: "Announcements", href: "#chat-announcements", linkLabel: "All announcements", order: 1, render(body) { body.innerHTML = `<div class="chat-widget">${list.map(a => annCard(a, ctx, true)).join("")}</div>`; } }];
    }
  });
  /* The nav badge reads prefs; re-render chrome once after marking announcements read. */
  let chromeTimer = null;
  function renderChromeSoon() { clearTimeout(chromeTimer); chromeTimer = setTimeout(() => (RW.refreshNav ? RW.refreshNav() : RW.refresh()), 50); }

  RW.registerClientTab({
    id: "chat", title: "Chat", order: 70,
    render(el, client, ctx) {
      const chans = (ctx.state.channels || []).filter(c => c.clientId === client.id).sort((a, b) => !!a.archived - !!b.archived);
      if (!chans.length) {
        el.innerHTML = `<div class="empty">${esc(client.name)} doesn't have a chat channel yet.${ctx.adminWrite ? `<div style="margin-top:10px"><button class="btn sm primary" data-act="chat.createClientChannel" data-client="${esc(client.id)}">Create #${esc(slug(client.name) || "client")} channel</button></div>` : " Ask an admin to create one."}</div>`;
        return;
      }
      const ch = chans[0];
      const msgs = channelMsgs(ctx, ch.id).slice(-8);
      let prev = null;
      el.innerHTML = `<div class="panel chat-ctab"><div class="panel-head"><h3 style="margin:0">#${esc(ch.name)}${ch.archived ? " (archived)" : ""}</h3><a class="btn sm" href="#chat-${esc(ch.id)}">Open channel</a></div>
        ${msgs.length ? msgs.map(m => { const x = msgHTML(m, prev, Object.assign({}, ctx, { canWrite: false, adminWrite: false })); prev = m; return x; }).join("") : `<div class="empty">No messages in the last ${WINDOW_DAYS} days.</div>`}</div>`;
    }
  });

  /* Test/debug hooks (no side effects). */
  RW.chat = { mergeMsgs, mentionsIn, richText, timeline: () => timeline(RW.ctx), _state: U };
})();
