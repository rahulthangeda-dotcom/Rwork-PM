"use strict";
/* People directory + employee profiles (admin writes). Collection: employees. */
(function () {
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.6c2.6.1 4.5 1.9 5.2 4.9"/></svg>';
  const teamOf = e => e.team || e.department || "";
  /* Standalone (Firebase) mode: the login email is the identity, and staff/<email> is the sign-in allow-list. */
  const FB = () => !!window.RWORK_FIREBASE;
  const ADMIN_ROLES = ["hr", "ops", "mgmt", "admin"];
  const normEmail = v => String(v || "").trim().toLowerCase();
  async function syncStaff(empId, data, oldEmail) {
    const em = normEmail(data.email), old = normEmail(oldEmail);
    if (old && old !== em) { const ok = await write(() => S.db.doc("staff/" + old).delete()); if (!ok) return false; }
    if (!em) return true;
    return write(() => S.db.doc("staff/" + em).set({ employeeId: empId, name: data.name || "", admin: ADMIN_ROLES.includes(data.role), active: data.active !== false, updatedAt: new Date().toISOString() }));
  }

  function employeeForm(emp) {
    const e = emp || { role: "employee", active: true };
    const types = settings().leaveTypes;
    const o = e.leaveQuotaOverrides || {};
    const quotaInputs = types.map(t => {
      const cur = o[t.key] !== undefined && o[t.key] !== null && o[t.key] !== "" ? o[t.key] : num(t.quota, 0);
      return `<div class="field"><label for="q_${esc(t.key)}">${esc(t.name)}</label><input id="q_${esc(t.key)}" name="q_${esc(t.key)}" type="number" min="0" max="365" step="0.5" value="${esc(cur)}" inputmode="decimal"></div>`;
    }).join("");
    const role = e.role === "admin" ? "hr" : (e.role || "employee");
    const teamVal = e.team || (TEAMS.includes(e.department) ? e.department : "");
    openModal({
      title: emp ? "Edit employee" : "Add employee", wide: true, submitLabel: emp ? "Save changes" : "Add employee",
      body: `
        <div class="fgrid">
          <div class="field"><label for="eName">Full name</label><input id="eName" name="name" required value="${esc(e.name)}"></div>
          <div class="field"><label for="eEmail">${FB() ? "Login email" : "Work email"}</label><input id="eEmail" name="email" type="email" value="${esc(e.email)}"${FB() ? " required" : ""}>${FB() ? `<span class="hint">This person signs in with this email. Personal emails (Gmail etc.) are fine.</span>` : ""}</div>
          <div class="field"><label for="eDesig">Designation</label><input id="eDesig" name="designation" value="${esc(e.designation)}" placeholder="e.g. Social Media Executive"></div>
          <div class="field"><label for="eTeam">Team</label><select id="eTeam" name="team">${opts(TEAMS, teamVal, "Choose a team")}</select>${!e.team && e.department && !TEAMS.includes(e.department) ? `<span class="hint">Previously: ${esc(e.department)}</span>` : ""}</div>
          <div class="field"><label for="ePhone">Phone</label><input id="ePhone" name="phone" type="tel" value="${esc(e.phone)}"></div>
          <div class="field"><label for="eJoin">Joining date</label><input id="eJoin" name="joinDate" type="date" value="${esc(e.joinDate)}"></div>
          <div class="field"><label for="eRole">Role in Rwork</label><select id="eRole" name="role">${opts(ROLES, role)}</select><span class="hint">${FB() ? "HR, Operations and Management admins can manage people, clients, projects, invoices and approve leave." : "A label. Admin rights (people, clients, approvals) come from Editor access in this page's Share menu."}</span></div>
          <div class="field"><label for="eActive">Status</label><select id="eActive" name="active">${opts([{ v: "1", l: "Active" }, { v: "0", l: "Inactive (left the company)" }], e.active === false ? "0" : "1")}</select></div>
        </div>
        <div class="field">
          <span class="flabel">Leave quotas (per year)</span>
          <div class="quota-grid">${quotaInputs || `<span class="hint">No leave types yet. Add them in Settings.</span>`}</div>
          <span class="hint">Prefilled from company defaults. Enter this person's own numbers, for example their earned leave.</span>
        </div>
        <div class="field" id="linkField"${FB() ? " hidden" : ""}>
          <label for="eLink">Linked Claude account</label>
          <input type="hidden" name="userId" id="eUserId" value="${esc(e.userId || "")}">
          <div class="hint" id="eLinkCur">${e.userId ? "Linked" : "Not linked. Linking lets this person see their own tasks and apply for leave."}</div>
          <input id="eLink" type="search" placeholder="Search a colleague by name" autocomplete="off">
          <div class="ta-list" id="eLinkList"></div>
          ${e.userId ? `<button type="button" class="btn sm" id="eUnlink" style="align-self:flex-start">Remove link</button>` : ""}
        </div>`,
      onMount: form => {
        if (!S.user || FB()) { $("#linkField", form).hidden = true; return; }
        const curEl = $("#eLinkCur", form), hid = $("#eUserId", form), list = $("#eLinkList", form), inp = $("#eLink", form);
        if (e.userId) Promise.resolve(S.user.profiles([e.userId])).then(ps => { const p = ps && ps[e.userId]; if (p && curEl.isConnected && hid.value === e.userId) curEl.textContent = "Linked to " + (p.name || "a Claude account"); }, () => {});
        let seq = 0;
        const find = q => { const my = ++seq; Promise.resolve(S.user.search(q)).then(hits => { if (my === seq && inp.isConnected) show(hits); }, () => {}); };
        const show = hits => {
          list.innerHTML = "";
          (Array.isArray(hits) ? hits : []).forEach(hh => {
            if (!hh || !hh.id) return;
            const b = document.createElement("button"); b.type = "button";
            const sp = document.createElement("span"); sp.textContent = (hh.name || "Someone") + (hh.email ? " (" + hh.email + ")" : "");
            if (hh.avatarUrl) { const img = document.createElement("img"); img.src = hh.avatarUrl; img.alt = ""; b.append(img); }
            b.append(sp);
            b.addEventListener("click", () => {
              const taken = Object.values(S.employees).find(x => x.userId === hh.id && (!emp || x.id !== emp.id));
              if (taken) { toast(`That account is already linked to ${taken.name}.`, "bad"); return; }
              hid.value = hh.id; curEl.textContent = "Linked to " + (hh.name || "a Claude account"); list.innerHTML = ""; inp.value = ""; seq++;
            });
            list.appendChild(b);
          });
        };
        inp.addEventListener("focus", () => find(""));
        inp.addEventListener("input", () => find(inp.value));
        const un = $("#eUnlink", form); if (un) un.addEventListener("click", () => { hid.value = ""; curEl.textContent = "Not linked"; un.remove(); });
      },
      onSubmit: async form => {
        const name = fv(form, "name"); if (!name) { toast("Enter the employee's name.", "bad"); return false; }
        const ov = {};
        for (const t of settings().leaveTypes) {
          const raw = fv(form, "q_" + t.key);
          if (raw === "") continue;
          const n = Number(raw); if (!Number.isFinite(n) || n < 0) { toast(`Enter a valid ${t.name} quota.`, "bad"); return false; }
          // Store an override only when it differs from the default (or one existed), so later default changes still apply.
          const had = o[t.key] !== undefined && o[t.key] !== null && o[t.key] !== "";
          if (!had && n === num(t.quota, 0)) continue;
          ov[t.key] = n;
        }
        const team = fv(form, "team");
        const email = fv(form, "email");
        if (FB()) {
          const em = normEmail(email);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { toast("Enter this person's login email.", "bad"); return false; }
          const dup = Object.values(S.employees).find(x => normEmail(x.email) === em && (!emp || x.id !== emp.id));
          if (dup) { toast(`${dup.name} already uses that email.`, "bad"); return false; }
        }
        const data = clean({
          name, email: FB() ? normEmail(email) : email, designation: fv(form, "designation"), team,
          department: team || e.department || "",
          phone: fv(form, "phone"), joinDate: fv(form, "joinDate"), role: fv(form, "role") || "employee",
          active: fv(form, "active") !== "0", userId: FB() ? normEmail(email) : (fv(form, "userId") || ""), leaveQuotaOverrides: ov,
          createdAt: emp ? emp.createdAt : new Date().toISOString()
        });
        if (FB()) {
          let id = emp && emp.id;
          const ok = await write(async () => { if (emp) await col("employees").doc(emp.id).set(data); else id = (await col("employees").add(data)).id; });
          if (!ok) return false;
          if (!(await syncStaff(id, data, emp && emp.email))) return false;
          toast(emp ? "Employee updated." : "Employee added. They can now set their password on the sign-in page.");
          return true;
        }
        return write(() => emp ? col("employees").doc(emp.id).set(data) : col("employees").add(data), emp ? "Employee updated." : "Employee added.");
      }
    });
  }

  function vPeople() {
    const list = emps(S.isAdmin);
    const types = settings().leaveTypes;
    const actions = adminWrite() ? `<button class="btn primary" data-act="newEmployee">Add employee</button>` : "";
    if (!list.length) return { html: `<div class="empty">${adminWrite() ? "No employees yet. Add your team to assign tasks and track leave." : "The directory is empty."}</div>`, actions };
    const missing = S.isAdmin ? list.filter(e => e.active !== false && earnedMissing(e)) : [];
    const html = `${missing.length ? `<div class="calc warn">${missing.length === 1 ? "1 employee has" : missing.length + " employees have"} no earned leave entered yet. They're highlighted below. Edit each one to fill it in.</div>` : ""}
      <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Designation</th><th>Team</th>${S.isAdmin ? `<th>Joined</th>${types.map(t => `<th>${esc(t.name)} quota</th>`).join("")}<th>${FB() ? "Login email" : "Account"}</th><th></th>` : "<th>Email</th>"}</tr></thead><tbody>
      ${list.map(e => `<tr class="${e.active === false ? "inactive" : ""} ${S.isAdmin && e.active !== false && earnedMissing(e) ? "needs" : ""}">
        <td><span style="display:inline-flex;align-items:center;gap:8px">${av(e)}<span><strong>${esc(e.name)}</strong>${roleLabel(e.role) ? ` <span class="pill accent">${esc(roleLabel(e.role))}</span>` : ""}${e.active === false ? ` <span class="pill">Inactive</span>` : ""}</span></span></td>
        <td>${esc(e.designation || "—")}</td><td>${esc(teamOf(e) || "—")}</td>
        ${S.isAdmin ? `<td class="num">${e.joinDate ? esc(nice(e.joinDate)) : "—"}</td>${types.map(t => { const q = quotaFor(e, t); const miss = t.key === "earned" && q === 0; return `<td class="num">${miss ? `<span class="pill warn">Not entered</span>` : esc(q)}</td>`; }).join("")}
          ${FB() ? `<td class="small">${e.email ? esc(e.email) : `<span class="pill warn">No login email</span>`}</td>` : `<td class="small" data-uid="${esc(e.userId || "")}">${e.userId ? "Linked" : `<span class="muted">Not linked</span>`}</td>`}
          <td>${adminWrite() ? `<button class="btn sm" data-act="editEmployee" data-id="${esc(e.id)}">Edit</button>` : ""}</td>` : `<td class="small">${esc(e.email || "—")}</td>`}
      </tr>`).join("")}
      </tbody></table></div>`;
    return { html, actions, after: resolveLinked };
  }
  async function resolveLinked() {
    if (!S.user || FB()) return;
    const cells = [...document.querySelectorAll("td[data-uid]")].filter(c => c.dataset.uid);
    if (!cells.length) return;
    let ps = null;
    try { ps = await S.user.profiles([...new Set(cells.map(c => c.dataset.uid))]); } catch (e) {}
    if (!ps) return;
    cells.forEach(c => { const p = ps[c.dataset.uid]; if (p && c.isConnected) c.textContent = p.name || "Linked"; });
  }

  Object.assign(RW.actions, {
    newEmployee: () => employeeForm(),
    editEmployee: el => employeeForm(S.employees[el.dataset.id])
  });
  RW.register({ id: "people", title: "People", icon: ICON, group: "People", order: 30, render: vPeople,
    alerts: ctx => {
      if (!ctx.isAdmin) return [];
      const miss = emps().filter(earnedMissing);
      return miss.length ? [{ level: "warn", text: `${miss.length} employee${miss.length === 1 ? " has" : "s have"} no earned leave entered`, href: "#people" }] : [];
    } });
})();
