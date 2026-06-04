require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const SS_BASE = 'https://api.smartsheet.com/2.0';
const HEADERS = {
  Authorization: `Bearer ${process.env.SMARTSHEET_TOKEN}`,
  'Content-Type': 'application/json'
};

const SHEETS = {
  schedule: process.env.SHEET_SCHEDULE,
  berths:   process.env.SHEET_BERTHS,
  pipeline: process.env.SHEET_PIPELINE
};

// ─────────────────────────────────────────────────────────────
// CACHE
// Two layers:
//   dataCache   — full sheet rows, 60s TTL, invalidated on writes
//   colCache    — column title→id map, permanent until restart
//                 eliminates the extra fetchSheet call on every write
// ─────────────────────────────────────────────────────────────
const DATA_TTL  = 60 * 1000; // 60 seconds
const dataCache = {};        // { [sheetId]: { rows, ts } }
const colCache  = {};        // { [sheetId]: { [colTitle]: colId } }

function cacheIsFresh(sheetId) {
  const entry = dataCache[sheetId];
  return entry && (Date.now() - entry.ts < DATA_TTL);
}

function invalidate(sheetId) {
  delete dataCache[sheetId];
}

// ── Raw Smartsheet fetch ─────────────────────────────────────
async function fetchSheet(sheetId) {
  const res = await fetch(`${SS_BASE}/sheets/${sheetId}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Smartsheet error ${res.status} on sheet ${sheetId}`);
  return res.json();
}

// ── Cached sheet rows (data cache) ──────────────────────────
async function getRows(sheetId) {
  if (cacheIsFresh(sheetId)) {
    return dataCache[sheetId].rows;
  }
  const sheet = await fetchSheet(sheetId);
  const rows  = parseRows(sheet);
  dataCache[sheetId] = { rows, ts: Date.now() };
  // Also seed colCache while we have the full sheet in hand
  if (!colCache[sheetId]) {
    const map = {};
    sheet.columns.forEach(c => { map[c.title] = c.id; });
    colCache[sheetId] = map;
  }
  return rows;
}

// ── Cached column map (colCache) ────────────────────────────
// Avoids fetching the full sheet just to get column IDs on writes.
async function getColMap(sheetId) {
  if (colCache[sheetId]) return colCache[sheetId];
  const sheet = await fetchSheet(sheetId);
  const map   = {};
  sheet.columns.forEach(c => { map[c.title] = c.id; });
  colCache[sheetId] = map;
  // Seed dataCache too since we have the full sheet
  if (!cacheIsFresh(sheetId)) {
    dataCache[sheetId] = { rows: parseRows(sheet), ts: Date.now() };
  }
  return map;
}

// ── Helper: rows → flat JS objects ──────────────────────────
function parseRows(sheet) {
  const cols = {};
  sheet.columns.forEach(c => { cols[c.id] = c.title; });
  return (sheet.rows || []).map(row => {
    const obj = { _rowId: row.id };
    row.cells.forEach(cell => {
      const key = cols[cell.columnId];
      if (key) obj[key] = cell.value ?? null;
    });
    return obj;
  });
}

// ── Helper: flat object → Smartsheet cells ──────────────────
function buildCells(colMap, data) {
  return Object.entries(data)
    .filter(([k]) => k !== '_rowId' && colMap[k] !== undefined)
    .map(([k, v]) => ({ columnId: colMap[k], value: v }));
}

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'DockOps Proxy Online', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────
// CACHE STATUS  (debug — GET /api/cache/status)
// ─────────────────────────────────────────────────────────────
app.get('/api/cache/status', (req, res) => {
  const sheetName = id => Object.entries(SHEETS).find(([,v]) => v === id)?.[0] ?? id;
  const status = {};
  Object.entries(dataCache).forEach(([id, entry]) => {
    const ageMs  = Date.now() - entry.ts;
    const ageSec = Math.round(ageMs / 1000);
    status[sheetName(id)] = {
      fresh:    ageMs < DATA_TTL,
      age:      `${ageSec}s`,
      expiresIn:`${Math.max(0, Math.round((DATA_TTL - ageMs) / 1000))}s`,
      rows:     entry.rows.length,
    };
  });
  res.json({
    ttl:     `${DATA_TTL / 1000}s`,
    sheets:  status,
    colMaps: Object.keys(colCache).map(sheetName),
  });
});

// ─────────────────────────────────────────────────────────────
// BERTHS
// ─────────────────────────────────────────────────────────────
app.get('/api/berths', async (req, res) => {
  try {
    res.json(await getRows(SHEETS.berths));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/berths/:rowId', async (req, res) => {
  try {
    const colMap = await getColMap(SHEETS.berths);
    const cells  = buildCells(colMap, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.berths}/rows`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify([{ id: parseInt(req.params.rowId), cells }])
    });
    invalidate(SHEETS.berths);           // next GET will be fresh
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// SCHEDULE
// ─────────────────────────────────────────────────────────────
app.get('/api/schedule', async (req, res) => {
  try {
    res.json(await getRows(SHEETS.schedule));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/schedule', async (req, res) => {
  try {
    const colMap = await getColMap(SHEETS.schedule);
    const cells  = buildCells(colMap, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.schedule}/rows`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify([{ cells, toBottom: true }])
    });
    invalidate(SHEETS.schedule);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/schedule/:rowId', async (req, res) => {
  try {
    const colMap = await getColMap(SHEETS.schedule);
    const cells  = buildCells(colMap, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.schedule}/rows`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify([{ id: parseInt(req.params.rowId), cells }])
    });
    invalidate(SHEETS.schedule);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/schedule/:rowId', async (req, res) => {
  try {
    const r = await fetch(
      `${SS_BASE}/sheets/${SHEETS.schedule}/rows?rowIds=${req.params.rowId}&ignoreRowsNotFound=true`,
      { method: 'DELETE', headers: HEADERS }
    );
    invalidate(SHEETS.schedule);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PIPELINE
// ─────────────────────────────────────────────────────────────
app.get('/api/pipeline', async (req, res) => {
  try {
    res.json(await getRows(SHEETS.pipeline));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline', async (req, res) => {
  try {
    const colMap = await getColMap(SHEETS.pipeline);
    const cells  = buildCells(colMap, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.pipeline}/rows`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify([{ cells, toBottom: true }])
    });
    invalidate(SHEETS.pipeline);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/pipeline/:rowId', async (req, res) => {
  try {
    const colMap = await getColMap(SHEETS.pipeline);
    const cells  = buildCells(colMap, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.pipeline}/rows`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify([{ id: parseInt(req.params.rowId), cells }])
    });
    invalidate(SHEETS.pipeline);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pipeline/:rowId', async (req, res) => {
  try {
    const r = await fetch(
      `${SS_BASE}/sheets/${SHEETS.pipeline}/rows?rowIds=${req.params.rowId}&ignoreRowsNotFound=true`,
      { method: 'DELETE', headers: HEADERS }
    );
    invalidate(SHEETS.pipeline);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// INTAKE  (Shipyard client lead → Smartsheet)
// ─────────────────────────────────────────────────────────────
app.post('/api/intake', async (req, res) => {
  try {
    const { sheetId, row } = req.body;
    const r = await fetch(`${SS_BASE}/sheets/${sheetId}/rows`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify([row])
    });
    const data = await r.json();
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`DockOps Proxy running on port ${PORT}`));
