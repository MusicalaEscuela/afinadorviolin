/* =========================================================
   Afinador de Violín — Musicala (medidor lineal)
   - “AFINADO” cuando |cents| <= 5 (banda verde).
   - Sin controles de suavizado ni puerta de ruido visibles.
   ========================================================= */

'use strict';

const UI = {
  btnMic: document.getElementById('btnMic'),
  mode: document.getElementById('mode'),
  a4: document.getElementById('a4'),
  a4Val: document.getElementById('a4Val'),

  indicator: document.getElementById('indicator'),
  note: document.getElementById('note'),
  freq: document.getElementById('freq'),
  cents: document.getElementById('cents'),
  targetNote: document.getElementById('targetNote'),
  targetFreq: document.getElementById('targetFreq'),
  levelBar: document.getElementById('levelBar'),
  status: document.getElementById('status'),
  display: document.getElementById('displayCard'),
  badgeOk: document.getElementById('badgeOk'),
};

const STATE = {
  ctx: null, analyser: null, source: null, data: null,
  running: false, a4: 440,
  internalSmoothing: 0.5,   // estabilidad visual
  noiseGateRMS: 0.015,      // umbral fijo para ruido ambiente
  lastHz: 0,
};

const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const VIOLIN_STRINGS = [
  { name: 'G3', hz: 196.00 },
  { name: 'D4', hz: 293.66 },
  { name: 'A4', hz: 440.00 },
  { name: 'E5', hz: 659.25 },
];

/* ===== Utilidades ===== */
const hzToNoteNumber = (hz,a4=440)=> 69 + 12 * Math.log2(hz/a4);
const noteNumberToHz = (n,a4=440)=> a4 * Math.pow(2,(n-69)/12);
function noteNameFromNumber(n){
  const i = Math.round(n);
  const name = NOTE_NAMES[(i % 12 + 12) % 12];
  const octave = Math.floor(i/12) - 1;
  return `${name}${octave}`;
}
function nearestViolinString(hz){
  let best = VIOLIN_STRINGS[0], min = Infinity;
  for (const s of VIOLIN_STRINGS){ const d = Math.abs(hz - s.hz); if (d < min){min=d; best=s;} }
  return best;
}
const centsOff = (hz,target)=> 1200 * Math.log2(hz/target);
const smooth = (o,n,a)=> (!o? n : o*a + n*(1-a));

/* ===== Pitch detection (autocorrelación con refinamiento) ===== */
function detectPitchACF(buf, sr, gate=0.015){
  let rms=0; for (let i=0;i<buf.length;i++){ rms += buf[i]*buf[i]; }
  rms = Math.sqrt(rms/buf.length);
  if (rms < gate) return null;

  const minLag = Math.floor(sr / 1200);
  const maxLag = Math.floor(sr / 80);

  let bestLag=-1, bestCorr=0;
  for (let lag=minLag; lag<=maxLag; lag++){
    let c=0;
    for (let i=0;i<buf.length-lag;i++){ c += buf[i]*buf[i+lag]; }
    if (c>bestCorr){ bestCorr=c; bestLag=lag; }
  }
  if (bestLag<=0) return null;

  const y = L => { let c=0; for(let i=0;i<buf.length-L;i++){ c+=buf[i]*buf[i+L]; } return c; };
  const y1=y(bestLag-1), y2=y(bestLag), y3=y(bestLag+1);
  const denom=(y1 - 2*y2 + y3);
  let shift=0; if (denom!==0){ shift = 0.5 * (y1 - y3) / denom; }
  const refinedLag = bestLag + shift;
  const f = sr / refinedLag;
  return (isFinite(f) && f>0) ? f : null;
}

/* ===== Audio ===== */
async function startAudio(){
  if (STATE.running) return;
  try{
    STATE.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false }
    });
    STATE.source = STATE.ctx.createMediaStreamSource(stream);
    STATE.analyser = STATE.ctx.createAnalyser();
    STATE.analyser.fftSize = 2048;
    STATE.analyser.smoothingTimeConstant = 0;

    STATE.source.connect(STATE.analyser);
    STATE.data = new Float32Array(STATE.analyser.fftSize);

    STATE.running = true;
    UI.status.textContent = 'Escuchando… toca una cuerda.';
    UI.btnMic.textContent = '✅ Micrófono activo';
    UI.btnMic.classList.add('secondary');
    loop();
  }catch(e){
    console.error(e);
    UI.status.textContent = 'No se pudo acceder al micrófono. Verifica permisos y HTTPS.';
  }
}

function updateLinearIndicator(cents){
  // mapear -50 → 0%, +50 → 100%
  const clamped = Math.max(-50, Math.min(50, cents));
  const pct = (clamped + 50) / 100 * 100; // 0..100
  UI.indicator.style.left = pct + '%';
}

function loop(){
  if (!STATE.running) return;

  STATE.analyser.getFloatTimeDomainData(STATE.data);
  const sr = STATE.ctx.sampleRate;
  const hzRaw = detectPitchACF(STATE.data, sr, STATE.noiseGateRMS);

  // Nivel
  let peak = 0; for (let i=0;i<STATE.data.length;i++){ peak = Math.max(peak, Math.abs(STATE.data[i])); }
  UI.levelBar.style.width = Math.min(100, Math.round(peak*200)) + '%';

  if (hzRaw){
    const hz = smooth(STATE.lastHz, hzRaw, STATE.internalSmoothing);
    STATE.lastHz = hz;

    const a4 = STATE.a4;
    let targetHz, targetLabel;

    if (UI.mode.value === 'violin'){
      const s = nearestViolinString(hz);
      targetHz = s.hz * (a4/440);
      targetLabel = s.name;
    }else{
      const n = Math.round(hzToNoteNumber(hz, a4));
      targetHz = noteNumberToHz(n, a4);
      targetLabel = noteNameFromNumber(n);
    }

    const det = centsOff(hz, targetHz);
    updateLinearIndicator(det);

    // Estados visuales
    const abs = Math.abs(det);
    UI.display.classList.remove('good','warn','bad');
    if (abs <= 5) UI.display.classList.add('good');
    else if (abs <= 15) UI.display.classList.add('warn');
    else UI.display.classList.add('bad');

    UI.badgeOk.classList.toggle('hidden', !(abs <= 5));

    // Lecturas
    UI.note.textContent = noteNameFromNumber(hzToNoteNumber(hz, a4));
    UI.freq.textContent = hz.toFixed(2);
    UI.cents.textContent = det.toFixed(1);
    UI.targetNote.textContent = targetLabel;
    UI.targetFreq.textContent = `(${targetHz.toFixed(2)} Hz)`;
  }else{
    UI.display.classList.remove('good','warn','bad');
    UI.badgeOk.classList.add('hidden');
    UI.note.textContent = '--';
    UI.freq.textContent = '0.00';
    UI.cents.textContent = '0.0';
    UI.targetNote.textContent = '--';
    UI.targetFreq.textContent = '';
    updateLinearIndicator(0);
  }

  requestAnimationFrame(loop);
}

/* ===== Eventos ===== */
UI.btnMic.addEventListener('click', startAudio);
UI.a4.addEventListener('input', e => { STATE.a4 = +e.target.value; UI.a4Val.textContent = STATE.a4.toFixed(0); });

if (location.protocol !== 'https:' && location.hostname !== 'localhost'){
  UI.status.textContent = 'Para usar el micrófono, abre esta página en HTTPS (GitHub Pages funciona perfecto).';
}
