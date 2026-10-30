// Облачная функция Яндекса: озвучивает свои фразы пользователей голосом SpeechKit.
//
// Что делает на каждый запрос:
//  1. Проверяет подпись Telegram (initData) — озвучивать могут только настоящие пользователи бота.
//  2. Проверяет текст (не пустой, не длиннее 200 символов).
//  3. Если такая фраза этим голосом уже озвучивалась (у кого угодно) — отдаёт её из хранилища, бесплатно.
//  4. Иначе проверяет лимиты, озвучивает через SpeechKit, кладёт mp3 в хранилище и отдаёт.
//
// Ключей в коде нет: функция работает от сервисного аккаунта, Яндекс сам выдаёт ей временный
// пропуск (context.token). Единственный секрет — токен бота, он в настройках функции (BOT_TOKEN).
//
// Настройки функции (переменные окружения):
//   BOT_TOKEN           — токен бота от BotFather (обязательно)
//   BUCKET              — имя хранилища, по умолчанию affirmacii-voice
//   FOLDER_ID           — каталог Облака (для SpeechKit)
//   LIMIT_PER_USER_DAY  — новых озвучек в день на человека, по умолчанию 40
//   LIMIT_TOTAL_MONTH   — новых озвучек в месяц на всех, по умолчанию 1800
//   ALLOWED_ORIGINS     — с каких сайтов можно обращаться, через запятую
//   VOICES              — (необязательно) свои голоса в формате JSON, как VOICES ниже

'use strict';
const crypto = require('crypto');

const VOICES_DEFAULT = {
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

const MAX_TEXT = 200;
const TTS_URL = 'https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis';
const S3 = 'https://storage.yandexcloud.net/';

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function voices() {
  try { return JSON.parse(env('VOICES', '')); } catch (e) { return VOICES_DEFAULT; }
}

// --- Ответы ---
function corsHeaders(origin) {
  const allowed = env('ALLOWED_ORIGINS', 'https://gaer-333.github.io').split(',').map((s) => s.trim());
  const h = { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin' };
  if (origin && allowed.indexOf(origin) >= 0) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '3600';
  }
  return h;
}
function reply(origin, status, data) {
  return { statusCode: status, headers: corsHeaders(origin), body: JSON.stringify(data) };
}

// --- Подпись Telegram ---
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function telegramUser(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const check = (skip) => {
    const pairs = [];
    params.forEach((v, k) => { if (skip.indexOf(k) < 0) pairs.push(k + '=' + v); });
    pairs.sort();
    const calc = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
    return calc.length === hash.length && crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
  };
  // Новые версии Telegram добавляют поле signature; на случай разных версий проверяем оба варианта
  if (!check(['hash']) && !check(['hash', 'signature'])) return null;
  const authDate = Number(params.get('auth_date')) || 0;
  if (Date.now() / 1000 - authDate > 7 * 86400) return null; // подпись старше недели — не принимаем
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? String(user.id) : null;
  } catch (e) { return null; }
}

// --- Хранилище (Object Storage) с временным пропуском функции ---
async function s3get(token, key) {
  const res = await fetch(S3 + env('BUCKET', 'affirmacii-voice') + '/' + key, {
    headers: { 'X-YaCloud-SubjectToken': token },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('хранилище: чтение ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}
async function s3put(token, key, body, type) {
  const res = await fetch(S3 + env('BUCKET', 'affirmacii-voice') + '/' + key, {
    method: 'PUT',
    headers: { 'X-YaCloud-SubjectToken': token, 'Content-Type': type },
    body: body,
  });
  if (!res.ok) throw new Error('хранилище: запись ' + res.status + ' ' + (await res.text()).slice(0, 200));
}
async function readCount(token, key) {
  const b = await s3get(token, key);
  if (!b) return 0;
  try { return Number(JSON.parse(b.toString('utf8')).count) || 0; } catch (e) { return 0; }
}
function writeCount(token, key, count) {
  return s3put(token, key, Buffer.from(JSON.stringify({ count: count })), 'application/json');
}

// --- SpeechKit ---
function collectAudio(raw) {
  const chunks = [];
  const pick = (obj) => {
    const r = obj && (obj.result || obj);
    if (r && r.audioChunk && r.audioChunk.data) chunks.push(Buffer.from(r.audioChunk.data, 'base64'));
  };
  const text = raw.trim();
  try {
    const whole = JSON.parse(text);
    (Array.isArray(whole) ? whole : [whole]).forEach(pick);
  } catch (e) {
    text.split(/\r?\n/).filter(Boolean).forEach((line) => { try { pick(JSON.parse(line)); } catch (err) {} });
  }
  return Buffer.concat(chunks);
}

async function synth(token, text, v) {
  const attempts = v.model ? [true, false] : [false];
  let last = '';
  for (const withModel of attempts) {
    const hints = [{ voice: v.voice }];
    if (v.role) hints.push({ role: v.role });
    if (v.speed) hints.push({ speed: v.speed });
    const body = { text: text, hints: hints, outputAudioSpec: { containerAudio: { containerAudioType: 'MP3' } } };
    if (withModel) body.model = v.model;
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'x-folder-id': env('FOLDER_ID', ''), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) { last = 'SpeechKit ' + res.status + ': ' + raw.slice(0, 200); continue; }
    const audio = collectAudio(raw);
    if (audio.length > 1000) return audio;
    last = 'SpeechKit: пустой ответ';
  }
  throw new Error(last);
}

// --- Вспомогательное ---
function cleanText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}
function moscowDate() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10); // ГГГГ-ММ-ДД по Москве
}

// --- Главное ---
module.exports.handler = async function (event, context) {
  const headers = event.headers || {};
  const origin = headers.Origin || headers.origin || '';
  if (event.httpMethod === 'OPTIONS') return reply(origin, 204, {});
  if (event.httpMethod !== 'POST') return reply(origin, 405, { error: 'method' });

  let req;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    req = JSON.parse(raw);
  } catch (e) { return reply(origin, 400, { error: 'bad_json' }); }

  const userId = telegramUser(req.initData, env('BOT_TOKEN', ''));
  if (!userId) return reply(origin, 401, { error: 'not_telegram' });

  const text = cleanText(req.text);
  if (!text || !/[a-zа-яё]/i.test(text)) return reply(origin, 400, { error: 'empty' });
  if (text.length > MAX_TEXT) return reply(origin, 400, { error: 'too_long', max: MAX_TEXT });

  const all = voices();
  const v = all[req.gender] && all[req.gender][req.time];
  if (!v) return reply(origin, 400, { error: 'bad_voice' });

  const token = context && context.token && context.token.access_token;
  if (!token) return reply(origin, 500, { error: 'no_service_account' });

  // Отпечаток фразы: одинаковый текст тем же голосом озвучивается один раз на всех
  const id = crypto.createHash('sha256').update(JSON.stringify({ t: text, v: v, ver: 1 })).digest('hex').slice(0, 40);
  const audioKey = 'custom/' + id + '.mp3';

  try {
    const cached = await s3get(token, audioKey);
    if (cached) return reply(origin, 200, { audio: cached.toString('base64'), cached: true });

    const day = moscowDate();
    const userKey = 'limits/day-' + day + '/' + userId + '.json';
    const totalKey = 'limits/month-' + day.slice(0, 7) + '.json';
    const [used, total] = await Promise.all([readCount(token, userKey), readCount(token, totalKey)]);
    const perUser = Number(env('LIMIT_PER_USER_DAY', 40));
    const perMonth = Number(env('LIMIT_TOTAL_MONTH', 1800));
    if (used >= perUser) return reply(origin, 429, { error: 'limit_user', limit: perUser });
    if (total >= perMonth) return reply(origin, 429, { error: 'limit_total' });

    const audio = await synth(token, text, v);
    await s3put(token, audioKey, audio, 'audio/mpeg');
    await Promise.all([writeCount(token, userKey, used + 1), writeCount(token, totalKey, total + 1)]);
    return reply(origin, 200, { audio: audio.toString('base64'), cached: false, left: perUser - used - 1 });
  } catch (e) {
    console.error(e && e.message);
    return reply(origin, 502, { error: 'tts_failed' });
  }
};

// Для проверки на компьютере (tools/test-function.js)
module.exports._test = { telegramUser, cleanText, collectAudio, moscowDate };
