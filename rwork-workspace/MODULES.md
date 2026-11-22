# Rwork workspace — module guide

Rwork is a multi-file, vanilla-JS single-page app hosted as a claude.ai artifact. It runs in a sandboxed iframe and stores its data through the platform's `db` capability, which is Firestore-like. Each feature is a **module file** that registers itself with the core.

**Rules for module agents**
- **Edit only your own module file**: `js/m-chat.js`, `js/m-content.js`, `js/m-ads-web.js` or `js/m-time.js`. Each one already exists as a stub.
- **Add your own test file**: `/tmp/rwtest/tests/<module>.test.js`.
- **Do not edit the shared files**: `index.html`, `css/app.css`, `js/core.js`, `js/boot.js`, the other `m-*.js` files, or `/tmp/rwtest/harness.js` / `run.js`. If you need a core change, describe it in your report instead.
- **Read before you write**: this file, then `js/core.js`. `js/m-clients.js` and `js/m-leave.js` are good examples to copy from.

Load order (from `index.html`): `core.js` → `m-dashboard` → `m-projects` → `m-clients` → `m-leave` → `m-people` → `m-settings` → `m-chat` → `m-content` → `m-ads-web` → `m-time` → `boot.js`. Every file is a classic script, so wrap your module in an IIFE (`(function(){ ... })();`) and start it with `"use strict";`.

---

## 1. Registering a view

```js
RW.register({
  id: "content",              // lowercase letters/digits only (no hyphens). Used in the URL: #content
  title: "Content calendar",  // nav label and default page title
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">…</svg>', // 24×24 stroke icon
  group: "Clients",           // "Home" | "Work" | "Clients" | "People" | "Admin"   (nav section)
  order: 20,                  // order inside the group (lower first). Existing: projects 10, board 20, tasks 30,
                              //   clients 10, invoices 90, leave 10, calendar 20, people 30, settings 90
  adminOnly: false,           // true: hidden from non-admins, and render() is replaced by a "Only admins" note
  hidden: false,              // true: routable but not in the nav
  collections: ["posts"],     // data to watch (see §3); strings or query objects
  docs: [],                   // single documents to watch, e.g. ["org/contentSettings"]
  render(el, ctx, route) { … return { title, actions, after }; },
  badge: ctx => 0,            // optional number shown on the nav item (0 = none)
  alerts: ctx => [],          // optional: [{ level:"warn"|"danger", text, date?:"YYYY-MM-DD", href?:"#content-xyz" }]
  dashboardWidgets: ctx => [] // optional: [{ title, render(bodyEl, ctx), href?, linkLabel?, wide?:bool, order? }]
});
```

One file may call `RW.register` several times. For example, the ads/web module registers both `ads` and `websites`.

### render(el, ctx, route)
- `el` is an empty, detached `<div class="stack">` (a vertical flex column with a 20px gap). Fill it in one of two ways:
  - return `{ html: "..." }`, a string **you have escaped**; or
  - append DOM nodes yourself, for example with `RW.ui.h()` or `el.innerHTML = ...`.
- Return an object; every field is optional:
  - `title`: overrides the page title (for example a record's name on a detail page).
  - `actions`: buttons for the top bar, as an HTML string or a Node.
  - `after(el)`: called after `el` is attached to the document. Wire drag-and-drop and other listeners that need layout here.
  - `html`: as described above.
- `route` is `{ id, sub }`. The URL `#<id>-<sub>` routes to your view with `sub` set, for example `#content-abc123`. Use `sub` for detail pages or sub-tabs so Back works. Navigate with `RW.go("content", "abc123")` or a plain `<a href="#content-abc123">`.
- If your render throws, the core logs `console.error` and shows an error panel. The rest of the app keeps working.
- Render is a **pure re-draw from state**. Never subscribe or write to the db inside render.

### When re-renders happen
- **User actions:** the core re-renders the current view on route changes, after built-in filter changes, and when you call `RW.render()`.
- **Data changes:** the core re-renders after every snapshot through `RW.refresh()`. That re-render is **deferred** while a dialog is open, or while the focus is on an input, select or textarea inside the view. It runs when the dialog closes or the field loses focus. So typing is never wiped out.
- Two attributes change this behaviour:
  - `data-live` on an input (for example a chat composer) lets data re-renders run even while it has focus. The focus and caret are restored if the input has an `id`.
  - `data-keep` together with an `id` copies that field's current value into the re-rendered field, so drafts survive. Keep drafts in your own variables as well if they matter.
- Remember UI state such as the selected tab or filters in closure variables, or in `RW.prefs.get/set` (localStorage for one viewer; it may be missing). Never put it in shared data.

### Events (delegated, so no listeners are needed for markup in render)
- `data-act="name"` on a button or link calls `RW.actions[name](el, event, ctx)` on click. Register with `RW.action("content.open", fn)`, or `Object.assign(RW.actions, {...})`. **Prefix action names with your module id** (`content.`, `chat.`, `ads.`, `web.`, `time.`) to avoid collisions.
- `data-change="name"` calls `RW.changes[name](el, event, ctx)` (register with `RW.onChange`). `data-input="name"` calls `RW.inputs[name]` (register with `RW.onInput`).
- Built-in filter wiring: `<select data-change="filter" data-key="myKey">` or `<input data-input="filter" data-key="myKey">` stores the value in `RW.S.f.myKey`, which is remembered per viewer, and then re-renders. Prefix the keys too, for example `contentClient`.
- Clicks inside dialogs are not delegated. Wire dialog controls in `onMount` (see §4).

---

## 2. Context (`ctx`, also `RW.ctx`, a fresh object on each read)

| field | meaning |
|---|---|
| `db`, `user` | the platform namespaces (may be `null`) |
| `viewerId` | opaque id of the viewer (`user.id()`), or `null` |
| `isAdmin` | **Admin = Editor or Owner on the artifact's Share menu** (`user.canEdit()`). HR and Operations get Editor access. Every other employee is a Contributor. |
| `isOwner` | the artifact's owner |
| `canWrite` | may write shared data (signed in, `user.can("data.write") !== false`, not revoked) |
| `adminWrite` | `isAdmin && canWrite`. Use it to gate admin-only controls. |
| `readOnly` | the viewer can't write |
| `me` | the **employee record** linked to the viewer (`employees/*` where `userId === viewerId`), or `null` if not linked |
| `employees` / `allEmployees` | active employees sorted by name / all employees, including inactive |
| `employeeById`, `empName(id)` | lookup map, and a display name ("Unassigned" when missing) |
| `clients`, `clientById`, `clientName(id)` | clients sorted by name; lookup map; name |
| `projects`, `projectById` | projects array; lookup map |
| `settings` | `{ companyName, leaveTypes, holidays }` |
| `today` | `"YYYY-MM-DD"` in the viewer's local time |
| `state[key]`, `map[key]`, `docs[key]` | watched data: array / id→record map / single doc (see §3) |
| `route` | `{ id, sub }` |
| `can("admin"\|"write")` | the same as `adminWrite` / `canWrite` |

Employee records: `{ name, email, designation, team, role, userId, active, phone, joinDate, leaveQuotaOverrides }`.
- `team` is one of `RW.const.TEAMS`: HR, Operations, Management, Creative, Performance, Development, Content, Other.
- `role` is a **label only**: employee, hr, ops or mgmt.
- **Identify people by employee id** (`ctx.me.id`) in your data. For "who wrote this" you may also store `viewerId`. Never store names in data; look them up when rendering.

Clients: `{ name, industry, status, logoColor, contactName, contactEmail, contactPhone, accountManagerId, teamIds[], services[], contractStart, contractEnd, notes, links[{label,url}] }`.
- `status` is one of `RW.const.CLIENT_STATUSES`.
- `services` come from `RW.const.SERVICES`: SEO, Social media, Performance ads, Website, Content, Branding, Email.
- Retainers live in the `billing/<clientId>` collection, which only admins can read. Invoices live in `invoices`, also admin-only.

---

## 3. Data

### Watching
Declare the data in `collections` / `docs` when you register; the core subscribes **once** at boot. Each `collections` entry is either:
- `"posts"`: the whole collection. It is exposed as `RW.state.posts` (an array of `{id, ...fields}`) and `RW.map.posts` (a map from id to record).
- `{ path: "chat", key: "chatRecent", where: () => [["day", ">=", RW.date.addDays(RW.date.today(), -30)]], orderBy: ["day", "asc"], limit: 1000 }`: a windowed query.
  - `where` may be an array, or a function that is evaluated once at subscribe time.
  - Operators: `== != < <= > >= in not-in array-contains`; at most 10 filters and one `orderBy`.
  - The results go under `key`, which defaults to `path`.

For a single document, `docs: ["org/contentSettings"]` gives `RW.docs["org/contentSettings"]` (data, or `null` when the doc is missing).

You can also call `RW.watch(spec)` / `RW.watchDoc(spec)` at runtime; they are deduplicated by key. Don't create a subscription per record: the limit is 64 subscriptions per page.

Core already watches: `org/settings` (doc), `employees`, `projects`, `tasks`, `leaves`, `approvals`, `clients`, `invoices`, `billing` (the last two only for admins).
Add `adminOnly: true` to a watch spec for any path whose db rule is `read: "admin"`; non-admins then skip it instead of getting a refused subscription.

`RW.refreshNav()` redraws only the nav (badges), e.g. after changing a per-viewer pref that a badge reads.

`<a data-act>` clicks never navigate by themselves; if the link has a `#...` href and the action didn't open a dialog, the core follows the href after the action.

**The database starts empty.** Never hardcode seed records. Render friendly empty states, and for admins add "getting started" hints.

### Paths
- A path with an even number of segments is a doc (`posts/p1`); an odd number is a collection (`posts`).
- Segments may use letters, digits and `_ - . ~ : @ +` only. Build ids such as `2026-11-22_<employeeId>`; an employee id from `add()` is alphanumeric.
- Use the collection names reserved for you (see §7) to avoid collisions.

### Writing (always on a user action, never in render or snapshot callbacks; one write at a time per doc)
```js
await RW.write.add("posts", data, "Post created.");     // -> DocumentReference | false
await RW.write.set("posts/" + id, data, "Saved.");       // full replace
await RW.write.update("posts/" + id, { status: "Published" }); // merge; FAILS if the doc doesn't exist
await RW.write.del("posts/" + id, "Deleted.");
```
- Each call resolves to a truthy value on success, or to `false` on failure, in which case a toast has already explained it: permission, quota, rate limit or revoked access.
- `undefined` fields are stripped.
- Writes are last-writer-wins and there are no transactions. Don't build counters with read-modify-write; store per-person docs instead.
- Store dates as `"YYYY-MM-DD"` strings, months as `"YYYY-MM"`, and timestamps as `new Date().toISOString()`.

### Capacity (important)
- The artifact's database holds **at most 25,000 documents in total**, and each document can be at most 256 KiB.
- High-volume data must be **aggregated per person per day**, never one document per event. For example:
  - chat messages: one doc per (employee, day), holding `messages: [...]`, written only by that person;
  - timesheet entries: one doc per (employee, day) with `entries: [...]`;
  - attendance: in the same day doc.
- About 20 people × 250 working days is roughly 5,000 docs a year per such collection. Also offer admins a "clean up older than N months" action for anything unbounded.
- If a create fails with `quota_exceeded`, the toast tells the user. Don't retry in a loop.
- Shared data is untrusted. Escape everything you render.

---

## 4. UI helpers (`RW.ui`)

Every shared top-level function in `core.js` is also a global (for example `esc`, `S`, `schedule`). Prefer the `RW.*` names listed here.

- **Escaping and building markup:**
  - `esc(s)`: HTML-escapes text. **Every user value inside an HTML string must go through `esc`.**
  - `h(tag, attrs, ...children)`: a DOM builder. String children become text nodes, so they are safe. `attrs` accepts `class`, `style` (object), `dataset`, `on<Event>` functions, and `html` (trusted innerHTML).
- **Form fields:**
  - `field({label, name, type, value, options, empty, required, placeholder, hint, min, max, step, checked})` returns the HTML for one labelled field. `type` is one of text, email, tel, url, number, date, month, time, color, textarea, select, checkbox, hidden. Wrap several in `<div class="fgrid">…</div>` for two columns.
  - `fv(form, name)` returns a field's trimmed value.
  - `opts(list, selected, emptyLabel)`: `<option>` HTML from strings or `{v, l}` objects.
  - `empOpts(sel, empty)` / `clientOpts(sel, empty)` / `projOpts(sel, empty)`: option lists for employees, clients and projects. Each keeps a selected value even if that record is now inactive or deleted.
- **Dialogs and messages:**
  - `modal({ title, body, submitLabel, onSubmit(form) => bool|Promise<bool>, onMount(form), wide, danger, noSubmit, cancelLabel })`: `body` is an HTML string or a Node. Return `false` from `onSubmit` to keep the dialog open. There's no `alert`, `confirm` or `prompt` in the sandbox, so use this instead.
  - `closeModal()`.
  - `await confirm(message, buttonLabel)` resolves to true or false.
  - `toast(msg, "bad"?)`.
- **Pills and status markup:** `pill(text, kind)` where kind is `good`, `warn`, `bad`, `accent` or empty; also `statusPill`, `projPill`, `leavePill`, `prioHtml`, `healthHTML(health)`.
- **Avatars:** `av(employee)` is an initials avatar; `clientAv(client, large?)`.
- **Tables:**
  - `tableHTML(cols, rows, { empty, rowClass })`. Each column is `{ label, text(row) }`, which is auto-escaped, or `{ label, html(row) }`, which is trusted. `cls` sets a column's class.
  - `tabsHTML([[key, labelHtml], …], current, actName, extraAttrs)` renders a tab bar whose buttons have `data-act=actName data-tab=key`. The label HTML is trusted, so escape it.
  - Existing renderers you can reuse: `taskTable(tasks, sortable)` and `projectCard(project)`.
- **Export and formatting:**
  - `csvCopy(rows, "What")`: copies CSV to the clipboard, or shows a dialog to copy from. Downloads are blocked in the sandbox.
  - `fmtINR(n)` gives `₹1,25,000` (en-IN grouping).
  - `safeUrl(u)` returns the URL only if it is http(s), otherwise `""`. Always use it before rendering an `href`, with `target="_blank" rel="noopener noreferrer"`.
  - `safeColor('#rrggbb')`.
- **Modules shipped by core:**
  - `RW.openTaskForm(task|null, defaults)` and `RW.openProjectForm(project|null, defaults)`.
  - `RW.saveSettings(patch, toastMsg)` merges into `org/settings`. Prefer your own doc, for example `org/<module>Settings`.
- **Styles:** `RW.addStyle(cssText, moduleId)` injects your module's CSS. **Prefix every class with your module id**, for example `.content-cal`.

**Dates (`RW.date`):** `today()`, `parse(s)` (a UTC-midnight Date; use `getUTC*`), `toISO(d)`, `addDays(s, n)`, `addMonths("YYYY-MM", n)`, `valid(s)`, `isWeekend(s)`, `daysBetween(a, b)`, `workingDays(from, to, holidaySet, halfDay, year)`, `fmt(s)` ("22 Nov 2026"), `fmtShort(s)`, `range(a, b)`, `monthLabel("YYYY-MM")`, `fmtDays(n)`.

**Leave (`RW.leave`):** `status(leaveId)`, `onLeaveOn(date)` (approved leaves on that day), `balances(empId, year)`, `holidaySet()`, `holidayMap()`, `overlapping(from, to, statuses)`. Timesheets and attendance should treat approved leave and holidays as non-working days.

**Constants (`RW.const`):** `TEAMS`, `ROLES`, `SERVICES`, `CLIENT_STATUSES`, `INVOICE_STATUSES`, `TASK_STATUSES`, `PRIORITIES`, `PROJECT_STATUSES`, `NAV_GROUPS`.

### CSS classes available (from `css/app.css`)
- **Layout:** `panel` + `panel-head`, `stack`, `grid2`, `fgrid`, `widgets`.
- **Tiles and cards:** `tiles` + `tile` (with `.v` value and `.l` label; add `alert` or `leave` for an accent border), `cards`, `pcard` / `ccard`.
- **Lists:** `list` / `row` (`.grow`, `.title`), `alerts` + `alert warn|danger`, `empty`, `start` (onboarding box).
- **Forms and controls:** `filters`, `field`, `hint`, `check`, `checks`, `members`, `btn` (`primary`, `ghost`, `danger`, `sm`).
- **Tables and tabs:** `tbl-wrap` + `table`, `tabs`.
- **Status markup:** `pill` (`good`, `warn`, `bad`, `accent`), `chips`, `bar > i` (progress), `calc` (`warn`, `bad`) for info strips.
- **Calendar:** `cal` / `dow` / `day` / `chip`.
- **Text:** `muted`, `small`, `num`, `money`, `overdue`.

Colour tokens: `--brand`, `--brand-accent`, `--accent`, `--marigold` (leave/holidays), `--good`, `--warn`, `--bad` (each with `-soft`), `--bg`, `--surface`, `--ink`, `--muted`, `--line`. Dark mode works through the same variables, so never hard-code colours. **Branding:** the logo is the inline SVG `#logoMark` in `index.html` plus the favicon data URI, and the colours are the `--brand*` tokens at the top of `css/app.css`. Swap those to drop in the real Rwork logo.

---

## 5. Extending other areas

```js
// A tab on every client's detail page (#clients-<id>)
RW.registerClientTab({ id: "content", title: "Content", order: 20, adminOnly: false,
  render(el, client, ctx) { el.innerHTML = "…"; } });   // el is an empty .stack div

// A signal in the client health score (shown on client cards, the detail page and the dashboard widget)
RW.registerHealthSignal((client, ctx) => n ? { label: `${n} posts awaiting client approval`, level: "warn" } : null);
// Return null, one object, or an array of objects. level: "warn" | "danger". Overall: any danger = At risk, any warn = Needs attention.
```
- Alerts returned by `alerts(ctx)` appear in the dashboard's **Alerts & renewals** panel, with danger alerts first and then the rest sorted by date. Use `href` to deep-link, for example `#websites-abc`.
- `dashboardWidgets(ctx)` panels appear below the core dashboard. Keep them small: at most 8 rows, plus a link to your view.

---

## 6. Roles and permissions
- **Admins (HR and Operations):** `ctx.isAdmin`. They hold Editor access on the Share menu, which is the database's `admin` level.
- **Employees:** Contributor access, the `interact` level. By default they read and write all shared data except the paths with stricter rules below.
- **Database rules** are fixed when the page is published and are declared once by the coordinator (§7). Your module must also **gate controls in the UI**: hide admin-only buttons when `!ctx.adminWrite`, and hide editing of other people's records unless the viewer is an admin. The UI is the only guard for paths without a rule, so say so in your report.
- **Unlinked viewers:** when `ctx.me` is null, show a note that HR must link their account. Never fall back to writing under a shared or anonymous path.

---

## 7. CAPABILITIES (declared by the coordinator after publishing)

Base declaration (core + clients):
```json
{
  "db": { "rules": [
    { "path": "org",       "write": "admin" },
    { "path": "employees", "write": "admin" },
    { "path": "projects",  "write": "admin" },
    { "path": "approvals", "write": "admin" },
    { "path": "clients",   "write": "admin" },
    { "path": "invoices",  "read": "admin", "write": "admin" },
    { "path": "billing",   "read": "admin", "write": "admin" }
  ] },
  "user": { "scopes": ["profile"] }
}
```
`tasks` and `leaves` use the defaults: everyone reads, Contributors write.

**Module rules (append yours here, in your report):** reserved collection names, with suggested rules:
- **chat:**
  - `chat` (messages per person per day, doc id `<day>_<employeeId>`): default rules.
  - `channels`: `{path:"channels", write:"admin"}` if only admins create channels.
  - `announcements`: `{path:"announcements", write:"admin"}`.
- **content:** `posts` (the content calendar and post tracker): default rules, since everyone edits. Optionally `contentApprovals`.
- **ads-web:**
  - `campaigns` (one doc per campaign, holding monthly metrics in a map): `write: "admin"`, or default rules if performance staff update spend.
  - `websites`: `write: "admin"`.
- **time:**
  - `timelogs` (per person per day: check-in, check-out, entries[]): default rules.
  - For "only the owner edits their own day", the coordinator can use a `{self}` pattern only if the doc path is keyed by viewer id. Describe what you need.

Rules allow at most 64 entries. A rule's path covers that path and everything below it.

---

## 8. Tests

- Run everything with `node /tmp/rwtest/run.js`, or one file with `node /tmp/rwtest/run.js chat`. Add `VERBOSE=1` to print passing checks too.
- Add `/tmp/rwtest/tests/<module>.test.js`; it is auto-discovered. The core suite always runs first.

```js
module.exports = async (T) => {
  const { makeStore, load, go, click, fill, submit, wait, text, modal, title, ok, seed, docsIn } = T;
  const s = makeStore();
  seed(s, "employees/e1", { name: "Asha", userId: "uA" });             // direct seed before load
  const A = await load({ store: s, user: { id: "uA", admin: true, dir: { uA: "Asha" } } });
  await go(A, "content");                                                // sets location.hash, waits
  ok(/No posts yet/.test(text(A)), "empty state");                      // text(ctx) = #main text, whitespace-collapsed
  click(A, '#topActions [data-act="content.new"]'); await wait(10);
  fill(A, modal(A), { title: "Diwali post", date: "2026-11-25" });      // sets values + fires input/change
  await submit(A);                                                       // requestSubmit + wait
  ok(docsIn(s, "posts").length === 1, "post saved");                     // [{id, ...data}]
  ok(!A.errors.length, "no console errors " + A.errors.join("\n"));     // console.error/warn, page errors, blocked APIs
};
```
- `load()` options:
  - `user: { id, admin, owner, canWrite, dir: {userId: name} }`; `user: null` simulates a missing user capability.
  - `nullDb: true` or `noClaude: true` for the signed-out paths.
  - `dbOpts: { denyWrite: path => bool, denyRead: path => bool, snapError: "invalid_argument", cacheOnly: true }`.
- The fake database supports `where`, `orderBy`, `limit`, `add`, `set`, `update` (which rejects when the doc is missing), `delete` and `onSnapshot`. The access rules are **not** simulated beyond `denyWrite` / `denyRead`.
- To simulate another person writing: `seed(...)` and then any `RW.write.*` call from the page, or `await A.w.RW.write.set(...)`.
- Every test should check, at minimum:
  - the empty state for both an admin and an employee;
  - create, edit and delete;
  - that non-admins can't see admin controls;
  - that injected markup is escaped (`<img src=x>` in names produces no `img` element in `#main`);
  - that `A.errors` is empty.
