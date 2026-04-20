/* ============================================================
   GasSense Pro — app.js
   Firebase project : smart-industrial-alarm
   DB path          : sensorData/
   Field auto-map   : gas→mq2, temperature→temp, humidity→hum
   ============================================================ */

'use strict';

// ════════════════════════════════════════════════════════════
//  🔥 FIREBASE CONFIG  (smart-industrial-alarm)
// ════════════════════════════════════════════════════════════
const FIREBASE_CONFIG = {
  apiKey:        "AIzaSyBztHOggL1GNf-eMZ6GMaB_zEBwNy6PP1g",
  authDomain:    "smart-industrial-alarm.firebaseapp.com",
  databaseURL:   "https://smart-industrial-alarm-default-rtdb.firebaseio.com",
  projectId:     "smart-industrial-alarm",
  storageBucket: "smart-industrial-alarm.appspot.com",
};

// DB path — matches the Node server: ref(db, 'sensorData')
const FB_LIVE_PATH = 'sensorData';

// ════════════════════════════════════════════════════════════
//  🌤️  WEATHER CONFIG  (Open-Meteo — 100% FREE, NO API KEY)
//  open-meteo.com — zero signup, zero key, works instantly
//  Uses 3 free endpoints:
//    1. geocoding-api  → city name → lat/lon
//    2. api.open-meteo → temperature + humidity (current)
//    3. air-quality-api → outdoor PM2.5, AQI (European AQI)
//  MQ-2 & MQ-135 Firebase sensors are NOT touched by this
// ════════════════════════════════════════════════════════════
const WEATHER = {
  CITY:     'Ludhiana',   // ← change to YOUR city name
  POLL_MIN: 10,             // fetch every 10 minutes (free tier: no limit)
};

// ── Field name mapping
//    Matches whatever key names the ESP32 actually writes.
//    Add more aliases to the right side if your ESP32 uses different names.
// ── FIELD_MAP: left=dashboard name, right=exact Firebase keys
// Their ESP32 sends: mq2_ppm, mq135_ppm  (seen in socket.on code)
const FIELD_MAP = {
  mq2:   ['mq2_ppm',   'gas',   'mq2',   'MQ2',  'smoke', 'Gas'],
  mq135: ['mq135_ppm', 'mq135', 'MQ135', 'air',  'airQuality'],
  temp:  ['temperature','temp',  'Temp',  'Temperature', 't'],
  hum:   ['humidity',  'hum',   'Hum',   'Humidity',    'h'],
};

// picks first matching key from raw Firebase data
function mapField(raw, candidates) {
  for (const key of candidates) {
    if (raw[key] !== undefined && raw[key] !== null) {
      return parseFloat(raw[key]) || 0;
    }
  }
  return 0;
}

// ════════════════════════════════════════════════════════════
//  App Config  (thresholds, limits)
// ════════════════════════════════════════════════════════════
const CONFIG = {
  MQ2_WARN:     200,
  MQ2_DANGER:   300,
  MQ135_WARN:   300,
  MQ135_DANGER: 400,
  TEMP_MAX:     60,
  HUM_MAX:      100,
  HISTORY_MAX:  600,    // readings kept in memory (~20 min @2s)
  DEMO_MODE:    false,  // true = fake data, no Firebase needed
  DEMO_POLL_MS: 2000,
};

// ════════════════════════════════════════════════════════════
//  State
// ════════════════════════════════════════════════════════════
const state = {
  mq2: 0, mq135: 0, temp: 0, hum: 0,
  mq2History:  [], mq135History: [],
  tempHistory: [], humHistory:   [],
  timestamps:  [],
  alertCount:  0,
  sampleCount: 0,
  startTime:   Date.now(),
  connected:   false,
  rangeSeconds:60,
  demoT:       0,
};

// ════════════════════════════════════════════════════════════
//  DOM Refs
// ════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const el = {
  mq2Val:      $('mq2Value'),
  mq135Val:    $('mq135Value'),
  mq2Status:   $('mq2Status'),
  mq135Status: $('mq135Status'),
  mq2Fill:     $('mq2Fill'),
  mq135Fill:   $('mq135Fill'),
  tempVal:     $('tempValue'),
  humVal:      $('humValue'),
  aqiVal:      $('aqiValue'),
  aqiLabel:    $('aqiLabel'),
  aqiPointer:  $('aqiPointer'),
  waterFill:   $('waterFill'),
  alertList:   $('alertList'),
  alertCount:  $('alertCount'),
  lastUpdate:  $('lastUpdate'),
  espIP:       $('espIP'),
  sampleCount: $('sampleCount'),
  uptime:      $('uptime'),
  toast:       $('toast'),
  connStatus:  $('connectionStatus'),
  mq2Card:     $('mq2Card'),
  mq135Card:   $('mq135Card'),
  fbStatus:    $('fbStatus'),
};

// ════════════════════════════════════════════════════════════
//  Canvas contexts
// ════════════════════════════════════════════════════════════
const ctx = {
  mq2Gauge:   $('mq2Gauge').getContext('2d'),
  mq135Gauge: $('mq135Gauge').getContext('2d'),
  mq2Mini:    $('mq2Mini').getContext('2d'),
  mq135Mini:  $('mq135Mini').getContext('2d'),
  tempGauge:  $('tempGauge').getContext('2d'),
  history:    $('historyChart').getContext('2d'),
};

// ════════════════════════════════════════════════════════════
//  Theme Toggle
// ════════════════════════════════════════════════════════════
$('themeToggle').addEventListener('click', () => {
  const html = document.documentElement;
  html.dataset.theme = html.dataset.theme === 'dark' ? 'light' : 'dark';
  drawAll();
});

// ════════════════════════════════════════════════════════════
//  Range Buttons
// ════════════════════════════════════════════════════════════
document.querySelectorAll('.ctrl-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ctrl-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.rangeSeconds = parseInt(btn.dataset.range);
    drawHistoryChart();
  });
});

// ════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════
const cssVar = name =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function hhmmss(sec) {
  return [
    Math.floor(sec / 3600),
    Math.floor((sec % 3600) / 60),
    sec % 60,
  ].map(n => String(n).padStart(2, '0')).join(':');
}

function animateNumber(domEl, target, current) {
  const diff = target - current, steps = 8;
  let step = 0;
  const iv = setInterval(() => {
    step++;
    domEl.textContent = Math.round(current + diff * step / steps);
    if (step >= steps) { domEl.textContent = target; clearInterval(iv); }
  }, 30);
}

// ════════════════════════════════════════════════════════════
//  Arc Gauge  (big, MQ-2 / MQ-135)
// ════════════════════════════════════════════════════════════
function drawGauge(canvas, ctxRef, value, max, color) {
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2, R = W * 0.43;
  const sA = Math.PI * 0.75, eA = Math.PI * 2.25;
  const ratio  = Math.min(Math.max(value / max, 0), 1);
  const valA   = sA + ratio * (eA - sA);

  ctxRef.clearRect(0, 0, W, H);

  // Background track
  ctxRef.beginPath();
  ctxRef.arc(cx, cy, R, sA, eA);
  ctxRef.strokeStyle = 'rgba(255,255,255,0.06)';
  ctxRef.lineWidth = 18; ctxRef.lineCap = 'round';
  ctxRef.stroke();

  // Colored arc with glow
  ctxRef.save();
  ctxRef.shadowColor = color; ctxRef.shadowBlur = 20;
  const grad = ctxRef.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, cssVar('--accent3'));
  grad.addColorStop(0.5, color);
  grad.addColorStop(1, color);
  ctxRef.beginPath();
  ctxRef.arc(cx, cy, R, sA, valA);
  ctxRef.strokeStyle = grad; ctxRef.lineWidth = 18; ctxRef.lineCap = 'round';
  ctxRef.stroke();
  ctxRef.restore();

  // Tick marks
  for (let i = 0; i <= 10; i++) {
    const a = sA + (i / 10) * (eA - sA);
    const inner = R - 28, outer = R - (i % 5 === 0 ? 18 : 22);
    ctxRef.beginPath();
    ctxRef.moveTo(cx + inner * Math.cos(a), cy + inner * Math.sin(a));
    ctxRef.lineTo(cx + outer * Math.cos(a), cy + outer * Math.sin(a));
    ctxRef.strokeStyle = i % 5 === 0 ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)';
    ctxRef.lineWidth = i % 5 === 0 ? 2 : 1;
    ctxRef.stroke();
  }

  // Needle dot
  const nR = R - 10;
  ctxRef.beginPath();
  ctxRef.arc(cx + nR * Math.cos(valA), cy + nR * Math.sin(valA), 8, 0, Math.PI * 2);
  ctxRef.fillStyle = color;
  ctxRef.shadowColor = color; ctxRef.shadowBlur = 16;
  ctxRef.fill(); ctxRef.shadowBlur = 0;
}

// ════════════════════════════════════════════════════════════
//  Small Arc Gauge  (temperature)
// ════════════════════════════════════════════════════════════
function drawSmallGauge(ctxRef, value, min, max, color) {
  const W = 100, H = 100, cx = 50, cy = 55, R = 38;
  const sA = Math.PI * 0.8, eA = Math.PI * 2.2;
  const ratio = Math.min(Math.max((value - min) / (max - min), 0), 1);
  const valA  = sA + ratio * (eA - sA);
  ctxRef.clearRect(0, 0, W, H);
  ctxRef.beginPath();
  ctxRef.arc(cx, cy, R, sA, eA);
  ctxRef.strokeStyle = 'rgba(255,255,255,0.07)'; ctxRef.lineWidth = 8; ctxRef.lineCap = 'round';
  ctxRef.stroke();
  ctxRef.beginPath();
  ctxRef.arc(cx, cy, R, sA, valA);
  ctxRef.strokeStyle = color; ctxRef.lineWidth = 8; ctxRef.lineCap = 'round';
  ctxRef.shadowColor = color; ctxRef.shadowBlur = 10;
  ctxRef.stroke(); ctxRef.shadowBlur = 0;
}

// ════════════════════════════════════════════════════════════
//  Sparkline
// ════════════════════════════════════════════════════════════
function drawSparkline(ctxRef, data, color, W, H) {
  if (data.length < 2) return;
  ctxRef.clearRect(0, 0, W, H);
  const slice = data.slice(-60);
  const min = Math.min(...slice), max = Math.max(...slice) || 1;
  const norm = v => H - ((v - min) / (max - min || 1)) * (H - 4) - 2;
  const grad = ctxRef.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, 'transparent'); grad.addColorStop(1, color);
  ctxRef.beginPath();
  slice.forEach((v, i) => {
    const x = (i / (slice.length - 1)) * W;
    i === 0 ? ctxRef.moveTo(x, norm(v)) : ctxRef.lineTo(x, norm(v));
  });
  ctxRef.strokeStyle = grad; ctxRef.lineWidth = 2; ctxRef.lineJoin = 'round';
  ctxRef.stroke();
}

// ════════════════════════════════════════════════════════════
//  History Chart
// ════════════════════════════════════════════════════════════
function drawHistoryChart() {
  const canvas = $('historyChart');
  const W = canvas.offsetWidth * (window.devicePixelRatio || 1) || 1200;
  const H = 220;
  canvas.width = W; canvas.height = H;
  const c = ctx.history;
  c.clearRect(0, 0, W, H);

  const n      = state.rangeSeconds;
  const mq2d   = state.mq2History.slice(-n);
  const mq135d = state.mq135History.slice(-n);
  const tempd  = state.tempHistory.slice(-n).map(v => v * 5);
  const humd   = state.humHistory.slice(-n);
  const allV   = [...mq2d, ...mq135d, ...tempd, ...humd];
  if (allV.length < 2) return;

  const maxV = Math.max(...allV, 10) * 1.1;
  const norm  = v => H - 24 - (v / maxV) * (H - 40);

  // Grid lines
  c.strokeStyle = cssVar('--grid-col'); c.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = 20 + (i / 4) * (H - 40);
    c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
    c.fillStyle = cssVar('--text-muted'); c.font = '10px monospace';
    c.fillText(Math.round(maxV - (i / 4) * maxV), 4, y - 3);
  }

  const drawLine = (data, color) => {
    if (data.length < 2) return;
    const grad = c.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, color + '44'); grad.addColorStop(1, color);
    c.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * W;
      i === 0 ? c.moveTo(x, norm(v)) : c.lineTo(x, norm(v));
    });
    c.strokeStyle = grad; c.lineWidth = 2; c.lineJoin = 'round';
    c.shadowColor = color; c.shadowBlur = 6;
    c.stroke(); c.shadowBlur = 0;
  };

  drawLine(mq2d,   cssVar('--mq2'));
  drawLine(mq135d, cssVar('--mq135'));
  drawLine(tempd,  cssVar('--temp-col'));
  drawLine(humd,   cssVar('--hum-col'));
}

// ════════════════════════════════════════════════════════════
//  Update UI — called on every new data point from Firebase
// ════════════════════════════════════════════════════════════
function updateUI(data) {
  const { mq2, mq135, temp, hum } = data;

  animateNumber(el.mq2Val,   mq2,   state.mq2);
  animateNumber(el.mq135Val, mq135, state.mq135);

  state.mq2 = mq2; state.mq135 = mq135;
  state.temp = temp; state.hum = hum;

  // Push to rolling history arrays
  const pushTrim = (arr, val) => {
    arr.push(val);
    if (arr.length > CONFIG.HISTORY_MAX) arr.shift();
  };
  pushTrim(state.mq2History,  mq2);
  pushTrim(state.mq135History,mq135);
  pushTrim(state.tempHistory, temp);
  pushTrim(state.humHistory,  hum);
  pushTrim(state.timestamps,  Date.now());

  // Big gauges
  drawGauge($('mq2Gauge'),   ctx.mq2Gauge,   mq2,   500, cssVar('--mq2'));
  drawGauge($('mq135Gauge'), ctx.mq135Gauge, mq135, 500, cssVar('--mq135'));
  drawSmallGauge(ctx.tempGauge, temp, -10, 60, cssVar('--temp-col'));

  // Threshold bars
  el.mq2Fill.style.width   = Math.min(mq2   / CONFIG.MQ2_DANGER   * 100, 100) + '%';
  el.mq135Fill.style.width = Math.min(mq135 / CONFIG.MQ135_DANGER * 100, 100) + '%';

  // Status chips
  setStatus(el.mq2Status,   el.mq2Card,   mq2,   CONFIG.MQ2_WARN,   CONFIG.MQ2_DANGER);
  setStatus(el.mq135Status, el.mq135Card, mq135, CONFIG.MQ135_WARN, CONFIG.MQ135_DANGER);

  // Temp & Humidity — filled by Weather API (startWeather), NOT Firebase
  // state.temp / state.hum are still updated above for the history chart
  // but the DOM elements are owned by updateWeatherUI()

  // AQI — still calculated from MQ-135 sensor (unchanged)
  const aqi = calcAQI(mq135);
  el.aqiVal.textContent   = aqi;
  const { label, pct, col } = aqiInfo(aqi);
  el.aqiLabel.textContent = label;
  el.aqiVal.style.color   = col;
  el.aqiPointer.style.left = pct + '%';

  // Sparklines
  drawSparkline(ctx.mq2Mini,   state.mq2History,   cssVar('--mq2'),   200, 50);
  drawSparkline(ctx.mq135Mini, state.mq135History, cssVar('--mq135'), 200, 50);
  drawHistoryChart();

  // Footer meta
  el.lastUpdate.textContent  = new Date().toLocaleTimeString();
  el.sampleCount.textContent = ++state.sampleCount;

  // Uptime — prefer ESP32 reported value
  if (data.uptime !== undefined) {
    el.uptime.textContent = hhmmss(parseInt(data.uptime));
  } else {
    el.uptime.textContent = hhmmss(Math.floor((Date.now() - state.startTime) / 1000));
  }

  // Device IP
  if (data.ip && el.espIP) el.espIP.textContent = data.ip;

  checkAlerts(mq2, mq135, temp, hum);
}

// ════════════════════════════════════════════════════════════
//  Status Badge
// ════════════════════════════════════════════════════════════
function setStatus(statusEl, cardEl, val, warn, danger) {
  statusEl.className = 'sensor-status';
  cardEl.style.borderColor = '';
  if (val >= danger) {
    statusEl.classList.add('danger');
    statusEl.textContent = 'DANGER';
    cardEl.style.borderColor = 'rgba(255,77,77,0.45)';
  } else if (val >= warn) {
    statusEl.classList.add('warning');
    statusEl.textContent = 'WARNING';
    cardEl.style.borderColor = 'rgba(255,170,0,0.35)';
  } else {
    statusEl.textContent = 'NORMAL';
  }
}

// ════════════════════════════════════════════════════════════
//  Alerts
// ════════════════════════════════════════════════════════════
let lastAlerted = {};
function checkAlerts(mq2, mq135, temp, hum) {
  const now = Date.now();
  const checks = [
    { key:'mq2d',   cond: mq2   >= CONFIG.MQ2_DANGER,   msg:`⚠ MQ-2 CRITICAL: ${mq2} ppm — Combustible gas!` },
    { key:'mq2w',   cond: mq2   >= CONFIG.MQ2_WARN && mq2 < CONFIG.MQ2_DANGER, msg:`MQ-2 Warning: ${mq2} ppm` },
    { key:'mq135d', cond: mq135 >= CONFIG.MQ135_DANGER, msg:`⚠ MQ-135 CRITICAL: ${mq135} ppm — Air hazard!` },
    { key:'mq135w', cond: mq135 >= CONFIG.MQ135_WARN && mq135 < CONFIG.MQ135_DANGER, msg:`MQ-135 Warning: ${mq135} ppm` },
    { key:'tempH',  cond: temp  > 50,  msg:`🌡 High Temp: ${temp.toFixed(1)}°C` },
    { key:'humH',   cond: hum   > 90,  msg:`💧 High Humidity: ${hum.toFixed(0)}%` },
  ];
  checks.forEach(({ key, cond, msg }) => {
    if (cond && (!lastAlerted[key] || now - lastAlerted[key] > 15000)) {
      addAlert(msg);
      if (key.includes('d')) showToast(msg);
      lastAlerted[key] = now;
    }
    if (!cond) delete lastAlerted[key];
  });
}

function addAlert(msg) {
  const noA = el.alertList.querySelector('.no-alerts');
  if (noA) noA.remove();
  const item = document.createElement('div');
  item.className = 'alert-item';
  item.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.alertList.prepend(item);
  el.alertCount.textContent = ++state.alertCount;
}

function clearAlerts() {
  el.alertList.innerHTML = '<div class="no-alerts">No alerts detected</div>';
  state.alertCount = 0; el.alertCount.textContent = '0';
}
window.clearAlerts = clearAlerts;

// ════════════════════════════════════════════════════════════
//  Toast
// ════════════════════════════════════════════════════════════
let toastTimer;
function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 4500);
}

// ════════════════════════════════════════════════════════════
//  AQI
// ════════════════════════════════════════════════════════════
function calcAQI(ppm) {
  if (ppm <= 50)  return Math.round(ppm);
  if (ppm <= 100) return Math.round(50 + ppm);
  if (ppm <= 300) return Math.round(150 + (ppm - 100));
  return Math.round(350 + (ppm - 300) * 0.5);
}
function aqiInfo(aqi) {
  if (aqi <= 50)  return { label:'Good',      pct:(aqi/50)*25,                         col:'#39ff14' };
  if (aqi <= 100) return { label:'Moderate',  pct:25+((aqi-50)/50)*25,                 col:'#ffaa00' };
  if (aqi <= 200) return { label:'Unhealthy', pct:50+((aqi-100)/100)*25,               col:'#ff6b35' };
  return               { label:'Hazardous', pct:Math.min(75+((aqi-200)/200)*25,99),  col:'#ff0040' };
}

// ════════════════════════════════════════════════════════════
//  Connection Badge
// ════════════════════════════════════════════════════════════
function setConnected(v, source = '') {
  state.connected = v;
  const dot = el.connStatus.querySelector('.status-dot');
  const txt = el.connStatus.querySelector('.status-text');
  if (v) {
    dot.style.background = 'var(--accent3)';
    dot.style.animation  = '';
    txt.textContent = source ? `LIVE · ${source}` : 'CONNECTED';
    el.connStatus.style.borderColor = 'rgba(57,255,20,0.3)';
    if (el.fbStatus) {
      el.fbStatus.textContent = source === 'Demo'
        ? '🎮 Demo Mode Active'
        : '🔥 Firebase Live';
      el.fbStatus.style.color = 'var(--accent3)';
    }
  } else {
    dot.style.background = 'var(--accent)';
    dot.style.animation  = 'none';
    txt.textContent = 'OFFLINE';
    el.connStatus.style.borderColor = 'rgba(255,77,77,0.3)';
    if (el.fbStatus) {
      el.fbStatus.textContent = '🔥 Firebase Connecting...';
      el.fbStatus.style.color = 'var(--temp-col)';
    }
  }
}

// ════════════════════════════════════════════════════════════
//  Draw All  (on theme change / resize)
// ════════════════════════════════════════════════════════════
function drawAll() {
  drawGauge($('mq2Gauge'),   ctx.mq2Gauge,   state.mq2,   500, cssVar('--mq2'));
  drawGauge($('mq135Gauge'), ctx.mq135Gauge, state.mq135, 500, cssVar('--mq135'));
  drawSmallGauge(ctx.tempGauge, state.temp, -10, 60, cssVar('--temp-col'));
  drawSparkline(ctx.mq2Mini,   state.mq2History,   cssVar('--mq2'),   200, 50);
  drawSparkline(ctx.mq135Mini, state.mq135History, cssVar('--mq135'), 200, 50);
  drawHistoryChart();
}

// ════════════════════════════════════════════════════════════
//  🔥 FIREBASE — Real-time Listener
//  Uses Firebase v10 modular SDK via dynamic import (CDN)
// ════════════════════════════════════════════════════════════
async function startFirebase() {
  if (el.fbStatus) {
    el.fbStatus.textContent = '🔥 Connecting to Firebase...';
    el.fbStatus.style.color = 'var(--temp-col)';
  }

  try {
    // Dynamic import — Firebase v10 Modular SDK (no bundler needed)
    const { initializeApp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'
    );
    const { getDatabase, ref, onValue, off } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js'
    );

    // ── Initialize Firebase App
    const app = initializeApp(FIREBASE_CONFIG);
    const db  = getDatabase(app);

    // ── Monitor Firebase connection state
    const connRef = ref(db, '.info/connected');
    onValue(connRef, snap => {
      if (!snap.val()) setConnected(false);
    });

    // ── Listen to live sensor data
    const liveRef = ref(db, FB_LIVE_PATH);
    onValue(liveRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          console.warn('[Firebase] No data at:', FB_LIVE_PATH);
          if (el.fbStatus) {
            el.fbStatus.textContent = '🔥 Waiting for ESP32 data...';
            el.fbStatus.style.color = 'var(--temp-col)';
          }
          return;
        }

        const raw = snapshot.val();

        // Log raw data so you can see exact field names in the console
        console.log('[Firebase] Raw sensorData:', raw);

        // Auto-map field names using FIELD_MAP aliases
        const mq2   = mapField(raw, FIELD_MAP.mq2);
        const mq135 = mapField(raw, FIELD_MAP.mq135);
        const temp  = mapField(raw, FIELD_MAP.temp);
        const hum   = mapField(raw, FIELD_MAP.hum);

        // If ALL 4 values are 0, the field names probably don't match
        // Open browser DevTools → Console to see the raw object above
        if (mq2 === 0 && mq135 === 0 && temp === 0 && hum === 0) {
          console.warn('[Firebase] All values read as 0 — check FIELD_MAP keys match your DB field names');
          console.warn('[Firebase] Available keys in DB:', Object.keys(raw));
        }

        setConnected(true, 'Firebase');

        updateUI({ mq2, mq135, temp, hum,
          uptime: raw.uptime || raw.Uptime,
          ip:     raw.ip     || raw.IP,
        });
      },
      (error) => {
        console.error('[Firebase] Error:', error.code, error.message);
        setConnected(false);
        showToast('Firebase error: ' + error.message);
        // Retry after 6 seconds
        setTimeout(startFirebase, 6000);
      }
    );

    console.log('[Firebase] ✓ Listening on path:', FB_LIVE_PATH);

  } catch (err) {
    console.error('[Firebase] Init error:', err);
    setConnected(false);
    showToast('⚠ Firebase config error — switching to Demo');

    // Auto-fallback to demo mode
    setTimeout(() => {
      startDemo();
      setConnected(true, 'Demo');
    }, 2000);
  }
}

// ════════════════════════════════════════════════════════════
//  Demo Mode  (simulated data — no Firebase needed)
// ════════════════════════════════════════════════════════════
let demoInterval;
function startDemo() {
  if (demoInterval) clearInterval(demoInterval);
  demoInterval = setInterval(() => {
    state.demoT += 0.05;
    const t = state.demoT;
    const mq2   = Math.round(80  + 60 * Math.sin(t * 0.7)   + 30 * Math.sin(t * 2.1) + Math.random() * 15);
    const mq135 = Math.round(120 + 80 * Math.sin(t * 0.5+1) + 40 * Math.sin(t * 1.7) + Math.random() * 20);
    const temp  = parseFloat((26 + 4 * Math.sin(t * 0.3) + Math.random() * 0.5).toFixed(1));
    const hum   = parseFloat((60 + 15 * Math.sin(t * 0.2+0.5) + Math.random() * 2).toFixed(1));
    updateUI({ mq2: Math.max(0, mq2), mq135: Math.max(0, mq135), temp, hum });
  }, CONFIG.DEMO_POLL_MS);
}

// ════════════════════════════════════════════════════════════
//  Background Particles
// ════════════════════════════════════════════════════════════
function initParticles() {
  const container = $('particles');
  const colors = ['#ff6b35','#00e5ff','#39ff14','#ffaa00'];
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = 2 + Math.random() * 4;
    p.style.cssText = `
      width:${size}px;height:${size}px;
      background:${colors[i % colors.length]};
      left:${Math.random() * 100}%;
      --dur:${6 + Math.random() * 10}s;
      --delay:${Math.random() * 8}s;
    `;
    container.appendChild(p);
  }
}


// ════════════════════════════════════════════════════════════
//  🌤️  WEATHER — Open-Meteo (100% FREE · NO API KEY NEEDED)
//  3-step fetch: geocode city → weather → air quality
//  Completely isolated — NEVER touches MQ-2 / MQ-135 values
// ════════════════════════════════════════════════════════════

// Condition code → human readable description (WMO standard)
function wmoDesc(code) {
  const map = {
    0:'Clear sky', 1:'Mainly clear', 2:'Partly cloudy', 3:'Overcast',
    45:'Foggy', 48:'Icy fog', 51:'Light drizzle', 53:'Drizzle',
    55:'Heavy drizzle', 61:'Slight rain', 63:'Moderate rain',
    65:'Heavy rain', 71:'Slight snow', 73:'Moderate snow',
    75:'Heavy snow', 77:'Snow grains', 80:'Slight showers',
    81:'Moderate showers', 82:'Violent showers', 85:'Snow showers',
    86:'Heavy snow showers', 95:'Thunderstorm', 96:'Thunderstorm+hail',
    99:'Thunderstorm+heavy hail',
  };
  return map[code] || 'Unknown';
}

// European AQI index (0–500) → category label + color
function euAqiInfo(val) {
  if (val === null || val === undefined) return { label:'N/A', col:'#888' };
  if (val <= 20)  return { label:'Good',       col:'#39ff14' };
  if (val <= 40)  return { label:'Fair',        col:'#aaff00' };
  if (val <= 60)  return { label:'Moderate',    col:'#ffaa00' };
  if (val <= 80)  return { label:'Poor',        col:'#ff6b35' };
  if (val <= 100) return { label:'Very Poor',   col:'#ff0040' };
  return                  { label:'Extremely Poor', col:'#cc00ff' };
}

// Updates ONLY the temp/hum DOM elements + weather badge
// MQ-2 and MQ-135 values are completely untouched
function updateWeatherUI(w) {
  // ── Temperature
  if (el.tempVal) {
    el.tempVal.textContent = w.temp.toFixed(1);
    state.temp = w.temp;
    drawSmallGauge(ctx.tempGauge, w.temp, -10, 60, cssVar('--temp-col'));
  }

  // ── Humidity
  if (el.humVal) {
    el.humVal.textContent = Math.round(w.hum);
    state.hum = w.hum;
    if (el.waterFill) el.waterFill.style.height = Math.min(w.hum, 100) + '%';
  }

  // ── City label
  const wCity = $('weatherCity');
  if (wCity) wCity.textContent = `${w.city}`;

  // ── Weather description badge
  const wBadge = $('weatherBadge');
  if (wBadge) {
    wBadge.textContent = `${w.desc} · ${w.temp.toFixed(0)}°C`;
    wBadge.title = `Wind: ${w.wind} m/s | Humidity: ${Math.round(w.hum)}%`;
  }

  // ── Outdoor AQI (European AQI scale from Open-Meteo air-quality API)
  const wAqiVal   = $('weatherAqiVal');
  const wAqiLabel = $('weatherAqiLabel');
  if (wAqiVal) {
    const info = euAqiInfo(w.aqi);
    wAqiVal.textContent   = w.aqi !== null ? Math.round(w.aqi) : '--';
    wAqiVal.style.color   = info.col;
    if (wAqiLabel) wAqiLabel.textContent = info.label;
  }

  console.log('[Weather ✓] Open-Meteo data:', w);
}

// Step 1 — Geocode city name → lat/lon (Open-Meteo geocoding, no key)
async function geocodeCity(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.results || data.results.length === 0) throw new Error(`City not found: ${city}`);
  const r = data.results[0];
  return { lat: r.latitude, lon: r.longitude, name: r.name, country: r.country };
}

// Step 2 — Fetch current weather (temp, humidity, wind, condition)
async function fetchCurrentWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${lat}&longitude=${lon}`
    + `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,apparent_temperature`
    + `&timezone=auto`;
  const res  = await fetch(url);
  const data = await res.json();
  const c = data.current;
  return {
    temp:  c.temperature_2m,
    hum:   c.relative_humidity_2m,
    wind:  c.wind_speed_10m,
    feels: c.apparent_temperature,
    desc:  wmoDesc(c.weather_code),
  };
}

// Step 3 — Fetch outdoor air quality (European AQI from Open-Meteo, no key)
async function fetchAirQuality(lat, lon) {
  try {
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality`
      + `?latitude=${lat}&longitude=${lon}`
      + `&current=european_aqi,pm2_5,pm10`
      + `&timezone=auto`;
    const res  = await fetch(url);
    const data = await res.json();
    return data.current?.european_aqi ?? null;
  } catch {
    return null; // AQI failure is non-critical
  }
}

// Main weather fetch — runs all 3 steps, updates UI only
async function fetchWeather() {
  try {
    const { lat, lon, name, country } = await geocodeCity(WEATHER.CITY);
    const weather   = await fetchCurrentWeather(lat, lon);
    const aqiVal    = await fetchAirQuality(lat, lon);

    updateWeatherUI({
      ...weather,
      city:    name,
      country: country,
      aqi:     aqiVal,
    });

  } catch (err) {
    console.error('[Weather] Open-Meteo error:', err.message);
    const wBadge = $('weatherBadge');
    if (wBadge) wBadge.textContent = 'Weather unavailable';
    // silently retry next cycle — never breaks MQ sensors
  }
}

// Start weather polling — fetch now, then every POLL_MIN minutes
function startWeather() {
  fetchWeather();
  setInterval(fetchWeather, WEATHER.POLL_MIN * 60 * 1000);
}

// ════════════════════════════════════════════════════════════
//  Init
// ════════════════════════════════════════════════════════════
function init() {
  initParticles();
  drawAll();

  if (CONFIG.DEMO_MODE) {
    showToast('🎮 Running in Demo Mode — set DEMO_MODE:false for Firebase');
    startDemo();
    setConnected(true, 'Demo');
  } else {
    setConnected(false);
    startFirebase();
  }

  window.addEventListener('resize', drawAll);

  // 🌤️ Start weather API polling (temp, hum, outdoor AQI)
  // Runs completely independently — never touches MQ-2 / MQ-135
  startWeather();
}

init();
