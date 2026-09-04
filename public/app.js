// app.js
// Draws the weather report: the "right now" reading, the half-hourly strip,
// the daily rows and the detail tiles.
//
// Two data paths, same renderer:
//   demo  - a generated series, so the page is never empty and all five
//           conditions stay previewable
//   live  - GET /api/latest for the current reading, GET /api/history for
//           the series behind the strip and the daily rows

/* ------------------------------------------------------------------
   CONDITIONS
   ------------------------------------------------------------------ */

// Keys match the ones scoring.js emits, so a live snapshot maps straight on.
//
// These are status colours, not a categorical set - each one always ships
// with its emoji and its label, never colour on its own. Cloudy uses the
// brand sand rather than the lighter cream: against yellow the cream sat at
// ~14 ΔE, close enough to be hard to separate even with full colour vision.
const conditions = [
  {
    key: 'sunny', label: 'Sunny', emoji: '☀️', score: 82, color: '#ffe01a',
    desc: 'Lots of tokens graduating, high volume, rugs below normal. The friendliest conditions to enter.',
    mouth: { rx: 26, ry: 16, cy: 210 }
  },
  {
    key: 'cloudy', label: 'Cloudy', emoji: '⛅', score: 54, color: '#d9a066',
    desc: 'Normal volume, no clear trend either way. Nothing here rewards rushing.',
    mouth: { rx: 20, ry: 12, cy: 216 }
  },
  {
    key: 'overcast', label: 'Overcast', emoji: '🌧️', score: 34, color: '#3ba9f5',
    desc: 'Volume is fading and fewer tokens are making it off the bonding curve.',
    mouth: { rx: 22, ry: 10, cy: 222 }
  },
  {
    key: 'storm', label: 'Storm', emoji: '⛈️', score: 18, color: '#ff2fb9',
    desc: 'Rugs are above normal and tokens are collapsing together. Hard conditions.',
    mouth: { rx: 30, ry: 20, cy: 222 }
  },
  {
    key: 'extreme', label: 'Extreme', emoji: '🌪️', score: 96, color: '#c97a3e',
    desc: 'Wild swings across the board. One token is dragging the whole market, or everything is moving at once.',
    mouth: { rx: 32, ry: 22, cy: 220 }
  }
];

const byKey = Object.fromEntries(conditions.map((c) => [c.key, c]));

// Same thresholds as scoring.js, so a demo index picks the same condition a
// real one would.
function conditionForIndex(index) {
  if (index >= 70) return byKey.sunny;
  if (index >= 45) return byKey.cloudy;
  if (index >= 25) return byKey.overcast;
  return byKey.storm;
}

// The four sub-scores. Weights mirror config.js; the labels match report.js
// ("Rug safety", "Stability") because those two are already inverted, so on
// every tile higher means better weather.
const signals = [
  { key: 'graduation', name: 'Graduation', weight: '35%', cap: 'Share of new tokens reaching Raydium.' },
  { key: 'volume',     name: 'Volume',     weight: '30%', cap: 'Trading volume against your own baseline.' },
  { key: 'rug',        name: 'Rug safety', weight: '25%', cap: 'How few tokens rugged. Higher is safer.' },
  { key: 'volatility', name: 'Stability',  weight: '10%', cap: 'How calm the price swings were.' }
];

/* ------------------------------------------------------------------
   DEMO SERIES
   ------------------------------------------------------------------ */

const demoScores = {
  sunny:    { graduation: 78, volume: 88, rug: 88, volatility: 60 },
  cloudy:   { graduation: 50, volume: 52, rug: 78, volatility: 65 },
  overcast: { graduation: 28, volume: 30, rug: 66, volatility: 70 },
  storm:    { graduation: 15, volume: 60, rug: 26, volatility: 12 },
  extreme:  { graduation: 65, volume: 97, rug: 55, volatility: 5 }
};

const demoRaw = {
  sunny:    { tokensCreated: 9120,  tokensGraduated: 214, totalVolumeSol: 128400, tokensRugged: 41,  avgPriceSwingPercent: 14 },
  cloudy:   { tokensCreated: 8044,  tokensGraduated: 125, totalVolumeSol: 77563,  tokensRugged: 79,  avgPriceSwingPercent: 17 },
  overcast: { tokensCreated: 6380,  tokensGraduated: 62,  totalVolumeSol: 41200,  tokensRugged: 96,  avgPriceSwingPercent: 21 },
  storm:    { tokensCreated: 7410,  tokensGraduated: 38,  totalVolumeSol: 96800,  tokensRugged: 233, avgPriceSwingPercent: 44 },
  extreme:  { tokensCreated: 11250, tokensGraduated: 180, totalVolumeSol: 214000, tokensRugged: 158, avgPriceSwingPercent: 63 }
};

// A deterministic wobble, so the demo strip looks like a real series instead
// of a flat line - and looks the same on every reload.
function wobble(seed) {
  return Math.sin(seed * 12.9898) * 43758.5453 % 1;
}

// Build a believable run of readings ending at `endIndex`.
function demoSeries(endIndex, count, stepMs) {
  const now = Date.now();
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const drift = Math.round(wobble(i + endIndex) * 16);
    const index = Math.max(2, Math.min(99, endIndex + (i === 0 ? 0 : drift)));
    out.push({
      timestamp: new Date(now - i * stepMs).toISOString(),
      index,
      condition: conditionForIndex(index)
    });
  }
  return out;
}

/* ------------------------------------------------------------------
   ELEMENTS
   ------------------------------------------------------------------ */

const el = {
  index: document.getElementById('wxIndex'),
  cond: document.getElementById('wxCond'),
  summary: document.getElementById('wxSummary'),
  hl: document.getElementById('wxHL'),
  loc: document.getElementById('wxLoc'),
  hours: document.getElementById('wxHours'),
  hoursMeta: document.getElementById('wxHoursMeta'),
  days: document.getElementById('wxDays'),
  daysMeta: document.getElementById('wxDaysMeta'),
  tiles: document.getElementById('wxTiles'),
  raw: document.getElementById('wxRaw'),
  chips: document.getElementById('wxChips'),
  note: document.getElementById('wxNote'),
  glow: document.getElementById('mascotGlow'),
  mouth: document.getElementById('mouthShape'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText')
};

const nf = new Intl.NumberFormat('en-US');
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: false });
const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const fullFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/* ------------------------------------------------------------------
   RENDERING
   ------------------------------------------------------------------ */

// Half-hourly strip. Every value is directly labelled, so the tooltip only
// carries the things the column has no room for.
function renderHours(series) {
  el.hours.innerHTML = '';

  series.forEach((point, i) => {
    const cond = byKey[point.condition.key] || byKey.cloudy;
    const isNow = i === series.length - 1;
    const when = new Date(point.timestamp);

    const col = document.createElement('div');
    col.className = 'wx-hour' + (isNow ? ' now' : '');
    col.title = `${fullFmt.format(when)} · ${cond.label} · index ${point.index}`;
    col.innerHTML =
      '<span class="t"></span>' +
      '<span class="ico"></span>' +
      '<span class="v"></span>' +
      '<span class="pip"></span>';

    col.querySelector('.t').textContent = isNow ? 'Now' : timeFmt.format(when);
    col.querySelector('.ico').textContent = cond.emoji;
    col.querySelector('.v').textContent = point.index;
    col.querySelector('.pip').style.background = cond.color;

    el.hours.appendChild(col);
  });

  // Newest reading sits at the right, which is where the eye should land.
  el.hours.scrollLeft = el.hours.scrollWidth;
}

// Group a series into calendar days, keeping each day's low, high and last.
function groupByDay(series) {
  const days = new Map();

  for (const point of series) {
    const date = new Date(point.timestamp);
    const key = date.toISOString().slice(0, 10);

    if (!days.has(key)) {
      days.set(key, { key, date, low: point.index, high: point.index, last: point.index });
    }
    const day = days.get(key);
    day.low = Math.min(day.low, point.index);
    day.high = Math.max(day.high, point.index);
    day.last = point.index; // series is oldest-first, so this ends up the newest
  }

  return [...days.values()];
}

function renderDays(series) {
  const days = groupByDay(series);
  const todayKey = new Date().toISOString().slice(0, 10);
  el.days.innerHTML = '';

  for (const day of days) {
    const cond = conditionForIndex(day.last);
    const isToday = day.key === todayKey;

    const row = document.createElement('div');
    row.className = 'wx-day' + (isToday ? ' today' : '');
    row.title = `${day.key} · low ${day.low}, high ${day.high}`;
    row.innerHTML =
      '<span class="d"></span>' +
      '<span class="ico"></span>' +
      '<span class="lo"></span>' +
      '<span class="wx-range"><span class="fill"></span><span class="pin"></span></span>' +
      '<span class="hi"></span>';

    row.querySelector('.d').textContent = isToday ? 'Today' : dayFmt.format(day.date);
    row.querySelector('.ico').textContent = cond.emoji;
    row.querySelector('.lo').textContent = day.low;
    row.querySelector('.hi').textContent = day.high;

    // Track is the whole 0-100 scale; the fill spans this day's range, so
    // rows stay comparable to each other rather than each being self-scaled.
    const fill = row.querySelector('.fill');
    fill.style.left = day.low + '%';
    fill.style.width = Math.max(2, day.high - day.low) + '%';
    row.querySelector('.pin').style.left = day.last + '%';

    el.days.appendChild(row);
  }
}

function renderTiles(scores, raw) {
  el.tiles.innerHTML = '';

  for (const sig of signals) {
    const value = scores[sig.key];

    const tile = document.createElement('div');
    tile.className = 'wx-card wx-tile';
    tile.innerHTML =
      '<div class="wx-card-head"><span class="name"></span><span class="right"></span></div>' +
      '<div class="val"></div>' +
      '<div class="wx-meter"><div class="fill"></div></div>' +
      '<div class="wx-scale-ends"><span>0</span><span>100</span></div>' +
      '<div class="cap"></div>';

    tile.querySelector('.name').textContent = sig.name;
    tile.querySelector('.right').textContent = sig.weight;
    tile.querySelector('.val').textContent = value;
    tile.querySelector('.fill').style.width = value + '%';
    tile.querySelector('.cap').textContent = sig.cap;

    el.tiles.appendChild(tile);
  }

  const rows = [
    ['Tokens created', nf.format(raw.tokensCreated)],
    ['Graduated', nf.format(raw.tokensGraduated)],
    ['Volume (SOL)', nf.format(Math.round(raw.totalVolumeSol))],
    ['Rugged', nf.format(raw.tokensRugged)],
    ['Avg swing', raw.avgPriceSwingPercent + '%']
  ];

  el.raw.innerHTML = '';
  for (const [label, value] of rows) {
    const cell = document.createElement('div');
    cell.innerHTML = '<dt></dt><dd></dd>';
    cell.querySelector('dt').textContent = label;
    cell.querySelector('dd').textContent = value;
    el.raw.appendChild(cell);
  }
}

// Paint the hero reading and drive the accent colour + mascot mood.
function renderNow(cond, index, summary, series) {
  document.documentElement.style.setProperty('--accent', cond.color);

  el.index.innerHTML = '';
  el.index.append(String(index));
  const sup = document.createElement('sup');
  sup.textContent = '/100';
  el.index.append(sup);

  el.cond.textContent = `${cond.label} ${cond.emoji}`;
  el.summary.textContent = summary;
  el.glow.style.background = cond.color;
  el.mouth.setAttribute('rx', cond.mouth.rx);
  el.mouth.setAttribute('ry', cond.mouth.ry);
  el.mouth.setAttribute('cy', cond.mouth.cy);

  // High and low across whatever series we have, the way a forecast shows
  // the day's range under the current temperature.
  const values = series.map((p) => p.index);
  el.hl.innerHTML = 'H:<span>' + Math.max(...values) + '</span>  L:<span>' + Math.min(...values) + '</span>';

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.key === cond.key);
  });
}

/* ------------------------------------------------------------------
   VIEWS
   ------------------------------------------------------------------ */

const HALF_HOUR = 30 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

function showDemo(cond) {
  const hourly = demoSeries(cond.score, 14, HALF_HOUR);
  const daily = demoSeries(cond.score, 7 * 6, 4 * 60 * 60 * 1000); // 6 readings/day, 7 days

  el.loc.textContent = 'pump.fun';
  renderNow(cond, cond.score, cond.desc, hourly);
  renderHours(hourly);
  renderDays(daily);
  renderTiles(demoScores[cond.key], demoRaw[cond.key]);

  el.hoursMeta.textContent = 'demo';
  el.daysMeta.textContent = 'demo';
  el.note.textContent =
    'Demo reading. Pick a condition above to preview how each one looks — real numbers replace these as soon as a snapshot is available.';
}

function showLive(snapshot, history) {
  const cond = byKey[snapshot.condition.key] || byKey.cloudy;

  // The snapshot may be newer than the history file's tail, so make sure the
  // current reading is the last point of the series either way.
  const series = history.length ? history : [snapshot];
  const hourly = series.slice(-14);

  el.loc.textContent = 'pump.fun';
  renderNow(cond, snapshot.index, snapshot.condition.summary, hourly);
  renderHours(hourly);
  renderDays(series);
  renderTiles(snapshot.subScores, snapshot.raw);

  const readings = series.length;
  el.hoursMeta.textContent = readings > 1 ? `last ${Math.min(readings, 14)} readings` : 'first reading';
  el.daysMeta.textContent = `${groupByDay(series).length} day(s) on file`;

  el.statusDot.classList.add('live');
  el.statusText.textContent = 'Live · ' + timeAgo(snapshot.timestamp);

  const isMock = snapshot.raw.source === 'mock';
  el.note.textContent =
    (isMock ? 'Live view, mock collector. ' : 'Live view. ') +
    (readings < 6
      ? `Only ${readings} snapshot(s) on file — the strip and the daily rows fill in as the collector keeps running.`
      : 'Reading from your stored snapshots.');
}

function timeAgo(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.round(hours / 24) + 'd ago';
}

/* ------------------------------------------------------------------
   CONDITION CHIPS
   ------------------------------------------------------------------ */

for (const cond of conditions) {
  const chip = document.createElement('button');
  chip.className = 'chip';
  chip.type = 'button';
  chip.textContent = cond.label;
  chip.dataset.key = cond.key;
  chip.addEventListener('click', () => showDemo(cond));
  el.chips.appendChild(chip);
}

/* ------------------------------------------------------------------
   SIDEBAR SHELL  (shared behaviour lives in shell.js)
   ------------------------------------------------------------------ */

HaboobShell.initDrawer();
HaboobShell.initContractCopy();
HaboobShell.initScrollSpy('.nav-item[data-target]');

/* ------------------------------------------------------------------
   BOOT
   ------------------------------------------------------------------ */

showDemo(byKey.cloudy); // paint immediately so the page is never empty

// Then swap in real data. No server (opened as a plain file, offline) simply
// leaves the demo view in place.
Promise.all([
  fetch('/api/latest').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  fetch('/api/history?days=7').then((r) => (r.ok ? r.json() : null)).catch(() => null)
]).then(([latest, history]) => {
  if (!latest || !latest.snapshot) return;
  showLive(latest.snapshot, (history && history.snapshots) || []);
});
