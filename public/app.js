// app.js
// Everything the Haboob dashboard does in the browser:
//   1. the demo condition switcher (so the page is never empty)
//   2. swapping in the real snapshot from GET /api/latest when one exists
//   3. sidebar shell behaviour - mobile drawer, scrollspy, copy-address

/* ------------------------------------------------------------------
   DATA
   ------------------------------------------------------------------ */

// Colours and mascot expressions per condition. Keys match the ones
// scoring.js emits, so a live snapshot maps straight onto these.
const conditions = [
  {
    key: 'sunny', label: 'Sunny', score: 82, color: '#ffe01a',
    desc: 'Lots of tokens graduating, high volume, rugs below normal. The friendliest conditions to enter.',
    mouth: { rx: 26, ry: 16, cy: 210 }
  },
  {
    key: 'cloudy', label: 'Cloudy', score: 54, color: '#e8b87a',
    desc: 'Normal volume, no clear trend either way. Nothing here rewards rushing.',
    mouth: { rx: 20, ry: 12, cy: 216 }
  },
  {
    key: 'overcast', label: 'Overcast', score: 34, color: '#3ba9f5',
    desc: 'Volume is fading and fewer tokens are making it off the bonding curve.',
    mouth: { rx: 22, ry: 10, cy: 222 }
  },
  {
    key: 'storm', label: 'Storm', score: 18, color: '#ff2fb9',
    desc: 'Rugs are above normal and tokens are collapsing together. Hard conditions.',
    mouth: { rx: 30, ry: 20, cy: 222 }
  },
  {
    key: 'extreme', label: 'Extreme', score: 96, color: '#c97a3e',
    desc: 'Wild swings across the board. One token is dragging the whole market, or everything is moving at once.',
    mouth: { rx: 32, ry: 22, cy: 220 }
  }
];

// The four sub-scores. Weights mirror config.js; the labels use the same
// wording as report.js ("Rug safety", "Stability"), because those scores are
// already inverted so that higher always means better weather.
const signals = [
  { key: 'graduation', name: 'Graduation', weight: '35%', note: 'Share of new tokens reaching Raydium' },
  { key: 'volume',     name: 'Volume',     weight: '30%', note: 'Trading volume vs your own baseline' },
  { key: 'rug',        name: 'Rug safety', weight: '25%', note: 'How few tokens rugged (inverted)' },
  { key: 'volatility', name: 'Stability',  weight: '10%', note: 'How calm the price swings were (inverted)' }
];

// Demo sub-scores, used until a real snapshot arrives.
const demoScores = {
  sunny:    { graduation: 78, volume: 88, rug: 88, volatility: 60 },
  cloudy:   { graduation: 50, volume: 52, rug: 78, volatility: 65 },
  overcast: { graduation: 28, volume: 30, rug: 66, volatility: 70 },
  storm:    { graduation: 15, volume: 60, rug: 26, volatility: 12 },
  extreme:  { graduation: 65, volume: 97, rug: 55, volatility: 5 }
};

// Demo raw numbers, roughly in the shape collector.js produces.
const demoRaw = {
  sunny:    { tokensCreated: 9120, tokensGraduated: 214, totalVolumeSol: 128400, tokensRugged: 41,  avgPriceSwingPercent: 14 },
  cloudy:   { tokensCreated: 8044, tokensGraduated: 125, totalVolumeSol: 77563,  tokensRugged: 79,  avgPriceSwingPercent: 17 },
  overcast: { tokensCreated: 6380, tokensGraduated: 62,  totalVolumeSol: 41200,  tokensRugged: 96,  avgPriceSwingPercent: 21 },
  storm:    { tokensCreated: 7410, tokensGraduated: 38,  totalVolumeSol: 96800,  tokensRugged: 233, avgPriceSwingPercent: 44 },
  extreme:  { tokensCreated: 11250, tokensGraduated: 180, totalVolumeSol: 214000, tokensRugged: 158, avgPriceSwingPercent: 63 }
};

const scaleRows = [
  { range: '70 – 100', name: 'Sunny ☀️',   color: '#ffe01a', note: 'Graduations up, volume up, rugs quiet.' },
  { range: '45 – 69',  name: 'Cloudy ⛅',   color: '#e8b87a', note: 'Ordinary day. No edge either direction.' },
  { range: '25 – 44',  name: 'Overcast 🌧️', color: '#3ba9f5', note: 'Volume fading, bonding curves stalling.' },
  { range: '0 – 24',   name: 'Storm ⛈️',    color: '#ff2fb9', note: 'Rugs above normal, tokens falling together.' },
  { range: 'override', name: 'Extreme 🌪️',  color: '#c97a3e', note: 'Volatility so high the index stops mattering.' }
];

/* ------------------------------------------------------------------
   ELEMENTS
   ------------------------------------------------------------------ */

const el = {
  panelLabel: document.getElementById('panelLabel'),
  condName: document.getElementById('condName'),
  condDesc: document.getElementById('condDesc'),
  scoreNum: document.getElementById('scoreNum'),
  chips: document.getElementById('chips'),
  glow: document.getElementById('mascotGlow'),
  mouth: document.getElementById('mouthShape'),
  signalGrid: document.getElementById('signalGrid'),
  readout: document.getElementById('readout'),
  scaleGrid: document.getElementById('scaleGrid'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  footNote: document.getElementById('footNote')
};

/* ------------------------------------------------------------------
   RENDERING
   ------------------------------------------------------------------ */

const nf = new Intl.NumberFormat('en-US');

function renderSignals(scores, color) {
  el.signalGrid.innerHTML = '';
  for (const sig of signals) {
    const value = scores[sig.key];
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div class="card-top">' +
        '<span class="card-name"></span>' +
        '<span class="weight"></span>' +
      '</div>' +
      '<div class="card-value"></div>' +
      '<div class="track"><div class="fill"></div></div>' +
      '<div class="card-note"></div>';

    card.querySelector('.card-name').textContent = sig.name;
    card.querySelector('.weight').textContent = sig.weight;
    card.querySelector('.card-value').textContent = value;
    card.querySelector('.card-note').textContent = sig.note;

    const fill = card.querySelector('.fill');
    fill.style.width = value + '%';
    fill.style.background = color;

    el.signalGrid.appendChild(card);
  }
}

function renderReadout(raw) {
  const rows = [
    ['Tokens created', nf.format(raw.tokensCreated)],
    ['Graduated', nf.format(raw.tokensGraduated)],
    ['Volume (SOL)', nf.format(Math.round(raw.totalVolumeSol))],
    ['Rugged', nf.format(raw.tokensRugged)],
    ['Avg swing', raw.avgPriceSwingPercent + '%']
  ];

  el.readout.innerHTML = '';
  for (const [label, value] of rows) {
    const cell = document.createElement('div');
    cell.innerHTML = '<dt></dt><dd></dd>';
    cell.querySelector('dt').textContent = label;
    cell.querySelector('dd').textContent = value;
    el.readout.appendChild(cell);
  }
}

function renderScale() {
  el.scaleGrid.innerHTML = '';
  for (const row of scaleRows) {
    const item = document.createElement('div');
    item.className = 'scale-item';
    item.style.borderLeftColor = row.color;
    item.innerHTML =
      '<div class="scale-range"></div>' +
      '<div class="scale-name"></div>' +
      '<div class="scale-note"></div>';
    item.querySelector('.scale-range').textContent = row.range;
    item.querySelector('.scale-name').textContent = row.name;
    item.querySelector('.scale-name').style.color = row.color;
    item.querySelector('.scale-note').textContent = row.note;
    el.scaleGrid.appendChild(item);
  }
}

// Paint the whole report card: colour accent, mascot mood, sub-scores, raws.
function paint({ cond, label, index, desc, scores, raw }) {
  document.documentElement.style.setProperty('--accent', cond.color);

  el.panelLabel.textContent = label;
  el.condName.textContent = cond.label;
  el.condDesc.textContent = desc;
  el.scoreNum.textContent = index;
  el.glow.style.background = cond.color;

  el.mouth.setAttribute('rx', cond.mouth.rx);
  el.mouth.setAttribute('ry', cond.mouth.ry);
  el.mouth.setAttribute('cy', cond.mouth.cy);

  renderSignals(scores, cond.color);
  renderReadout(raw);

  document.querySelectorAll('.chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.key === cond.key);
  });
}

function showDemo(cond) {
  paint({
    cond,
    label: 'Current condition · demo',
    index: cond.score,
    desc: cond.desc,
    scores: demoScores[cond.key],
    raw: demoRaw[cond.key]
  });
}

function showLive(snapshot) {
  const cond = conditions.find(c => c.key === snapshot.condition.key) || conditions[1];

  paint({
    cond,
    label: 'Current condition · live',
    index: snapshot.index,
    desc: snapshot.condition.summary,
    scores: snapshot.subScores,
    raw: snapshot.raw
  });

  el.condName.textContent = snapshot.condition.label;

  el.statusDot.classList.add('live');
  el.statusText.textContent = 'Live · ' + timeAgo(snapshot.timestamp);
  el.footNote.textContent =
    'Reading from the latest stored snapshot' +
    (snapshot.raw.source === 'mock' ? ' (mock collector)' : '') +
    '. Switch conditions above to preview the other four.';
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
   SIDEBAR SHELL
   ------------------------------------------------------------------ */

const sidebar = document.getElementById('sidebar');
const backdrop = document.getElementById('backdrop');
const menuOpen = document.getElementById('menuOpen');
const menuClose = document.getElementById('menuClose');

function setDrawer(open) {
  sidebar.classList.toggle('open', open);
  backdrop.classList.toggle('open', open);
  menuOpen.setAttribute('aria-expanded', String(open));
  menuClose.style.display = open ? 'inline-flex' : 'none';
}

menuOpen.addEventListener('click', () => setDrawer(true));
menuClose.addEventListener('click', () => setDrawer(false));
backdrop.addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') setDrawer(false);
});

// Tapping a nav link on mobile should close the drawer behind you.
document.querySelectorAll('.nav-item[data-target]').forEach(item => {
  item.addEventListener('click', () => setDrawer(false));
});

// Copy the contract address. Falls back to a temporary textarea where the
// async clipboard API isn't available (http:// origins, older browsers).
const caBtn = document.getElementById('caBtn');
const caValue = document.getElementById('caValue');
const CONTRACT_ADDRESS = ''; // paste the real address here once it exists

caBtn.addEventListener('click', async () => {
  if (!CONTRACT_ADDRESS) {
    flashCa('Not live yet');
    return;
  }
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(CONTRACT_ADDRESS);
    } else {
      const tmp = document.createElement('textarea');
      tmp.value = CONTRACT_ADDRESS;
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      tmp.remove();
    }
    flashCa('Copied!');
  } catch {
    flashCa('Copy failed');
  }
});

function flashCa(message) {
  const original = caValue.textContent;
  caValue.textContent = message;
  caValue.classList.add('copied');
  setTimeout(() => {
    caValue.textContent = original;
    caValue.classList.remove('copied');
  }, 1400);
}

if (CONTRACT_ADDRESS) {
  caValue.textContent = CONTRACT_ADDRESS.slice(0, 4) + '…' + CONTRACT_ADDRESS.slice(-4);
}

// Highlight the nav item for whichever section is currently in view.
const navItems = [...document.querySelectorAll('.nav-item[data-target]')];
const sections = navItems
  .map(item => document.getElementById(item.dataset.target))
  .filter(Boolean);

const spy = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    navItems.forEach(item => {
      item.classList.toggle('active', item.dataset.target === entry.target.id);
    });
  }
}, { rootMargin: '-45% 0px -50% 0px' });

sections.forEach(section => spy.observe(section));

/* ------------------------------------------------------------------
   BOOT
   ------------------------------------------------------------------ */

renderScale();
showDemo(conditions[1]); // paint immediately so the page is never empty

// Then swap in real data if the server has a snapshot. No server (opened as a
// plain file, offline) simply leaves the demo view in place.
fetch('/api/latest')
  .then(res => (res.ok ? res.json() : null))
  .then(data => {
    if (data && data.snapshot) showLive(data.snapshot);
  })
  .catch(() => {});
