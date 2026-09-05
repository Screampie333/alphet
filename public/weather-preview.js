// weather-preview.js
// TEMPORARY dev control for eyeballing the weather backgrounds.
//
// To remove: delete this file and its <script> tag in index.html. Nothing else
// refers to it - it injects its own styles and takes over HaboobWeatherBg.set
// from the outside rather than asking app.js to know about it.
//
// Pinning matters: without it, picking "storm" would hold only until the next
// thing that calls set() with the real reading, and the sky would snap back
// mid-inspection. While a condition is pinned, calls from the data are
// swallowed and remembered, so "Live" can hand control straight back.

(function () {
  if (!window.HaboobWeatherBg) return;

  // Mirrors the condition colours in app.js. Duplicated rather than exported
  // because this file is temporary and should not leave a hook behind in the
  // real code when it goes.
  const COLORS = {
    sunny: '#ffe01a',
    cloudy: '#d9a066',
    overcast: '#3ba9f5',
    storm: '#ff2fb9',
    extreme: '#c97a3e'
  };

  const LABELS = {
    sunny: 'Sunny',
    cloudy: 'Cloudy',
    overcast: 'Overcast',
    storm: 'Storm',
    extreme: 'Extreme'
  };

  // renderNow paints the mascot glow with an inline style, which a CSS
  // variable cannot reach - so the preview has to set it directly or the sky
  // and the glow disagree.
  function applyAccent(key){
    document.documentElement.style.setProperty('--accent', COLORS[key]);
    const glow = document.getElementById('mascotGlow');
    if (glow) glow.style.background = COLORS[key];
  }

  const liveSet = HaboobWeatherBg.set;
  let pinned = null;
  let liveCondition = HaboobWeatherBg.current();

  // Everything the page does to the sky comes through here now. When pinned,
  // the real reading is recorded but not shown.
  HaboobWeatherBg.set = function (condition) {
    liveCondition = condition;
    if (pinned) {
      paint();
      return;
    }
    liveSet(condition);
    paint();
  };

  const style = document.createElement('style');
  style.textContent = `
    #wxPreview{
      position:fixed; right:16px; bottom:16px; z-index:60;
      display:flex; flex-direction:column; gap:8px;
      padding:12px 14px;
      background:rgba(20,13,8,0.88);
      border:1px dashed rgba(217,160,102,0.5);
      border-radius:12px;
      backdrop-filter:blur(10px);
      font-family:var(--font-body, system-ui);
      max-width:260px;
    }
    #wxPreview .hd{
      display:flex; align-items:center; gap:8px;
      font-size:10px; font-weight:700; letter-spacing:0.14em;
      text-transform:uppercase; color:var(--text-dim,#8d7458);
    }
    #wxPreview .hd b{
      font-family:var(--font-mono,monospace); font-weight:400;
      font-size:9.5px; letter-spacing:0.04em;
      color:var(--ink,#120d09); background:var(--sand,#d9a066);
      border-radius:3px; padding:1px 5px;
    }
    #wxPreview .row{display:flex; gap:5px; flex-wrap:wrap;}
    #wxPreview button{
      font-family:inherit; font-size:11.5px; font-weight:500;
      padding:5px 10px; border-radius:14px;
      border:1px solid rgba(251,241,226,0.14);
      background:transparent; color:var(--text-muted,#c9ad8c);
      cursor:pointer; transition:all .15s ease;
    }
    #wxPreview button:hover{border-color:var(--sand,#d9a066); color:var(--text,#fbf1e2);}
    #wxPreview button.on{
      background:var(--sand,#d9a066); border-color:var(--sand,#d9a066);
      color:var(--ink,#120d09); font-weight:700;
    }
    #wxPreview .live{border-style:dashed;}
    #wxPreview .note{
      font-size:10.5px; line-height:1.45; color:var(--text-dim,#8d7458);
    }
    #wxPreview .note code{
      font-family:var(--font-mono,monospace); font-size:10px;
      color:var(--cream,#e8b87a);
    }
    @media (max-width:640px){ #wxPreview{left:16px; right:16px; max-width:none;} }
  `;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'wxPreview';
  panel.innerHTML =
    '<div class="hd"><span>Weather preview</span><b>DEV</b></div>' +
    '<div class="row" id="wxPreviewRow"></div>' +
    '<div class="note" id="wxPreviewNote"></div>';
  document.body.appendChild(panel);

  const row = panel.querySelector('#wxPreviewRow');
  const note = panel.querySelector('#wxPreviewNote');

  function paint() {
    row.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.key === (pinned || '__live'));
    });
    note.innerHTML = '';
    if (pinned) {
      note.append('Pinned. The live reading is ');
      const code = document.createElement('code');
      code.textContent = liveCondition || '—';
      note.append(code, ' — press Live to follow it again.');
    } else {
      note.append('Following the reading: ');
      const code = document.createElement('code');
      code.textContent = liveCondition || '—';
      note.append(code);
    }
  }

  for (const key of HaboobWeatherBg.CONDITIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.key = key;
    btn.textContent = LABELS[key] || key;
    btn.addEventListener('click', () => {
      pinned = key;
      liveSet(key);
      // The accent tints the mascot glow and the index, so it follows the
      // pinned sky too - otherwise a rust sky sits under a blue glow and the
      // preview says nothing about how the pairing really looks. The numbers
      // and the condition label stay honest; only the colouring is previewed.
      applyAccent(key);
      paint();
    });
    row.appendChild(btn);
  }

  const live = document.createElement('button');
  live.type = 'button';
  live.className = 'live';
  live.dataset.key = '__live';
  live.textContent = 'Live';
  live.addEventListener('click', () => {
    pinned = null;
    // Snap back to whatever the data last said, which was recorded while the
    // panel was holding the sky.
    if (liveCondition) {
      liveSet(liveCondition);
      applyAccent(liveCondition);
    }
    paint();
  });
  row.appendChild(live);

  paint();
})();
