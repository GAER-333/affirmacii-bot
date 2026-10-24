// Солнечная система в шапке приложения.
// Рисуется на <canvas> каждый кадр. Планеты стоят там, где они реально находятся сегодня,
// и движутся с настоящим соотношением скоростей (только сильно ускоренно).
// Внешний вид зависит от времени суток: SolarSystem.setMode('morning' | 'day' | 'night').
(function () {
  var canvas = document.getElementById('solar');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var TAU = Math.PI * 2, DEG = Math.PI / 180;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- Время ---
  // Отсчёт в сутках от 1 января 2000 (так считают астрономы).
  var J2000 = Date.UTC(2000, 0, 1, 12);
  var simDays = (Date.now() - J2000) / 86400000;
  var DAYS_PER_SEC = reduceMotion ? 0.5 : 365.25 / 90; // один земной год за 90 секунд

  // --- Планеты ---
  // L0 — положение на орбите 1 января 2000 (в градусах), rate — сколько градусов проходит за сутки.
  // dist — расстояние на рисунке (сжато, иначе Сатурн не влез бы), r — размер на рисунке.
  var PLANETS = [
    { id: 'mercury', dist: .18, r: 3.6, L0: 252.25, rate: 4.09233445, color: [176, 168, 158] },
    { id: 'venus',   dist: .29, r: 6,   L0: 181.98, rate: 1.60213034, color: [236, 204, 150] },
    { id: 'earth',   dist: .43, r: 10,  L0: 100.46, rate: 0.98560910, color: [52, 112, 214] },
    { id: 'mars',    dist: .57, r: 5.4, L0: 355.43, rate: 0.52403840, color: [214, 104, 62] },
    { id: 'jupiter', dist: .75, r: 14,  L0: 34.40,  rate: 0.08308677, color: [216, 184, 146] },
    { id: 'saturn',  dist: .94, r: 10.5, L0: 49.94, rate: 0.03345965, color: [228, 206, 154] },
  ];
  var MOON = { L0: 218.316, rate: 13.176396, dist: 19 };
  var TILT = 0.5; // насколько «наклонена» плоскость орбит (1 — вид сверху)

  // Материки Земли: lon — долгота (радианы), lat — широта (-1..1), r — размер (в радиусах Земли)
  var CONTINENTS = [
    { lon: 0.0, lat: -0.35, r: 0.46 }, { lon: 1.0, lat: 0.25, r: 0.4 },
    { lon: 2.1, lat: -0.1, r: 0.5 }, { lon: 3.2, lat: 0.4, r: 0.36 },
    { lon: 4.2, lat: -0.4, r: 0.4 }, { lon: 5.3, lat: 0.15, r: 0.38 },
  ];
  // Огни городов — точки на материках
  var CITIES = [];
  CONTINENTS.forEach(function (c, ci) {
    for (var k = 0; k < 9; k++) {
      CITIES.push({
        lon: c.lon + (rand(ci * 20 + k) - 0.5) * c.r * 1.6,
        lat: c.lat + (rand(ci * 20 + k + 9) - 0.5) * c.r * 1.3,
        phase: rand(ci * 7 + k) * TAU,
      });
    }
  });

  // Звёзды фона
  var STARS = [];
  for (var s = 0; s < 110; s++) {
    STARS.push({ x: rand(s), y: rand(s + 500), size: 0.4 + rand(s + 900) * 1.1, phase: rand(s + 1300) * TAU });
  }

  // Детерминированный «случайный» генератор — звёзды не прыгают при перезагрузке
  function rand(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  // --- Режимы (время суток) ---
  // Все числа плавно перетекают из одного режима в другой.
  var MODES = {
    morning: { top: [40, 30, 82],  bottom: [232, 142, 112], sunCore: [255, 226, 176], sunGlow: [255, 150, 92],  glow: 1.0,  stars: .45, city: .45, crescent: 0, orbit: .2 },
    day:     { top: [14, 52, 108], bottom: [76, 158, 212],  sunCore: [255, 252, 236], sunGlow: [255, 222, 128], glow: 1.35, stars: .2,  city: .25, crescent: 0, orbit: .2 },
    night:   { top: [3, 5, 13],    bottom: [16, 20, 38],    sunCore: [255, 200, 136], sunGlow: [255, 126, 58],  glow: .75,  stars: 1,   city: 1,   crescent: 1, orbit: .13 },
  };
  var cur = clone(MODES.night), target = MODES.night;
  var playing = false, playAmount = 0;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function approach(k) {
    Object.keys(target).forEach(function (key) {
      var t = target[key];
      if (Array.isArray(t)) for (var i = 0; i < t.length; i++) cur[key][i] = lerp(cur[key][i], t[i], k);
      else cur[key] = lerp(cur[key], t, k);
    });
  }
  function rgba(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')'; }
  function shadeColor(c, f) { return [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)]; }

  // --- Размер холста (чёткость на экранах с высокой плотностью пикселей) ---
  var W = 0, H = 0, dpr = 1;
  function resize() {
    var rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = rect.width; H = rect.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize', resize);
  resize();

  // --- Рисование ---
  function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); }

  // Тень на ночной стороне планеты. (lx, ly) — направление на Солнце.
  function nightSide(x, y, r, lx, ly, strength) {
    var g = ctx.createLinearGradient(x + lx * r, y + ly * r, x - lx * r, y - ly * r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.42, 'rgba(0,0,0,' + Math.min(1, 0.06 * strength) + ')');
    g.addColorStop(0.58, 'rgba(0,0,0,' + Math.min(1, 0.78 * strength) + ')');
    g.addColorStop(1, 'rgba(0,0,0,' + Math.min(1, 0.9 * strength) + ')');
    ctx.fillStyle = g; circle(x, y, r); ctx.fill();
  }

  // Блик на освещённой стороне
  function highlight(x, y, r, lx, ly) {
    var hx = x + lx * r * 0.45, hy = y + ly * r * 0.45;
    var g = ctx.createRadialGradient(hx, hy, 0, hx, hy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.28)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; circle(x, y, r); ctx.fill();
  }

  function drawBasic(p, x, y, r, lx, ly) {
    ctx.fillStyle = rgba(p.color, 1); circle(x, y, r); ctx.fill();
    if (p.id === 'jupiter' || p.id === 'saturn') {
      // полосы облаков
      ctx.save(); circle(x, y, r); ctx.clip();
      var bands = p.id === 'jupiter' ? [-0.55, -0.2, 0.15, 0.5] : [-0.35, 0.1, 0.45];
      bands.forEach(function (b, i) {
        ctx.fillStyle = rgba(shadeColor(p.color, i % 2 ? 0.78 : 0.88), 0.85);
        ctx.fillRect(x - r, y + b * r, r * 2, r * (p.id === 'jupiter' ? 0.18 : 0.14));
      });
      if (p.id === 'jupiter') { // Большое красное пятно
        ctx.fillStyle = 'rgba(190,100,70,0.8)';
        ctx.beginPath(); ctx.ellipse(x + r * 0.3, y + r * 0.32, r * 0.2, r * 0.11, 0, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
    highlight(x, y, r, lx, ly);
    nightSide(x, y, r, lx, ly, 1);
  }

  function drawEarth(x, y, r, lx, ly, t) {
    var rot = t * 1.6; // вращение Земли (на рисунке — неторопливо)
    // атмосфера — мягкое голубое свечение со стороны Солнца (рисуется позади планеты)
    var ax = x + lx * r * 0.2, ay = y + ly * r * 0.2;
    var ag = ctx.createRadialGradient(ax, ay, r * 0.95, ax, ay, r * 1.5);
    ag.addColorStop(0, 'rgba(120,180,255,0.45)');
    ag.addColorStop(1, 'rgba(120,180,255,0)');
    ctx.fillStyle = ag; circle(ax, ay, r * 1.5); ctx.fill();

    ctx.save(); circle(x, y, r); ctx.clip();
    // океан
    var og = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    og.addColorStop(0, 'rgb(84,150,240)'); og.addColorStop(1, 'rgb(28,78,170)');
    ctx.fillStyle = og; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    // материки (видны, только когда повёрнуты к нам)
    CONTINENTS.forEach(function (c) {
      var a = c.lon + rot;
      var front = Math.cos(a);
      if (front <= 0) return;
      var k = Math.sqrt(1 - c.lat * c.lat);
      var cx = x + Math.sin(a) * k * r, cy = y + c.lat * r;
      ctx.fillStyle = 'rgba(78,158,96,0.95)';
      ctx.beginPath(); ctx.ellipse(cx, cy, c.r * r * front, c.r * r * 0.8, 0, 0, TAU); ctx.fill();
    });
    highlight(x, y, r, lx, ly);
    nightSide(x, y, r, lx, ly, 1.1);
    // огни городов — только на ночной стороне
    if (cur.city > 0.02) {
      CITIES.forEach(function (c) {
        var a = c.lon + rot;
        if (Math.cos(a) <= 0) return;
        var k = Math.sqrt(Math.max(0, 1 - c.lat * c.lat));
        var px = Math.sin(a) * k, py = c.lat;
        var dark = -(px * lx + py * ly); // >0 — точка на тёмной стороне
        if (dark < 0.12) return;
        var a2 = cur.city * Math.min(1, (dark - 0.12) * 3) * (0.75 + 0.25 * Math.sin(t * 3 + c.phase));
        var cx = x + px * r, cy = y + py * r;
        var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 1.8);
        g.addColorStop(0, 'rgba(255,220,150,' + a2 + ')');
        g.addColorStop(1, 'rgba(255,170,80,0)');
        ctx.fillStyle = g; circle(cx, cy, 1.8); ctx.fill();
      });
    }
    ctx.restore();
  }

  // Луна: днём — обычная, освещённая сбоку; ночью превращается в полумесяц
  function drawMoon(x, y, r, lx, ly) {
    var m = cur.crescent;
    if (m > 0.05) { // мягкое свечение ночью
      var gg = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
      gg.addColorStop(0, 'rgba(230,236,255,' + 0.25 * m + ')');
      gg.addColorStop(1, 'rgba(230,236,255,0)');
      ctx.fillStyle = gg; circle(x, y, r * 3.2); ctx.fill();
    }
    ctx.save(); circle(x, y, r); ctx.clip();
    ctx.fillStyle = 'rgb(222,222,212)'; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.fillStyle = 'rgba(170,170,160,0.6)'; // кратеры
    circle(x - r * 0.3, y - r * 0.2, r * 0.22); ctx.fill();
    circle(x + r * 0.25, y + r * 0.3, r * 0.16); ctx.fill();
    if (m < 0.95) { ctx.globalAlpha = 1 - m; nightSide(x, y, r, lx, ly, 1); ctx.globalAlpha = 1; }
    // тень, «откусывающая» диск до полумесяца
    var off = 2.1 - 1.5 * m;
    ctx.fillStyle = 'rgba(10,12,22,' + 0.95 * m + ')';
    circle(x - lx * r * off, y - ly * r * off, r * 1.02); ctx.fill();
    ctx.restore();
  }

  function drawSaturnRing(x, y, r, front) {
    ctx.save();
    ctx.strokeStyle = 'rgba(226,206,160,0.75)'; ctx.lineWidth = r * 0.42;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 2.05, r * 0.66, -0.25, front ? 0 : Math.PI, front ? Math.PI : TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(190,170,130,0.5)'; ctx.lineWidth = r * 0.12;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.62, r * 0.52, -0.25, front ? 0 : Math.PI, front ? Math.PI : TAU);
    ctx.stroke();
    ctx.restore();
  }

  function drawSun(cx, cy, t) {
    var breath = playAmount * 0.09 * Math.sin(t * 1.3) + 0.03 * Math.sin(t * 0.7);
    var R = (22 + 42 * cur.glow) * (1 + breath);
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, rgba(cur.sunGlow, 0.75));
    g.addColorStop(0.35, rgba(cur.sunGlow, 0.28));
    g.addColorStop(1, rgba(cur.sunGlow, 0));
    ctx.fillStyle = g; circle(cx, cy, R); ctx.fill();
    var core = ctx.createRadialGradient(cx - 4, cy - 4, 0, cx, cy, 16);
    core.addColorStop(0, rgba([255, 255, 245], 1));
    core.addColorStop(0.5, rgba(cur.sunCore, 1));
    core.addColorStop(1, rgba(cur.sunGlow, 1));
    ctx.fillStyle = core; circle(cx, cy, 16); ctx.fill();
  }

  // --- Кадр ---
  var last = performance.now(), t0 = last;
  function frame(now) {
    var dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    var t = (now - t0) / 1000;
    simDays += dt * DAYS_PER_SEC;
    approach(1 - Math.exp(-dt * 2.5));
    playAmount = lerp(playAmount, playing ? 1 : 0, 1 - Math.exp(-dt * 2));
    draw(t);
    requestAnimationFrame(frame);
  }

  function draw(t) {
    if (!W || !H) return;
    // небо
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, rgba(cur.top, 1)); bg.addColorStop(1, rgba(cur.bottom, 1));
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    // звёзды
    STARS.forEach(function (s) {
      var a = cur.stars * (0.55 + 0.45 * Math.sin(t * 1.4 + s.phase));
      if (a < 0.03) return;
      ctx.fillStyle = 'rgba(255,255,255,' + a + ')';
      circle(s.x * W, s.y * H, s.size); ctx.fill();
    });

    // Центр системы — под переключателем; размер ограничен и шириной, и высотой,
    // чтобы на широком экране Сатурн не уехал за край
    var cx = W / 2, cy = H * 0.47;
    var Rx = Math.min(W / 2 - 24, H * 0.21 / (TILT * 0.94));

    // орбиты
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,' + cur.orbit + ')';
    PLANETS.forEach(function (p) {
      ctx.beginPath(); ctx.ellipse(cx, cy, p.dist * Rx, p.dist * Rx * TILT, 0, 0, TAU); ctx.stroke();
    });

    // положения планет; depth > 0 — ближе к нам (нижняя половина орбиты)
    var bodies = PLANETS.map(function (p) {
      var a = (p.L0 + p.rate * simDays) * DEG;
      var depth = -Math.sin(a);
      var s = 1 + 0.14 * depth; // ближние чуть крупнее
      return {
        p: p, depth: depth,
        x: cx + Math.cos(a) * p.dist * Rx,
        y: cy - Math.sin(a) * p.dist * Rx * TILT,
        r: p.r * s, s: s,
      };
    });
    bodies.push({ sun: true, depth: 0 });
    bodies.sort(function (a, b) { return a.depth - b.depth; });

    bodies.forEach(function (b) {
      if (b.sun) { drawSun(cx, cy, t); return; }
      var dx = cx - b.x, dy = cy - b.y, len = Math.hypot(dx, dy) || 1;
      var lx = dx / len, ly = dy / len;
      if (b.p.id === 'saturn') {
        drawSaturnRing(b.x, b.y, b.r, false);
        drawBasic(b.p, b.x, b.y, b.r, lx, ly);
        drawSaturnRing(b.x, b.y, b.r, true);
      } else if (b.p.id === 'earth') {
        var ma = (MOON.L0 + MOON.rate * simDays) * DEG;
        var mr = (3.2 + 1.8 * cur.crescent) * b.s;
        var md = MOON.dist * b.s * (1 + 0.2 * cur.crescent);
        var mx = b.x + Math.cos(ma) * md, my = b.y - Math.sin(ma) * md * TILT * 1.4;
        var mdx = cx - mx, mdy = cy - my, ml = Math.hypot(mdx, mdy) || 1;
        var moonFront = Math.sin(ma) < 0;
        if (!moonFront) drawMoon(mx, my, mr, mdx / ml, mdy / ml);
        drawEarth(b.x, b.y, b.r, lx, ly, t);
        if (moonFront) drawMoon(mx, my, mr, mdx / ml, mdy / ml);
      } else {
        drawBasic(b.p, b.x, b.y, b.r, lx, ly);
      }
    });
  }

  requestAnimationFrame(frame);

  window.SolarSystem = {
    setMode: function (name, instant) {
      if (!MODES[name]) return;
      target = MODES[name];
      if (instant) cur = clone(target);
    },
    setPlaying: function (on) { playing = !!on; },
  };
})();
