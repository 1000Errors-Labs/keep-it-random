// app.js — polyphonic subtractive synth + FX chain driven by MIDI CC from the FM1 firmware
//
// Navigation (ENV button cycles pages, EDIT flips sub-pages):
//   ENV → SEQ page → SYNTH FILT page → FX DLY page → (back to SEQ)
//   EDIT on SYNTH → flip FILT ↔ AMP
//   EDIT on FX    → flip DLY+VERB ↔ DRIVE+FX
//
// Synth CCs (firmware → app.js on encoder turns or before first note)
// FX CCs (same mechanism, CCs 80-93)
"use strict";

// ── CC map (must match app.c defines) ────────────────────────────────────────
const SYNTH_CC = {
  20:"osc1Wave", 21:"osc2Wave", 22:"osc2Det", 23:"osc2Level",
  74:"filtCut",  71:"filtRes",  24:"filtAmt",
  25:"filtAtk",  26:"filtDec",  27:"filtSus",  28:"filtRel",
  73:"ampAtk",   75:"ampDec",   29:"ampSus",   72:"ampRel",
};
const FX_CC = {
  80:"dlyTime",  81:"dlyFback", 82:"dlyMix",
  83:"verbSize", 84:"verbDec",  85:"verbMix",  86:"verbDamp",
  87:"drive",    88:"driveMix",
  89:"bits",     90:"bitsRate", 91:"bitsMix",
  92:"chorRate", 93:"chorMix",
};

// ── Synth params (mirrors firmware defaults) ──────────────────────────────────
const P = {
  osc1Wave:0, osc2Wave:0, osc2Det:-7, osc2Level:60,
  filtCut:55, filtRes:40, filtAmt:80,
  filtAtk:15, filtDec:55, filtSus:25, filtRel:45,
  ampAtk:5,   ampDec:30,  ampSus:65,  ampRel:45,
};

// ── FX params (mirrors firmware defaults) ─────────────────────────────────────
const FX = {
  dlyTime:64,  dlyFback:40, dlyMix:0,
  verbSize:60, verbDec:50,  verbMix:30, verbDamp:70,
  drive:0,     driveMix:0,
  bits:127,    bitsRate:0,  bitsMix:0,
  chorRate:30, chorMix:0,
};

const WAVE_TYPE = ["sawtooth","square","triangle","sine"];
const MAX_VOICES = 8;
const voices = new Map();
let _ac = null, _bus = null;

// FX nodes
let _dlyNode = null, _dlyFback = null, _dlyWet = null;
let _reverb   = null, _verbWet = null;
let _drive    = null, _driveWet = null;
let _crusher  = null, _crusherWet = null;
let _chorus   = null, _chorusMod = null, _chorusWet = null;

// ── Scaling helpers ───────────────────────────────────────────────────────────
const cutoffHz = v => 80 * Math.pow(18000 / 80, v / 127);
const toQ      = v => 0.5 + (v / 127) * 17.5;
const toAmt    = v => (v / 127) * 5;
const toSec    = v => 0.001 * Math.pow(3000, v / 127);
const toFrac   = v => v / 100;
const toMix    = v => v / 127;

// ── Voice ─────────────────────────────────────────────────────────────────────
function Voice(ac, freq, vel, dest) {
  const now = ac.currentTime;
  const v   = (vel / 127) * 0.38;

  const o1 = ac.createOscillator();
  o1.type = WAVE_TYPE[P.osc1Wave & 3];
  o1.frequency.value = freq;

  const o2 = ac.createOscillator();
  o2.type = WAVE_TYPE[P.osc2Wave & 3];
  o2.frequency.value = freq;
  o2.detune.value = P.osc2Det;

  const g1 = ac.createGain(); g1.gain.value = 1 - P.osc2Level / 100;
  const g2 = ac.createGain(); g2.gain.value = P.osc2Level / 100;

  const filt = ac.createBiquadFilter();
  filt.type = "lowpass";
  filt.Q.value = toQ(P.filtRes);

  const base  = cutoffHz(P.filtCut);
  const peak  = base * Math.pow(2, toAmt(P.filtAmt));
  const sustF = Math.max(40, base * (0.08 + 0.92 * toFrac(P.filtSus)));
  const fAtk  = toSec(P.filtAtk);
  const fDec  = toSec(P.filtDec);
  filt.frequency.setValueAtTime(base, now);
  filt.frequency.linearRampToValueAtTime(peak, now + fAtk);
  filt.frequency.exponentialRampToValueAtTime(Math.max(40, sustF), now + fAtk + fDec);

  const amp = ac.createGain();
  const aAtk = toSec(P.ampAtk), aDec = toSec(P.ampDec);
  amp.gain.setValueAtTime(0, now);
  amp.gain.linearRampToValueAtTime(v, now + aAtk);
  amp.gain.linearRampToValueAtTime(v * toFrac(P.ampSus), now + aAtk + aDec);

  o1.connect(g1); o2.connect(g2);
  g1.connect(filt); g2.connect(filt);
  filt.connect(amp);
  amp.connect(dest);
  o1.start(now); o2.start(now);

  let stopped = false;
  this.stop = function (t) {
    if (stopped) return; stopped = true;
    const rel = toSec(P.ampRel);
    amp.gain.cancelScheduledValues(t);
    amp.gain.setValueAtTime(amp.gain.value, t);
    amp.gain.linearRampToValueAtTime(0.0001, t + rel);
    filt.frequency.cancelScheduledValues(t);
    filt.frequency.setValueAtTime(filt.frequency.value, t);
    filt.frequency.exponentialRampToValueAtTime(40, t + toSec(P.filtRel));
    o1.stop(t + rel + 0.05); o2.stop(t + rel + 0.05);
  };
}

function noteOn(note, vel) {
  if (!_ac || !_bus) return;
  if (voices.size >= MAX_VOICES) {
    const k = voices.keys().next().value;
    voices.get(k).stop(_ac.currentTime); voices.delete(k);
  }
  if (voices.has(note)) { voices.get(note).stop(_ac.currentTime); voices.delete(note); }
  voices.set(note, new Voice(_ac, 440 * Math.pow(2, (note - 69) / 12), vel, _bus));
}
function noteOff(note) {
  if (!_ac || !voices.has(note)) return;
  voices.get(note).stop(_ac.currentTime); voices.delete(note);
}

// ── FX node updaters ──────────────────────────────────────────────────────────
function applyDelay() {
  if (!_dlyNode) return;
  _dlyNode.delayTime.value = 0.001 + (FX.dlyTime / 127) * 0.999; // 1ms–1000ms
  _dlyFback.gain.value     = Math.min(0.92, FX.dlyFback / 134);
  _dlyWet.gain.value       = toMix(FX.dlyMix);
}

let _verbTimer = null;
function applyReverb() {
  if (!_reverb) return;
  _verbWet.gain.value = toMix(FX.verbMix);
  clearTimeout(_verbTimer);
  _verbTimer = setTimeout(rebuildIR, 180);
}
function rebuildIR() {
  if (!_ac || !_reverb) return;
  const size  = FX.verbSize / 127;
  const decay = FX.verbDec  / 127;
  const damp  = FX.verbDamp / 127;
  const len   = Math.floor(_ac.sampleRate * (0.3 + size * 4));
  const ir    = _ac.createBuffer(2, len, _ac.sampleRate);
  const lpAlpha = 1 - damp * 0.9;
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, 1 + (1 - decay) * 8);
      lp = lpAlpha * (Math.random() * 2 - 1) * env + (1 - lpAlpha) * lp;
      d[i] = lp;
    }
  }
  _reverb.buffer = ir;
}

function applyDrive() {
  if (!_drive) return;
  const d = FX.drive / 127;
  const gain = 1 + d * 40;
  const curve = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    const x = (i * 2 / 511) - 1;
    curve[i] = Math.tanh(gain * x) / Math.tanh(gain);
  }
  _drive.curve = curve;
  _driveWet.gain.value = toMix(FX.driveMix);
}

function applyCrusher() {
  if (!_crusher) return;
  const bits = Math.max(1, Math.round(1 + (FX.bits / 127) * 15));
  const rate = Math.max(1, Math.round(1 + (FX.bitsRate / 127) * 63));
  _crusher.port.postMessage({ bits, rate });
  _crusherWet.gain.value = toMix(FX.bitsMix);
}

function applyChorus() {
  if (!_chorus || !_chorusMod) return;
  _chorusMod.frequency.value = 0.1 + (FX.chorRate / 127) * 3;
  _chorusWet.gain.value = toMix(FX.chorMix);
}

// ── CC handling ───────────────────────────────────────────────────────────────
function handleCC(cc, val) {
  if (SYNTH_CC[cc] !== undefined) {
    const key = SYNTH_CC[cc];
    P[key] = (key === "osc2Det") ? val - 64 : val;
    return;
  }
  if (FX_CC[cc] !== undefined) {
    FX[FX_CC[cc]] = val;
    // apply immediately
    if (cc >= 80 && cc <= 82) applyDelay();
    else if (cc >= 83 && cc <= 86) applyReverb();
    else if (cc === 87 || cc === 88) applyDrive();
    else if (cc >= 89 && cc <= 91) applyCrusher();
    else applyChorus();
  }
}

// ── Bit-crusher AudioWorklet (inline blob) ────────────────────────────────────
const CRUSHER_WORKLET = `
class BitCrusherProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bits = 16; this._rate = 1; this._phase = 0; this._last = 0;
    this.port.onmessage = e => {
      if (e.data.bits !== undefined) this._bits = e.data.bits;
      if (e.data.rate !== undefined) this._rate = e.data.rate;
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0]; const out = outputs[0];
    for (let ch = 0; ch < out.length; ch++) {
      const i = inp[ch] || out[ch]; const o = out[ch];
      const step = 2 / Math.pow(2, this._bits - 1);
      for (let n = 0; n < o.length; n++) {
        this._phase += 1 / this._rate;
        if (this._phase >= 1) {
          this._phase -= 1;
          this._last = step * Math.floor(i[n] / step + 0.5);
        }
        o[n] = this._last;
      }
    }
    return true;
  }
}
registerProcessor('fm1-bit-crusher', BitCrusherProcessor);
`;

// ── FX chain setup ────────────────────────────────────────────────────────────
function setupFX(ac, src, dest) {
  // All effects run in parallel from src, wet signals summed at dest

  // ── Delay
  _dlyNode  = ac.createDelay(1.1);
  _dlyFback = ac.createGain();
  const dlyLp = ac.createBiquadFilter();
  dlyLp.type = "lowpass"; dlyLp.frequency.value = 4000;
  _dlyWet = ac.createGain();

  src.connect(_dlyNode);
  _dlyNode.connect(dlyLp);
  dlyLp.connect(_dlyFback);
  _dlyFback.connect(_dlyNode);   // feedback
  _dlyNode.connect(_dlyWet);
  _dlyWet.connect(dest);
  applyDelay();

  // ── Reverb
  _reverb  = ac.createConvolver();
  _verbWet = ac.createGain();
  src.connect(_reverb);
  _reverb.connect(_verbWet);
  _verbWet.connect(dest);
  rebuildIR();                   // builds initial impulse response

  // ── Overdrive
  _drive    = ac.createWaveShaper();
  _drive.oversample = "4x";
  _driveWet = ac.createGain();
  src.connect(_drive);
  _drive.connect(_driveWet);
  _driveWet.connect(dest);
  applyDrive();

  // ── Chorus  (LFO → delay.delayTime, slight feedback)
  _chorus    = ac.createDelay(0.06);
  _chorus.delayTime.value = 0.02;
  _chorusMod = ac.createOscillator();
  _chorusMod.type = "sine";
  const chorusDepth = ac.createGain();
  chorusDepth.gain.value = 0.007;       // ±7ms depth
  _chorusMod.connect(chorusDepth);
  chorusDepth.connect(_chorus.delayTime);
  _chorusMod.start();
  _chorusWet = ac.createGain();
  src.connect(_chorus);
  _chorus.connect(_chorusWet);
  _chorusWet.connect(dest);
  applyChorus();

  // ── Bit crusher (AudioWorklet, async — adds itself once loaded)
  const blob = new Blob([CRUSHER_WORKLET], { type: "application/javascript" });
  const url  = URL.createObjectURL(blob);
  ac.audioWorklet.addModule(url).then(() => {
    URL.revokeObjectURL(url);
    _crusher    = new AudioWorkletNode(ac, "fm1-bit-crusher");
    _crusherWet = ac.createGain();
    src.connect(_crusher);
    _crusher.connect(_crusherWet);
    _crusherWet.connect(dest);
    applyCrusher();
  }).catch(console.error);
}

// ── Reference panel ───────────────────────────────────────────────────────────
function injectRef() {
  const s = document.createElement("style");
  s.textContent = `
.fm1ref{margin:1.8rem 0 0;font-size:.88rem;color:var(--ink)}
.fm1ref h3{font:600 1rem "Barlow Semi Condensed","Barlow",sans-serif;margin:0 0 .5rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.fm1ref .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem 2rem;margin:0 0 1.2rem}
.fm1ref table{border-collapse:collapse;width:100%}
.fm1ref td,.fm1ref th{padding:.18em .5em;text-align:left;vertical-align:top}
.fm1ref th{color:var(--muted);font-weight:600;border-bottom:1px solid var(--rule);white-space:nowrap}
.fm1ref td:first-child{white-space:nowrap;font-weight:600;color:var(--accent)}
.fm1ref .tag{display:inline-block;font:600 .78rem ui-monospace,monospace;background:var(--card);border:1px solid var(--rule);border-radius:4px;padding:0 .3em;color:var(--ink)}
.fm1ref details summary{cursor:pointer;color:var(--muted);font-weight:600;font-size:.92rem;margin:0 0 .6rem}
.fm1ref details[open] summary{margin:0 0 .8rem}
`;
  document.head.appendChild(s);

  const nav = [
    ["ENV","Cycle: SEQ → SYNTH → FX → SEQ"],
    ["EDIT","On SYNTH: flip Filter ↔ Amp  |  On FX: flip Dly/Verb ↔ Drive/FX"],
    ["SEQ","Go to SEQ page directly"],
    ["PLAY","Start / Stop"],
    ["REC","Record-arm current step"],
    ["SAVE","Save to flash"],
    ["HOME","Return to top of sequence"],
    ["ARP","Toggle arpeggiator"],
    ["SEL","Select / confirm"],
    ["GLO","Global settings"],
    ["LFO","LFO settings"],
    ["FX","(reserved — use ENV to reach FX page)"],
    ["OCT−/+","Shift keyboard octave"],
  ];

  const pages = [
    ["SEQ","KNOB1-4: step params  SELECT: pattern  ALGORITHM: scale  PRESETS: root"],
    ["SYNTH FILT","KNOB1: Cutoff  KNOB2: Resonance  KNOB3: Filter Env Amt  KNOB4: Osc2 Level\nSELECT: Osc1 wave  ALGORITHM: Osc2 wave  PRESETS: Osc2 detune"],
    ["SYNTH AMP","KNOB1: Amp Atk  KNOB2: Amp Dec  KNOB3: Amp Sus  KNOB4: Amp Rel\n(EDIT to swap Filter ADSR: Flt Atk / Dec / Sus / Rel)"],
    ["FX DLY","KNOB1: Dly Time  KNOB2: Feedback  KNOB3: Dly Mix  KNOB4: Verb Size\nSELECT: Verb Decay  ALGORITHM: Verb Mix  PRESETS: Verb Damp"],
    ["FX DRIVE","KNOB1: Drive  KNOB2: Drive Mix  KNOB3: Bit Depth  KNOB4: Bit Rate\nSELECT: Bit Mix  ALGORITHM: Chorus Rate  PRESETS: Chorus Mix"],
  ];

  const html = `<div class="fm1ref">
<details open>
<summary>Quick Reference</summary>
<div class="grid">
<div>
<h3>Buttons</h3>
<table><thead><tr><th>Button</th><th>What it does</th></tr></thead><tbody>
${nav.map(([k,v])=>`<tr><td><span class="tag">${k}</span></td><td>${v}</td></tr>`).join("")}
</tbody></table>
</div>
<div>
<h3>Pages &amp; Encoders</h3>
<table><thead><tr><th>Page</th><th>Encoders (KNOB1–4 + SELECT/ALGO/PRESETS)</th></tr></thead><tbody>
${pages.map(([k,v])=>`<tr><td><span class="tag">${k}</span></td><td>${v.replace(/\n/g,"<br>")}</td></tr>`).join("")}
</tbody></table>
</div>
</div>
<div class="grid">
<div>
<h3>Mouse / Keyboard</h3>
<table><tbody>
<tr><td><span class="tag">Click</span></td><td>Hold button / play key</td></tr>
<tr><td><span class="tag">Right-click or Shift-click</span></td><td>Latch a button (toggle hold)</td></tr>
<tr><td><span class="tag">Arrow keys on a knob</span></td><td>Turn one step</td></tr>
<tr><td><span class="tag">PgUp / PgDn on a knob</span></td><td>Turn fast</td></tr>
</tbody></table>
</div>
<div>
<h3>FX defaults (all dry until turned up)</h3>
<table><tbody>
<tr><td><span class="tag">Delay</span></td><td>Dly Mix = 0 — turn KNOB3 on FX DLY page</td></tr>
<tr><td><span class="tag">Reverb</span></td><td>Verb Mix = 30 — audible by default</td></tr>
<tr><td><span class="tag">Drive</span></td><td>Drive Mix = 0 — turn KNOB2 on FX DRIVE page</td></tr>
<tr><td><span class="tag">Bit crush</span></td><td>Bit Mix = 0 — turn KNOB4 on FX DRIVE page</td></tr>
<tr><td><span class="tag">Chorus</span></td><td>Chorus Mix = 0 — turn PRESETS on FX DRIVE page</td></tr>
</tbody></table>
</div>
</div>
</details>
</div>`;

  const main = document.querySelector("main");
  if (main) main.insertAdjacentHTML("beforeend", html);
}

// ── Exports called by index.html ──────────────────────────────────────────────
export function attach({ node: _node, ac }) {
  _ac = ac;
  injectRef();

  // Compressor bus — voices connect here
  _bus = ac.createDynamicsCompressor();
  _bus.threshold.value = -14; _bus.knee.value = 6;
  _bus.ratio.value = 4; _bus.attack.value = 0.003; _bus.release.value = 0.12;

  // Dry path: bus → output directly
  _bus.connect(ac.destination);

  // FX sends (parallel, from bus)
  setupFX(ac, _bus, ac.destination);
}

export function message(m) {
  if (!m || m.sub !== "midi") return;
  const pkt = m.pkt >>> 0;
  const st  = (pkt >>> 8)  & 0xFF;
  const b1  = (pkt >>> 16) & 0xFF;
  const b2  = (pkt >>> 24) & 0xFF;
  const t   = st & 0xF0;
  if      (t === 0x90 && b2 > 0) noteOn(b1, b2);
  else if (t === 0x80 || (t === 0x90 && b2 === 0)) noteOff(b1);
  else if (t === 0xB0) handleCC(b1, b2);
}
