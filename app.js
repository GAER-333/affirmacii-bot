(function () {
  // --- Telegram Mini App ---
  // Если страница открыта внутри Telegram, tg.initData не пустой; в обычном браузере — пустой.
  var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  var inTelegram = !!(tg && tg.initData);

  if (inTelegram) {
    tg.ready();   // сообщаем Telegram, что приложение загрузилось (убирает лоадер)
    tg.expand();  // раскрываем мини-приложение на всю высоту
    // Чтобы свайп по переключателю не закрывал приложение
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
  var MUSIC_VOLUME_DB = -12;  // громкость фоновой музыки (0 — максимум, чем меньше, тем тише)

  function timeByClock() {
    var h = new Date().getHours();
    if (h >= 5 && h < 12) return 'morning';
    if (h >= 12 && h < 18) return 'day';
    return 'night';
  }

  var state = { time: timeByClock(), isPlaying: false, currentIndex: null };
  // Номер текущего «сеанса» воспроизведения. Растёт при каждой остановке —
  // так запоздалые события от прошлого сеанса просто игнорируются.
  var session = 0;
  var timeoutId = null, startCheckId = null, resumeIntervalId = null;

  var els = {
    seg: document.getElementById('seg'),
    thumb: document.getElementById('segThumb'),
    segBtns: Array.prototype.slice.call(document.querySelectorAll('.seg-btn')),
    title: document.getElementById('title'),
    subtitle: document.getElementById('subtitle'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    countLabel: document.getElementById('countLabel'),
    currentLabel: document.getElementById('currentLabel'),
    listCard: document.getElementById('listCard'),
    input: document.getElementById('phraseInput'),
    addBtn: document.getElementById('addBtn'),
    clearBtn: document.getElementById('clearBtn'),
    playBtn: document.getElementById('playBtn'),
    playIcon: document.getElementById('playIcon'),
    playLabel: document.getElementById('playLabel'),
    statusMsg: document.getElementById('statusMsg'),
  };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function escapeHtml(s) {
    var d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  }

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
        if (err || !value || state.isPlaying) return;
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
    if (state.isPlaying) stopPlaying();
    custom[state.time] = [];
    persistCustom(); renderSet(); renderPlayback();
  });

  // --- Отрисовка ---
  function renderSet() {
    var set = AFFIRMATIONS[state.time];
    var items = playlist();
    els.title.textContent = set.title;
    els.subtitle.textContent = set.subtitle;
    els.countLabel.textContent = items.length;
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
    var live = state.isPlaying && state.currentIndex !== null && items[state.currentIndex];
    els.currentLabel.textContent = live ? items[state.currentIndex].text : '—';
    els.currentLabel.classList.toggle('live', !!live);
    Array.prototype.forEach.call(els.listCard.children, function (row, i) {
      row.classList.toggle('live', !!live && i === state.currentIndex);
    });
    els.statusDot.classList.toggle('live', state.isPlaying);
    els.statusDot.classList.toggle('dot-live', state.isPlaying);
    els.statusText.textContent = state.isPlaying ? 'Звучит сейчас' : 'Готово к старту';
    els.playIcon.textContent = state.isPlaying ? '❚❚' : '▶';
    els.playLabel.textContent = state.isPlaying ? 'Остановить' : 'Слушать';
    if (window.SolarSystem) SolarSystem.setPlaying(state.isPlaying);
  }

  // Нажатие на фразу — играть с неё; на крестик — удалить свою фразу
  els.listCard.addEventListener('click', function (e) {
    var remove = e.target.closest('.remove-btn');
    if (remove) {
      if (state.isPlaying) stopPlaying();
      custom[state.time].splice(parseInt(remove.getAttribute('data-ci'), 10), 1);
      haptic('light');
      persistCustom(); renderSet(); renderPlayback();
      return;
    }
    var row = e.target.closest('.list-row');
    if (!row) return;
    if (state.isPlaying) stopPlaying();
    startPlaying(parseInt(row.getAttribute('data-idx'), 10));
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
    if (state.isPlaying) stopPlaying();
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
    if (!window.speechSynthesis) {
      stopPlaying();
      els.statusMsg.textContent = 'Голос устройства недоступен, а озвучка этой фразы ещё не загружена.';
      return;
    }
    var u = new SpeechSynthesisUtterance(text);
    var voice = pickVoice();
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'ru-RU'; }
    u.rate = 0.88; u.pitch = 1.05;
    var started = false;
    u.onstart = function () { started = true; };
    u.onend = function () { if (my === session) onDone(); };
    u.onerror = function (e) {
      if (my !== session || (e && (e.error === 'interrupted' || e.error === 'canceled'))) return;
      stopPlaying();
      els.statusMsg.textContent = 'Не удалось воспроизвести голос. Попробуйте ещё раз.';
    };
    if (startCheckId) clearTimeout(startCheckId);
    startCheckId = setTimeout(function () {
      if (!started && my === session) {
        stopPlaying();
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

  function playPhrase(i) {
    if (!state.isPlaying) return;
    var items = playlist();
    if (!items.length) { stopPlaying(); return; }
    i = i % items.length;
    var item = items[i];
    var my = session;
    state.currentIndex = i;
    renderPlayback();

    var next = function () {
      timeoutId = setTimeout(function () {
        if (my === session) playPhrase(i + 1);
      }, PAUSE_MS);
    };
    if (!item.src || missing[item.src]) { speakWithDevice(item.text, next, my); return; }

    var fellBack = false;
    var fallback = function () {
      if (fellBack || my !== session) return;
      fellBack = true;
      missing[item.src] = true;
      speakWithDevice(item.text, next, my);
    };
    voiceEl.onended = function () { if (my === session) next(); };
    voiceEl.onerror = fallback;
    voiceEl.src = item.src;
    var p = voiceEl.play();
    if (p && p.catch) p.catch(function (err) {
      if (my !== session) return;
      if (err && err.name === 'NotAllowedError') {
        stopPlaying();
        els.statusMsg.textContent = 'Браузер заблокировал звук. Нажмите «Слушать» ещё раз.';
      } else if (err && err.name !== 'AbortError') {
        fallback();
      }
    });
  }

  // --- Фоновая музыка ---
  // Если есть файл audio/music/<время>.mp3 — играет он, по кругу.
  // Если нет — включается мягкий синтезатор из прототипа.
  var musicPlayers = {};
  var synth = null, reverb = null, loop = null;

  function startMusic(my) {
    var time = state.time;
    var url = 'audio/music/' + time + '.mp3';
    if (missing[url]) { startSynth(); return; }
    var player = musicPlayers[time];
    if (player && player.loaded) { player.start(); return; }
    if (!player) {
      player = musicPlayers[time] = new Tone.Player({ loop: true, fadeIn: 2.5, fadeOut: 1.5, volume: MUSIC_VOLUME_DB }).toDestination();
    }
    player.load(url).then(function () {
      if (my === session && player.state !== 'started') player.start();
    }).catch(function () {
      missing[url] = true;
      player.dispose(); delete musicPlayers[time];
      if (my === session) startSynth();
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
    Object.keys(musicPlayers).forEach(function (k) {
      var p = musicPlayers[k];
      if (p.state === 'started') p.stop();
    });
    if (loop) loop.stop(0);
    Tone.Transport.stop();
  }

  // --- Старт / стоп ---
  function startPlaying(fromIndex) {
    els.statusMsg.textContent = '';
    state.isPlaying = true;
    var my = session;
    haptic('medium');
    renderPlayback();
    playPhrase(fromIndex || 0);

    // Chrome иногда «засыпает» посреди долгой озвучки — будим
    resumeIntervalId = setInterval(function () {
      if (window.speechSynthesis && window.speechSynthesis.speaking) window.speechSynthesis.resume();
    }, 6000);

    Tone.start().then(function () {
      if (my === session) startMusic(my);
    }).catch(function () {});
  }

  function stopPlaying() {
    session += 1;
    state.isPlaying = false; state.currentIndex = null;
    voiceEl.pause();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (timeoutId) clearTimeout(timeoutId);
    if (startCheckId) clearTimeout(startCheckId);
    if (resumeIntervalId) clearInterval(resumeIntervalId);
    stopMusic();
    renderPlayback();
  }

  els.playBtn.addEventListener('click', function () {
    if (state.isPlaying) stopPlaying(); else startPlaying(0);
  });

  // --- Первый запуск ---
  applyTheme(true);
  placeThumb(false);
  renderSet();
  renderPlayback();
})();
