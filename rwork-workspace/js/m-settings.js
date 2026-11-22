"use strict";
/* Settings (admin only): leave types & quotas, holidays, company name. Doc: org/settings. */
(function () {
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
  // Always write the whole settings doc, keeping other fields (modules may store extra keys in it).
  const saveSettings = (patch, msg) => { const cur = Object.assign({}, S.settingsDoc || {}), s = settings(); return write(() => S.db.doc("org/settings").set(Object.assign(cur, { companyName: s.companyName, leaveTypes: s.leaveTypes, holidays: s.holidays }, patch)), msg); };
  RW.saveSettings = saveSettings;

  function leaveTypesForm() {
    const types = settings().leaveTypes.map(t => Object.assign({}, t));
    const rowHtml = (t, i) => `<div class="lt-row" data-i="${i}"><input aria-label="Leave type name" name="ltName" value="${esc(t.name)}" placeholder="e.g. Maternity"><input aria-label="Default days per year" name="ltQuota" type="number" min="0" step="0.5" value="${esc(num(t.quota, 0))}"><input type="hidden" name="ltKey" value="${esc(t.key || "")}"><button type="button" class="btn ghost sm danger" data-rm>Remove</button></div>`;
    openModal({
      title: "Leave types and default quotas", wide: true, submitLabel: "Save leave types",
      body: `<p class="hint" style="margin:0">Defaults apply to every employee unless HR enters a different number on their profile. Earned leave is usually entered per person.</p>
        <div class="lt-row hint"><span>Name</span><span>Days per year</span><span></span></div>
        <div id="ltRows" style="display:flex;flex-direction:column;gap:8px">${types.map(rowHtml).join("")}</div>
        <button type="button" class="btn sm" id="ltAdd" style="align-self:flex-start">Add leave type</button>`,
      onMount: form => {
        const rows = $("#ltRows", form);
        $("#ltAdd", form).addEventListener("click", () => { rows.insertAdjacentHTML("beforeend", rowHtml({ name: "", quota: 0, key: "" }, rows.children.length)); rows.lastElementChild.querySelector("input").focus(); });
        rows.addEventListener("click", e => { const b = e.target.closest("[data-rm]"); if (b) b.closest(".lt-row").remove(); });
      },
      onSubmit: async form => {
        const out = []; const keys = new Set();
        for (const r of form.querySelectorAll("#ltRows .lt-row")) {
          const name = r.querySelector('[name="ltName"]').value.trim(); if (!name) continue;
          const q = Number(r.querySelector('[name="ltQuota"]').value); if (!Number.isFinite(q) || q < 0) { toast(`Enter a valid quota for ${name}.`, "bad"); return false; }
          let key = r.querySelector('[name="ltKey"]').value || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "type";
          let k = key, i = 2; while (keys.has(k)) k = key + "-" + i++; keys.add(k);
          out.push({ key: k, name, quota: q });
        }
        if (!out.length) { toast("Keep at least one leave type.", "bad"); return false; }
        return saveSettings({ leaveTypes: out }, "Leave types saved.");
      }
    });
  }
  function holidayForm() {
    openModal({
      title: "Add holiday", submitLabel: "Add holiday",
      body: `<div class="field"><label for="hName">Holiday name</label><input id="hName" name="name" required placeholder="e.g. Diwali"></div>
        <div class="field"><label for="hDate">Date</label><input id="hDate" name="date" type="date" required></div>`,
      onSubmit: async form => {
        const name = fv(form, "name"), date = fv(form, "date");
        if (!name || !validDate(date)) { toast("Enter a name and a date.", "bad"); return false; }
        const s = settings();
        if (s.holidays.some(x => x.date === date)) { toast("There's already a holiday on that date.", "bad"); return false; }
        return saveSettings({ holidays: [...s.holidays, { date, name }].sort((a, b) => a.date.localeCompare(b.date)) }, "Holiday added.");
      }
    });
  }
  function companyForm() {
    openModal({
      title: "Company name", submitLabel: "Save",
      body: `<div class="field"><label for="cName">Company name</label><input id="cName" name="name" required value="${esc(settings().companyName)}"></div>`,
      onSubmit: async form => { const name = fv(form, "name"); if (!name) return false; return saveSettings({ companyName: name }, "Company name saved."); }
    });
  }

  function vSettings() {
    const s = settings();
    const ed = adminWrite();
    const html = `<div class="grid2">
      <section class="panel"><div class="panel-head"><h2>Leave types and default quotas</h2>${ed ? `<button class="btn sm" data-act="editLeaveTypes">Edit</button>` : ""}</div>
        <div class="list">${s.leaveTypes.map(t => `<div class="row"><div class="grow title">${esc(t.name)}</div><span class="num">${esc(num(t.quota, 0))} days a year</span>${t.key === "earned" && !num(t.quota, 0) ? `<span class="pill warn">Entered per employee</span>` : ""}</div>`).join("")}</div>
        <p class="hint" style="margin:10px 0 0">Set a different number for any employee in People. Weekends and holidays don't count toward leave.</p></section>
      <section class="panel"><div class="panel-head"><h2>Holidays</h2>${ed ? `<button class="btn sm" data-act="addHoliday">Add holiday</button>` : ""}</div>
        ${s.holidays.length ? `<div class="list">${s.holidays.slice().sort((a, b) => a.date.localeCompare(b.date)).map(x => `<div class="row"><span class="num small muted" style="min-width:110px">${esc(nice(x.date))}</span><div class="grow title">${esc(x.name)}</div>${ed ? `<button class="btn sm ghost danger" data-act="removeHoliday" data-date="${esc(x.date)}">Remove</button>` : ""}</div>`).join("")}</div>` : `<div class="empty">No holidays yet. Add your company's holiday list so leave counts skip them.</div>`}</section>
      <section class="panel"><div class="panel-head"><h2>Company</h2>${ed ? `<button class="btn sm" data-act="editCompany">Edit</button>` : ""}</div><p style="margin:0">${esc(s.companyName)}</p>
        <p class="hint">Who can sign in is set on the People page: only active employees with a login email can get in. Give HR and Operations an <strong>admin</strong> role (HR admin, Operations admin or Management admin) so they can manage people, clients, projects, invoices and approvals. Everyone else can update tasks, apply for leave and use the other tools.</p></section>
    </div>`;
    return { html };
  }

  Object.assign(RW.actions, {
    editLeaveTypes: () => leaveTypesForm(),
    addHoliday: () => holidayForm(),
    removeHoliday: async el => { const s = settings(); const x = s.holidays.find(y => y.date === el.dataset.date); if (!x) return; if (await confirmDialog(`Remove the holiday "${x.name}"?`, "Remove")) await saveSettings({ holidays: s.holidays.filter(y => y.date !== x.date) }, "Holiday removed."); },
    editCompany: () => companyForm()
  });
  RW.register({ id: "settings", title: "Settings", icon: ICON, group: "Admin", order: 90, adminOnly: true, render: vSettings });
})();
