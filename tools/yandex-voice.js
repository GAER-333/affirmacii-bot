// Озвучка готовых фраз голосами Яндекс SpeechKit (API v3).
// Каждая фраза озвучивается отдельно и кладётся в audio/<голос>/<время суток>/NN.mp3 —
// туда же, откуда их берёт приложение. Резать записи на фразы больше не нужно.
//
// Ключ берётся из файла .env (строка YANDEX_API_KEY=...). Сам ключ скрипт нигде не показывает.
//
// Запуск (из папки проекта):
//   node tools/yandex-voice.js                       — озвучить всё, чего ещё нет
//   node tools/yandex-voice.js --force               — перезаписать всё заново
//   node tools/yandex-voice.js --gender female --time night --only 3,5 --force
//   node tools/yandex-voice.js --dry-run             — только показать, что будет сделано
// Цена: около 0,16 ₽ за фразу (голоса LiveTTS — 0,25 ₽).

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Какой голос Яндекса читает какой набор. Названия и амплуа — как в документации SpeechKit:
// zamira_ru / yulduz_ru — женские, ermil — мужской (модель general);
// denis — мужской из нового «живого» синтеза (модель livetts, скорость у него не настраивается).
// Амплуа: friendly — «дружелюбный», good — «радостный», casual — «разговорный».
const VOICES = {
  female: {
    morning: { voice: 'zamira_ru', role: 'friendly', speed: 0.89 },
    day:     { voice: 'zamira_ru', role: 'friendly', speed: 0.89 },
    night:   { voice: 'yulduz_ru', role: 'friendly', speed: 0.89 },
  },
  male: {
    morning: { voice: 'ermil', role: 'good', speed: 0.89 },
    day:     { voice: 'ermil', role: 'good', speed: 0.89 },
    night:   { voice: 'denis', role: 'casual', model: 'livetts' },
  },
};

const ROOT = path.join(__dirname, '..');
const API = 'https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis';

function args() {
  const a = process.argv.slice(2), o = { force: false, dryRun: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--force') o.force = true;
    else if (a[i] === '--dry-run') o.dryRun = true;
    else if (a[i] === '--gender') o.gender = a[++i];
    else if (a[i] === '--time') o.time = a[++i];
    else if (a[i] === '--only') o.only = a[++i].split(',').map(Number);
  }
  return o;
}

function readKey() {
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch (e) {}
  const m = text.match(/^\s*YANDEX_API_KEY\s*=\s*(.+?)\s*$/m);
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
}

function readPhrases() {
  const box = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8') + '\nthis.A = AFFIRMATIONS;', box);
  return box.A;
}

function body(text, v, withModel) {
  const hints = [{ voice: v.voice }];
  if (v.role) hints.push({ role: v.role });
  if (v.speed) hints.push({ speed: v.speed });
  const b = { text: text, hints: hints, outputAudioSpec: { containerAudio: { containerAudioType: 'MP3' } } };
  if (withModel && v.model) b.model = v.model;
  return JSON.stringify(b);
}

// Ответ приходит потоком JSON-объектов (по строке на кусок звука). Собираем все кусочки.
function collectAudio(raw) {
  const chunks = [];
  const pick = (obj) => {
    const r = obj && (obj.result || obj);
    if (r && r.audioChunk && r.audioChunk.data) chunks.push(Buffer.from(r.audioChunk.data, 'base64'));
    if (obj && obj.error) throw new Error((obj.error.message || JSON.stringify(obj.error)).slice(0, 300));
  };
  const text = raw.trim();
  try {
    const whole = JSON.parse(text);
    (Array.isArray(whole) ? whole : [whole]).forEach(pick);
  } catch (e) {
    if (e.message && !/JSON/.test(e.message) && !/Unexpected/.test(e.message)) throw e;
    text.split(/\r?\n/).filter(Boolean).forEach((line) => pick(JSON.parse(line)));
  }
  return Buffer.concat(chunks);
}

function looksLikeMp3(buf) {
  if (buf.length < 1000) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // ID3
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;                    // кадр MPEG
}

async function synth(key, text, v) {
  // Модель указываем только для «живых» голосов; если Яндекс её не примет — пробуем без неё
  const attempts = v.model ? [true, false] : [false];
  let lastError = null;
  for (const withModel of attempts) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { Authorization: 'Api-Key ' + key, 'Content-Type': 'application/json' },
      body: body(text, v, withModel),
    });
    const raw = await res.text();
    if (!res.ok) { lastError = 'HTTP ' + res.status + ': ' + raw.slice(0, 300); continue; }
    const audio = collectAudio(raw);
    if (!looksLikeMp3(audio)) { lastError = 'ответ не похож на mp3 (' + audio.length + ' байт)'; continue; }
    return audio;
  }
  throw new Error(lastError);
}

function pad(n) { return (n < 10 ? '0' : '') + n; }

async function main() {
  const o = args();
  const key = readKey();
  if (!key && !o.dryRun) {
    console.error('Нет ключа: впишите YANDEX_API_KEY=... в файл .env в папке проекта.');
    process.exit(1);
  }
  const phrases = readPhrases();
  const jobs = [];
  for (const gender of Object.keys(VOICES)) {
    if (o.gender && o.gender !== gender) continue;
    for (const time of Object.keys(VOICES[gender])) {
      if (o.time && o.time !== time) continue;
      phrases[time].phrases.forEach((text, i) => {
        if (o.only && o.only.indexOf(i + 1) < 0) return;
        const file = path.join(ROOT, 'audio', gender, time, pad(i + 1) + '.mp3');
        if (!o.force && fs.existsSync(file)) return;
        jobs.push({ gender, time, n: i + 1, text, file, v: VOICES[gender][time] });
      });
    }
  }
  console.log('Фраз к озвучке: ' + jobs.length + (o.dryRun ? ' (пробный прогон, ничего не отправляется)' : ''));
  let ok = 0, failed = 0;
  for (const j of jobs) {
    const label = j.gender + '/' + j.time + '/' + pad(j.n) + ' — ' + j.v.voice;
    if (o.dryRun) { console.log('  ' + label + ': ' + j.text); continue; }
    try {
      const audio = await synth(key, j.text, j.v);
      fs.mkdirSync(path.dirname(j.file), { recursive: true });
      fs.writeFileSync(j.file, audio);
      ok++;
      console.log('  ✓ ' + label + ' (' + Math.round(audio.length / 1024) + ' КБ)');
    } catch (e) {
      failed++;
      console.log('  ✗ ' + label + ': ' + e.message);
      if (/HTTP 401|HTTP 403/.test(e.message)) { console.log('Ключ не подходит или у него нет доступа к SpeechKit — остановка.'); break; }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!o.dryRun) console.log('Готово: ' + ok + ', ошибок: ' + failed);
  process.exit(failed ? 1 : 0);
}

main();
