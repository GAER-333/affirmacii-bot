// Облачная функция Яндекса: бот, который пишет сам.
//
//  • Telegram присылает сюда сообщения пользователей (вебхук):
//      /start — приветствие с кнопкой «Слушать» и подписка на аффирмацию дня;
//      /stop  — больше не присылать (снова — /start);
//      заблокировал бота — тоже больше не присылаем.
//  • Таймер Облака раз в день (9:00 по Москве) запускает рассылку: всем подписчикам —
//    одна аффирмация текстом и кнопка, которая открывает приложение.
//
// Подписчики хранятся в том же закрытом хранилище, что и озвучка: bot/subscribers/<id чата>.json.
// Фразы берутся из самого приложения (data.js на сайте) — поменяли фразы там, поменялись и в рассылке.
//
// Настройки функции (переменные окружения):
//   BOT_TOKEN       — токен бота (обязательно)
//   WEBHOOK_SECRET  — секретное слово вебхука: Telegram присылает его в каждом запросе,
//                     чужие запросы без него отклоняются (обязательно)
//   BUCKET          — хранилище, по умолчанию affirmacii-voice
//   APP_URL         — адрес приложения

'use strict';
const vm = require('vm');

const S3 = 'https://storage.yandexcloud.net/';
const PREFIX = 'bot/subscribers/';

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
const APP_URL = () => env('APP_URL', 'https://gaer-333.github.io/affirmacii-bot/');

// Запасные фразы — если сайт с приложением вдруг недоступен
const FALLBACK = [
  'Сегодня новый день, и я встречаю его с открытым сердцем.',
  'Я спокоен и уверен в себе.',
  'Я делаю всё в своём темпе.',
];

// --- Telegram ---
async function tg(method, body) {
  const res = await fetch('https://api.telegram.org/bot' + env('BOT_TOKEN', '') + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, ok: !!data.ok, data: data };
}
function listenButton(text) {
  return { inline_keyboard: [[{ text: text || '🎧 Слушать', web_app: { url: APP_URL() } }]] };
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Хранилище ---
async function s3(token, method, key, body) {
  const opt = { method: method, headers: { 'X-YaCloud-SubjectToken': token } };
  if (body !== undefined) { opt.body = body; opt.headers['Content-Type'] = 'application/json'; }
  return fetch(S3 + env('BUCKET', 'affirmacii-voice') + '/' + key, opt);
}
async function setSubscribed(token, chatId, on) {
  const res = await s3(token, 'PUT', PREFIX + chatId + '.json', JSON.stringify({ on: on, at: new Date().toISOString() }));
  if (!res.ok) throw new Error('хранилище: запись ' + res.status);
}
async function readSubscriber(token, key) {
  const res = await s3(token, 'GET', key);
  if (!res.ok) return null;
  try { return await res.json(); } catch (e) { return null; }
}
// Все подписчики: список файлов в папке bot/subscribers/ (по 1000 за раз)
async function listSubscribers(token) {
  const keys = [];
  let cont = '';
  for (;;) {
    const q = '?list-type=2&prefix=' + encodeURIComponent(PREFIX) + (cont ? '&continuation-token=' + encodeURIComponent(cont) : '');
    const res = await fetch(S3 + env('BUCKET', 'affirmacii-voice') + q, { headers: { 'X-YaCloud-SubjectToken': token } });
    if (!res.ok) throw new Error('хранилище: список ' + res.status);
    const xml = await res.text();
    xml.replace(/<Key>([^<]+)<\/Key>/g, (m, k) => { keys.push(k); return m; });
    const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !next) break;
    cont = next[1];
  }
  return keys;
}

// --- Фразы ---
async function loadPhrases() {
  try {
    const res = await fetch(APP_URL() + 'data.js', { cache: 'no-store' });
    if (res.ok) {
      const box = {};
      vm.runInNewContext((await res.text()) + '\nthis.A = AFFIRMATIONS;', box, { timeout: 1000 });
      const p = box.A && box.A.morning && box.A.morning.phrases;
      if (Array.isArray(p) && p.length) return p;
    }
  } catch (e) {}
  return FALLBACK;
}
// Аффирмация дня: одна на всех в этот день, каждый день — следующая
function phraseOfDay(phrases, date) {
  const day = Math.floor((date.getTime() + 3 * 3600 * 1000) / 86400000); // дни по Москве
  return phrases[day % phrases.length];
}

// --- Тексты ---
const WELCOME =
  '🌙 <b>Здравствуйте!</b>\n\n' +
  'Здесь аффирмации проговаривает спокойный голос под мягкую музыку — утром, днём и перед сном.\n\n' +
  'Нажмите «Слушать», чтобы начать. А каждое утро я буду присылать вам <b>аффирмацию дня</b> 💌\n\n' +
  '<i>Не хотите получать её — отправьте /stop</i>';
const STOPPED = 'Хорошо, больше не буду присылать аффирмацию дня.\nЕсли захотите снова — отправьте /start 🌿';
function dailyText(phrase) {
  return '🌅 <b>Аффирмация дня</b>\n\n«' + escapeHtml(phrase) + '»\n\nНайдите пару минут, чтобы послушать её спокойным голосом 🎧';
}

// --- Сообщения от Telegram ---
async function onUpdate(token, update) {
  // Заблокировал бота / разблокировал
  if (update.my_chat_member) {
    const st = update.my_chat_member.new_chat_member && update.my_chat_member.new_chat_member.status;
    const chatId = update.my_chat_member.chat && update.my_chat_member.chat.id;
    if (chatId && (st === 'kicked' || st === 'left')) await setSubscribed(token, chatId, false);
    return;
  }
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  if (/^\/start\b/.test(text)) {
    await setSubscribed(token, chatId, true);
    await tg('sendMessage', { chat_id: chatId, text: WELCOME, parse_mode: 'HTML', reply_markup: listenButton() });
  } else if (/^\/stop\b/.test(text)) {
    await setSubscribed(token, chatId, false);
    await tg('sendMessage', { chat_id: chatId, text: STOPPED });
  } else {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Аффирмации живут в приложении — нажмите «Слушать» 👇',
      reply_markup: listenButton(),
    });
  }
}

// --- Ежедневная рассылка ---
async function sendDaily(token) {
  const phrase = phraseOfDay(await loadPhrases(), new Date());
  const keys = await listSubscribers(token);
  let sent = 0, off = 0, failed = 0;
  for (const key of keys) {
    const sub = await readSubscriber(token, key);
    if (!sub || !sub.on) { off++; continue; }
    const chatId = key.slice(PREFIX.length).replace(/\.json$/, '');
    let r = await tg('sendMessage', { chat_id: chatId, text: dailyText(phrase), parse_mode: 'HTML', reply_markup: listenButton() });
    if (r.status === 429) { // Telegram просит подождать
      const wait = ((r.data.parameters && r.data.parameters.retry_after) || 1) * 1000;
      await new Promise((ok) => setTimeout(ok, wait));
      r = await tg('sendMessage', { chat_id: chatId, text: dailyText(phrase), parse_mode: 'HTML', reply_markup: listenButton() });
    }
    if (r.ok) sent++;
    else if (r.status === 403) { await setSubscribed(token, chatId, false); off++; } // заблокировал бота
    else failed++;
    await new Promise((ok) => setTimeout(ok, 40)); // не больше ~25 сообщений в секунду
  }
  console.log('Рассылка: отправлено ' + sent + ', отписаны ' + off + ', ошибок ' + failed);
  return { sent: sent, off: off, failed: failed };
}

// --- Забрать новые сообщения у Telegram самим (без вебхука) ---
// Пока Яндекс не пускает к функциям запросы из-за границы, Telegram не может прислать нам сообщения
// сам. Тогда таймер раз в минуту запускает функцию с данными «poll», и она забирает накопившиеся
// сообщения (getUpdates). Номер последнего обработанного сообщения хранится в bot/state.json.
// Важно: пока у бота включён вебхук, getUpdates не работает — его нужно отключить (deleteWebhook).
async function pollUpdates(token) {
  let offset = 0;
  const st = await s3(token, 'GET', 'bot/state.json');
  if (st.ok) { try { offset = (await st.json()).offset || 0; } catch (e) {} }
  const r = await tg('getUpdates', { offset: offset, timeout: 0, limit: 100, allowed_updates: ['message', 'my_chat_member'] });
  if (!r.ok) {
    console.error('getUpdates: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 200)); // 409 — включён вебхук
    return { polled: 0, error: r.status };
  }
  const updates = r.data.result || [];
  for (const u of updates) {
    try { await onUpdate(token, u); } catch (e) { console.error(e && e.message); }
    offset = u.update_id + 1;
  }
  if (updates.length) await s3(token, 'PUT', 'bot/state.json', JSON.stringify({ offset: offset }));
  return { polled: updates.length };
}

// --- Главное ---
module.exports.handler = async function (event, context) {
  const token = context && context.token && context.token.access_token;
  if (!token) return { statusCode: 500, body: 'no service account' };

  // Запуск от таймера Облака
  const isTimer = event && Array.isArray(event.messages) && event.messages.some((m) =>
    m && m.event_metadata && /TimerMessage/.test(m.event_metadata.event_type || ''));
  if (isTimer) {
    // Таймер с данными «poll» — забрать сообщения; без данных — утренняя рассылка
    const payload = event.messages.map((m) => (m.details && m.details.payload) || '').join('');
    const result = payload.trim() === 'poll' ? await pollUpdates(token) : await sendDaily(token);
    return { statusCode: 200, body: JSON.stringify(result) };
  }

  // Сообщение от Telegram — проверяем секретное слово вебхука
  const headers = (event && event.headers) || {};
  const secret = headers['X-Telegram-Bot-Api-Secret-Token'] || headers['x-telegram-bot-api-secret-token'];
  if (!env('WEBHOOK_SECRET', '') || secret !== env('WEBHOOK_SECRET', '')) return { statusCode: 401, body: 'unauthorized' };
  let update;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    update = JSON.parse(raw);
  } catch (e) { return { statusCode: 200, body: 'ok' }; }
  try { await onUpdate(token, update); } catch (e) { console.error(e && e.message); }
  return { statusCode: 200, body: 'ok' }; // Telegram должен получить 200, иначе будет повторять
};

module.exports._test = { phraseOfDay, dailyText, loadPhrases, pollUpdates };
