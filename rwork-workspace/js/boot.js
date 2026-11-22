"use strict";
/* Runs after every module file has called RW.register(). Waits for sign-in (js/firebase-shim.js) first. */
Promise.resolve(window.RWORK_GATE).then(() => RW.boot());
