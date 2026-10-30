(function () {
  // Звук готовится крупными порциями (latencyHint: 'playback'): кнопки реагируют на доли секунды
  // медленнее — для аффирмаций это незаметно, зато звук не рвётся и не хрипит, когда телефон
  // в фоне урезает приложению ресурсы.
  try { Tone.setContext(new Tone.Context({ latencyHint: 'playback', lookAhead: 0.2 })); } catch (e) {}

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

  // «Щелчок» линейки таймера. На iPhone «щелчок выбора» отчётливый, а на Android Telegram
  // делает его еле заметным — там вместо него толчок средней силы (подобрали на Samsung).
  function tick() {
    if (inTelegram && tg.HapticFeedback) {
      if (/Android/i.test(navigator.userAgent)) tg.HapticFeedback.impactOccurred('medium');
      else tg.HapticFeedback.selectionChanged();
    } else if (navigator.vibrate) {
      navigator.vibrate(10);
    }
  }

  function haptic(kind) {
    try {
      if (kind === 'tick') { tick(); return; }
      if (!inTelegram || !tg.HapticFeedback) {
        // Вне Telegram (обычный браузер на Android) — короткий «щелчок» системной вибрацией
        if (kind === 'select' && navigator.vibrate) navigator.vibrate(4);
        return;
      }
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
  var startCheckId = null, resumeIntervalId = null;

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
    genderChips: document.getElementById('genderChips'),
    sleepValue: document.getElementById('sleepValue'),
    sleepOff: document.getElementById('sleepOff'),
    sleepRuler: document.getElementById('sleepRuler'),
    rulerScroll: document.getElementById('rulerScroll'),
    rulerTicks: document.getElementById('rulerTicks'),
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
        ensureCustom();
      });
    } catch (e) {}
  }

  // Плейлист текущего времени суток: сначала готовые фразы (с mp3), потом свои (озвучка Яндекса).
  // srcs — файлы озвучки по порядку предпочтения: сначала выбранный голос, потом другой.
  function playlist() {
    var t = state.time;
    var order = [voiceGender].concat(VOICES.filter(function (v) { return v !== voiceGender; }));
    return AFFIRMATIONS[t].phrases.map(function (p, i) {
      return { text: p, srcs: order.map(function (g) { return voicePath(g, t, i); }), custom: false };
    }).concat(custom[t].map(function (p, i) {
      return { text: p, srcs: [], custom: true, ci: i };
    }));
  }

  function addPhrase() {
    var v = els.input.value.trim();
    if (!v) return;
    custom[state.time].push(v);
    els.input.value = '';
    haptic('medium');
    persistCustom(); renderSet(); renderPlayback();
    ensureCustom(); // озвучка голосом диктора; в очередь фраза войдёт, когда будет готова
  }
  els.addBtn.addEventListener('click', addPhrase);
  els.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') addPhrase(); });

  els.clearBtn.addEventListener('click', function () {
    stopPlayback();
    custom[state.time] = [];
    persistCustom(); renderSet(); renderPlayback();
  });

  // --- Отрисовка ---
  function tagHtml(item) {
    var l = customLabel(item);
    return '<span class="' + l.cls + '">' + l.text + '</span>';
  }

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
        '<span class="text">' + escapeHtml(item.text) + (item.custom ? tagHtml(item) : '') + '</span>' +
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
    prefetchMusic();
    ensureCustom();
  }

  // Заранее качаем первый трек и фразы текущего времени суток — к нажатию «Слушать» всё уже готово
  var prefetchId = null;
  function prefetchMusic() {
    clearTimeout(prefetchId);
    prefetchId = setTimeout(function () {
      loadTrack(state.time, 0);
      playlist().forEach(function (item) { if (!item.custom) resolveVoice(item, voiceRate); });
    }, 1200);
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

  // --- Как устроен звук ---
  // Фразы и музыка ставятся в очередь звуковой системы заранее, с точным временем начала —
  // как ноты в партитуре. Дальше они звучат сами, даже когда экран заблокирован и телефон
  // «усыпил» приложение. Пока приложение не спит, очередь просто продлевается вперёд.
  var HORIZON_S = 60 * 60;   // на сколько вперёд расписываем звук — на час
  var TOPUP_MS = 15000;      // как часто продлеваем расписание, пока приложение не спит

  function audioCtx() { return Tone.getContext().rawContext; }

  // Озвучка лежит по голосам: audio/female/night/01.mp3, audio/male/night/01.mp3
  var VOICES = ['female', 'male'];
  var voiceGender = loadPref('affirmations-voice-gender', 'female');
  if (VOICES.indexOf(voiceGender) < 0) voiceGender = 'female';
  function voicePath(gender, time, i) { return 'audio/' + gender + '/' + time + '/' + pad(i + 1) + '.mp3'; }
  var missing = {}; // файлы, которых нет — чтобы не запрашивать их повторно

  // Поправка громкости набора озвучки (см. audio/levels.js): тихие записи чуть усиливаем,
  // громкие чуть приглушаем — чтобы все голоса звучали одинаково
  function levelOf(src) {
    var levels = window.VOICE_LEVELS || {};
    return levels[src.split('/').slice(1, 3).join('/')] || 0; // 'audio/female/night/01.mp3' → 'female/night'
  }

  // --- Темп речи ---
  // Замедление всей записи звучит как «слоумо», поэтому делаем иначе: находим паузы
  // между словами (где голос затихает) и удлиняем только их. Слова звучат с обычной скоростью.
  // При ускорении — наоборот, паузы укорачиваются.
  var decodedVoice = {}; // src → Promise с раскодированным звуком
  var pacedVoice = {};   // src|темп → Promise со звуком в нужном темпе

  function decodeVoice(src) {
    if (!decodedVoice[src]) {
      decodedVoice[src] = fetch(src).then(function (r) {
        if (!r.ok) throw new Error('нет файла');
        return r.arrayBuffer();
      }).then(function (data) { return audioCtx().decodeAudioData(data); });
    }
    return decodedVoice[src];
  }

  function voiceBuffer(src, rate) {
    if (rate === 1) return decodeVoice(src);
    var key = src + '|' + rate;
    if (!pacedVoice[key]) {
      pacedVoice[key] = decodeVoice(src).then(function (buf) { return stretchPauses(buf, rate); });
    }
    return pacedVoice[key];
  }

  // Звук для фразы: выбранный голос → другой голос → null (тогда читает голос устройства).
  // Своя фраза — озвучка Яндекса (см. ниже); 'skip' — ещё озвучивается, пока пропускаем.
  function resolveVoice(item, rate) {
    if (item.custom) return customVoice(item, rate);
    var srcs = item.srcs.filter(function (s) { return !missing[s]; }), k = 0;
    var attempt = function () {
      if (k >= srcs.length) return Promise.resolve(null);
      var src = srcs[k++];
      return voiceBuffer(src, rate).then(function (buf) {
        return { buffer: buf, gain: Math.pow(10, levelOf(src) / 20) };
      }, function () { missing[src] = true; return attempt(); });
    };
    return attempt();
  }

  // --- Свои фразы голосом диктора (Яндекс SpeechKit через нашу облачную функцию) ---
  // Фраза озвучивается один раз — когда её добавили (или когда выбрали другой голос). Звук приходит
  // от функции (server/index.js) и запоминается на устройстве (IndexedDB), дальше это обычный звук,
  // как у готовых фраз: входит в очередь и в дорожку Android, играет в фоне.
  // Пока фраза озвучивается — её пропускаем. Если озвучить не вышло (нет связи, лимит, приложение
  // открыто не в Telegram) — читает голос устройства, как раньше.
  var TTS_FUNCTION_URL = 'https://functions.yandexcloud.net/d4ejo8j5231iiui7asuk';
  var customState = {};    // ключ → { status: 'loading' | 'ready' | 'error', code, data, promise }
  var decodedCustom = {};  // ключ|темп → Promise со звуком
  var netChain = Promise.resolve(); // запросы к функции идут по одному

  var idb = (function () {
    var dbp = null;
    function open() {
      if (!dbp) {
        dbp = new Promise(function (resolve, reject) {
          try {
            var r = indexedDB.open('affirmacii', 1);
            r.onupgradeneeded = function () { r.result.createObjectStore('tts'); };
            r.onsuccess = function () { resolve(r.result); };
            r.onerror = function () { reject(r.error); };
          } catch (e) { reject(e); }
        });
      }
      return dbp;
    }
    return {
      get: function (key) {
        return open().then(function (db) {
          return new Promise(function (resolve) {
            var q = db.transaction('tts').objectStore('tts').get(key);
            q.onsuccess = function () { resolve(q.result || null); };
            q.onerror = function () { resolve(null); };
          });
        }).catch(function () { return null; });
      },
      put: function (key, value) {
        return open().then(function (db) { db.transaction('tts', 'readwrite').objectStore('tts').put(value, key); }).catch(function () {});
      },
    };
  })();

  function cleanPhrase(text) { return String(text).replace(/\s+/g, ' ').trim(); }
  function customKey(text, gender, time) { return gender + '|' + time + '|' + cleanPhrase(text); }

  function askFunction(text, gender, time) {
    var run = function () {
      if (!inTelegram || !tg.initData) return Promise.reject({ code: 'not_telegram' });
      // text/plain — «простой» запрос: браузер не делает лишний предварительный запрос
      return fetch(TTS_FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ initData: tg.initData, text: cleanPhrase(text), gender: gender, time: time }),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j.audio) throw { code: j.error || 'http_' + r.status, limit: j.limit };
          var bin = atob(j.audio), bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes.buffer;
        });
      }, function () { throw { code: 'network' }; });
    };
    var p = netChain.then(run);
    netChain = p.catch(function () {});
    return p;
  }

  // Озвучить (или достать из памяти устройства) одну свою фразу
  function fetchCustom(text, gender, time) {
    var key = customKey(text, gender, time), st = customState[key];
    if (st && (st.status === 'ready' || st.status === 'loading')) return st.promise;
    st = customState[key] = { status: 'loading' };
    st.promise = idb.get(key).then(function (data) {
      if (data) return data;
      return askFunction(text, gender, time).then(function (buf) { idb.put(key, buf); return buf; });
    }).then(function (data) {
      st.status = 'ready';
      st.data = data;
      customChanged();
      return data;
    }, function (err) {
      st.status = 'error';
      st.code = (err && err.code) || 'network';
      customFailed(st.code, err && err.limit);
      customChanged();
      throw err;
    });
    return st.promise;
  }

  // Озвучить все свои фразы текущего времени суток выбранным голосом (уже готовые — пропускаются)
  function ensureCustom() {
    var g = voiceGender, t = state.time, started = false;
    custom[t].forEach(function (text) {
      var st = customState[customKey(text, g, t)];
      if (st && (st.status === 'ready' || st.status === 'loading')) return;
      fetchCustom(text, g, t).catch(function () {});
      started = true;
    });
    if (started) { renderSet(); renderPlayback(); }
  }

  // Готовность изменилась: обновить метки и, если играет, включить фразу в очередь
  var customReplanId = null;
  function customChanged() {
    renderSet();
    renderPlayback();
    clearTimeout(customReplanId);
    customReplanId = setTimeout(function () { if (state.mode === 'playing') replanVoice(); }, 400);
  }

  var customToldCodes = {};
  function customFailed(code, limit) {
    if (customToldCodes[code]) return; // одно и то же сообщение не повторяем
    customToldCodes[code] = true;
    var msg = {
      not_telegram: 'Свои фразы озвучиваются голосом диктора, когда приложение открыто в Telegram. Пока их читает голос устройства.',
      limit_user: 'Сегодня уже озвучено ' + (limit || 40) + ' своих фраз — остальные озвучатся завтра.',
      limit_total: 'Озвучка своих фраз сейчас недоступна, попробуйте позже.',
      too_long: 'Фраза слишком длинная — сократите до 200 символов.',
    }[code] || 'Не получилось озвучить фразу — проверьте интернет. Попробуем снова при следующем запуске.';
    els.statusMsg.textContent = msg;
  }

  // Звук своей фразы для воспроизведения: готов — звук, озвучивается — 'skip', не вышло — null
  function customVoice(item, rate) {
    var g = voiceGender, t = state.time, key = customKey(item.text, g, t), st = customState[key];
    if (!st) { fetchCustom(item.text, g, t).catch(function () {}); return Promise.resolve('skip'); }
    if (st.status === 'loading') return Promise.resolve('skip');
    if (st.status !== 'ready') return Promise.resolve(null);
    var dk = key + '|' + rate;
    if (!decodedCustom[dk]) {
      decodedCustom[dk] = audioCtx().decodeAudioData(st.data.slice(0)).then(function (b) {
        return rate === 1 ? b : stretchPauses(b, rate);
      });
    }
    // Голос тот же, что у готовых фраз этого набора, — и поправка громкости та же
    var level = (window.VOICE_LEVELS || {})[g + '/' + t] || 0;
    return decodedCustom[dk].then(function (b) { return { buffer: b, gain: Math.pow(10, level / 20) }; },
      function () { delete decodedCustom[dk]; return null; });
  }

  function customLabel(item) {
    var st = customState[customKey(item.text, voiceGender, state.time)];
    if (st && st.status === 'loading') return { text: 'моя · озвучивается…', cls: 'tag pending' };
    if (st && st.status === 'error') return { text: 'моя · не озвучена', cls: 'tag warn' };
    return { text: 'моя', cls: 'tag' };
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

  // --- Каналы микшера ---
  // голос  → voiceBus (громкость голоса) ────────────────────────────────┐
  // музыка → musicBus (затухание по таймеру сна) → musicVol (громкость музыки) ┴→ master → выход
  // (на Android звук идёт иначе — обычными плеерами, см. «Android: готовые дорожки» ниже)
  var isAndroid = /Android/i.test(navigator.userAgent);
  var voiceBus = null, musicBus = null, musicVol = null, master = null;
  function musicGainFor(v) { return v === 0 ? 0 : Math.pow(v / 100, 2) * 2.5; }

  function ensureBuses() {
    if (voiceBus) return;
    var c = audioCtx();
    master = c.createGain();
    master.connect(c.destination);
    voiceBus = c.createGain();
    voiceBus.gain.value = voiceGain();
    voiceBus.connect(master);
    musicVol = c.createGain();
    musicVol.gain.value = musicGainFor(parseInt(els.musicVolume.value, 10));
    musicVol.connect(master);
    musicBus = c.createGain();
    musicBus.connect(musicVol);
  }

  // Плавно заглушить звук из очереди: ещё не начавшийся — просто отменить
  function silenceNode(n, now, fadeS) {
    try {
      if (n.start > now) { n.src.stop(); n.gain.disconnect(); return; }
      var p = n.gain.gain;
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now); else p.cancelScheduledValues(now);
      p.setTargetAtTime(0, now, fadeS / 4);
      n.src.stop(now + fadeS);
    } catch (e) {}
  }

  function playBuffer(buffer, at, offset, duration, gainValue, dest) {
    var c = audioCtx();
    var src = c.createBufferSource(), g = c.createGain();
    src.buffer = buffer;
    g.gain.value = gainValue;
    src.connect(g);
    g.connect(dest);
    src.onended = function () { try { g.disconnect(); } catch (e) {} };
    if (duration === undefined) src.start(at, offset); else src.start(at, offset, duration);
    return { src: src, gain: g };
  }

  // До какого момента расписываем звук: на час вперёд, но не дальше таймера сна
  function horizonEnd() {
    var end = audioCtx().currentTime + HORIZON_S;
    return sleepEndAt ? Math.min(end, sleepEndAt) : end;
  }

  // --- Очередь фраз ---
  // vq.nodes — расписанные фразы по порядку: { src, gain, i, start, end, offset }
  var vq = null;

  function newQueue(items, i, at, offset) {
    var q = { items: items, rate: voiceRate, ready: [], waits: [], next: i, at: at, offset: offset || 0,
              nodes: [], ttsIndex: null, ttsWait: false, ttsTimer: null, replan: false };
    // Качаем все фразы сразу, начиная с той, что прозвучит первой
    for (var n = 0; n < items.length; n++) loadVoiceItem(q, (i + n) % items.length);
    return q;
  }

  function loadVoiceItem(q, k) {
    if (!q.waits[k]) {
      var item = q.items[k];
      q.waits[k] = resolveVoice(item, q.rate)
        .then(function (v) { q.ready[k] = v; return v; });
    }
    return q.waits[k];
  }

  function gapS(rate) { return PAUSE_MS / 1000 / rate; } // при медленном темпе пауза между фразами длиннее

  // Расписываем фразы вперёд, пока не упрёмся в горизонт, недогруженную фразу или свою фразу
  // (её читает голос устройства — заранее в очередь её не поставить)
  function scheduleVoice() {
    var q = vq;
    if (!q || state.mode !== 'playing' || q.ttsWait) return;
    var now = audioCtx().currentTime, limit = horizonEnd();
    if (q.at < now + 0.05) q.at = now + 0.05; // очередь кончилась, пока приложение спало
    var skipped = 0;
    while (q.at < limit) {
      var k = q.next;
      if (q.ready[k] === undefined) {
        loadVoiceItem(q, k).then(function () { if (vq === q) scheduleVoice(); });
        break;
      }
      var v = q.ready[k];
      if (v === 'skip') { // своя фраза ещё озвучивается — пропускаем, войдёт в очередь, когда будет готова
        q.next = (k + 1) % q.items.length;
        if (++skipped >= q.items.length) break;
        continue;
      }
      skipped = 0;
      if (!v) { scheduleTts(q, k); break; }
      var offset = Math.min(q.offset, v.buffer.duration), dur = v.buffer.duration - offset;
      if (sleepEndAt && q.at + dur > sleepEndAt) break; // не успеет дозвучать до таймера сна
      var node = playBuffer(v.buffer, q.at, offset, undefined, v.gain, voiceBus);
      node.i = k; node.start = q.at; node.end = q.at + dur; node.offset = offset;
      q.nodes.push(node);
      q.offset = 0;
      q.at = node.end + gapS(q.rate);
      q.next = (k + 1) % q.items.length;
    }
    // Отзвучавшие фразы из списка убираем (последнюю начавшуюся оставляем — она «текущая»)
    while (q.nodes.length > 1 && q.nodes[1].start <= now) q.nodes.shift();
  }

  // Своя фраза: в нужный момент приложение само просит голос устройства прочитать её.
  // Если экран заблокирован, это может не сработать — такая фраза дождётся возвращения в приложение.
  function scheduleTts(q, k) {
    q.ttsWait = true;
    q.ttsTimer = setTimeout(function () {
      if (vq !== q || state.mode !== 'playing') return;
      q.ttsIndex = k;
      refreshNow();
      speakWithDevice(q.items[k].text, function () {
        if (vq !== q) return;
        if (q.replan) { startVoice(k + 1, 0, gapS(voiceRate)); return; }
        q.ttsIndex = null;
        q.ttsWait = false;
        q.at = audioCtx().currentTime + gapS(q.rate);
        q.next = (k + 1) % q.items.length;
        scheduleVoice();
      }, session);
    }, Math.max(0, (q.at - audioCtx().currentTime) * 1000));
  }

  function cancelVoice() {
    session++;
    if (voiceEl) voiceEl.pause();
    if (startCheckId) { clearTimeout(startCheckId); startCheckId = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (!vq) return;
    var now = audioCtx().currentTime;
    clearTimeout(vq.ttsTimer);
    vq.nodes.forEach(function (n) { silenceNode(n, now, 0.12); });
    vq = null;
  }

  // Начать с фразы i (offset — с какой секунды внутри фразы, delayS — через сколько секунд)
  function startVoice(i, offset, delayS) {
    if (mediaMode()) { startVoiceMedia(i, offset); return; }
    cancelVoice();
    ensureBuses();
    var items = playlist();
    if (!items.length) { stopPlayback(); return; }
    i = ((i % items.length) + items.length) % items.length;
    state.currentIndex = i;
    state.phase = 'voice';
    vq = newQueue(items, i, audioCtx().currentTime + 0.05 + (delayS || 0), offset);
    renderPlayback();
    scheduleVoice();
  }

  // Голос, темп или список фраз поменялись на ходу: текущая фраза дозвучит как есть,
  // а со следующей очередь строится заново
  function replanVoice() {
    if (mediaMode()) {
      // Склеиваем дорожку заново и продолжаем со следующей фразы
      if (state.mode === 'playing') { var c = voiceNowMedia(); startVoiceMedia(c ? c.i + 1 : (state.currentIndex || 0)); }
      return;
    }
    var q = vq;
    if (state.mode !== 'playing' || !q) return;
    if (q.ttsIndex !== null) { q.replan = true; return; } // голос устройства договорит, потом перестроим
    var cur = voiceNow();
    if (!cur || !cur.node) { startVoice(q.next); return; } // первая фраза ещё не началась
    var now = audioCtx().currentTime;
    var keep = cur.phase === 'voice' ? cur.node : null;
    clearTimeout(q.ttsTimer);
    q.nodes.forEach(function (n) { if (n !== keep) silenceNode(n, now, 0.12); });
    var items = playlist();
    var nq = newQueue(items, (cur.i + 1) % items.length, Math.max(cur.node.end + gapS(voiceRate), now + 0.05), 0);
    nq.nodes.push(cur.node);
    vq = nq;
    scheduleVoice();
  }

  // Какая фраза звучит прямо сейчас — по часам звуковой системы
  function voiceNow() {
    if (mediaMode()) return voiceNowMedia();
    var q = vq;
    if (!q) return null;
    if (q.ttsIndex !== null) return { i: q.ttsIndex, phase: 'voice', node: null };
    var now = audioCtx().currentTime, cur = null;
    for (var n = 0; n < q.nodes.length && q.nodes[n].start <= now; n++) cur = q.nodes[n];
    return cur ? { i: cur.i, phase: now < cur.end ? 'voice' : 'gap', node: cur } : null;
  }

  // Обновляем экран под то, что звучит (пока приложение открыто)
  function refreshNow() {
    if (state.mode !== 'playing') return;
    var cur = voiceNow();
    if (!cur) return;
    state.phase = cur.phase;
    if (cur.i !== state.currentIndex) { state.currentIndex = cur.i; renderPlayback(); }
  }

  // --- Android: готовые дорожки в обычных плеерах ---
  // Telegram на Android, когда приложение свёрнуто, глушит звук, который страница собирает сама
  // (Web Audio), а если пропустить его через аудиоплеер — в фоне он хрипит. Обычные аудиоплееры
  // с готовыми файлами Telegram не трогает. Поэтому на Android:
  //  — голос: все фразы с паузами заранее склеиваются в одну дорожку, она играет по кругу —
  //    в фоне не нужно ничего запускать;
  //  — музыка: mp3 в обычном плеере. В свёрнутом приложении текущий трек повторяется,
  //    при открытом треки сменяют друг друга.
  // Свои фразы (их читает голос устройства) в склеенную дорожку не попадают.
  function mediaMode() { return isAndroid; }
  var mv = null;                 // склеенный голос: { key, url, segs: [{ i, start, end }] }
  var voiceEl = null, musicEl = null;

  function ensureMediaEls() {
    if (voiceEl) return;
    voiceEl = new Audio();
    musicEl = new Audio();
    [voiceEl, musicEl].forEach(function (el) { el.loop = true; el.preload = 'auto'; });
    musicEl.addEventListener('timeupdate', onMusicTime);
  }

  function mediaKey(items) {
    return state.time + '|' + voiceGender + '|' + voiceRate + '|' + items.map(function (it) {
      if (!it.custom) return it.text;
      var st = customState[customKey(it.text, voiceGender, state.time)];
      return it.text + (st && st.status === 'ready' ? '+' : '-'); // готовность своих фраз — тоже часть дорожки
    }).join('§');
  }

  // Склеиваем фразы: фраза, пауза, фраза, пауза… Громкость наборов выравниваем сразу
  function buildVoiceTrack(items) {
    var key = mediaKey(items);
    if (mv && mv.key === key) return Promise.resolve(mv);
    var rate = voiceRate;
    return Promise.all(items.map(function (it) {
      return resolveVoice(it, rate).then(function (v) { return v && v.buffer ? v : null; });
    })).then(function (vs) {
      var sr = 0;
      vs.forEach(function (v) { if (v && !sr) sr = v.buffer.sampleRate; });
      if (!sr) return null;
      var gap = Math.round(gapS(rate) * sr), total = 0;
      vs.forEach(function (v) { if (v) total += v.buffer.length + gap; });
      var data = new Float32Array(total), pos = 0, segs = [];
      vs.forEach(function (v, i) {
        if (!v) return;
        var b = v.buffer, chs = b.numberOfChannels, g = v.gain / chs;
        for (var c = 0; c < chs; c++) {
          var src = b.getChannelData(c);
          for (var k = 0; k < src.length; k++) data[pos + k] += src[k] * g;
        }
        segs.push({ i: i, start: pos / sr, end: (pos + b.length) / sr });
        pos += b.length + gap;
      });
      var old = mv;
      mv = {
        key: key, segs: segs,
        url: URL.createObjectURL(encodeWav({
          numberOfChannels: 1, sampleRate: sr, length: total,
          getChannelData: function () { return data; },
        })),
      };
      if (old) setTimeout(function () { URL.revokeObjectURL(old.url); }, 5000);
      return mv;
    });
  }

  function startVoiceMedia(i, offset) {
    cancelVoice();
    ensureMediaEls();
    var items = playlist();
    if (!items.length) { stopPlayback(); return; }
    i = ((i % items.length) + items.length) % items.length;
    state.currentIndex = i;
    state.phase = 'voice';
    renderPlayback();
    var my = session;
    buildVoiceTrack(items).then(function (track) {
      if (my !== session || state.mode !== 'playing') return;
      if (!track || !track.segs.length) return; // озвученных фраз нет
      // Своя фраза в дорожку не входит — начинаем со следующей озвученной
      var seg = track.segs.filter(function (s) { return s.i >= i; })[0] || track.segs[0];
      var at = seg.start + (seg.i === i ? (offset || 0) : 0);
      if (voiceEl.src !== track.url) voiceEl.src = track.url;
      voiceEl.volume = Math.min(1, voiceGain());
      var go = function () {
        if (my !== session) return;
        try { voiceEl.currentTime = at; } catch (e) {}
        var p = voiceEl.play();
        if (p && p.catch) p.catch(playFailed);
      };
      if (voiceEl.readyState >= 1) go(); else voiceEl.addEventListener('loadedmetadata', go, { once: true });
    }, function () {});
  }

  // Какая фраза звучит — по положению в склеенной дорожке
  function voiceNowMedia() {
    if (!mv || !voiceEl || voiceEl.src !== mv.url) return null;
    var t = voiceEl.currentTime, cur = mv.segs[0];
    mv.segs.forEach(function (s) { if (s.start <= t) cur = s; });
    return { i: cur.i, phase: t < cur.end ? 'voice' : 'gap', node: null };
  }

  function musicKey(time, k) { return time + (k ? '-' + (k + 1) : ''); }
  function musicCount(time) {
    var levels = window.MUSIC_LEVELS || {}, n = 0;
    while (n < MAX_TRACKS && (musicKey(time, n) in levels)) n++;
    return n;
  }
  function applyMusicElVolume() {
    if (!musicEl) return;
    var lv = (window.MUSIC_LEVELS || {})[musicKey(musicTime, musicTrack)] || 0;
    var g = musicGainFor(parseInt(els.musicVolume.value, 10)) * Tone.dbToGain(MUSIC_VOLUME_DB + lv);
    musicEl.volume = Math.max(0, Math.min(1, g));
  }

  // Телефон не дал включить звук без нажатия — ставим на паузу и просим нажать «Продолжить»
  function playFailed(err) {
    if (!err || err.name !== 'NotAllowedError' || state.mode !== 'playing') return;
    pausePlayback();
    els.statusMsg.textContent = 'Телефон заблокировал звук. Нажмите «Продолжить».';
  }

  function playMusicEl() {
    var p = musicEl.play();
    if (p && p.catch) p.catch(playFailed);
  }

  function startMusicMedia() {
    ensureMediaEls();
    var time = state.time, n = musicCount(time);
    if (musicTime !== time) { musicTime = time; musicTrack = 0; musicEl.removeAttribute('src'); }
    if (!n) return; // треков нет
    if (musicTrack >= n) musicTrack = 0;
    var url = new URL(musicUrl(time, musicTrack), location.href).href;
    if (musicEl.src !== url) musicEl.src = url;
    applyMusicElVolume();
    playMusicEl();
  }

  // Пока приложение открыто — у конца трека переключаемся на следующий.
  // В свёрнутом приложении трек просто повторяется (плеер стоит «по кругу»).
  function onMusicTime() {
    if (!mediaMode() || state.mode !== 'playing' || document.hidden) return;
    var d = musicEl.duration, n = musicCount(musicTime);
    if (!d || n < 2 || musicEl.currentTime < d - 0.6) return;
    musicTrack = (musicTrack + 1) % n;
    musicEl.src = musicUrl(musicTime, musicTrack);
    applyMusicElVolume();
    playMusicEl();
  }

  // --- Фоновая музыка ---
  // Треки лежат в audio/music: night.mp3, night-2.mp3, night-3.mp3… — свои для каждого времени суток.
  // Играют по очереди и по кругу, с плавным перекрёстным переходом — без провалов и щелчков на стыке.
  // Если файлов нет — включается мягкий синтезатор из прототипа.
  var MAX_TRACKS = 5;        // сколько треков на одно время суток ищем максимум
  var CROSSFADE_S = 4;       // на сколько секунд следующий трек накладывается на конец предыдущего
  var FADE_IN_S = 2;         // плавное начало трека
  var TARGET_RMS_DB = -24;   // к этой средней громкости выравниваются все треки
  var trackCache = {};       // адрес файла → Promise с описанием трека (null — файла нет)
  var trackReady = {};       // адрес файла → описание трека, когда он уже загружен (null — файла нет)
  var musicTime = null, musicTrack = 0;
  var musicRun = 0;          // растёт при каждом старте/остановке музыки — старые загрузки игнорируются
  var mq = null;             // очередь треков: { run, time, nodes, at, k }
  var synth = null, reverb = null, loop = null;

  function musicUrl(time, k) { return 'audio/music/' + time + (k ? '-' + (k + 1) : '') + '.mp3'; }

  // Загружаем один трек. Каждый файл скачивается только один раз.
  function loadTrack(time, k) {
    var url = musicUrl(time, k);
    if (!(url in trackCache)) {
      trackCache[url] = new Tone.ToneAudioBuffer().load(url).then(function (buf) {
        var info = describeTrack(buf);
        return info.length > CROSSFADE_S * 3 ? info : null;
      }, function () { return null; }).then(function (info) {
        trackReady[url] = info;
        return info;
      });
    }
    return trackCache[url];
  }

  // Качаем треки по очереди: первый, второй… пока файлы есть
  function loadAllTracks(time, onEach) {
    var k = 0;
    var next = function () {
      loadTrack(time, k).then(function (info) {
        if (!info) return;
        onEach(k);
        if (++k < MAX_TRACKS) next();
      });
    };
    next();
  }

  // Какой трек звучит после k: следующий по номеру, если он уже загружен, иначе снова первый
  function nextLoadedTrack(time, k) {
    var info = k + 1 < MAX_TRACKS ? trackReady[musicUrl(time, k + 1)] : null;
    return info ? k + 1 : 0;
  }

  function startMusic() {
    if (state.mode !== 'playing' || mediaMode()) return;
    ensureBuses();
    var time = state.time, run = ++musicRun;
    if (musicTime !== time) { musicTime = time; musicTrack = 0; }
    var startK = musicTrack;
    var alive = function () { return run === musicRun && state.mode === 'playing' && state.time === time; };
    loadTrack(time, startK).then(function (info) {
      if (info || startK === 0) return info;
      startK = 0; // трек, на котором остановились, пропал — начинаем с первого
      return loadTrack(time, 0);
    }).then(function (first) {
      if (!alive()) return;
      if (!first) { startSynth(); return; }
      mq = { run: run, time: time, nodes: [], at: audioCtx().currentTime + 0.05, k: startK };
      scheduleMusic();
      // Остальные треки догружаются в фоне; как только очередной готов — включаем его в очередь
      loadAllTracks(time, function (k) { if (k > 0 && alive() && mq && mq.run === run) replanMusic(); });
    });
  }

  function scheduleMusic() {
    var q = mq;
    if (!q || state.mode !== 'playing') return;
    var now = audioCtx().currentTime, limit = horizonEnd();
    if (q.at < now + 0.05) q.at = now + 0.05;
    while (q.at < limit) {
      var info = trackReady[musicUrl(q.time, q.k)];
      if (!info) { q.k = 0; info = trackReady[musicUrl(q.time, 0)]; if (!info) return; }
      // Своё плавное затухание в конце трека совпадает с наложением следующего,
      // поэтому стык мягкий, даже если сам трек обрывается без затихания
      var vol = Tone.dbToGain(MUSIC_VOLUME_DB + info.gainDb), start = q.at, end = start + info.length;
      var node = playBuffer(info.buffer.get(), start, info.start, info.length, 0, musicBus);
      var p = node.gain.gain;
      p.setValueAtTime(0, start);
      p.linearRampToValueAtTime(vol, start + FADE_IN_S);
      p.setValueAtTime(vol, end - CROSSFADE_S);
      p.linearRampToValueAtTime(0, end);
      node.k = q.k; node.start = start; node.end = end;
      q.nodes.push(node);
      q.at = end - CROSSFADE_S;
      q.k = nextLoadedTrack(q.time, q.k);
    }
    while (q.nodes.length > 1 && q.nodes[0].end < now) q.nodes.shift();
  }

  // Догрузился новый трек — пересобираем ещё не начавшуюся часть очереди, чтобы он в неё вошёл
  function replanMusic() {
    var q = mq;
    if (!q) return;
    var now = audioCtx().currentTime;
    q.nodes = q.nodes.filter(function (n) {
      if (n.start > now + 0.5) { silenceNode(n, now, 0.1); return false; }
      return true;
    });
    var last = q.nodes[q.nodes.length - 1];
    if (last) { q.at = last.end - CROSSFADE_S; q.k = nextLoadedTrack(q.time, last.k); }
    scheduleMusic();
  }

  function startSynth() {
    if (!synth) {
      reverb = new Tone.Reverb({ decay: 9, wet: 0.55 });
      reverb.connect(musicBus);
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
    musicRun++; // недогруженные треки после остановки уже не запустятся
    if (musicEl) musicEl.pause();
    if (mq) {
      var now = audioCtx().currentTime;
      mq.nodes.forEach(function (n) {
        if (n.start <= now) musicTrack = n.k; // после паузы продолжим с этого трека
        silenceNode(n, now, 2);               // с плавным затуханием
      });
      mq = null;
    }
    if (loop) loop.stop(0);
    if (synth) synth.releaseAll();
    Tone.Transport.stop();
  }

  // Ползунок 0..100 → громкость. Квадратичная шкала: на слух изменение получается равномерным.
  function applyMusicVolume(v) {
    els.musicVolume.style.setProperty('--fill', v + '%');
    if (musicVol) musicVol.gain.setTargetAtTime(musicGainFor(v), audioCtx().currentTime, 0.05);
    applyMusicElVolume();
  }

  function voiceGain() { return Math.pow(parseInt(els.voiceVolume.value, 10) / 100, 2); }
  function applyVoiceVolume(v) {
    els.voiceVolume.style.setProperty('--fill', v + '%');
    if (voiceBus) voiceBus.gain.setTargetAtTime(Math.pow(v / 100, 2), audioCtx().currentTime, 0.05);
    if (voiceEl) voiceEl.volume = Math.min(1, Math.pow(v / 100, 2));
    // Голос устройства меняет громкость только со следующей фразы
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
  bindSlider(els.voiceVolume, 'affirmations-voice-volume', 80, applyVoiceVolume);

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
    replanVoice();
  });

  // Голос диктора: женский / мужской. Применяется со следующей фразы.
  function applyVoiceGender() {
    Array.prototype.forEach.call(els.genderChips.children, function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-voice') === voiceGender ? 'true' : 'false');
    });
  }
  applyVoiceGender();
  els.genderChips.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    voiceGender = b.getAttribute('data-voice');
    savePref('affirmations-voice-gender', voiceGender);
    haptic('select');
    applyVoiceGender();
    ensureCustom(); // свои фразы — озвучить и этим голосом
    renderSet(); renderPlayback();
    replanVoice();
  });

  // --- Плеер на экране блокировки (iPhone) ---
  // Системный плеер на экране блокировки появляется, только когда играет обычный аудиоэлемент.
  // Весь наш звук идёт через Web Audio, поэтому параллельно крутим «несущую» дорожку — тишину по кругу.
  // Заодно iPhone считает приложение плеером: звук не глохнет от переключателя «Без звука»
  // и не обрывается при блокировке экрана.
  // Кнопки системного плеера на Android не подключаем: система присылает через них «паузу».
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var carrier = null;
  function startCarrier() {
    if (!isIOS) return;
    try {
      if (!carrier) {
        // 30 секунд почти тишины: еле заметный шум на −80 дБ — его не слышно,
        // но система точно видит, что дорожка звучит
        var n = 8000 * 30, quiet = new Float32Array(n);
        for (var i = 0; i < n; i++) quiet[i] = (Math.random() * 2 - 1) * 0.0001;
        carrier = new Audio();
        carrier.loop = true;
        carrier.setAttribute('playsinline', '');
        carrier.src = URL.createObjectURL(encodeWav({
          numberOfChannels: 1, sampleRate: 8000, length: n,
          getChannelData: function () { return quiet; },
        }));
      }
      var p = carrier.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }
  function stopCarrier() { if (carrier) carrier.pause(); }

  // --- Управление воспроизведением ---
  var uiTimer = null, topupTimer = null;
  var resumeFrom = null; // где остановились внутри фразы: { i, offset, rate, gender }

  function topUp() { scheduleVoice(); scheduleMusic(); }
  function startTimers() {
    if (!uiTimer) uiTimer = setInterval(refreshNow, 250);
    if (!topupTimer) topupTimer = setInterval(topUp, TOPUP_MS);
  }
  function stopTimers() {
    clearInterval(uiTimer); clearInterval(topupTimer);
    uiTimer = topupTimer = null;
    if (resumeIntervalId) { clearInterval(resumeIntervalId); resumeIntervalId = null; }
  }

  function startAudioEngine() {
    // Tone.start() и запуск аудиоэлемента должны быть прямо из нажатия — иначе браузер не даст включить звук
    Tone.start().then(startMusic).catch(function () {});
    ensureBuses();
    startCarrier();
    if (mediaMode()) startMusicMedia();
    if (!resumeIntervalId) {
      // Chrome иногда «засыпает» посреди долгой озвучки голосом устройства — будим
      resumeIntervalId = setInterval(function () {
        if (window.speechSynthesis && window.speechSynthesis.speaking) window.speechSynthesis.resume();
      }, 6000);
    }
    startTimers();
  }

  function playFrom(i) {
    els.statusMsg.textContent = '';
    resumeFrom = null;
    var wasPlaying = state.mode === 'playing';
    state.mode = 'playing';
    if (!wasPlaying) { haptic('medium'); startAudioEngine(); startSleepCountdown(); }
    ensureCustom(); // повторить озвучку, если раньше не вышло
    startVoice(i);
  }

  function resumePlayback() {
    els.statusMsg.textContent = '';
    state.mode = 'playing';
    haptic('medium');
    startAudioEngine();
    startSleepCountdown();
    var i = state.currentIndex === null ? 0 : state.currentIndex;
    var r = resumeFrom;
    resumeFrom = null;
    // Android: дорожка та же — просто продолжаем с того же места
    if (mediaMode() && r && r.media && mv && r.key === mediaKey(playlist())) {
      session++;
      var p = voiceEl.play();
      if (p && p.catch) p.catch(playFailed);
      renderPlayback();
      return;
    }
    if (state.phase === 'gap') { startVoice(i + 1); return; }
    // Продолжаем фразу с того же места (чуть отступив назад), если голос и темп не меняли
    var same = r && r.i === i && r.rate === voiceRate && r.gender === voiceGender;
    startVoice(i, same ? Math.max(0, r.offset - 0.3) : 0);
  }

  function haltAudio() {
    cancelVoice();
    stopMusic();
    stopCarrier();
    stopTimers();
    pauseSleepCountdown();
  }

  function pausePlayback() {
    if (state.mode !== 'playing') return;
    var cur = voiceNow(), now = audioCtx().currentTime;
    resumeFrom = null;
    if (cur) {
      state.currentIndex = cur.i;
      state.phase = cur.phase;
      if (mediaMode() && mv) resumeFrom = { media: true, key: mv.key };
      else if (cur.phase === 'voice' && cur.node) {
        resumeFrom = { i: cur.i, offset: cur.node.offset + (now - cur.node.start), rate: voiceRate, gender: voiceGender };
      }
    }
    state.mode = 'paused';
    haltAudio();
    renderPlayback();
  }

  function stopPlayback() {
    if (state.mode === 'stopped' && state.currentIndex === null) return;
    state.mode = 'stopped';
    state.currentIndex = null;
    state.phase = 'voice';
    resumeFrom = null;
    haltAudio();
    renderPlayback();
  }

  // Шаг вперёд/назад. Если играет — сразу звучит новая фраза; если нет — просто переставляем «курсор».
  function step(delta) {
    var items = playlist();
    if (!items.length) return;
    var base = state.currentIndex === null ? (delta > 0 ? -1 : 0) : state.currentIndex;
    var i = ((base + delta) % items.length + items.length) % items.length;
    haptic('light');
    if (state.mode === 'playing') { startVoice(i); return; }
    resumeFrom = null;
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
  // Конец таймера заранее записан и в расписание звука: последняя фраза — та, что успевает
  // дозвучать, а музыка плавно затихает к нужной секунде. Так звук выключится вовремя,
  // даже если экран заблокирован и приложение «спит».
  var SLEEP_FADE_S = 15;
  var sleep = { minutes: 0, leftMs: 0, lastTick: 0, intervalId: null };
  var sleepEndAt = null; // момент окончания по часам звуковой системы

  function applySleepFade() {
    if (!musicBus) return;
    var p = musicBus.gain, now = audioCtx().currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(1, now);
    if (sleepEndAt) {
      p.setValueAtTime(1, Math.max(now, sleepEndAt - SLEEP_FADE_S));
      p.linearRampToValueAtTime(0, sleepEndAt);
    }
  }

  function minutesText(m) { return m ? m + ' мин' : 'Выкл'; }

  function renderSleep() {
    if (!ruler.busy()) {
      els.sleepValue.textContent = minutesText(sleep.minutes);
      if (ruler.value !== sleep.minutes) ruler.scrollTo(sleep.minutes, true); // например, таймер сработал
    }
    els.sleepOff.hidden = !sleep.minutes;
    els.sleepRuler.setAttribute('aria-valuenow', sleep.minutes);
    els.sleepRuler.setAttribute('aria-valuetext', sleep.minutes ? sleep.minutes + ' минут' : 'Выключен');
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
    ensureBuses();
    sleepEndAt = audioCtx().currentTime + sleep.leftMs / 1000;
    applySleepFade();
  }

  function pauseSleepCountdown() {
    sleepEndAt = null;
    applySleepFade();
    if (!sleep.intervalId) return;
    clearInterval(sleep.intervalId);
    sleep.intervalId = null;
    if (sleep.minutes) {
      sleep.leftMs -= Date.now() - sleep.lastTick;
      renderSleep();
    }
  }

  function setSleepMinutes(m) {
    if (m === sleep.minutes) return;
    pauseSleepCountdown();
    sleep.minutes = m;
    sleep.leftMs = m * 60000;
    if (state.mode === 'playing') {
      startSleepCountdown();
      if (!mediaMode()) replanVoice(); // убрать фразы, которые не успеют до таймера, или продлить очередь
      scheduleMusic();
    }
    renderSleep();
  }

  // --- Линейка таймера сна ---
  // Обычная горизонтальная прокрутка с «примагничиванием» к делениям: на телефоне она
  // сама даёт инерцию и плавную доводку. Деление — 5 минут, от «Выкл» до 2 часов.
  // На каждом делении — лёгкий «щелчок» вибрацией. Время применяется, когда линейка остановилась.
  var ruler = (function () {
    var STEP = 5, MAX = 120, PX = 22; // PX — ширина деления, как в style.css (.tick)
    var scroller = els.rulerScroll, ticks = [];
    var value = 0, touching = false, settleId = null, programmatic = false, lastBuzz = 0;

    for (var m = 0; m <= MAX; m += STEP) {
      var t = document.createElement('div');
      t.className = 'tick' + (m % 15 === 0 ? ' major' : '');
      t.setAttribute('data-min', m);
      if (m % 15 === 0) t.innerHTML = '<span>' + (m ? m : 'Выкл') + '</span>';
      els.rulerTicks.appendChild(t);
      ticks.push(t);
    }

    function valueAtScroll() {
      return Math.max(0, Math.min(MAX, Math.round(scroller.scrollLeft / PX) * STEP));
    }
    function mark(v) {
      ticks.forEach(function (t) { t.classList.toggle('on', parseInt(t.getAttribute('data-min'), 10) === v); });
    }
    function scrollTo(v, smooth) {
      programmatic = true;
      value = v;
      mark(v);
      scroller.scrollTo({ left: v / STEP * PX, behavior: smooth ? 'smooth' : 'auto' });
      clearTimeout(settleId);
      settleId = setTimeout(settle, smooth ? 600 : 50);
    }
    function settle() {
      settleId = null;
      if (touching) { settleId = setTimeout(settle, 150); return; }
      var wasProgrammatic = programmatic;
      programmatic = false;
      if (!wasProgrammatic) setSleepMinutes(value);
      else renderSleep();
    }

    scroller.addEventListener('scroll', function () {
      var v = valueAtScroll();
      if (v !== value) {
        value = v;
        mark(v);
        if (!programmatic) {
          els.sleepValue.textContent = minutesText(v);
          var now = Date.now();
          if (now - lastBuzz > 35) { lastBuzz = now; haptic('tick'); }
        }
      }
      if (!programmatic) {
        clearTimeout(settleId);
        settleId = setTimeout(settle, 160);
      }
    }, { passive: true });

    scroller.addEventListener('touchstart', function () { touching = true; programmatic = false; }, { passive: true });
    scroller.addEventListener('touchend', function () { touching = false; }, { passive: true });
    scroller.addEventListener('touchcancel', function () { touching = false; }, { passive: true });

    // Мышью (Telegram на компьютере): тянуть линейку, крутить колёсико, нажать на деление
    var drag = null;
    scroller.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      drag = { x: e.clientX, left: scroller.scrollLeft, moved: false };
      touching = true; programmatic = false;
      scroller.classList.add('dragging');
    });
    window.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
      scroller.scrollLeft = drag.left - (e.clientX - drag.x);
    });
    var suppressClick = false;
    window.addEventListener('pointerup', function () {
      if (!drag) return;
      var moved = drag.moved;
      drag = null;
      touching = false;
      scroller.classList.remove('dragging');
      if (!moved) return;
      suppressClick = true; // после перетаскивания браузер пришлёт «нажатие» — его пропускаем
      setTimeout(function () { suppressClick = false; }, 0);
      // Довести до ближайшего деления и применить
      var v = valueAtScroll();
      scroller.scrollTo({ left: v / STEP * PX, behavior: 'smooth' });
      clearTimeout(settleId);
      settleId = setTimeout(settle, 400);
    });
    scroller.addEventListener('wheel', function (e) {
      var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault();
      pick(Math.max(0, Math.min(MAX, value + (d > 0 ? STEP : -STEP))));
    }, { passive: false });
    scroller.addEventListener('click', function (e) {
      var t = e.target.closest('.tick');
      if (t && !suppressClick) pick(parseInt(t.getAttribute('data-min'), 10));
    });
    els.sleepRuler.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? STEP : e.key === 'ArrowLeft' ? -STEP : 0;
      if (!d) return;
      e.preventDefault();
      pick(Math.max(0, Math.min(MAX, value + d)));
    });

    // Выбрать значение нажатием: щелчок, линейка плавно едет, время применяется сразу
    function pick(v) {
      if (v === value && v === sleep.minutes) return;
      haptic('tick');
      scrollTo(v, true);
      setSleepMinutes(v);
      els.sleepValue.textContent = minutesText(v);
    }

    return {
      get value() { return value; },
      busy: function () { return touching || (settleId !== null && !programmatic); },
      scrollTo: scrollTo,
      pick: pick,
    };
  })();

  // Крестик — выключить таймер одним нажатием
  els.sleepOff.addEventListener('click', function () { ruler.pick(0); });

  // --- Работа в фоне и экран блокировки ---
  // Media Session — название фразы и кнопки «пауза / вперёд / назад» на экране блокировки.
  // Тоже только для iPhone — на Android в Telegram такого плеера нет, а системные команды мешают.
  var media = isIOS && 'mediaSession' in navigator ? navigator.mediaSession : null;
  // Когда приложение сворачивают, система может сама прислать «паузу». Это не нажатие пользователя:
  // такую команду в первые секунды после сворачивания пропускаем, звук играет дальше.
  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () { if (document.hidden) hiddenAt = Date.now(); });
  function userPause() {
    if (document.hidden && Date.now() - hiddenAt < 2000) return;
    pausePlayback();
  }
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
      media.setActionHandler('pause', userPause);
      media.setActionHandler('nexttrack', function () { step(1); });
      media.setActionHandler('previoustrack', function () { step(-1); });
    } catch (e) {}
  }

  // Когда пользователь возвращается в приложение — «будим» звук, если система его приостановила,
  // и подтягиваем экран к тому, что сейчас звучит
  function onReturn() {
    if (document.hidden || state.mode !== 'playing') return;
    try { if (Tone.context.state !== 'running') Tone.context.resume(); } catch (e) {}
    if (sleep.intervalId) tickSleep();
    if (state.mode !== 'playing') return;
    if (carrier && carrier.paused) startCarrier();
    if (mediaMode() && voiceEl && voiceEl.paused && voiceEl.src) voiceEl.play().catch(function () {});
    if (mediaMode() && musicEl && musicEl.paused && musicEl.src) playMusicEl();
    topUp();
    refreshNow();
    if (vq && vq.ttsIndex !== null && window.speechSynthesis && !window.speechSynthesis.speaking) {
      startVoice(vq.ttsIndex); // свою фразу прервали в фоне — повторяем
    }
  }
  document.addEventListener('visibilitychange', onReturn);
  if (inTelegram) { try { tg.onEvent('activated', onReturn); } catch (e) {} }

  // --- Первый запуск ---
  applyTheme(true);
  placeThumb(false);
  renderSet();
  renderPlayback();
  renderSleep();
  prefetchMusic();
  ensureCustom();
})();
