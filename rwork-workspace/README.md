# Rwork Workspace: setup guide

Rwork is your team's workspace for projects, tasks, clients, content, ads, websites, timesheets, chat and leave. This folder is the whole app. It runs in any web browser. Logins and data are stored in your own Firebase project, **rwork2027**.

The Firebase settings are already in `js/config.js`. The steps below take about 15 minutes and you only do them once.

---

## Step 1: Turn on email and password sign-in

1. Go to **https://console.firebase.google.com** and open the **rwork2027** project.
2. In the left menu, click **Build → Authentication**, then **Get started**.
3. Open the **Sign-in method** tab, click **Email/Password**, switch on the **first** toggle only, then click **Save**.

## Step 2: Create the database

1. In the left menu, click **Build → Firestore Database**, then **Create database**.
2. For location, choose **asia-south1 (Mumbai)**. This can't be changed later.
3. Choose **Start in production mode**, then click **Create**.

## Step 3: Set yourself as the owner

The owner is always an admin and can add everyone else. You need to change two files.

1. Open `js/config.js` in a text editor such as Notepad, or in GitHub's ✏️ editor. Find this line:
   ```
   ownerEmails: ["rworkrahult@gmail.com"]
   ```
   Replace `rworkrahult@gmail.com` with **your own email, in lowercase**, for example `["ravi@gmail.com"]`. Save the file.
2. Open `firestore.rules`. Find this line:
   ```
   function ownerEmails() { return ['rworkrahult@gmail.com']; }
   ```
   Put the **same email** in place of `rworkrahult@gmail.com`. Save the file.

If you want two owners, separate them with commas, like this: `["a@gmail.com", "b@gmail.com"]`.

## Step 4: Protect the data (security rules)

1. In Firebase, go to **Firestore Database → Rules**.
2. Delete everything in the box.
3. Paste in the whole of `firestore.rules`, including your email from Step 3.
4. Click **Publish**.

These rules make sure that:
- only people HR has added can see anything;
- only admins can change people, clients, projects, settings and leave approvals;
- only admins can see invoices and retainer amounts.

## Step 5: Put the app online

### Option A: GitHub Pages (easiest; you only need a browser)

1. On **github.com**, click **+ → New repository**. Name it `rwork-workspace`. Choose **Private** if your plan supports Pages for private repositories; otherwise choose **Public**. Click **Create repository**.
2. Click **uploading an existing file**. Drag in **everything inside this folder**: `index.html` and the `css`, `js` and `img` folders, plus the other files. Click **Commit changes**.
3. Go to **Settings → Pages**. Under **Branch**, choose **main** and **/ (root)**, then click **Save**.
4. Wait 1–2 minutes. Your address is shown at the top of that page, for example **https://rahulthangeda-dotcom.github.io/rwork-workspace/**.
5. Allow that address in Firebase so people can log in from it:
   1. Go to **Authentication → Settings → Authorized domains → Add domain**.
   2. Type `rahulthangeda-dotcom.github.io` (no `https://`, no `/rwork-workspace`).
   3. Click **Add**.

Even if the repository is public, your data stays private. The files only contain the app's screens. Every record lives in Firebase, which is protected by the rules from Step 4.

### Option B: Firebase Hosting (address https://rwork2027.web.app)

This option needs a computer with Node.js installed.

1. Open a terminal in this folder.
2. Run `npm install -g firebase-tools`.
3. Run `firebase login`.
4. Run `firebase deploy`.

The app will then be at **https://rwork2027.web.app**. Running `firebase deploy` also uploads the security rules for you.

---

## Step 6: First login, then add your team

1. Open your app's address. Click **First time here**, enter your owner email and choose a password.
2. Firebase sends you a **verification email**. Click the link in it, then click **"I've verified my email"**. If you can't find the email, check your Spam and Promotions folders.
3. You're in as an admin.
   1. Go to **Settings**: check the leave quotas and add this year's holidays.
   2. Go to **People → Add employee** for each person, with their **login email** (personal Gmail or Yahoo addresses are fine). Choose **HR admin**, **Operations admin** or **Management admin** for people who should manage the workspace.
4. Send everyone the address. Each person:
   1. clicks **First time here**;
   2. uses the email you entered for them and picks a password;
   3. verifies their email.

Day to day:
- **Forgotten passwords:** the person uses **Forgot password** on the sign-in page.
- **When someone leaves:** edit them in People and set **Status → Inactive**. They can no longer get in.
- **When you get company emails:** edit each person and change their login email. They then use **First time here** with the new email.

## Later: using your own address (app.rwork.in)

You need to own a domain to do this. Whoever manages your website can set it up in about 10 minutes:
- **On GitHub Pages:** go to **Settings → Pages → Custom domain**.
- **On Firebase Hosting:** go to **Hosting → Add custom domain**.

Afterwards, add the new address under **Authentication → Authorized domains**.

## Backups

Firebase keeps your data safe. For an extra copy, you can export the database from **Firestore Database → Import/Export**, which needs the paid Blaze plan, or use the **Copy CSV** buttons in the app: Tasks, Leave, Timesheets and others have them.

## Costs

Firebase's free **Spark** plan easily covers a team of 20: it allows 50,000 reads a day, 20,000 writes a day and 1 GB of storage. You don't need a credit card.

## What's in this folder

| File | What it is |
|---|---|
| `index.html`, `css/`, `img/` | The app's page, its look, and the Rwork logo |
| `js/config.js` | Firebase settings and the owner email (**Step 3**) |
| `js/firebase-shim.js` | The sign-in screens and the database connection |
| `js/core.js`, `js/m-*.js` | The app itself: one file per section |
| `firestore.rules` | The security rules (**Step 4**) |
| `firebase.json`, `.firebaserc`, `firestore.indexes.json` | Used only by Option B |
| `MODULES.md` | Notes for developers |
