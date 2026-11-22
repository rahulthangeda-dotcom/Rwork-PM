"use strict";
/* Rwork standalone mode: Firebase Authentication (email + password) + Cloud Firestore.
   Provides window.claude.use("db" | "user") with the same shape the app was written for,
   shows the sign-in screen, and opens window.RWORK_GATE (boot.js waits on it) once a
   verified, allowed person is signed in.
   If window.claude already exists (opened inside claude.ai, or the test harness), this file does nothing.
   Tests can set window.RWORK_FIREBASE_ADAPTER to a fake (same shape as loadRealSdk() returns). */
(function () {
  if (window.claude && typeof window.claude.use === "function") { window.RWORK_GATE = Promise.resolve(); return; }
  let openGate;
  window.RWORK_GATE = new Promise(r => { openGate = r; });
  const SDK_VERSION = "10.12.2";
  const cfg = window.RWORK_CONFIG || {};
  const fbc = cfg.firebase || {};
  const owners = (cfg.ownerEmails || []).map(e => String(e).trim().toLowerCase()).filter(e => e && e !== "owner@example.com");
  const configured = !!(fbc.apiKey && fbc.projectId && !/PASTE/.test(JSON.stringify(fbc)));
  const $ = s => document.querySelector(s);
  const escH = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lower = v => String(v || "").trim().toLowerCase();

  /* ---------- screens ---------- */
  function screen(inner) {
    document.body.classList.add("auth-mode");
    let el = $("#authScreen");
    if (!el) { el = document.createElement("div"); el.id = "authScreen"; document.body.appendChild(el); }
    el.innerHTML = `<div class="auth-card"><div class="auth-brand"><img src="img/logo.png" alt="Rwork logo"><div><b>Rwork</b><span>Workspace</span></div></div>${inner}</div>`;
    return el;
  }
  function hideScreen() { document.body.classList.remove("auth-mode"); const el = $("#authScreen"); if (el) el.remove(); }
  function showSetup() {
    screen(`<h1>Almost there</h1><p>This copy of Rwork isn't connected to its database yet.</p>
      <ol class="auth-steps"><li>Open <code>js/config.js</code>.</li><li>Paste your Firebase settings and your own email as the owner.</li><li>Upload the file again and refresh this page.</li></ol>
      <p class="auth-muted">The step-by-step guide is in README.md.</p>`);
  }
  function showFatal(msg) { screen(`<h1>Rwork couldn't start</h1><p>${escH(msg)}</p><p class="auth-muted">Check your internet connection and refresh the page.</p><button class="btn primary" type="button" onclick="location.reload()">Refresh</button>`); }

  const AUTH_MSG = {
    "auth/invalid-credential": "Wrong email or password.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/user-not-found": "No password is set for this email yet. Use \"First time? Set your password\".",
    "auth/invalid-email": "That doesn't look like an email address.",
    "auth/email-already-in-use": "This email already has a password. Use Sign in, or Forgot password if you don't remember it.",
    "auth/weak-password": "Choose a password with at least 6 characters.",
    "auth/missing-password": "Enter your password.",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes, or reset your password.",
    "auth/network-request-failed": "No internet connection. Check it and try again.",
    "auth/user-disabled": "This account has been switched off. Ask HR."
  };
  const authMsg = e => AUTH_MSG[e && e.code] || ((e && e.message) ? "Something went wrong: " + e.message : "Something went wrong. Try again.");

  function showLogin(fb, tab, note) {
    tab = tab || "signin";
    const tabs = [["signin", "Sign in"], ["signup", "First time here"], ["reset", "Forgot password"]];
    const forms = {
      signin: `<form data-f="signin"><label>Email<input name="email" type="email" autocomplete="username" required></label>
        <label>Password<input name="pw" type="password" autocomplete="current-password" required></label>
        <button class="btn primary" type="submit">Sign in</button></form>`,
      signup: `<form data-f="signup"><p class="auth-muted">New to Rwork? Set your password using the email HR added for you.</p>
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        <label>New password<input name="pw" type="password" autocomplete="new-password" minlength="6" required></label>
        <label>Type it again<input name="pw2" type="password" autocomplete="new-password" minlength="6" required></label>
        <button class="btn primary" type="submit">Set password</button></form>`,
      reset: `<form data-f="reset"><p class="auth-muted">We'll email you a link to choose a new password.</p>
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        <button class="btn primary" type="submit">Send reset link</button></form>`
    };
    const el = screen(`<div class="auth-tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" class="${k === tab ? "on" : ""}" aria-selected="${k === tab}">${l}</button>`).join("")}</div>
      <div class="auth-msg" role="alert" ${note ? "" : "hidden"}>${note ? escH(note.text) : ""}</div>${forms[tab]}`);
    const msg = el.querySelector(".auth-msg");
    if (note && note.ok) msg.classList.add("ok");
    const say = (t, ok) => { msg.hidden = false; msg.textContent = t; msg.classList.toggle("ok", !!ok); };
    el.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => showLogin(fb, b.dataset.tab)));
    const form = el.querySelector("form");
    const first = form.querySelector("input"); if (first) setTimeout(() => { try { first.focus(); } catch (e) {} }, 0);
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      const btn = form.querySelector("button[type=submit]");
      const val = n => { const i = form.querySelector('[name="' + n + '"]'); return i ? i.value : ""; };
      const email = lower(val("email"));
      btn.disabled = true;
      try {
        if (tab === "signin") { await fb.signIn(email, val("pw")); }
        else if (tab === "signup") {
          if (val("pw").length < 6) { say(AUTH_MSG["auth/weak-password"]); return; }
          if (val("pw") !== val("pw2")) { say("The two passwords don't match."); return; }
          pendingSignupNote = true;
          await fb.signUp(email, val("pw"));
          try { await fb.sendVerify(); } catch (e) {}
        } else {
          await fb.reset(email);
          say("If this email is registered, a reset link is on its way. Check your inbox and spam folder.", true);
        }
      } catch (e) { pendingSignupNote = false; say(authMsg(e)); }
      finally { btn.disabled = false; }
    });
  }
  let pendingSignupNote = false;

  function showVerify(fb, email) {
    const el = screen(`<h1>Check your inbox</h1><p>We sent a verification link to <strong>${escH(email)}</strong>. Click it, then come back here.</p>
      <p class="auth-muted">Can't find it? Look in your spam or promotions folder.</p>
      <div class="auth-msg" role="alert" hidden></div>
      <div class="auth-row"><button class="btn primary" type="button" data-a="done">I've verified my email</button><button class="btn" type="button" data-a="resend">Send the link again</button></div>
      <button class="btn ghost auth-link" type="button" data-a="out">Use a different email</button>`);
    const msg = el.querySelector(".auth-msg");
    const say = (t, ok) => { msg.hidden = false; msg.textContent = t; msg.classList.toggle("ok", !!ok); };
    el.querySelector('[data-a="done"]').addEventListener("click", async () => {
      try { const u = await fb.reloadUser(); if (u && u.emailVerified) { await fb.refreshToken(); afterSignIn(fb, u); } else say("Not verified yet. Click the link in the email first."); }
      catch (e) { say(authMsg(e)); }
    });
    el.querySelector('[data-a="resend"]').addEventListener("click", async () => { try { await fb.sendVerify(); say("Sent. Check your inbox.", true); } catch (e) { say(authMsg(e)); } });
    el.querySelector('[data-a="out"]').addEventListener("click", () => fb.signOut());
  }
  function showDenied(fb, email) {
    const el = screen(`<h1>You're not on the team list yet</h1><p><strong>${escH(email)}</strong> hasn't been added to Rwork, or the profile is inactive.</p>
      <p>Ask HR to add you on the People page with exactly this email. Then sign in again.</p>
      ${owners.length ? "" : `<p class="auth-msg">Setup isn't finished: no owner email is set in js/config.js and firestore.rules, so nobody can add people yet.</p>`}
      <button class="btn primary" type="button" data-a="out">Back to sign in</button>`);
    el.querySelector('[data-a="out"]').addEventListener("click", () => fb.signOut());
  }

  /* ---------- Firestore wrapper with the claude db shape ---------- */
  const SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
  function segs(p, wantEven) {
    if (typeof p !== "string") throw new TypeError("Path must be a string");
    const s = p.split("/");
    if (!s.length || s.some(x => !x || !SEG.test(x) || x === "." || x === "..")) throw new TypeError("Bad path segment in " + p);
    if ((s.length % 2 === 0) !== wantEven) throw new TypeError((wantEven ? "Document" : "Collection") + " path has the wrong number of segments (" + s.length + "): " + p);
    return s;
  }
  function mapErr(e) {
    const c = String((e && e.code) || "");
    const m = (e && e.message) || "";
    if (/permission-denied|unauthenticated|not-found|invalid-argument|failed-precondition|out-of-range/.test(c)) return { code: "invalid_argument", message: m };
    if (/resource-exhausted/.test(c)) return { code: "resource_exhausted", message: m };
    return { code: "unavailable", message: m || "Network problem" };
  }
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  function deepFreeze(o) { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
  const isPlain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  function wrapSnap(s) {
    const ex = typeof s.exists === "function" ? s.exists() : !!s.exists;
    let cache;
    return { id: s.id, exists: ex, data: () => { if (!ex) return undefined; if (cache === undefined) cache = deepFreeze(clone(s.data())); return cache; },
      metadata: { fromCache: !!(s.metadata && s.metadata.fromCache), hasPendingWrites: !!(s.metadata && s.metadata.hasPendingWrites) } };
  }
  const RANGE = ["<", "<=", ">", ">=", "!=", "not-in"];
  function buildDb(sdk, fs) {
    function docRef(path) {
      segs(path, true);
      const ref = () => sdk.doc(fs, path);
      const r = {
        id: path.split("/").pop(), path,
        get: () => sdk.getDoc(ref()).then(wrapSnap, e => { throw mapErr(e); }),
        set: data => { if (!isPlain(data)) return Promise.reject({ code: "invalid_argument", message: "Body must be an object" }); return sdk.setDoc(ref(), clone(data)).then(() => {}, e => { throw mapErr(e); }); },
        update: data => {
          if (!isPlain(data)) return Promise.reject({ code: "invalid_argument", message: "Body must be an object" });
          const pairs = [];
          (function flat(o, pre) { Object.keys(o).forEach(k => { const v = o[k]; if (v === undefined) return; if (isPlain(v) && Object.keys(v).length) flat(v, pre.concat(k)); else pairs.push([pre.concat(k), clone(v)]); }); })(data, []);
          if (!pairs.length) return sdk.getDoc(ref()).then(s => { if (!wrapSnap(s).exists) throw { code: "invalid_argument", message: "Document does not exist" }; }, e => { throw mapErr(e); });
          const args = [];
          pairs.forEach(([p, v]) => { args.push(new sdk.FieldPath(...p), v); });
          return sdk.updateDoc(ref(), ...args).then(() => {}, e => { throw mapErr(e); });
        },
        delete: () => sdk.deleteDoc(ref()).then(() => {}, e => { throw mapErr(e); }),
        acquire: o => Promise.resolve({ acquired: true, holder: o && o.holder, expiresAt: new Date(Date.now() + ((o && o.ttlMs) || 30000)).toISOString() }),
        onSnapshot: (next, error) => {
          let dead = false;
          const un = sdk.onSnapshot(ref(), s => { if (!dead) next(wrapSnap(s)); }, e => { if (dead) return; dead = true; const m = mapErr(e); if (error) error(m); else console.error("[Rwork] listener", path, m); });
          return () => { dead = true; un(); };
        },
        collection: c => colRef(path + "/" + c)
      };
      return r;
    }
    function colRef(path) {
      segs(path, false);
      function mk(filters, order, lim) {
        // Firestore needs a composite index when ordering by a field other than the range-filtered one.
        // In that case, order and limit on this side instead.
        const rangeField = (filters.find(f => RANGE.includes(f[1])) || [])[0];
        const clientSide = !!(order && rangeField && order[0] !== rangeField);
        function build() {
          const c = [];
          filters.forEach(f => c.push(sdk.where(f[0], f[1], f[2])));
          if (order && !clientSide) c.push(sdk.orderBy(order[0], order[1] || "asc"));
          if (lim && !clientSide) c.push(sdk.limit(lim));
          return sdk.query(sdk.collection(fs, path), ...c);
        }
        function wrapQ(qs) {
          let docs = qs.docs.map(wrapSnap);
          if (clientSide) {
            const [f, dir] = order, k = dir === "desc" ? -1 : 1;
            docs = docs.map(d => ({ d, v: d.data()[f] })).sort((a, b) => a.v === undefined ? 1 : b.v === undefined ? -1 : (a.v < b.v ? -1 : a.v > b.v ? 1 : 0) * k).map(x => x.d);
            if (lim) docs = docs.slice(0, lim);
          }
          const changes = typeof qs.docChanges === "function" ? qs.docChanges() : [];
          return { docs, size: docs.length, empty: !docs.length,
            docChanges: () => changes.map(ch => ({ type: ch.type, doc: wrapSnap(ch.doc), oldIndex: ch.oldIndex, newIndex: ch.newIndex })),
            metadata: { fromCache: !!(qs.metadata && qs.metadata.fromCache), hasPendingWrites: !!(qs.metadata && qs.metadata.hasPendingWrites) } };
        }
        return {
          path,
          where: (f, op, v) => { if (filters.length >= 10) throw new TypeError("Too many filters"); return mk(filters.concat([[f, op, v]]), order, lim); },
          orderBy: (f, dir) => mk(filters, [f, dir || "asc"], lim),
          limit: n => mk(filters, order, n),
          get: () => sdk.getDocs(build()).then(wrapQ, e => { throw mapErr(e); }),
          onSnapshot: (next, error) => {
            let dead = false;
            const un = sdk.onSnapshot(build(), qs => { if (!dead) next(wrapQ(qs)); }, e => { if (dead) return; dead = true; const m = mapErr(e); if (error) error(m); else console.error("[Rwork] listener", path, m); });
            return () => { dead = true; un(); };
          }
        };
      }
      const base = mk([], null, 0);
      base.doc = id => docRef(path + "/" + (id || sdk.doc(sdk.collection(fs, path)).id));
      base.add = data => { const r = base.doc(); return r.set(data).then(() => r); };
      return base;
    }
    return { doc: docRef, collection: colRef };
  }

  /* ---------- user namespace ---------- */
  function hashColor(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 45% 38%)`; }
  function initialsOf(n) { const p = String(n || "?").trim().split(/[\s@._-]+/).filter(Boolean); return ((p[0] || "?")[0] + (p.length > 1 ? p[1][0] : "")).toUpperCase(); }
  function avatar(name, color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="${color}"/><text x="32" y="41" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="#fff" text-anchor="middle">${escH(initialsOf(name))}</text></svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  function buildUser(email, staff, isOwner) {
    const emps = () => ((window.RW && RW.state && RW.state.employees) || []);
    const byId = id => emps().find(e => lower(e.userId) === id || lower(e.email) === id);
    const admin = isOwner || !!(staff && staff.admin && staff.active !== false);
    const writer = isOwner || !!(staff && staff.active !== false);
    const profile = id => { const e = byId(id); const name = e ? (e.name || "") : (id === email ? ((staff && staff.name) || "") : ""); const color = hashColor(id); return { id, name, avatarUrl: avatar(name || id, color), color, email: e || id === email ? id : null, isMe: id === email, guest: false }; };
    return {
      isOwner: async () => isOwner,
      canEdit: async () => admin,
      can: async n => n === "data.write" ? writer : (n === "files.write" || n === "assets.write") ? admin : false,
      id: async () => email,
      me: async () => { const p = profile(email); return { id: email, name: p.name, avatarUrl: p.avatarUrl, color: p.color, email, isOwner, canEdit: admin }; },
      name: async () => profile(email).name,
      email: async () => email,
      avatarUrl: async () => profile(email).avatarUrl,
      profiles: async ids => { const r = {}; [].concat(ids || []).forEach(i => { r[i] = Object.assign(profile(lower(i)), { id: i }); }); return r; },
      search: async q => {
        q = lower(q);
        return emps().filter(e => e.email && e.active !== false && (!q || lower(e.name).includes(q) || lower(e.email).includes(q))).slice(0, 8).map(e => profile(lower(e.email))).filter(p => p.name);
      }
    };
  }

  /* ---------- sign-in flow ---------- */
  let started = false;
  async function afterSignIn(fb, u) {
    const email = lower(u.email);
    if (!u.emailVerified) { showVerify(fb, email); return; }
    const isOwner = owners.includes(email);
    let staff = null;
    try { const s = await fb.sdk.getDoc(fb.sdk.doc(fb.fs, "staff/" + email)); const w = wrapSnap(s); staff = w.exists ? w.data() : null; }
    catch (e) { if (!/permission-denied/.test(String(e && e.code))) { showFatal("The database couldn't be reached (" + ((e && e.message) || e) + ")."); return; } }
    if (!isOwner && !(staff && staff.active !== false)) { showDenied(fb, email); return; }
    if (started) { location.reload(); return; }
    started = true;
    const db = buildDb(fb.sdk, fb.fs), user = buildUser(email, staff, isOwner);
    window.RWORK_FIREBASE = true;
    window.claude = Object.freeze({ use: n => Promise.resolve(n === "db" ? db : n === "user" ? user : null) });
    hideScreen();
    const so = $("#signOutBtn");
    if (so) { so.hidden = false; so.onclick = () => fb.signOut(); }
    openGate();
  }
  async function start(fb) {
    fb.onAuth(u => {
      if (!u) { if (started) { location.reload(); return; } showLogin(fb, "signin"); return; }
      if (pendingSignupNote && !u.emailVerified) { pendingSignupNote = false; showVerify(fb, lower(u.email)); return; }
      afterSignIn(fb, u).catch(e => showFatal((e && e.message) || String(e)));
    });
  }

  /* ---------- real Firebase SDK ---------- */
  async function loadRealSdk() {
    const base = "https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/";
    const [appM, authM, fsM] = await Promise.all([import(base + "firebase-app.js"), import(base + "firebase-auth.js"), import(base + "firebase-firestore.js")]);
    const app = appM.initializeApp(fbc);
    const auth = authM.getAuth(app);
    const fs = fsM.initializeFirestore(app, { ignoreUndefinedProperties: true });
    const cur = () => auth.currentUser;
    const wrapU = u => u ? { email: u.email, emailVerified: !!u.emailVerified } : null;
    return {
      sdk: fsM, fs,
      onAuth: cb => authM.onAuthStateChanged(auth, u => cb(wrapU(u))),
      signIn: (e, p) => authM.signInWithEmailAndPassword(auth, e, p),
      signUp: (e, p) => authM.createUserWithEmailAndPassword(auth, e, p),
      sendVerify: () => cur() ? authM.sendEmailVerification(cur()) : Promise.resolve(),
      reloadUser: async () => { if (!cur()) return null; await cur().reload(); return wrapU(cur()); },
      refreshToken: () => cur() ? cur().getIdToken(true) : Promise.resolve(),
      reset: e => authM.sendPasswordResetEmail(auth, e),
      signOut: () => authM.signOut(auth)
    };
  }

  function go() {
    if (!configured) { showSetup(); return; }
    screen(`<p class="auth-muted">Loading…</p>`);
    Promise.resolve(window.RWORK_FIREBASE_ADAPTER || loadRealSdk()).then(start, e => showFatal("Firebase couldn't load: " + ((e && e.message) || e)));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
  window.RWORK_INTERNAL = { buildDb, buildUser, mapErr };
})();
