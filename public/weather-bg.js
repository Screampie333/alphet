// weather-bg.js
// Builds and drives the animated sky behind the report.
//
// The layers live in CSS (weather-bg.css); this only puts the elements on the
// page and moves one attribute. Keeping the switch to a single attribute is
// what makes the transition a CSS one - nothing is created or destroyed when
// the weather turns, so there is no flash and no reflow.
//
//   HaboobWeatherBg.mount()          -> inserts #weatherBg as the first child
//   HaboobWeatherBg.set('storm')     -> crossfades to that condition

window.HaboobWeatherBg = (function () {
  const CONDITIONS = ['sunny', 'cloudy', 'overcast', 'storm', 'extreme'];
  const DEFAULT = 'cloudy';

  // Enough to read as blown dust, few enough that a phone does not care.
  // Each one gets its own path and delay so they never march in step.
  const DUST_COUNT = 16;

  let root = null;

  function buildDust() {
    const dust = document.createElement('div');
    dust.className = 'wb-dust';

    for (let i = 0; i < DUST_COUNT; i++) {
      const grain = document.createElement('i');
      const size = 2 + (i % 4);

      grain.style.width = size + 'px';
      grain.style.height = size + 'px';
      grain.style.left = (i * 6.3) % 100 + '%';
      grain.style.top = 55 + ((i * 17) % 45) + '%';
      // Long, staggered, and deliberately not multiples of each other, so the
      // field never falls into a visible loop.
      grain.style.animationDuration = 26 + ((i * 7) % 23) + 's';
      grain.style.animationDelay = '-' + ((i * 11) % 40) + 's';
      grain.style.opacity = 0.35 + ((i % 5) * 0.13);

      dust.appendChild(grain);
    }
    return dust;
  }

  function build() {
    const bg = document.createElement('div');
    bg.id = 'weatherBg';
    bg.setAttribute('aria-hidden', 'true');
    bg.dataset.weather = DEFAULT;

    const sky = document.createElement('div');
    sky.className = 'wb-sky';

    const sun = document.createElement('div');
    sun.className = 'wb-sun';
    const rays = document.createElement('span');
    rays.className = 'wb-rays';
    sun.appendChild(rays);

    const clouds = document.createElement('div');
    clouds.className = 'wb-clouds';
    for (let i = 0; i < 4; i++) clouds.appendChild(document.createElement('i'));

    const rain = document.createElement('div');
    rain.className = 'wb-rain';

    // The flash needs a child: its keyframes animate opacity, and the layer's
    // own opacity is what the condition rules control. One element cannot do
    // both - an animation beats the cascade and the condition would lose.
    const flash = document.createElement('div');
    flash.className = 'wb-flash';
    flash.appendChild(document.createElement('i'));

    const wall = document.createElement('div');
    wall.className = 'wb-wall';

    // Painted back to front: sky, sun, clouds, rain, flash, dust, wall.
    bg.append(sky, sun, clouds, rain, flash, buildDust(), wall);
    return bg;
  }

  function mount(target) {
    if (root) return root;
    root = build();
    (target || document.body).prepend(root);
    return root;
  }

  function set(condition) {
    if (!root) return;
    // An unknown key would clear every rule and leave a bare sky, so anything
    // unrecognised falls back rather than blanking the background.
    root.dataset.weather = CONDITIONS.includes(condition) ? condition : DEFAULT;
  }

  function current() {
    return root ? root.dataset.weather : null;
  }

  return { mount, set, current, CONDITIONS };
})();
