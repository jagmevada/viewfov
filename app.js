// ==========================
// FoV Mapping Webapp - VIEWER
// Static GitHub Pages ready
// ==========================

const $ = (id) => document.getElementById(id);

const DEFAULT_SB_URL = "https://hsvctxongbvtnlofsazd.supabase.co";
const DEFAULT_SB_KEY = "sb_publishable_aZWobGm_WPP-H0vxx7VILA_6qiAFtIq";
const DEFAULT_DEVICE_ID = "dev1";
const AUTO_REFRESH_INTERVAL = 5000; // 5 seconds
const DEFAULT_3D_CAMERA = {
  eye: { x: 1.083, y: 0.0, z: 0.626 },
  center: { x: 0, y: 0, z: 0 }
};
const STORAGE_KEYS = {
  sessionId: "fov.sessionId",
};

const ui = {
  azMin: $("azMin"), azMax: $("azMax"),
  elMin: $("elMin"), elMax: $("elMax"),
  stepDeg: $("stepDeg"), dwellMs: $("dwellMs"),
  customSessionId: $("customSessionId"),

  btnFetchSession: $("btnFetchSession"),

  btnExportJson: $("btnExportJson"),
  btnExportCsv: $("btnExportCsv"),

  sbDeviceId: $("sbDeviceId"),

  stState: $("stState"),
  stAz: $("stAz"),
  stEl: $("stEl"),
  stIndex: $("stIndex"),
  stSessionId: $("stSessionId"),
  stOk: $("stOk"),
  stBad: $("stBad"),
  progressBar: $("progressBar"),
  progressText: $("progressText"),
  telemetryStatus: $("telemetryStatus"),
  btnRetry: $("btnRetry"),

  polarCanvas: $("polarCanvas"),
  polar3d: $("polar3d"),

  log: $("log"),
  rows: $("rows"),
};

// ---- State ----
const state = {
  runState: "idle", // idle | running | paused | stopped
  points: [],       // generated scan points
  idx: 0,           // current point index
  dwellMs: 250,
  captured: [],     // {az, el, status, t}
  currentSessionId: "",
  lastTelemetryId: null,
  lastTelemetry: null,
  lastTelemetryError: "",
  fovRows: [],
  autoRefreshTimer: null,
  camera3d: null,
  cameraListenerBound: false,
};

function nowISO() {
  return new Date().toISOString();
}

function log(msg) {
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  ui.log.prepend(line);
}

function clampInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function buildPoints({ azMin, azMax, elMin, elMax, step }) {
  // Your desired scan order:
  // For each azimuth: sweep elevation fully
  // azimuth steps first, then elevation angles, then next azimuth
  const pts = [];
  for (let az = azMin; az <= azMax + 1e-9; az += step) {
    for (let el = elMin; el <= elMax + 1e-9; el += step) {
      pts.push({ az: round1(az), el: round1(el) });
    }
  }
  return pts;
}

function round1(x) { return Math.round(x * 10) / 10; }

function setRunState(s) {
  state.runState = s;
  ui.stState.textContent = s.toUpperCase();
}

function updateStatus() {
  const total = state.points.length || 0;
  const idx = Math.min(state.idx, Math.max(total - 1, 0));
  const p = total ? state.points[idx] : { az: 0, el: 0 };

  ui.stAz.textContent = `${p.az}°`;
  ui.stEl.textContent = `${p.el}°`;
  ui.stIndex.textContent = `${Math.min(state.idx + 1, total)} / ${total}`;
  ui.stSessionId.textContent = state.currentSessionId ? state.currentSessionId.substring(0, 8) : "—";

  if (!isSupabaseMode()) {
    clearTelemetryUI();
    setRetryEnabled(false);
    setCaptureEnabled(true);
  }

  const rows = getActiveRowsNormalized();
  const okCount = rows.filter(x => x.status === "OK").length;
  const badCount = rows.filter(x => x.status === "NOT_OK").length;
  ui.stOk.textContent = String(okCount);
  ui.stBad.textContent = String(badCount);

  const progress = total ? Math.round(((state.idx) / total) * 100) : 0;
  ui.progressBar.style.width = `${Math.min(100, Math.max(0, progress))}%`;
  ui.progressText.textContent = `${Math.min(100, Math.max(0, progress))}%`;

  renderTable();
  drawPolar();
  drawPolar3D();
}

function renderTable() {
  ui.rows.innerHTML = "";
  const frag = document.createDocumentFragment();

  const rows = getActiveRowsNormalized();
  rows.slice().reverse().forEach((r, i) => {
    const tr = document.createElement("tr");
    const badge = badgeHTML(r.status);
    tr.innerHTML = `
      <td>${rows.length - i}</td>
      <td>${r.az}</td>
      <td>${r.el}</td>
      <td>${badge}</td>
      <td>${new Date(r.t).toLocaleString()}</td>
    `;
    frag.appendChild(tr);
  });

  ui.rows.appendChild(frag);
}

function badgeHTML(status) {
  if (status === "OK") return `<span class="badge ok">OK</span>`;
  if (status === "NOT_OK") return `<span class="badge no">NOT OK</span>`;
  return `<span class="badge na">—</span>`;
}

// =======================
// Device command sending
// =======================

async function sendMoveCommand(az, el) {
  const mode = ui.deviceMode ? ui.deviceMode.value : "supabase";

  if (mode === "none") return;

  if (mode === "http") {
    // Expect your ESP32 to expose something like:
    // POST /move { az: <deg>, el: <deg> }
    // or GET /move?az=..&el=..
    const base = ui.espBaseUrl.value.trim();
    if (!base) {
      log("HTTP mode selected, but ESP32 Base URL is empty.");
      return;
    }

    const url = `${base.replace(/\/+$/,"")}/move`;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ az, el }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      log(`Sent ESP32 move: az=${az}, el=${el}`);
    } catch (e) {
      log(`ESP32 send failed: ${e.message}`);
    }
    return;
  }

  if (mode === "supabase") {
    const sbUrl = ui.sbUrl ? ui.sbUrl.value.trim() : DEFAULT_SB_URL;
    const sbKey = ui.sbKey ? ui.sbKey.value.trim() : DEFAULT_SB_KEY;
    if (!sbUrl || !sbKey) {
      log("Supabase mode selected, but URL/Key missing.");
      return;
    }

    try {
      if (!state.currentSessionId) {
        await createSession(getRanges());
      }
      clearTelemetryUI();
      setRetryEnabled(false);
      setCaptureEnabled(false);
      await insertMoveCommand(az, el);
      await pollTelemetryAck();
    } catch (e) {
      log(`Supabase cmd insert failed: ${e.message}`);
    }
  }
}

async function retryCurrentPointMove() {
  if (!isSupabaseMode()) return;
  if (!state.points.length) {
    log("No points to retry.");
    return;
  }

  const p = currentPoint();
  showTelemetryOk("Retrying...");
  setRetryEnabled(false);
  setCaptureEnabled(false);

  try {
    await insertMoveCommand(p.az, p.el);
    await pollTelemetryAck();
  } catch (e) {
    showTelemetryError(e.message || "Unknown error");
    setRetryEnabled(true);
    log(`Retry failed: ${e.message}`);
  }
}

// =======================
// Scan engine
// =======================

function currentPoint() {
  if (!state.points.length) return { az: 0, el: 0 };
  return state.points[Math.min(state.idx, state.points.length - 1)];
}

async function stepToIndex(newIdx, reason = "") {
  const total = state.points.length;
  if (!total) return;

  state.idx = Math.min(Math.max(newIdx, 0), total - 1);
  const p = currentPoint();

  await sendMoveCommand(p.az, p.el);
  if (reason) log(`${reason}: moved to az=${p.az}, el=${p.el}`);
  updateStatus();
}

async function runLoop() {
  setRunState("running");
  log("Scan started.");

  while (state.runState === "running") {
    const total = state.points.length;
    if (!total) {
      log("No points. Check ranges.");
      setRunState("idle");
      break;
    }
    if (state.idx >= total) {
      log("Scan completed.");
      setRunState("idle");
      break;
    }

    const p = currentPoint();
    await sendMoveCommand(p.az, p.el);
    log(`At point az=${p.az}, el=${p.el} (waiting user OK/Not OK...)`);

    // Wait for user capture OR timeout dwell? (You said user presses)
    // We will not auto-advance on timer.
    // User must press OK/Not OK or Next.
    setRunState("paused");
    updateStatus();
    break;
  }
}

async function capture(status) {
  const p = currentPoint();

  if (isSupabaseMode()) {
    try {
      if (state.lastTelemetryError) {
        log("Telemetry error present. Retry before capture.");
        return;
      }
      if (!state.lastTelemetry) {
        log("No telemetry available for capture.");
        return;
      }
      await insertFovData(status);
      log(`Captured ${status} at az=${state.lastTelemetry?.az_actual}, el=${state.lastTelemetry?.el_actual}`);
    } catch (e) {
      log(`Supabase capture failed: ${e.message}`);
      return;
    }
  } else {
    // update existing capture if already captured this point
    const key = `${p.az}|${p.el}`;
    const existing = state.captured.findIndex(x => `${x.az}|${x.el}` === key);
    const row = { az: p.az, el: p.el, status, t: Date.now() };

    if (existing >= 0) state.captured[existing] = row;
    else state.captured.push(row);

    log(`Captured ${status} at az=${p.az}, el=${p.el}`);
  }

  // auto-advance after capture
  if (state.idx < state.points.length - 1) {
    state.idx += 1;
    setRunState("running");
    // small dwell before moving
    const dwell = clampInt(ui.dwellMs.value, 250);
    state.dwellMs = dwell;
    setTimeout(async () => {
      await stepToIndex(state.idx, "Auto-next");
      setRunState("paused");
      updateStatus();
    }, dwell);
  } else {
    log("Last point captured. Scan completed.");
    setRunState("idle");
  }

  updateStatus();
}

// =======================
// Export
// =======================

function download(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportJSON() {
  if (isSupabaseMode()) {
    const payload = {
      meta: {
        created_at: nowISO(),
        ranges: getRanges(),
        session_id: state.currentSessionId,
        device_id: ui.sbDeviceId ? (ui.sbDeviceId.value.trim() || DEFAULT_DEVICE_ID) : DEFAULT_DEVICE_ID,
        total_points: state.points.length,
        captured_points: (state.fovRows || []).length
      },
      points: state.points,
      fov_data: state.fovRows || []
    };
    download(`fov_map_${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
    return;
  }

  const payload = {
    meta: {
      created_at: nowISO(),
      ranges: getRanges(),
      total_points: state.points.length,
      captured_points: state.captured.length
    },
    points: state.points,
    captured: state.captured
  };
  download(`fov_map_${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
}

function exportCSV() {
  if (isSupabaseMode()) {
    const lines = ["index,session_id,device_id,az_deg,el_deg,result,created_at"];
    (state.fovRows || []).forEach((r, i) => {
      lines.push(`${i + 1},${r.session_id},${r.device_id || (ui.sbDeviceId ? (ui.sbDeviceId.value.trim() || DEFAULT_DEVICE_ID) : DEFAULT_DEVICE_ID)},${r.az_deg},${r.el_deg},${r.result},${r.created_at}`);
    });
    download(`fov_map_${Date.now()}.csv`, lines.join("\n"), "text/csv");
    return;
  }

  const lines = ["index,az_deg,el_deg,status,timestamp_iso"];
  const map = new Map(state.captured.map(r => [`${r.az}|${r.el}`, r]));

  state.points.forEach((p, i) => {
    const r = map.get(`${p.az}|${p.el}`);
    const status = r ? r.status : "";
    const tiso = r ? new Date(r.t).toISOString() : "";
    lines.push(`${i + 1},${p.az},${p.el},${status},${tiso}`);
  });

  download(`fov_map_${Date.now()}.csv`, lines.join("\n"), "text/csv");
}

// =======================
// Helpers
// =======================

function isSupabaseMode() {
  if (!ui.deviceMode) return true;
  return ui.deviceMode.value === "supabase";
}

function setCaptureEnabled(enabled) {
  ui.btnOk.disabled = !enabled;
  ui.btnNotOk.disabled = !enabled;
}

function clearTelemetryUI() {
  state.lastTelemetryError = "";
  if (ui.telemetryStatus) {
    ui.telemetryStatus.textContent = "";
    ui.telemetryStatus.classList.add("hidden");
    ui.telemetryStatus.classList.remove("error", "ok");
  }
}

function showTelemetryError(msg) {
  state.lastTelemetryError = msg || "Unknown error";
  if (ui.telemetryStatus) {
    ui.telemetryStatus.textContent = state.lastTelemetryError;
    ui.telemetryStatus.classList.remove("hidden", "ok");
    ui.telemetryStatus.classList.add("error");
  }
}

function showTelemetryOk(msgOptional = "") {
  if (!msgOptional) {
    clearTelemetryUI();
    return;
  }
  if (ui.telemetryStatus) {
    ui.telemetryStatus.textContent = msgOptional;
    ui.telemetryStatus.classList.remove("hidden", "error");
    ui.telemetryStatus.classList.add("ok");
  }
}

function setRetryEnabled(enabled) {
  if (!ui.btnRetry) return;
  ui.btnRetry.disabled = !enabled;
  if (enabled) ui.btnRetry.classList.remove("hidden");
  else ui.btnRetry.classList.add("hidden");
}

function setSessionId(session_id) {
  state.currentSessionId = session_id || "";
  if (state.currentSessionId) {
    try { localStorage.setItem(STORAGE_KEYS.sessionId, state.currentSessionId); } catch { /* ignore */ }
  }
  updateStatus();
}

function clearSessionId() {
  state.currentSessionId = "";
  try { localStorage.removeItem(STORAGE_KEYS.sessionId); } catch { /* ignore */ }
  updateStatus();
}

function loadPersistedSessionId() {
  try {
    return localStorage.getItem(STORAGE_KEYS.sessionId) || "";
  } catch {
    return "";
  }
}

function getActiveRowsNormalized() {
  if (isSupabaseMode()) {
    return (state.fovRows || []).map(r => ({
      az: r.az_deg,
      el: r.el_deg,
      status: r.result,
      t: r.created_at ? Date.parse(r.created_at) : Date.now(),
      session_id: r.session_id,
      device_id: r.device_id,
      created_at: r.created_at,
    }));
  }
  return state.captured.map(r => ({
    az: r.az,
    el: r.el,
    status: r.status,
    t: r.t,
    created_at: new Date(r.t).toISOString(),
  }));
}

function sbBase() {
  const raw = ui.sbUrl ? ui.sbUrl.value.trim() : "";
  const val = raw || DEFAULT_SB_URL;
  return val.replace(/\/+$/, "");
}

function sbHeaders() {
  const raw = ui.sbKey ? ui.sbKey.value.trim() : "";
  const sbKey = raw || DEFAULT_SB_KEY;
  return {
    "Content-Type": "application/json",
    "apikey": sbKey,
    "Authorization": `Bearer ${sbKey}`,
    "Prefer": "return=representation",
  };
}

async function sbFetch(path, method = "GET", body) {
  const base = sbBase();
  if (!base) throw new Error("Supabase URL missing");
  const url = `${base}/rest/v1/${path}`;
  const options = { method, headers: sbHeaders() };
  if (body !== undefined) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${txt}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function createSession(ranges) {
  const customIdRaw = ui.customSessionId ? ui.customSessionId.value.trim() : "";
  const session_id = (customIdRaw || crypto.randomUUID().replace(/-/g, "")).substring(0, 8);
  const device_id = ui.sbDeviceId ? (ui.sbDeviceId.value.trim() || DEFAULT_DEVICE_ID) : DEFAULT_DEVICE_ID;
  const existing = await fetchSessionById(session_id).catch(() => null);
  if (existing) {
    setSessionId(session_id);
    state.fovRows = await fetchFovData(session_id);
    clearTelemetryUI();
    setRetryEnabled(false);
    updateStatus();
    log(`Session exists. Reusing: ${session_id.substring(0, 8)}`);
    return session_id;
  }
  const payload = [{
    session_id,
    device_id,
    az_min: ranges.azMin,
    az_max: ranges.azMax,
    el_min: ranges.elMin,
    el_max: ranges.elMax,
    step_deg: ranges.step,
    started_at: nowISO(),
  }];
  try {
    await sbFetch("fov_sessions", "POST", payload);
  } catch (e) {
    if (String(e.message || "").includes("HTTP 409")) {
      const existingAfterConflict = await fetchSessionById(session_id).catch(() => null);
      if (existingAfterConflict) {
        setSessionId(session_id);
        state.fovRows = await fetchFovData(session_id);
        clearTelemetryUI();
        setRetryEnabled(false);
        updateStatus();
        log(`Session exists (conflict). Reusing: ${session_id.substring(0, 8)}`);
        return session_id;
      }
    }
    throw e;
  }
  setSessionId(session_id);
  state.lastTelemetryId = null;
  state.lastTelemetry = null;
  state.lastTelemetryError = "";
  state.fovRows = [];
  clearTelemetryUI();
  setRetryEnabled(false);
  updateStatus();
  log(`Session created: ${session_id.substring(0, 8)}`);
  return session_id;
}

async function fetchSessionById(session_id) {
  if (!session_id) return null;
  const query = new URLSearchParams({
    session_id: `eq.${session_id}`,
    limit: "1",
  }).toString();
  const rows = await sbFetch(`fov_sessions?${query}`, "GET");
  return rows && rows[0] ? rows[0] : null;
}

async function insertMoveCommand(az, el) {
  const device_id = ui.sbDeviceId ? (ui.sbDeviceId.value.trim() || DEFAULT_DEVICE_ID) : DEFAULT_DEVICE_ID;
  if (!state.currentSessionId) throw new Error("No session_id. Press Start.");
  const payload = [{
    session_id: state.currentSessionId,
    device_id,
    cmd: "MOVE",
    az_cmd: az,
    el_cmd: el,
    created_at: nowISO(),
  }];
  await sbFetch("command_table", "POST", payload);
  log(`Inserted Supabase MOVE az=${az}, el=${el}`);
}

async function pollTelemetryAck() {
  const device_id = ui.sbDeviceId ? (ui.sbDeviceId.value.trim() || DEFAULT_DEVICE_ID) : DEFAULT_DEVICE_ID;
  if (!state.currentSessionId) return;

  setCaptureEnabled(false);
  const start = Date.now();
  const timeoutMs = 10000;

  while (Date.now() - start < timeoutMs) {
    const query = new URLSearchParams({
      session_id: `eq.${state.currentSessionId}`,
      device_id: `eq.${device_id}`,
      order: "id.desc",
      limit: "1",
    }).toString();

    const rows = await sbFetch(`telemetry_table?${query}`, "GET");
    const row = rows && rows[0];
    if (row && row.id !== state.lastTelemetryId) {
      state.lastTelemetryId = row.id;
      if (row.status === "EXECUTED") {
        state.lastTelemetry = { id: row.id, az_actual: row.az_actual, el_actual: row.el_actual };
        clearTelemetryUI();
        showTelemetryOk();
        setRetryEnabled(false);
        setCaptureEnabled(true);
        return true;
      }
      if (row.status === "ERROR") {
        showTelemetryError(row.error_msg || "Unknown error");
        log(`Telemetry error: ${row.error_msg || "Unknown"}`);
        setRetryEnabled(true);
        setCaptureEnabled(false);
        return false;
      }
    }
    await new Promise(r => setTimeout(r, 350));
  }

  log("Telemetry timeout");
  setCaptureEnabled(false);
  setRetryEnabled(false);
  return false;
}

async function insertFovData(result) {
  const device_id = ui.sbDeviceId ? (ui.sbDeviceId.value.trim() || DEFAULT_DEVICE_ID) : DEFAULT_DEVICE_ID;
  if (!state.currentSessionId) throw new Error("No session_id. Press Start.");
  if (!state.lastTelemetry) {
    log("No telemetry available for capture.");
    return;
  }
  const payload = [{
    session_id: state.currentSessionId,
    device_id,
    az_deg: state.lastTelemetry.az_actual,
    el_deg: state.lastTelemetry.el_actual,
    result,
    created_at: nowISO(),
  }];
  await sbFetch("fov_data", "POST", payload);
  state.fovRows = await fetchFovData(state.currentSessionId);
  updateStatus();
}

async function fetchFovData(session_id) {
  if (!session_id) return [];
  const query = new URLSearchParams({
    session_id: `eq.${session_id}`,
    order: "created_at.asc",
  }).toString();
  return sbFetch(`fov_data?${query}`, "GET");
}

function resizeCanvasToDisplaySize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    return true;
  }
  return false;
}

function deg2rad(deg) {
  return (deg * Math.PI) / 180;
}

function azElToUnitSphere(azDeg, elDeg) {
  const az = deg2rad(azDeg);
  const el = deg2rad(elDeg);
  return {
    x: Math.cos(el) * Math.cos(az),
    y: Math.cos(el) * Math.sin(az),
    z: Math.sin(el)
  };
}

function elevationToRadius(elevation, maxRadiusPx, maxRadiusDeg) {
  const rDeg = 90 - elevation;
  return (rDeg / maxRadiusDeg) * maxRadiusPx;
}

function drawPolar() {
  const canvas = ui.polarCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  resizeCanvasToDisplaySize(canvas);

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const pad = 14 * dpr;
  const maxRadiusPx = Math.max(1, Math.min(w, h) / 2 - pad);

  const ranges = getRanges();
  const elMin = Math.min(ranges.elMin, ranges.elMax);
  const maxRadiusDeg = elMin < 0 ? 90 - elMin : 90;

  // Rings
  const ringEls = [90, 60, 30, 0];
  if (elMin < 0) ringEls.push(elMin);

  ctx.strokeStyle = "rgba(255,255,255,.10)";
  ctx.lineWidth = 1 * dpr;
  ringEls.forEach((el) => {
    const r = elevationToRadius(el, maxRadiusPx, maxRadiusDeg);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  });

  // Radial lines
  const azLines = [-90, -45, 0, 45, 90];
  ctx.strokeStyle = "rgba(255,255,255,.10)";
  azLines.forEach((az) => {
    const t = deg2rad(az);
    const x = cx + maxRadiusPx * Math.cos(t);
    const y = cy - maxRadiusPx * Math.sin(t);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
  });

  // Points
  const dotR = 4 * dpr;
  const outline = "rgba(0,0,0,.6)";
  const rows = getActiveRowsNormalized();
  rows.forEach((p) => {
    const t = deg2rad(p.az);
    const r = elevationToRadius(p.el, maxRadiusPx, maxRadiusDeg);
    const x = cx + r * Math.cos(t);
    const y = cy - r * Math.sin(t);
    ctx.beginPath();
    ctx.fillStyle = p.status === "OK" ? "#22c55e" : "#ef4444";
    ctx.arc(x, y, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();
  });
}

function drawPolar3D() {
  const el = ui.polar3d;
  if (!el || typeof Plotly === "undefined") return;

  const existingCamera = el._fullLayout?.scene?.camera || null;
  const camera = state.camera3d || existingCamera || DEFAULT_3D_CAMERA;

  const ok = { x: [], y: [], z: [], customdata: [] };
  const bad = { x: [], y: [], z: [], customdata: [] };

  const rows = getActiveRowsNormalized();
  rows.forEach((p) => {
    const c = azElToUnitSphere(p.az, p.el);
    const timeStr = new Date(p.t).toLocaleString();
    const cd = [p.az, p.el, p.status, timeStr];
    if (p.status === "OK") {
      ok.x.push(c.x); ok.y.push(c.y); ok.z.push(c.z); ok.customdata.push(cd);
    } else {
      bad.x.push(c.x); bad.y.push(c.y); bad.z.push(c.z); bad.customdata.push(cd);
    }
  });

  // Unit sphere surface
  const uSteps = 50;
  const vSteps = 25;
  const xs = [];
  const ys = [];
  const zs = [];
  for (let i = 0; i <= vSteps; i++) {
    const v = -Math.PI / 2 + (i / vSteps) * Math.PI;
    const rowX = [];
    const rowY = [];
    const rowZ = [];
    for (let j = 0; j <= uSteps; j++) {
      const u = (j / uSteps) * Math.PI * 2;
      rowX.push(Math.cos(v) * Math.cos(u));
      rowY.push(Math.cos(v) * Math.sin(u));
      rowZ.push(Math.sin(v));
    }
    xs.push(rowX);
    ys.push(rowY);
    zs.push(rowZ);
  }

  // Spherical grid lines
  const gridLineStyle = { width: 1.2, color: "rgba(40,70,120,0.45)" };
  const gridTraces = [];

  // Latitude circles (every 10°)
  for (let elDeg = -80; elDeg <= 80; elDeg += 10) {
    const x = [], y = [], z = [];
    for (let azDeg = 0; azDeg <= 360; azDeg += 5) {
      const c = azElToUnitSphere(azDeg, elDeg);
      x.push(c.x); y.push(c.y); z.push(c.z);
    }
    gridTraces.push({
      type: "scatter3d",
      mode: "lines",
      x, y, z,
      line: gridLineStyle,
      hoverinfo: "skip",
      showlegend: false
    });
  }

  // Longitude meridians (every 10°)
  for (let azDeg = -180; azDeg <= 170; azDeg += 10) {
    const x = [], y = [], z = [];
    for (let elDeg = -90; elDeg <= 90; elDeg += 5) {
      const c = azElToUnitSphere(azDeg, elDeg);
      x.push(c.x); y.push(c.y); z.push(c.z);
    }
    gridTraces.push({
      type: "scatter3d",
      mode: "lines",
      x, y, z,
      line: gridLineStyle,
      hoverinfo: "skip",
      showlegend: false
    });
  }

  // Equator labels
  const labelAzimuths = [-90, -45, 0, 45, 90];
  const labelRadius = 1.03;
  const labelTraces = labelAzimuths.map(azDeg => {
    const c = azElToUnitSphere(azDeg, 0);
    return {
      type: "scatter3d",
      mode: "text",
      x: [c.x * labelRadius],
      y: [c.y * labelRadius],
      z: [c.z * labelRadius],
      text: [`${azDeg}°`],
      textfont: { color: "rgba(231,238,246,.85)", size: 11 },
      hoverinfo: "skip",
      showlegend: false
    };
  });

  const data = [
    {
      type: "surface",
      x: xs,
      y: ys,
      z: zs,
      opacity: 0.10,
      showscale: false,
      colorscale: [[0, "rgba(255,255,255,0.12)"], [1, "rgba(255,255,255,0.12)"]],
      hoverinfo: "skip",
      showlegend: false
    },
    ...gridTraces,
    ...labelTraces,
    {
      type: "scatter3d",
      mode: "markers",
      x: ok.x,
      y: ok.y,
      z: ok.z,
      customdata: ok.customdata,
      marker: { size: 4, color: "#22c55e", line: { color: "rgba(0,0,0,.6)", width: 1 } },
      name: "OK",
      hovertemplate: "az=%{customdata[0]}°<br>el=%{customdata[1]}°<br>%{customdata[2]}<br>%{customdata[3]}<extra></extra>"
    },
    {
      type: "scatter3d",
      mode: "markers",
      x: bad.x,
      y: bad.y,
      z: bad.z,
      customdata: bad.customdata,
      marker: { size: 4, color: "#ef4444", line: { color: "rgba(0,0,0,.6)", width: 1 } },
      name: "NOT OK",
      hovertemplate: "az=%{customdata[0]}°<br>el=%{customdata[1]}°<br>%{customdata[2]}<br>%{customdata[3]}<extra></extra>"
    }
  ];

  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    margin: { l: 0, r: 0, b: 0, t: 0 },
    scene: {
      xaxis: {
        visible: false,
        showgrid: false,
        showticklabels: false,
        showline: false,
        zeroline: false,
        range: [-1.1, 1.1]
      },
      yaxis: {
        visible: false,
        showgrid: false,
        showticklabels: false,
        showline: false,
        zeroline: false,
        range: [-1.1, 1.1]
      },
      zaxis: {
        visible: false,
        showgrid: false,
        showticklabels: false,
        showline: false,
        zeroline: false,
        range: [-1.1, 1.1]
      },
      aspectmode: "cube",
      camera
    },
    showlegend: true,
    legend: {
      x: 0.98,
      y: 0.98,
      xanchor: "right",
      yanchor: "top",
      bgcolor: "rgba(0,0,0,0)",
      borderwidth: 0,
      font: { color: "#e7eef6" }
    }
  };

  Plotly.react(el, data, layout, { displayModeBar: false, responsive: true });

  if (!state.cameraListenerBound) {
    el.on("plotly_relayout", (evt) => {
      if (!evt) return;
      if (evt["scene.camera"] || Object.keys(evt).some((k) => k.startsWith("scene.camera"))) {
        state.camera3d = el._fullLayout?.scene?.camera || state.camera3d;
      }
    });
    state.cameraListenerBound = true;
  }
}

function getRanges() {
  const azMin = clampInt(ui.azMin.value, -50);
  const azMax = clampInt(ui.azMax.value, 50);
  const elMin = clampInt(ui.elMin.value, -15);
  const elMax = clampInt(ui.elMax.value, 85);
  const step = Math.max(1, clampInt(ui.stepDeg.value, 5));
  const dwellMs = Math.max(0, clampInt(ui.dwellMs.value, 250));
  return { azMin, azMax, elMin, elMax, step, dwellMs };
}

function rebuildPoints() {
  const r = getRanges();

  // normalize
  const azMin = Math.min(r.azMin, r.azMax);
  const azMax = Math.max(r.azMin, r.azMax);
  const elMin = Math.min(r.elMin, r.elMax);
  const elMax = Math.max(r.elMin, r.elMax);

  state.points = buildPoints({ azMin, azMax, elMin, elMax, step: r.step });
  state.idx = 0;

  log(`Points generated: ${state.points.length} (az ${azMin}..${azMax}, el ${elMin}..${elMax}, step ${r.step})`);
  updateStatus();
}

// =======================
// Auto-refresh for viewer
// =======================

async function autoRefreshData() {
  if (!state.currentSessionId) return;
  
  try {
    const prevCount = state.fovRows.length;
    state.fovRows = await fetchFovData(state.currentSessionId);
    const newCount = state.fovRows.length;
    
    if (newCount !== prevCount) {
      log(`Auto-refresh: ${newCount} points (${newCount - prevCount > 0 ? '+' : ''}${newCount - prevCount})`);
    }
    
    // Update index to latest point
    state.idx = Math.max(0, state.fovRows.length - 1);
    updateStatus();
  } catch (e) {
    // Silently fail on auto-refresh errors
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.autoRefreshTimer = setInterval(autoRefreshData, AUTO_REFRESH_INTERVAL);
  log("Auto-refresh started (5s interval)");
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) {
    clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
}

// =======================
// UI bindings
// =======================

window.addEventListener("resize", () => {
  drawPolar();
  if (ui.polar3d && typeof Plotly !== "undefined") {
    Plotly.Plots.resize(ui.polar3d);
  }
});

ui.btnExportJson.addEventListener("click", exportJSON);
ui.btnExportCsv.addEventListener("click", exportCSV);

ui.btnFetchSession.addEventListener("click", async () => {
  const sessionIdInput = ui.customSessionId ? ui.customSessionId.value.trim() : "";
  if (!sessionIdInput) {
    log("Enter a Session ID to fetch.");
    return;
  }
  const sessionId = sessionIdInput.substring(0, 8);
  log(`Fetching session: ${sessionId}...`);

  try {
    const session = await fetchSessionById(sessionId);
    if (!session) {
      log(`Session "${sessionId}" not found in Supabase.`);
      return;
    }

    // Restore ranges from session
    if (ui.azMin && session.az_min !== undefined) ui.azMin.value = session.az_min;
    if (ui.azMax && session.az_max !== undefined) ui.azMax.value = session.az_max;
    if (ui.elMin && session.el_min !== undefined) ui.elMin.value = session.el_min;
    if (ui.elMax && session.el_max !== undefined) ui.elMax.value = session.el_max;
    if (ui.stepDeg && session.step_deg !== undefined) ui.stepDeg.value = session.step_deg;

    // Rebuild points with fetched ranges
    rebuildPoints();

    // Set session
    setSessionId(sessionId);
    if (ui.customSessionId) ui.customSessionId.value = sessionId;

    // Fetch existing fov_data
    state.fovRows = await fetchFovData(sessionId);
    
    // Set index to latest captured point
    state.idx = Math.max(0, state.fovRows.length - 1);

    clearTelemetryUI();
    setRetryEnabled(false);
    setRunState("viewing");
    updateStatus();

    log(`Session "${sessionId}" loaded. ${state.fovRows.length} captured points.`);
    
    // Start auto-refresh
    startAutoRefresh();
  } catch (e) {
    log(`Fetch session failed: ${e.message}`);
  }
});

// Initial
rebuildPoints();
setRunState("idle");
const persistedSessionId = loadPersistedSessionId();
if (persistedSessionId) {
  state.currentSessionId = persistedSessionId;
  if (ui.customSessionId && !ui.customSessionId.value.trim()) {
    ui.customSessionId.value = persistedSessionId;
  }
  // Auto-fetch persisted session on load
  fetchSessionById(persistedSessionId)
    .then((session) => {
      if (session) {
        if (ui.azMin && session.az_min !== undefined) ui.azMin.value = session.az_min;
        if (ui.azMax && session.az_max !== undefined) ui.azMax.value = session.az_max;
        if (ui.elMin && session.el_min !== undefined) ui.elMin.value = session.el_min;
        if (ui.elMax && session.el_max !== undefined) ui.elMax.value = session.el_max;
        if (ui.stepDeg && session.step_deg !== undefined) ui.stepDeg.value = session.step_deg;
        rebuildPoints();
      }
      return fetchFovData(persistedSessionId);
    })
    .then((rows) => {
      state.fovRows = rows || [];
      state.idx = Math.max(0, state.fovRows.length - 1);
      setRunState("viewing");
      updateStatus();
      startAutoRefresh();
    })
    .catch((e) => log(`Fetch session data failed: ${e.message}`));
}
log("Ready. Enter Session ID and click Fetch to view live data.");
updateStatus();
