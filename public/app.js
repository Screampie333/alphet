// app.js
// Draws the weather report: the "right now" reading, the hourly strip, the
// daily rows and the detail tiles.
//
// Two data paths, same renderer:
//   demo  - a generated series, so the page is never empty before the
//           collector has produced anything
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

// The four signals, weights mirroring config.js.
//
// Named and oriented the same way as the timeframe panel below them.
//
// These tiles used to read "Rug safety 89" and "Stability 47" while the panel
// read "Rug rate 0.14%" and "Volatility 99.5%" - the same two signals, facing
// opposite ways, one screen apart. Now both show the measured rate, and the
// 0-100 score that actually feeds the index sits under it as the meter.
//
// `rate` picks the measured value out of subScores.rates, which the scoring
// pass already pooled over an hour, so the number and its meter describe the
// same window.
const signals = [
  {
    key: 'graduation',
    name: 'Graduation rate',
    weight: '35%',
    rate: (r) => r.graduationRatePercent,
    unit: '%',
    decimals: 2,
    cap: 'Share of new tokens reaching Raydium.'
  },
  {
    key: 'volume',
    name: 'Volume',
    weight: '30%',
    rate: (r) => r.volumeSol,
    unit: ' SOL',
    decimals: 0,
    cap: 'Trading volume against your own baseline.'
  },
  {
    key: 'rug',
    name: 'Rug rate',
    weight: '25%',
    rate: (r) => r.rugRatePercent,
    unit: '%',
    decimals: 2,
    cap: 'Share of tracked tokens whose creator dumped. Lower is safer.'
  },
  {
    key: 'volatility',
    name: 'Volatility',
    weight: '10%',
    rate: (r) => r.avgPriceSwingPercent,
    unit: '%',
    decimals: 0,
    cap: 'How far prices swung. Lower is calmer.'
  }
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
  hourDetail: document.getElementById('wxHourDetail'),
  days: document.getElementById('wxDays'),
  daysMeta: document.getElementById('wxDaysMeta'),
  tiles: document.getElementById('wxTiles'),
  raw: document.getElementById('wxRaw'),
  note: document.getElementById('wxNote'),
  glow: document.getElementById('mascotGlow'),
  mouth: document.getElementById('mouthShape'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText')
};

// Everything on the page is shown in one fixed zone, so two people reading
// the same report in different countries are looking at the same clock.
//
// It also has to be the zone the *buckets* are built in, not just the one the
// labels are printed in. Before this, hours were grouped by the viewer's own
// clock while days were grouped in UTC - so on a browser east of UTC the last
// hour of a day landed in the following day's row.
const TZ = 'America/Chicago';

const nf = new Intl.NumberFormat('en-US');
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: false });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
const fullFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });

// Calendar parts as they read in TZ, which is what the buckets key on.
const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23'
});

function zonedParts(date) {
  const out = {};
  for (const part of partsFmt.formatToParts(date)) out[part.type] = part.value;
  return out;
}

// "2026-09-05" and "2026-09-05T14" in TZ, used as grouping keys.
function dayKey(date) {
  const p = zonedParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function hourKey(date) {
  return `${dayKey(date)}T${zonedParts(date).hour}`;
}

/* ------------------------------------------------------------------
   RENDERING
   ------------------------------------------------------------------ */

// Fold a series into one column per clock hour.
//
// The collector runs every few minutes, which is the right cadence for the
// index but far too fine to read as a strip - a dozen columns covering one
// hour tells you nothing you can act on. Each hour becomes its own column
// carrying the average of the readings inside it, so the strip covers a
// stretch of the day instead of the last few minutes.
//
// Bucketed on the local clock, not UTC, so the labels line up with the
// reader's own hours.
function groupByHour(series) {
  const hours = new Map();

  for (const point of series) {
    const when = new Date(point.timestamp);
    const key = hourKey(when);

    // The first reading of the hour stands for it. Keeping a real timestamp
    // rather than a reconstructed one means the formatters do the zone
    // conversion, and DST is theirs to handle rather than ours.
    if (!hours.has(key)) hours.set(key, { key, start: when, points: [] });
    hours.get(key).points.push(point);
  }

  return [...hours.values()]
    .sort((a, b) => a.start - b.start)
    .map((hour) => {
      const values = hour.points.map((p) => p.index);
      const total = values.reduce((sum, v) => sum + v, 0);
      return {
        key: hour.key,
        start: hour.start,
        index: Math.round(total / values.length),
        low: Math.min(...values),
        high: Math.max(...values),
        readings: values.length,
        // The individual snapshots are kept, not just their average: an hour
        // that averaged 59 having run 40 to 71 is a different hour from one
        // that sat at 59 throughout, and only the readings can say which.
        points: hour.points
      };
    });
}

// Hourly strip. Every value is directly labelled, so the tooltip only carries
// what the column has no room for.
let openHourKey = null;

function renderHours(hours, currentIndex = null) {
  el.hours.innerHTML = '';

  hours.forEach((hour, i) => {
    const isNow = i === hours.length - 1;
    // The current hour is still in progress, so its column shows the live
    // reading rather than a part-hour average - that way it agrees with the
    // big number above it. Past hours show what they averaged.
    const shown = isNow && currentIndex !== null ? currentIndex : hour.index;
    const cond = conditionForIndex(shown);

    const col = document.createElement('button');
    col.type = 'button';
    col.className = 'wx-hour' + (isNow ? ' now' : '') + (hour.key === openHourKey ? ' open' : '');
    col.setAttribute('aria-expanded', String(hour.key === openHourKey));
    col.title = `${fullFmt.format(hour.start)} — open this hour`;
    col.innerHTML =
      '<span class="t"></span>' +
      '<span class="ico"></span>' +
      '<span class="v"></span>' +
      '<span class="pip"></span>';

    col.querySelector('.t').textContent = isNow ? 'Now' : timeFmt.format(hour.start);
    col.querySelector('.ico').textContent = cond.emoji;
    col.querySelector('.v').textContent = shown;
    col.querySelector('.pip').style.background = cond.color;

    col.addEventListener('click', () => {
      openHourKey = openHourKey === hour.key ? null : hour.key;
      renderHours(hours, currentIndex);
      renderHourDetail(hours);
    });

    el.hours.appendChild(col);
  });

  // Newest hour sits at the right, which is where the eye should land - but
  // not while an hour is open, or picking one would scroll it out of view.
  if (openHourKey === null) el.hours.scrollLeft = el.hours.scrollWidth;
}

// The readings behind one hour. The strip shows an hour's average; this is
// what that average is standing on.
function renderHourDetail(hours) {
  const hour = hours.find((h) => h.key === openHourKey);

  if (!hour) {
    el.hourDetail.hidden = true;
    el.hourDetail.innerHTML = '';
    return;
  }

  const cond = conditionForIndex(hour.index);
  el.hourDetail.hidden = false;
  el.hourDetail.innerHTML =
    '<div class="hd-head">' +
      '<span class="hd-when"></span>' +
      '<span class="hd-sum"></span>' +
      '<button type="button" class="hd-close" aria-label="Close">✕</button>' +
    '</div>' +
    '<div class="hd-rows"></div>';

  el.hourDetail.querySelector('.hd-when').textContent = fullFmt.format(hour.start);
  el.hourDetail.querySelector('.hd-sum').textContent =
    `${cond.emoji} ${cond.label} · avg ${hour.index} · ` +
    (hour.readings === 1
      ? '1 reading'
      : `${hour.readings} readings, ${hour.low}–${hour.high}`);

  el.hourDetail.querySelector('.hd-close').addEventListener('click', () => {
    openHourKey = null;
    renderHours(hours);
    renderHourDetail(hours);
  });

  const rows = el.hourDetail.querySelector('.hd-rows');
  for (const point of hour.points) {
    const c = conditionForIndex(point.index);
    const row = document.createElement('div');
    row.className = 'hd-row';
    row.innerHTML =
      '<span class="hd-t"></span>' +
      '<span class="hd-i"></span>' +
      '<span class="hd-bar"><i></i></span>' +
      '<span class="hd-v"></span>';

    row.querySelector('.hd-t').textContent = timeFmt.format(new Date(point.timestamp));
    row.querySelector('.hd-i').textContent = c.emoji;
    row.querySelector('.hd-v').textContent = point.index;

    const fill = row.querySelector('.hd-bar i');
    fill.style.width = point.index + '%';
    fill.style.background = c.color;

    rows.appendChild(row);
  }
}

// Group a series into calendar days, keeping each day's low, high and last.
function groupByDay(series) {
  const days = new Map();

  for (const point of series) {
    const date = new Date(point.timestamp);
    const key = dayKey(date);

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
  const todayKey = dayKey(new Date());
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

function renderTiles(scores, raw, rates) {
  el.tiles.innerHTML = '';

  for (const sig of signals) {
    const score = scores[sig.key];
    const measured = rates ? sig.rate(rates) : null;

    const tile = document.createElement('div');
    tile.className = 'wx-card wx-tile';
    tile.innerHTML =
      '<div class="wx-card-head"><span class="name"></span><span class="right"></span></div>' +
      '<div class="val"></div>' +
      '<div class="wx-meter"><div class="fill"></div></div>' +
      '<div class="wx-scale-ends"><span class="s"></span><span>100</span></div>' +
      '<div class="cap"></div>';

    tile.querySelector('.name').textContent = sig.name;
    tile.querySelector('.right').textContent = sig.weight;

    // The measured rate leads, the way it does in the panel below. Where a
    // rate isn't available - the demo series carries no rates - the score
    // stands in rather than leaving the tile blank.
    const val = tile.querySelector('.val');
    if (measured === null || measured === undefined) {
      val.textContent = score;
    } else {
      val.textContent = formatValue(measured, sig.unit, sig.decimals);
      const unit = document.createElement('small');
      unit.textContent = sig.unit.trim();
      val.appendChild(unit);
    }

    // The 0-100 score is what actually feeds the index, so it stays visible
    // under the number as the meter and its left-hand label.
    tile.querySelector('.fill').style.width = score + '%';
    tile.querySelector('.wx-scale-ends .s').textContent = 'score ' + score;
    tile.querySelector('.cap').textContent = sig.cap;

    el.tiles.appendChild(tile);
  }

  const rows = [
    ['Tokens created', nf.format(raw.tokensCreated)],
    ['Graduated', nf.format(raw.tokensGraduated)],
    ['Volume (SOL)', nf.format(Math.round(raw.totalVolumeSol))],
    ['Rugged', nf.format(raw.tokensRugged)],
    // Rounded: this is a ratio of ratios, so it arrives as a long float and
    // renders as 4024.6111044235167% if handed straight to the page.
    ['Avg swing', nf.format(Math.round(raw.avgPriceSwingPercent)) + '%']
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
function renderNow(cond, index, summary, readings) {
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

  // High and low across the individual readings, not the hourly averages.
  // Averaging first would hide the range it is there to show: an hour that
  // ran 41 to 70 averages to 56, and "H:56 L:56" says nothing happened.
  const values = readings.map((p) => p.index);
  el.hl.innerHTML =
    'H:<span>' + Math.max(...values) + '</span>  L:<span>' + Math.min(...values) + '</span>';
}

/* ------------------------------------------------------------------
   VIEWS
   ------------------------------------------------------------------ */

const HOUR = 60 * 60 * 1000;
const HOURS_SHOWN = 14;

function showDemo(cond) {
  const readings = demoSeries(cond.score, HOURS_SHOWN, HOUR);
  const hourly = groupByHour(readings);
  const daily = demoSeries(cond.score, 7 * 6, 4 * HOUR); // 6 readings/day, 7 days

  el.loc.textContent = 'pump.fun';
  renderNow(cond, cond.score, cond.desc, readings);
  renderHours(hourly, cond.score);
  renderHourDetail(hourly);
  renderDays(daily);
  renderTiles(demoScores[cond.key], demoRaw[cond.key], null);

  el.hoursMeta.textContent = 'demo';
  el.daysMeta.textContent = 'demo';
  el.note.textContent =
    'Demo reading — real numbers replace these as soon as a snapshot is available.';
}

function showLive(snapshot, history) {
  const cond = byKey[snapshot.condition.key] || byKey.cloudy;

  // The snapshot may be newer than the history file's tail, so make sure the
  // current reading is the last point of the series either way.
  const series = history.length ? history : [snapshot];
  const hourly = groupByHour(series).slice(-HOURS_SHOWN);

  // Only the readings the strip actually covers feed the high/low, so the
  // range under the index describes the same stretch the columns show.
  const shownFrom = hourly.length ? hourly[0].start.getTime() : 0;
  const shownReadings = series.filter((s) => new Date(s.timestamp).getTime() >= shownFrom);

  el.loc.textContent = 'pump.fun';
  renderNow(cond, snapshot.index, snapshot.condition.summary, shownReadings);
  renderHours(hourly, snapshot.index);
  renderHourDetail(hourly);
  renderDays(series);
  renderTiles(snapshot.subScores, snapshot.raw, snapshot.subScores.rates);

  const readings = series.length;
  el.hoursMeta.textContent =
    hourly.length > 1 ? `last ${hourly.length} hours` : 'first hour';
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

/* ------------------------------------------------------------------
   TIMEFRAME ROLLUPS
   The four signals over a selectable window, with the change against
   the window before it. All four windows arrive in one response, so
   switching between them is instant.
   ------------------------------------------------------------------ */

const tfRow = document.getElementById('tfRow');
const tfBody = document.getElementById('tfBody');

let rollups = null;
let activeWindow = '24h';

function formatValue(value, unit, decimals) {
  if (value === null || value === undefined) return '—';

  // Big counts read better compacted, the way a market panel shows them.
  if (unit === ' SOL' && Math.abs(value) >= 1000) {
    const compact = value >= 1e6
      ? (value / 1e6).toFixed(2) + 'M'
      : (value / 1e3).toFixed(1) + 'K';
    return compact;
  }
  return nf.format(Number(value.toFixed(decimals ?? 0)));
}

// Direction is carried by the arrow as well as the colour, so the change is
// still readable without colour vision. Whether a rise is good news depends
// on the metric - more volume is good, more rugs is not.
function deltaMarkup(changePercent, upIsGood) {
  if (changePercent === null || changePercent === undefined) {
    return { text: '—', cls: 'flat', title: 'No previous window to compare against yet' };
  }

  const rounded = Math.abs(changePercent) < 0.05 ? 0 : changePercent;
  if (rounded === 0) return { text: '0%', cls: 'flat', title: 'Unchanged' };

  const rising = rounded > 0;
  const good = rising === upIsGood;
  const arrow = rising ? '\u25B2' : '\u25BC';
  const magnitude = Math.abs(rounded) >= 100
    ? Math.round(Math.abs(rounded))
    : Math.abs(rounded).toFixed(2);

  // Colour follows the direction of the number, the way a candle does: green
  // is up and red is down on every metric, so the colour and the arrow can
  // never disagree with each other.
  //
  // The cost is that a falling rug rate shows red even though fewer rugs is
  // good news. Colouring by good-versus-bad instead was tried first and read
  // as broken - green beside a down arrow looks like a contradiction, and it
  // was reported as a bug twice. Direction is the convention people arrive
  // with; the judgement goes in the tooltip, where it cannot fight the colour.
  return {
    text: `${arrow} ${magnitude}%`,
    cls: rising ? 'up' : 'down',
    title: `${rising ? 'Up' : 'Down'} ${magnitude}% vs the previous window — ${good ? 'better' : 'worse'} conditions`
  };
}

// Build a count cell from chain numbers, matching the shape the snapshot
// rollup produces so both render through the same code.
function withChange(label, value, previous, upIsGood) {
  return {
    label,
    upIsGood,
    value,
    changePercent: previous ? ((value - previous) / previous) * 100 : null
  };
}

function renderTimeframe() {
  if (!rollups) return;

  const win = rollups.windows.find((w) => w.key === activeWindow);
  if (!win) return;

  // Keep the pill row in step with the selection.
  [...tfRow.children].forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.key === activeWindow);
  });

  if (!win.available) {
    tfBody.innerHTML = '<div class="tf-empty"></div>';
    tfBody.firstChild.textContent = win.reason;
    return;
  }

  if (!win.readings) {
    tfBody.innerHTML = '<div class="tf-empty"></div>';
    tfBody.firstChild.textContent =
      `No snapshots inside the last ${win.label} yet. Keep the collector running and this fills in.`;
    return;
  }

  tfBody.innerHTML = '<div class="tf-cards"></div><div class="tf-counts"></div><p class="tf-cov"></p>';
  const cards = tfBody.querySelector('.tf-cards');
  const countRow = tfBody.querySelector('.tf-counts');
  const cov = tfBody.querySelector('.tf-cov');

  for (const key of ['graduationRate', 'volume', 'rugRate', 'volatility']) {
    let metric = win.metrics[key];

    // Graduation rate is counted straight off the chain when available, which
    // needs no stored history and is exact rather than sampled. The snapshot
    // rollup is the fallback for when the chain read failed.
    if (key === 'graduationRate' && win.live && win.live.graduationRate !== null) {
      metric = {
        label: 'Graduation rate',
        unit: '%',
        decimals: 2,
        upIsGood: true,
        value: win.live.graduationRate,
        changePercent: win.live.previous.graduationRate
          ? ((win.live.graduationRate - win.live.previous.graduationRate) / win.live.previous.graduationRate) * 100
          : null,
        score: metric ? metric.score : null,
        onChain: true
      };
    }
    if (!metric) continue;

    const delta = deltaMarkup(metric.changePercent, metric.upIsGood);

    const card = document.createElement('div');
    card.className = 'tf-card';
    card.innerHTML =
      '<div class="tf-label"></div>' +
      '<div class="tf-value-row"><span class="tf-value"></span><span class="tf-delta"></span></div>' +
      '<div class="tf-score"><span class="s"></span><span class="bar"><i></i></span></div>';

    card.querySelector('.tf-label').textContent = metric.label;

    const value = card.querySelector('.tf-value');
    value.textContent = formatValue(metric.value, metric.unit, metric.decimals);
    if (metric.unit) {
      const unit = document.createElement('span');
      unit.className = 'u';
      unit.textContent = metric.unit.trim();
      value.appendChild(unit);
    }

    // A total is only as complete as the window behind it. Rates and averages
    // survive a gap - they describe whatever was collected - but a sum comes
    // out short, and "138.2K SOL" sitting beside an exact on-chain count of
    // 25,113 created invites the reader to compare a third of a day with a
    // whole one. So the shortfall is marked on the number itself, not left to
    // a footnote under the panel.
    if (metric.coverageSensitive && win.coveragePercent < 90) {
      const partial = document.createElement('span');
      partial.className = 'tf-partial';
      partial.textContent = `${win.coveragePercent}% of window`;
      partial.title =
        `Summed from ${win.readings} of ~${win.expectedReadings} readings, so this ` +
        `total is short of the real ${win.label} figure. The rates above are ratios ` +
        `and stay accurate at any coverage.`;
      value.appendChild(partial);
    }

    const deltaEl = card.querySelector('.tf-delta');
    deltaEl.textContent = delta.text;
    deltaEl.className = 'tf-delta ' + delta.cls;
    deltaEl.title = delta.title;

    const score = metric.score === null ? 0 : metric.score;
    card.querySelector('.tf-score .s').textContent = 'score ' + (metric.score === null ? '—' : metric.score);
    card.querySelector('.tf-score .bar i').style.width = score + '%';

    cards.appendChild(card);
  }

  for (const key of ['tokensCreated', 'tokensGraduated', 'tokensRugged']) {
    let count = win.counts[key];

    if (win.live) {
      if (key === 'tokensCreated') count = withChange('Created', win.live.created, win.live.previous.created, true);
      if (key === 'tokensGraduated') count = withChange('Graduated', win.live.graduated, win.live.previous.graduated, true);
    }
    if (!count) continue;

    const delta = deltaMarkup(count.changePercent, count.upIsGood);

    const cell = document.createElement('div');
    cell.className = 'tf-count';
    cell.innerHTML = '<div class="k"></div><div class="v"><span class="n"></span><span class="tf-delta"></span></div>';
    cell.querySelector('.k').textContent = count.label;
    cell.querySelector('.n').textContent = count.value === null ? '—' : nf.format(count.value);

    if (count.coverageSensitive && win.coveragePercent < 90) {
      const partial = document.createElement('span');
      partial.className = 'tf-partial';
      partial.textContent = `${win.coveragePercent}%`;
      partial.title = `Summed from ${win.readings} of ~${win.expectedReadings} readings, so this count is short of the real ${win.label} figure.`;
      cell.querySelector('.v').appendChild(partial);
    }

    const deltaEl = cell.querySelector('.tf-delta');
    deltaEl.textContent = delta.text;
    deltaEl.className = 'tf-delta ' + delta.cls;
    deltaEl.title = delta.title;

    countRow.appendChild(cell);
  }

  // Say plainly how much of the window actually has data behind it, so a
  // partly-filled 24h isn't read as a complete day.
  const partial = win.coveragePercent < 90;
  cov.innerHTML = '';
  // Say where each half of the panel comes from. Creation and graduation are
  // counted on-chain and need no history; the rest waits on the collector.
  const snapshotPart = win.readings === 0
    ? `Volume, rug rate and volatility need the collector running — no snapshots in this window yet.`
    : partial
      ? `Volume, rug rate and volatility from ${win.readings} of ~${win.expectedReadings} readings (~${win.coveragePercent}% of this window).`
      : `Volume, rug rate and volatility from ${win.readings} readings.`;
  cov.append(win.live ? 'Created, graduated and graduation rate counted live on-chain. ' + snapshotPart : snapshotPart);
}

function renderTimeframeButtons() {
  tfRow.innerHTML = '';
  for (const win of rollups.windows) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tf';
    btn.textContent = win.label;
    btn.dataset.key = win.key;
    btn.disabled = !win.available;
    if (!win.available) btn.title = win.reason;
    btn.addEventListener('click', () => {
      activeWindow = win.key;
      renderTimeframe();
    });
    tfRow.appendChild(btn);
  }
}

fetch('/api/rollups')
  .then((r) => (r.ok ? r.json() : null))
  .then((data) => {
    if (!data || !data.windows) return;
    rollups = data;

    // Land on the widest window that actually has readings.
    const withData = data.windows.filter((w) => w.available && w.readings > 0);
    activeWindow = withData.length ? withData[withData.length - 1].key : '24h';

    renderTimeframeButtons();
    renderTimeframe();
  })
  .catch(() => {});
