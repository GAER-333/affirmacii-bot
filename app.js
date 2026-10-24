(function () {
  // --- Telegram Mini App ---
  // Если страница открыта внутри Telegram, tg.initData не пустой; в обычном браузере — пустой.
  var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  var inTelegram = !!(tg && tg.initData);

  if (inTelegram) {
    tg.ready();   // сообщаем Telegram, что приложение загрузилось (убирает лоадер)
    tg.expand();  // раскрываем мини-приложение на всю высоту
    // Чтобы свайп по переключателю или прокрутка вверх не сворачивали приложение
    try { if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes(); } catch (e) {}
  }

  function haptic(kind) {
    try {
      if (!inTelegram || !tg.HapticFeedback) return;
      if (kind === 'select') tg.HapticFeedback.selectionChanged();
      else tg.HapticFeedback.impactOccurred(kind || 'light');
    } catch (e) {}
  }

  // --- Настройки ---
  var TIMES = ['morning', 'day', 'night'];
  var THEME_BG = { morning: '#FBF3E9', day: '#EDF4F7', night: '#0D0F08' };
  // Шапка Telegram красится в цвет неба сверху — без шва с солнечной системой
  var SKY_TOP = { morning: '#281E52', day: '#0E346C', night: '#03050D' };
  var INPUT_HINT = { morning: 'Своя фраза для утра', day: 'Своя фраза для дня', night: 'Своя фраза для ночи' };
  var PAUSE_MS = 3200;        // пауза между фразами
  var MUSIC_VOLUME_DB = -12;  // насколько музыка тише голоса; ползунок меняет громкость относительно этой точки

  function timeByClock() {
    var h = new Date().getHours();
    if (h >= 5 && h < 12) return 'morning';
    if (h >= 12 && h < 18) return 'day';
    return 'night';
  }

  // mode: 'stopped' — не играет, 'playing' — играет, 'paused' — на паузе (помнит, где остановились)
  // phase: 'voice' — звучит фраза, 'gap' — тишина между фразами
  var state = { time: timeByClock(), mode: 'stopped', currentIndex: null, phase: 'voice' };
  // Номер «сеанса». Растёт при каждой смене фразы, паузе и остановке —
  // так запоздалые события от прошлой фразы просто игнорируются.
  var session = 0;
  var voiceSource = null; // чем озвучивается текущая фраза: 'mp3' или 'tts' (голос устройства)
  var timeoutId = null, startCheckId = null, resumeIntervalId = null;

  var els = {
    seg: document.getElementById('seg'),
    thumb: document.getElementById('segThumb'),
    segBtns: Array.prototype.slice.call(document.querySelectorAll('.seg-btn')),
    title: document.getElementById('title'),
    subtitle: document.getElementById('subtitle'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    progressLabel: document.getElementById('progressLabel'),
    progressFill: document.getElementById('progressFill'),
    currentLabel: document.getElementById('currentLabel'),
    musicVolume: document.getElementById('musicVolume'),
    voiceVolume: document.getElementById('voiceVolume'),
    speedChips: document.getElementById('speedChips'),
    sleepChips: document.getElementById('sleepChips'),
    sleepLeft: document.getElementById('sleepLeft'),
    listCard: document.getElementById('listCard'),
    input: document.getElementById('phraseInput'),
    addBtn: document.getElementById('addBtn'),
    clearBtn: document.getElementById('clearBtn'),
    prevBtn: document.getElementById('prevBtn'),
    playBtn: document.getElementById('playBtn'),
    nextBtn: document.getElementById('nextBtn'),
    playIcon: document.getElementById('playIcon'),
    playLabel: document.getElementById('playLabel'),
    statusMsg: document.getElementById('statusMsg'),
  };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function escapeHtml(s) {
    var d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  }
  function loadPref(key, fallback) {
    try { var v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; }
  }
  function savePref(key, value) { try { localStorage.setItem(key, String(value)); } catch (e) {} }

  // --- Свои фразы пользователя ---
  // Хранятся отдельно для каждого времени суток.
  // localStorage — память браузера на этом устройстве.
  // Telegram CloudStorage — облако Telegram: фразы видны на всех устройствах пользователя.
  var CUSTOM_KEY = 'affirmations-custom';
  var cloud = inTelegram && tg.CloudStorage && tg.isVersionAtLeast('6.9') ? tg.CloudStorage : null;
  var custom = { morning: [], day: [], night: [] };

  function parseCustom(json) {
    try {
      var o = JSON.parse(json);
      if (!o || typeof o !== 'object') return;
      TIMES.forEach(function (t) {
        if (Array.isArray(o[t])) custom[t] = o[t].filter(function (s) { return typeof s === 'string'; });
      });
    } catch (e) {}
  }
  try { var saved = localStorage.getItem(CUSTOM_KEY); if (saved) parseCustom(saved); } catch (e) {}

  function persistCustom() {
    var json = JSON.stringify(custom);
    try { localStorage.setItem(CUSTOM_KEY, json); } catch (e) {}
    // У CloudStorage лимит 4096 символов на значение
    if (cloud && json.length <= 4096) { try { cloud.setItem(CUSTOM_KEY, json); } catch (e) {} }
  }

  if (cloud) {
    try {
      cloud.getItem(CUSTOM_KEY, function (err, value) {
        if (err || !value || state.mode !== 'stopped') return;
        parseCustom(value);
        renderSet(); renderPlayback();
      });
    } catch (e) {}
  }

  // Плейлист текущего времени суток: сначала готовые фразы (с mp3), потом свои (голос устройства)
  function playlist() {
    var t = state.time;
    return AFFIRMATIONS[t].phrases.map(function (p, i) {
      return { text: p, src: voicePath(t, i), custom: false };
    }).concat(custom[t].map(function (p, i) {
      return { text: p, src: null, custom: true, ci: i };
    }));
  }

  function addPhrase() {
    var v = els.input.value.trim();
    if (!v) return;
    custom[state.time].push(v);
    els.input.value = '';
    haptic('medium');
    persistCustom(); renderSet(); renderPlayback();
  }
  els.addBtn.addEventListener('click', addPhrase);
  els.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') addPhrase(); });

  els.clearBtn.addEventListener('click', function () {
    stopPlayback();
    custom[state.time] = [];
    persistCustom(); renderSet(); renderPlayback();
  });

  // --- Отрисовка ---
  function renderSet() {
    var set = AFFIRMATIONS[state.time];
    var items = playlist();
    els.title.textContent = set.title;
    els.subtitle.textContent = set.subtitle;
    els.input.placeholder = INPUT_HINT[state.time];
    els.clearBtn.hidden = custom[state.time].length === 0;
    els.listCard.innerHTML = items.map(function (item, i) {
      return '<div class="list-row" role="button" tabindex="0" data-idx="' + i + '">' +
        '<span class="num">' + pad(i + 1) + '</span>' +
        '<span class="text">' + escapeHtml(item.text) + (item.custom ? '<span class="tag">моя</span>' : '') + '</span>' +
        (item.custom ? '<button class="remove-btn" data-ci="' + item.ci + '" aria-label="Удалить фразу">×</button>' : '') +
        '</div>';
    }).join('');
    els.segBtns.forEach(function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-time') === state.time ? 'true' : 'false');
    });
  }

  function renderPlayback() {
    var items = playlist();
    var hasCurrent = state.currentIndex !== null && !!items[state.currentIndex];
    var playing = state.mode === 'playing';

    els.statusText.textContent = playing ? 'Звучит сейчас' : state.mode === 'paused' ? 'Пауза' : 'Готово к старту';
    els.statusDot.classList.toggle('live', playing);
    els.statusDot.classList.toggle('dot-live', playing);

    // «Фраза 3 из 10»
    els.progressLabel.textContent = (hasCurrent ? state.currentIndex + 1 : '—') + ' из ' + items.length;
    els.progressFill.style.width = hasCurrent ? ((state.currentIndex + 1) / items.length * 100) + '%' : '0%';

    els.currentLabel.textContent = hasCurrent ? items[state.currentIndex].text : '—';
    els.currentLabel.classList.toggle('live', hasCurrent);
    Array.prototype.forEach.call(els.listCard.children, function (row, i) {
      row.classList.toggle('live', hasCurrent && i === state.currentIndex);
    });

    els.playIcon.textContent = playing ? '❚❚' : '▶';
    els.playLabel.textContent = playing ? 'Пауза' : state.mode === 'paused' ? 'Продолжить' : 'Слушать';
    els.playBtn.disabled = items.length === 0;
    els.prevBtn.disabled = els.nextBtn.disabled = items.length === 0;

    if (window.SolarSystem) SolarSystem.setPlaying(playing);
    updateMediaSession(hasCurrent ? items[state.currentIndex].text : null);
  }

  // Нажатие на фразу — играть с неё; на крестик — удалить свою фразу
  els.listCard.addEventListener('click', function (e) {
    var remove = e.target.closest('.remove-btn');
    if (remove) {
      stopPlayback();
      custom[state.time].splice(parseInt(remove.getAttribute('data-ci'), 10), 1);
      haptic('light');
      persistCustom(); renderSet(); renderPlayback();
      return;
    }
    var row = e.target.closest('.list-row');
    if (!row) return;
    playFrom(parseInt(row.getAttribute('data-idx'), 10));
  });
  els.listCard.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('list-row')) {
      e.preventDefault();
      e.target.click();
    }
  });

  // --- Время суток и тема ---
  function applyTheme(instant) {
    document.documentElement.setAttribute('data-time', state.time);
    if (window.SolarSystem) SolarSystem.setMode(state.time, instant);
    if (inTelegram) {
      try { tg.setHeaderColor(SKY_TOP[state.time]); tg.setBackgroundColor(THEME_BG[state.time]); } catch (e) {}
    }
  }

  function selectTime(time) {
    if (time === state.time) { placeThumb(); return; }
    stopPlayback();
    state.time = time;
    haptic('select');
    placeThumb(true);
    applyTheme(false);
    renderSet();
    renderPlayback();
  }

  // --- Ползунок переключателя ---
  function placeThumb(animate) {
    els.thumb.style.transform = 'translateX(' + (TIMES.indexOf(state.time) * 100) + '%)';
    if (animate) {
      els.thumb.classList.remove('stretch');
      void els.thumb.offsetWidth; // перезапуск анимации
      els.thumb.classList.add('stretch');
    }
  }

  els.segBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (suppressClick) return;
      selectTime(btn.getAttribute('data-time'));
    });
  });

  // Стрелки на клавиатуре
  els.seg.addEventListener('keydown', function (e) {
    var i = TIMES.indexOf(state.time);
    if (e.key === 'ArrowRight' && i < TIMES.length - 1) selectTime(TIMES[i + 1]);
    else if (e.key === 'ArrowLeft' && i > 0) selectTime(TIMES[i - 1]);
    else return;
    els.segBtns[TIMES.indexOf(state.time)].focus();
    e.preventDefault();
  });

  // Перетаскивание ползунка пальцем
  var drag = null, suppressClick = false;
  els.seg.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    drag = { startX: e.clientX, id: e.pointerId, active: false, x: 0, w: 0 };
  });
  els.seg.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.active) {
      if (Math.abs(e.clientX - drag.startX) < 6) return;
      drag.active = true;
      els.seg.setPointerCapture(drag.id);
      els.seg.classList.add('dragging');
    }
    var r = els.seg.getBoundingClientRect();
    var w = els.thumb.offsetWidth;
    var x = e.clientX - r.left - 6 - w / 2;
    x = Math.max(0, Math.min(x, w * (TIMES.length - 1)));
    els.thumb.style.transform = 'translateX(' + x + 'px)';
    drag.x = x; drag.w = w;
  });
  function endDrag() {
    if (!drag) return;
    if (drag.active) {
      els.seg.classList.remove('dragging');
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
      selectTime(TIMES[Math.round(drag.x / drag.w)]);
    }
    drag = null;
  }
  els.seg.addEventListener('pointerup', endDrag);
  els.seg.addEventListener('pointercancel', endDrag);

  // --- Голос устройства (для своих фраз и пока нет mp3) ---
  var voices = [];
  var femalePattern = /female|женск|milena|elena|katya|irina|tatyana|olga|anna|alyona/i;
  function loadVoices() {
    if (window.speechSynthesis) voices = window.speechSynthesis.getVoices();
  }
  function pickVoice() {
    var ru = voices.filter(function (v) { return v.lang && v.lang.toLowerCase().indexOf('ru') === 0; });
    return ru.filter(function (v) { return femalePattern.test(v.name); })[0] || ru[0] || null;
  }
  if (window.speechSynthesis) {
    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
  }

  function speakWithDevice(text, onDone, my) {
    voiceSource = 'tts';
    if (!window.speechSynthesis) {
      stopPlayback();
      els.statusMsg.textContent = 'Голос устройства недоступен, а озвучка этой фразы ещё не загружена.';
      return;
    }
    var u = new SpeechSynthesisUtterance(text);
    var voice = pickVoice();
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'ru-RU'; }
    u.rate = 0.88 * voiceRate; u.pitch = 1.05; u.volume = voiceGain();
    var started = false;
    u.onstart = function () { started = true; };
    u.onend = function () { if (my === session) onDone(); };
    u.onerror = function (e) {
      if (my !== session || (e && (e.error === 'interrupted' || e.error === 'canceled'))) return;
      stopPlayback();
      els.statusMsg.textContent = 'Не удалось воспроизвести голос. Попробуйте ещё раз.';
    };
    startCheckId = setTimeout(function () {
      // Если приложение свёрнуто, браузер мог отложить озвучку — это не ошибка
      if (!started && my === session && !document.hidden) {
        stopPlayback();
        els.statusMsg.textContent = 'Устройство не начало озвучку. Проверьте звук и попробуйте снова.';
      }
    }, 2000);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  // --- Голос из mp3 ---
  // Один и тот же <audio> используется для всех фраз: на iPhone он «разблокируется»
  // первым нажатием на «Слушать», и дальше фразы могут играть сами.
  var voiceEl = new Audio();
  voiceEl.preload = 'auto';
  var missing = {}; // файлы, которых нет — чтобы не запрашивать их повторно

  function voicePath(time, i) { return 'audio/' + time + '/' + pad(i + 1) + '.mp3'; }

  function clearVoiceTimers() {
    if (timeoutId) clearTimeout(timeoutId);
    if (startCheckId) clearTimeout(startCheckId);
    timeoutId = startCheckId = null;
  }

  // Что делать, когда фраза дозвучала: выдержать паузу и перейти к следующей.
  // При медленном темпе пауза между фразами тоже чуть длиннее.
  function afterPhrase(i, my) {
    return function () {
      if (my !== session) return;
      state.phase = 'gap';
      timeoutId = setTimeout(function () {
        if (my === session) playPhrase(i + 1);
      }, PAUSE_MS / voiceRate);
    };
  }

  // --- Темп речи ---
  // Замедление всей записи звучит как «слоумо», поэтому делаем иначе: находим паузы
  // между словами (где голос затихает) и удлиняем только их. Слова звучат с обычной скоростью.
  // При ускорении — наоборот, паузы укорачиваются.
  var decodedVoice = {}; // src → Promise с раскодированным звуком
  var pacedVoice = {};   // src|темп → Promise с адресом готового файла

  function decodeVoice(src) {
    if (!decodedVoice[src]) {
      decodedVoice[src] = fetch(src).then(function (r) {
        if (!r.ok) throw new Error('нет файла');
        return r.arrayBuffer();
      }).then(function (data) { return Tone.getContext().rawContext.decodeAudioData(data); });
    }
    return decodedVoice[src];
  }

  function pacedVoiceUrl(src, rate) {
    var key = src + '|' + rate;
    if (!pacedVoice[key]) {
      pacedVoice[key] = decodeVoice(src).then(function (buf) {
        return URL.createObjectURL(encodeWav(stretchPauses(buf, rate)));
      });
    }
    return pacedVoice[key];
  }

  function stretchPauses(buf, rate) {
    var sr = buf.sampleRate, n = buf.length, data = buf.getChannelData(0);
    // Громкость окнами по 10 мс
    var frame = Math.round(sr * 0.01), frames = Math.floor(n / frame);
    var level = new Float32Array(frames), peak = 0;
    for (var f = 0; f < frames; f++) {
      var s = 0;
      for (var k = f * frame; k < (f + 1) * frame; k++) s += data[k] * data[k];
      level[f] = Math.sqrt(s / frame);
      if (level[f] > peak) peak = level[f];
    }
    var quiet = peak * 0.06; // тише этого — уже не речь, а пауза
    var first = 0; while (first < frames && level[first] < quiet) first++;
    var last = frames - 1; while (last > first && level[last] < quiet) last--;

    // Паузы внутри фразы: от 70 мс тишины подряд. Короче — это обычно не пауза, а смычка
    // на «т», «п», «к»; если её растянуть, слово прозвучит с запинкой.
    // Тишину вставляем в самую тихую точку паузы.
    var gaps = [];
    for (var g = first; g <= last; g++) {
      if (level[g] >= quiet) continue;
      var from = g, quietest = g;
      while (g <= last && level[g] < quiet) { if (level[g] < level[quietest]) quietest = g; g++; }
      if (g - from >= 7) gaps.push({ at: quietest * frame + (frame >> 1), len: (g - from) * frame });
    }
    if (!gaps.length) return buf;

    // Сколько тишины добавить (минус — убрать), делим между паузами пропорционально их длине
    var gapTotal = 0; gaps.forEach(function (p) { gapTotal += p.len; });
    var change = (last - first) * frame * (1 / rate - 1);
    var total = n;
    gaps.forEach(function (p) {
      p.delta = Math.round(Math.max(-p.len * 0.5, Math.min(sr * 0.6, change * p.len / gapTotal)));
      total += p.delta;
    });

    var out = Tone.getContext().rawContext.createBuffer(buf.numberOfChannels, total, sr);
    for (var c = 0; c < buf.numberOfChannels; c++) {
      var src = buf.getChannelData(c), dst = out.getChannelData(c), r = 0, w = 0;
      gaps.forEach(function (p) {
        var cut = p.delta < 0 ? -p.delta : 0;
        var end = p.at - (cut >> 1);
        dst.set(src.subarray(r, end), w);
        w += end - r;
        r = end + cut;
        if (p.delta > 0) w += p.delta; // вставленная тишина — в новом буфере там уже нули
      });
      dst.set(src.subarray(r), w);
    }
    return out;
  }

  // Звук → файл WAV (16 бит), который можно отдать обычному плееру <audio>
  function encodeWav(buf) {
    var ch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
    var view = new DataView(new ArrayBuffer(44 + n * ch * 2));
    var text = function (o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + n * ch * 2, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, ch, true);
    view.setUint32(24, sr, true); view.setUint32(28, sr * ch * 2, true); view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, n * ch * 2, true);
    var chans = [];
    for (var c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    for (var i = 0, o = 44; i < n; i++) {
      for (c = 0; c < ch; c++, o += 2) {
        var v = Math.max(-1, Math.min(1, chans[c][i]));
        view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      }
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  // iPhone разрешает плееру звучать, только если первый play() был прямо из нажатия.
  // Обработка темпа занимает доли секунды, поэтому «разблокируем» плеер коротким кусочком тишины.
  var voiceUnlocked = false;
  function unlockVoice() {
    if (voiceUnlocked) return;
    voiceUnlocked = true;
    try {
      var silence = Tone.getContext().rawContext.createBuffer(1, 2205, 44100);
      voiceEl.src = URL.createObjectURL(encodeWav(silence));
      var p = voiceEl.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  function playPhrase(i) {
    if (state.mode !== 'playing') return;
    var items = playlist();
    if (!items.length) { stopPlayback(); return; }
    i = ((i % items.length) + items.length) % items.length;
    var my = ++session;
    clearVoiceTimers();
    voiceEl.pause();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    state.currentIndex = i;
    state.phase = 'voice';
    renderPlayback();

    var item = items[i];
    var done = afterPhrase(i, my);
    if (!item.src || missing[item.src]) { speakWithDevice(item.text, done, my); return; }

    voiceSource = 'mp3';
    var fellBack = false;
    var fallback = function () {
      if (fellBack || my !== session) return;
      fellBack = true;
      missing[item.src] = true;
      speakWithDevice(item.text, done, my);
    };
    var start = function (url) {
      if (my !== session) return;
      voiceEl.onended = done;
      voiceEl.onerror = fallback;
      voiceEl.src = url;
      var p = voiceEl.play();
      if (p && p.catch) p.catch(function (err) {
        if (my !== session) return;
        if (err && err.name === 'NotAllowedError') {
          pausePlayback();
          els.statusMsg.textContent = 'Браузер заблокировал звук. Нажмите «Продолжить».';
        } else if (err && err.name !== 'AbortError') {
          fallback();
        }
      });
    };
    var rate = voiceRate;
    if (rate === 1) { start(item.src); return; }
    // Если обработать не вышло — играем исходный файл (а если его нет, сработает голос устройства)
    pacedVoiceUrl(item.src, rate).then(start, function () { start(item.src); });
    // Заранее готовим следующую фразу, чтобы переход был без задержки
    var next = items[(i + 1) % items.length];
    if (next.src && !missing[next.src]) pacedVoiceUrl(next.src, rate).catch(function () {});
  }

  // --- Фоновая музыка ---
  // Треки лежат в audio/music: night.mp3, night-2.mp3, night-3.mp3… — свои для каждого времени суток.
  // Играют по очереди и по кругу, с плавным перекрёстным переходом — без провалов и щелчков на стыке.
  // Если файлов нет — включается мягкий синтезатор из прототипа.
  // Голос идёт мимо Tone.js, поэтому громкость Tone.Destination меняет только музыку.
  var MAX_TRACKS = 5;        // сколько треков на одно время суток ищем максимум
  var CROSSFADE_S = 4;       // на сколько секунд следующий трек накладывается на конец предыдущего
  var TARGET_RMS_DB = -24;   // к этой средней громкости выравниваются все треки
  var musicLibrary = {};     // время суток → Promise со списком загруженных треков
  var deck = null;           // два плеера по очереди — чтобы треки могли перекрываться
  var musicTime = null, musicTrack = 0;
  var synth = null, reverb = null, loop = null;

  function musicUrl(time, k) { return 'audio/music/' + time + (k ? '-' + (k + 1) : '') + '.mp3'; }

  // Загружаем треки по порядку, пока не встретится отсутствующий файл
  function loadTracks(time) {
    if (musicLibrary[time]) return musicLibrary[time];
    var tracks = [];
    function load(k) {
      if (k >= MAX_TRACKS) return Promise.resolve(tracks);
      return new Tone.ToneAudioBuffer().load(musicUrl(time, k)).then(function (buf) {
        var info = describeTrack(buf);
        if (info.length > CROSSFADE_S * 3) tracks.push(info);
        return load(k + 1);
      }, function () { return tracks; });
    }
    musicLibrary[time] = load(0);
    return musicLibrary[time];
  }

  // Где в треке начинается и заканчивается звук (обрезаем тишину) и насколько он громкий
  function describeTrack(buf) {
    var raw = buf.get(), data = raw.getChannelData(0), sr = raw.sampleRate, n = data.length;
    var lead = 0; while (lead < n && Math.abs(data[lead]) < 0.003) lead++;
    var tail = n - 1; while (tail > lead && Math.abs(data[tail]) < 0.003) tail--;
    var sum = 0, count = 0;
    for (var i = lead; i < tail; i += 16) { sum += data[i] * data[i]; count++; }
    var rmsDb = 10 * Math.log10(sum / Math.max(1, count) || 1e-12);
    return {
      buffer: buf, start: lead / sr, length: (tail - lead) / sr,
      gainDb: Math.max(-8, Math.min(8, TARGET_RMS_DB - rmsDb)),
    };
  }

  function startMusic() {
    if (state.mode !== 'playing') return;
    var time = state.time;
    if (musicTime !== time) { musicTime = time; musicTrack = 0; }
    loadTracks(time).then(function (tracks) {
      if (state.mode !== 'playing' || state.time !== time) return;
      if (!tracks.length) { startSynth(); return; }
      if (!deck) deck = [0, 1].map(function () { return new Tone.Player({ fadeIn: 2, fadeOut: 2 }).toDestination(); });
      Tone.Transport.cancel();
      Tone.Transport.stop();
      // Ставим трек k в очередь; когда он начнётся — сразу планируем следующий
      var queue = function (k, when) {
        Tone.Transport.scheduleOnce(function (t) {
          if (state.mode !== 'playing') return;
          var tr = tracks[k % tracks.length];
          var player = deck[k % 2];
          player.buffer = tr.buffer;
          player.volume.value = MUSIC_VOLUME_DB + tr.gainDb;
          player.start(t, tr.start, tr.length);
          musicTrack = k % tracks.length;
          queue(k + 1, when + tr.length - CROSSFADE_S);
        }, when);
      };
      queue(musicTrack, 0);
      Tone.Transport.start();
    });
  }

  function startSynth() {
    if (!synth) {
      reverb = new Tone.Reverb({ decay: 9, wet: 0.55 }).toDestination();
      synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'sine' },
        envelope: { attack: 2.5, decay: 1, sustain: 0.8, release: 5 },
        volume: -20,
      }).connect(reverb);
      var chords = [['A3','C4','E4'],['F3','A3','C4'],['C4','E4','G4'],['G3','C4','E4']];
      var step = 0;
      loop = new Tone.Loop(function (t) {
        synth.triggerAttackRelease(chords[step % chords.length], '6n', t);
        step += 1;
      }, '6s');
    }
    if (loop.state === 'started') return;
    Tone.Transport.bpm.value = 60;
    loop.start(0);
    Tone.Transport.start();
  }

  function stopMusic() {
    if (deck) deck.forEach(function (p) { if (p.state === 'started') p.stop(); }); // с плавным затуханием
    Tone.Transport.cancel();
    if (loop) loop.stop(0);
    if (synth) synth.releaseAll();
    Tone.Transport.stop();
  }

  // Ползунок 0..100 → громкость. Квадратичная шкала: на слух изменение получается равномерным.
  function applyMusicVolume(v) {
    els.musicVolume.style.setProperty('--fill', v + '%');
    try {
      Tone.Destination.mute = v === 0;
      if (v > 0) Tone.Destination.volume.rampTo(Tone.gainToDb(Math.pow(v / 100, 2) * 2.5), 0.15);
    } catch (e) {}
  }

  // Громкость голоса. На iPhone у <audio> громкость менять нельзя, поэтому голос из mp3
  // пропускаем через свой регулятор Web Audio — мимо регулятора музыки.
  var voiceGainNode = null;
  function voiceGain() { return Math.pow(parseInt(els.voiceVolume.value, 10) / 100, 2); }
  function connectVoice() {
    if (voiceGainNode) return;
    try {
      var raw = Tone.getContext().rawContext;
      voiceGainNode = raw.createGain();
      voiceGainNode.gain.value = voiceGain();
      raw.createMediaElementSource(voiceEl).connect(voiceGainNode);
      voiceGainNode.connect(raw.destination);
      voiceEl.volume = 1; // теперь громкостью управляет регулятор — иначе она применится дважды
    } catch (e) { voiceGainNode = null; }
  }
  function applyVoiceVolume(v) {
    els.voiceVolume.style.setProperty('--fill', v + '%');
    var g = Math.pow(v / 100, 2);
    if (voiceGainNode) voiceGainNode.gain.setTargetAtTime(g, voiceGainNode.context.currentTime, 0.05);
    else voiceEl.volume = g; // запасной путь (работает везде, кроме iPhone)
    // Голос устройства меняет громкость только со следующей фразы
  }

  // Подключаем ползунок: восстанавливаем сохранённое значение и запоминаем новое
  function bindSlider(input, key, fallback, apply) {
    var saved = parseInt(loadPref(key, String(fallback)), 10);
    input.value = isNaN(saved) ? fallback : saved;
    apply(parseInt(input.value, 10));
    input.addEventListener('input', function () {
      var v = parseInt(input.value, 10);
      apply(v);
      savePref(key, v);
    });
  }
  bindSlider(els.musicVolume, 'affirmations-music-volume', 50, applyMusicVolume);
  bindSlider(els.voiceVolume, 'affirmations-voice-volume', 100, applyVoiceVolume);

  // Темп речи: 0.8× … 1.1×. Для mp3 меняются паузы между словами (см. «Темп речи» выше),
  // голос устройства просто говорит медленнее или быстрее. Применяется со следующей фразы.
  var voiceRate = parseFloat(loadPref('affirmations-voice-rate', '1')) || 1;
  function applyVoiceRate() {
    Array.prototype.forEach.call(els.speedChips.children, function (b) {
      b.setAttribute('aria-pressed', parseFloat(b.getAttribute('data-rate')) === voiceRate ? 'true' : 'false');
    });
  }
  applyVoiceRate();
  els.speedChips.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    voiceRate = parseFloat(b.getAttribute('data-rate'));
    savePref('affirmations-voice-rate', voiceRate);
    haptic('select');
    applyVoiceRate();
  });

  // --- Управление воспроизведением ---
  function startAudioEngine() {
    // Tone.start() должен вызываться прямо из нажатия — иначе браузер не даст включить звук
    Tone.start().then(startMusic).catch(function () {});
    connectVoice();
    unlockVoice();
    if (!resumeIntervalId) {
      // Chrome иногда «засыпает» посреди долгой озвучки — будим
      resumeIntervalId = setInterval(function () {
        if (window.speechSynthesis && window.speechSynthesis.speaking) window.speechSynthesis.resume();
      }, 6000);
    }
  }

  function playFrom(i) {
    els.statusMsg.textContent = '';
    var wasPlaying = state.mode === 'playing';
    state.mode = 'playing';
    if (!wasPlaying) { haptic('medium'); startAudioEngine(); startSleepCountdown(); }
    playPhrase(i);
  }

  function resumePlayback() {
    els.statusMsg.textContent = '';
    state.mode = 'playing';
    haptic('medium');
    startAudioEngine();
    startSleepCountdown();
    var i = state.currentIndex === null ? 0 : state.currentIndex;
    // mp3 продолжаем с того же места; голос устройства так не умеет — повторяем фразу целиком
    if (state.phase === 'voice' && voiceSource === 'mp3' && voiceEl.currentTime > 0 && !voiceEl.ended) {
      var my = ++session;
      voiceEl.onended = afterPhrase(i, my);
      voiceEl.onerror = null;
      renderPlayback();
      voiceEl.play().catch(function () { if (my === session) playPhrase(i); });
    } else {
      playPhrase(state.phase === 'gap' ? i + 1 : i);
    }
  }

  function pausePlayback() {
    if (state.mode !== 'playing') return;
    session++;
    state.mode = 'paused';
    clearVoiceTimers();
    voiceEl.pause();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    stopMusic();
    pauseSleepCountdown();
    renderPlayback();
  }

  function stopPlayback() {
    if (state.mode === 'stopped' && state.currentIndex === null) return;
    session++;
    state.mode = 'stopped';
    state.currentIndex = null;
    state.phase = 'voice';
    voiceSource = null;
    clearVoiceTimers();
    voiceEl.pause();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (resumeIntervalId) { clearInterval(resumeIntervalId); resumeIntervalId = null; }
    stopMusic();
    pauseSleepCountdown();
    renderPlayback();
  }

  // Шаг вперёд/назад. Если играет — сразу звучит новая фраза; если нет — просто переставляем «курсор».
  function step(delta) {
    var items = playlist();
    if (!items.length) return;
    var base = state.currentIndex === null ? (delta > 0 ? -1 : 0) : state.currentIndex;
    var i = ((base + delta) % items.length + items.length) % items.length;
    haptic('light');
    if (state.mode === 'playing') { playPhrase(i); return; }
    session++;
    voiceEl.pause();
    voiceSource = null;
    state.currentIndex = i;
    state.phase = 'voice';
    state.mode = 'paused';
    renderPlayback();
  }

  function togglePlay() {
    if (state.mode === 'playing') pausePlayback();
    else if (state.mode === 'paused') resumePlayback();
    else playFrom(0);
  }

  els.playBtn.addEventListener('click', togglePlay);
  els.prevBtn.addEventListener('click', function () { step(-1); });
  els.nextBtn.addEventListener('click', function () { step(1); });

  // --- Таймер сна ---
  // Отсчёт идёт только пока звучит: на паузе время не тратится.
  var sleep = { minutes: 0, leftMs: 0, lastTick: 0, intervalId: null };

  function renderSleep() {
    Array.prototype.forEach.call(els.sleepChips.children, function (b) {
      b.setAttribute('aria-pressed', parseInt(b.getAttribute('data-min'), 10) === sleep.minutes ? 'true' : 'false');
    });
    if (!sleep.minutes) { els.sleepLeft.textContent = ''; return; }
    var s = Math.ceil(sleep.leftMs / 1000);
    els.sleepLeft.textContent = 'остановится через ' + Math.floor(s / 60) + ':' + pad(s % 60);
  }

  function tickSleep() {
    var now = Date.now();
    sleep.leftMs -= now - sleep.lastTick;
    sleep.lastTick = now;
    if (sleep.leftMs <= 0) {
      sleep.minutes = 0;
      stopPlayback();
      els.statusMsg.textContent = state.time === 'night' ? 'Таймер сна сработал. Спокойной ночи.' : 'Таймер сработал, воспроизведение остановлено.';
    }
    renderSleep();
  }

  function startSleepCountdown() {
    if (!sleep.minutes || sleep.intervalId) return;
    sleep.lastTick = Date.now();
    sleep.intervalId = setInterval(tickSleep, 1000);
  }

  function pauseSleepCountdown() {
    if (!sleep.intervalId) return;
    clearInterval(sleep.intervalId);
    sleep.intervalId = null;
    if (sleep.minutes) {
      sleep.leftMs -= Date.now() - sleep.lastTick;
      renderSleep();
    }
  }

  els.sleepChips.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    pauseSleepCountdown();
    sleep.minutes = parseInt(b.getAttribute('data-min'), 10);
    sleep.leftMs = sleep.minutes * 60000;
    haptic('select');
    if (state.mode === 'playing') startSleepCountdown();
    renderSleep();
  });

  // --- Работа в фоне и экран блокировки ---
  // Media Session — кнопки «пауза / вперёд / назад» на экране блокировки и в шторке уведомлений.
  var media = 'mediaSession' in navigator ? navigator.mediaSession : null;
  function updateMediaSession(text) {
    if (!media) return;
    try {
      media.playbackState = state.mode === 'playing' ? 'playing' : state.mode === 'paused' ? 'paused' : 'none';
      if (text && window.MediaMetadata) {
        media.metadata = new MediaMetadata({ title: text, artist: 'Аффирмации · ' + AFFIRMATIONS[state.time].label });
      }
    } catch (e) {}
  }
  if (media) {
    try {
      media.setActionHandler('play', function () { if (state.mode !== 'playing') togglePlay(); });
      media.setActionHandler('pause', pausePlayback);
      media.setActionHandler('nexttrack', function () { step(1); });
      media.setActionHandler('previoustrack', function () { step(-1); });
    } catch (e) {}
  }

  // Когда пользователь возвращается в приложение — «будим» звук, если система его приостановила
  function onReturn() {
    if (document.hidden || state.mode !== 'playing') return;
    try { if (Tone.context.state !== 'running') Tone.context.resume(); } catch (e) {}
    if (state.phase === 'voice' && voiceSource === 'tts' && window.speechSynthesis && !window.speechSynthesis.speaking) {
      playPhrase(state.currentIndex); // озвучку прервали в фоне — повторяем фразу
    }
    if (sleep.intervalId) tickSleep();
  }
  document.addEventListener('visibilitychange', onReturn);
  if (inTelegram) { try { tg.onEvent('activated', onReturn); } catch (e) {} }

  // --- Первый запуск ---
  applyTheme(true);
  placeThumb(false);
  renderSet();
  renderPlayback();
  renderSleep();
})();
