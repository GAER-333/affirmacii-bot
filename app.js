(function () {
  // --- Telegram Mini App ---
  // Если страница открыта внутри Telegram, здесь будет объект WebApp; в обычном браузере — undefined.
  var tg = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData !== undefined
    ? window.Telegram.WebApp : null;
  var inTelegram = !!(tg && tg.initData);

  if (inTelegram) {
    tg.ready();   // сообщаем Telegram, что приложение загрузилось (убирает лоадер)
    tg.expand();  // раскрываем мини-приложение на всю высоту
    try {
      tg.setHeaderColor('#0D0F08');
      tg.setBackgroundColor('#0D0F08');
    } catch (e) {}
  }

  function haptic(type) {
    try { if (inTelegram && tg.HapticFeedback) tg.HapticFeedback.impactOccurred(type || 'light'); } catch (e) {}
  }

  // --- Хранилище фраз ---
  // localStorage — память браузера на этом устройстве.
  // Telegram CloudStorage — облако Telegram, привязано к пользователю: фразы видны на всех его устройствах.
  var STORAGE_KEY = 'affirmations-list';
  var cloud = inTelegram && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9') ? tg.CloudStorage : null;

  var phrases = [];
  try { var saved = localStorage.getItem(STORAGE_KEY); if (saved) phrases = JSON.parse(saved) || []; } catch (e) {}

  function persist() {
    var json = JSON.stringify(phrases);
    try { localStorage.setItem(STORAGE_KEY, json); } catch (e) {}
    // У CloudStorage лимит 4096 символов на значение
    if (cloud && json.length <= 4096) { try { cloud.setItem(STORAGE_KEY, json); } catch (e) {} }
  }

  if (cloud) {
    try {
      cloud.getItem(STORAGE_KEY, function (err, value) {
        if (err || !value) return;
        try {
          var list = JSON.parse(value);
          if (Array.isArray(list)) { phrases = list; render(); }
        } catch (e) {}
      });
    } catch (e) {}
  }

  var isPlaying = false, currentIndex = null;
  var voices = [], selectedVoiceURI = '';
  var timeoutId = null, startCheckId = null, resumeIntervalId = null;
  var synth = null, reverb = null, loop = null;

  var els = {
    input: document.getElementById('phraseInput'),
    addBtn: document.getElementById('addBtn'),
    emptyHint: document.getElementById('emptyHint'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    countLabel: document.getElementById('countLabel'),
    currentLabel: document.getElementById('currentLabel'),
    listCard: document.getElementById('listCard'),
    playBtn: document.getElementById('playBtn'),
    playIcon: document.getElementById('playIcon'),
    playLabel: document.getElementById('playLabel'),
    voiceSelect: document.getElementById('voiceSelect'),
    clearBtn: document.getElementById('clearBtn'),
    statusMsg: document.getElementById('statusMsg'),
  };

  function render() {
    els.countLabel.textContent = phrases.length;
    els.currentLabel.textContent = (isPlaying && currentIndex !== null) ? phrases[currentIndex] : '—';
    els.currentLabel.style.color = isPlaying ? 'var(--accent)' : 'var(--text)';
    els.emptyHint.style.display = phrases.length === 0 ? 'block' : 'none';
    els.playBtn.disabled = phrases.length === 0;
    els.playBtn.classList.toggle('active-ready', phrases.length > 0);
    els.clearBtn.style.display = phrases.length > 0 ? 'flex' : 'none';

    if (phrases.length === 0) { els.listCard.style.display = 'none'; els.listCard.innerHTML = ''; }
    else {
      els.listCard.style.display = 'block';
      els.listCard.innerHTML = phrases.map(function (p, i) {
        var live = isPlaying && currentIndex === i;
        return '<div class="list-row"><span class="text' + (live ? ' live' : '') + '">' + escapeHtml(p) +
          '</span><button class="remove-btn" data-idx="' + i + '" aria-label="Удалить">×</button></div>';
      }).join('');
      Array.prototype.forEach.call(els.listCard.querySelectorAll('.remove-btn'), function (btn) {
        btn.addEventListener('click', function () {
          if (isPlaying) stopPlaying();
          phrases.splice(parseInt(btn.getAttribute('data-idx'), 10), 1);
          haptic('light');
          persist(); render();
        });
      });
    }

    els.statusDot.classList.toggle('live', isPlaying);
    els.statusDot.classList.toggle('dot-live', isPlaying);
    els.statusText.textContent = isPlaying ? 'Звучит сейчас' : 'Готово к старту';
  }

  function escapeHtml(s) {
    var d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  }

  function addPhrase() {
    var v = els.input.value.trim();
    if (!v) return;
    phrases.push(v); els.input.value = ''; haptic('medium'); persist(); render();
  }
  els.addBtn.addEventListener('click', addPhrase);
  els.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') addPhrase(); });
  els.clearBtn.addEventListener('click', function () {
    if (isPlaying) stopPlaying();
    phrases = []; persist(); render();
  });

  // --- Голос (встроенный синтез речи устройства) ---
  var femalePattern = /female|женск|milena|elena|katya|irina|tatyana|olga|anna|alyona/i;
  function pickDefault(list) {
    var ru = list.filter(function (v) { return v.lang && v.lang.toLowerCase().indexOf('ru') === 0; });
    var pool = ru.length > 0 ? ru : list;
    var female = pool.filter(function (v) { return femalePattern.test(v.name); })[0];
    return (female || pool[0] || {}).voiceURI || '';
  }
  function loadVoices() {
    var list = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    if (list.length > 0) {
      voices = list;
      if (!selectedVoiceURI) selectedVoiceURI = pickDefault(list);
      if (voices.length > 1) {
        els.voiceSelect.style.display = 'block';
        els.voiceSelect.innerHTML = voices.map(function (v) {
          return '<option value="' + escapeHtml(v.voiceURI) + '"' + (v.voiceURI === selectedVoiceURI ? ' selected' : '') + '>' +
            escapeHtml(v.name) + ' (' + v.lang + ')</option>';
        }).join('');
      }
    }
  }
  els.voiceSelect.addEventListener('change', function () { selectedVoiceURI = els.voiceSelect.value; });
  if (window.speechSynthesis) {
    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
  } else {
    els.statusMsg.textContent = 'Синтез речи не поддерживается на этом устройстве.';
  }

  // --- Фоновая музыка ---
  function setupMusic() {
    if (synth) return;
    reverb = new Tone.Reverb({ decay: 9, wet: 0.55 }).toDestination();
    synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 2.5, decay: 1, sustain: 0.8, release: 5 },
      volume: -20,
    }).connect(reverb);
    var chords = [['A3','C4','E4'],['F3','A3','C4'],['C4','E4','G4'],['G3','C4','E4']];
    var step = 0;
    loop = new Tone.Loop(function (time) {
      synth.triggerAttackRelease(chords[step % chords.length], '6n', time);
      step += 1;
    }, '6s');
  }

  // --- Воспроизведение ---
  function speakNext(index) {
    if (!isPlaying || phrases.length === 0) return;
    if (!window.speechSynthesis) return;
    currentIndex = index; render();
    var utterance = new SpeechSynthesisUtterance(phrases[index]);
    var voice = voices.filter(function (v) { return v.voiceURI === selectedVoiceURI; })[0];
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang; } else { utterance.lang = 'ru-RU'; }
    utterance.rate = 0.88; utterance.pitch = 1.05;
    var started = false;
    utterance.onstart = function () { started = true; els.statusMsg.textContent = ''; };
    utterance.onerror = function (e) {
      if (e && (e.error === 'interrupted' || e.error === 'canceled')) return;
      stopPlaying();
      els.statusMsg.textContent = 'Не удалось воспроизвести голос. Попробуйте ещё раз.';
    };
    utterance.onend = function () {
      if (!isPlaying) return;
      timeoutId = setTimeout(function () { if (isPlaying) speakNext((index + 1) % phrases.length); }, 3200);
    };
    if (startCheckId) clearTimeout(startCheckId);
    startCheckId = setTimeout(function () {
      if (!started && isPlaying) {
        stopPlaying();
        els.statusMsg.textContent = 'Устройство не начало озвучку. Проверьте звук и попробуйте снова.';
      }
    }, 2000);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  function startPlaying() {
    if (phrases.length === 0) return;
    els.statusMsg.textContent = '';
    isPlaying = true;
    haptic('medium');
    els.playIcon.textContent = '❚❚'; els.playLabel.textContent = 'Остановить';
    render();
    speakNext(0);
    resumeIntervalId = setInterval(function () {
      if (window.speechSynthesis && window.speechSynthesis.speaking) window.speechSynthesis.resume();
    }, 6000);

    Tone.start().then(function () {
      if (Tone.context.state !== 'running') return Tone.context.resume();
    }).then(function () {
      if (!isPlaying) return;
      setupMusic();
      Tone.Transport.bpm.value = 60;
      loop.start(0);
      Tone.Transport.start();
    }).catch(function () {});

    setTimeout(function () {
      if (!isPlaying) return;
      var speaking = window.speechSynthesis && window.speechSynthesis.speaking;
      if (!speaking && Tone.context.state !== 'running') {
        els.statusMsg.textContent = 'Звук не запускается. Проверьте громкость и беззвучный режим устройства.';
      }
    }, 2500);
  }

  function stopPlaying() {
    isPlaying = false; currentIndex = null;
    els.playIcon.textContent = '▶'; els.playLabel.textContent = 'Слушать';
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (timeoutId) clearTimeout(timeoutId);
    if (startCheckId) clearTimeout(startCheckId);
    if (resumeIntervalId) clearInterval(resumeIntervalId);
    if (loop) loop.stop(0);
    Tone.Transport.stop();
    render();
  }

  els.playBtn.addEventListener('click', function () { isPlaying ? stopPlaying() : startPlaying(); });

  render();
})();
