// app_worklet.js — runs inside the AudioWorklet alongside worklet.js
// Reads MIDI output from the built-in emu_web.c buffer (web_out_n / web_out_pkts /
// web_out_clear) and posts { type:"app", sub:"midi", pkt } messages to the main page.
// app.js (the main-thread side) synthesises the notes with Web Audio.
"use strict";
globalThis.fm1App = {
  process(fm1) {
    const ex = fm1.ex;
    if (!ex || !ex.web_out_n) return;
    const n = ex.web_out_n();
    if (!n) return;
    const ptr  = ex.web_out_pkts();
    const pkts = new Uint32Array(fm1.mem.buffer, ptr, n);
    for (let i = 0; i < n; i++) {
      fm1.port.postMessage({ type: "app", sub: "midi", pkt: pkts[i] >>> 0 });
    }
    ex.web_out_clear();
  }
};
