/* ============================================================
   RWORK SETTINGS — fill these in once (see README.md, step 3).
   ============================================================
   1. firebase: paste the values Firebase shows you under
      Project settings → General → Your apps → SDK setup and configuration → Config.
      These values are meant to be public; your data is protected by firestore.rules.
   2. ownerEmails: the email(s) that are always admin, even before anyone is added
      in People. Use lowercase. Put the SAME email(s) in firestore.rules.
*/
window.RWORK_CONFIG = {
  firebase: {
    apiKey: "AIzaSyBp5N6sp0caRM7DBVY1ct7ZZm9hhGZaIos",
    authDomain: "rwork2027.firebaseapp.com",
    projectId: "rwork2027",
    storageBucket: "rwork2027.firebasestorage.app",
    messagingSenderId: "99519310420",
    appId: "1:99519310420:web:ece8aa9c5c424d00e49bc1"
  },
  // ▼▼▼ OWNER EMAIL: replace rworkrahult@gmail.com with your own email (lowercase). Same email in firestore.rules. ▼▼▼
  ownerEmails: ["rworkrahult@gmail.com"]
};
