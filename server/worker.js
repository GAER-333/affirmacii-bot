// Бот на Cloudflare Workers: приветствие, /stop и аффирмация дня.
// (Та же логика, что в bot.js для Яндекса, но Cloudflare стоит за границей, и Telegram до него доходит.)
//
//  • Telegram присылает сюда сообщения (вебхук):
//      /start — приветствие с кнопкой «Слушать» и подписка на аффирмацию дня;
//      /stop  — больше не присылать (снова — /start);
//      заблокировал бота — тоже больше не присылаем.
//  • Таймер Cloudflare утром (каждые 5 минут с 9:00 до 10:00 по Москве) рассылает подписчикам
//    одну аффирмацию текстом с кнопкой «Слушать». За один запуск — до 45 человек (ограничение
//    бесплатного тарифа на число запросов), поэтому рассылка идёт порциями; кто уже получил — не повторяем.
//
// Настройки воркера:
//   SUBS            — хранилище KV (Bindings → KV namespace), в нём подписчики
//   BOT_TOKEN       — токен бота (секрет)
//   WEBHOOK_SECRET  — секретное слово вебхука (секрет)
//   APP_URL         — адрес приложения (необязательно)

const BATCH = 45;
const FALLBACK = [
  'Сегодня новый день, и я встречаю его с открытым сердцем.',
  'Я спокоен и уверен в себе.',
  'Я делаю всё в своём темпе.',
];

const appUrl = (env) => env.APP_URL || 'https://gaer-333.github.io/affirmacii-bot/';

async function tg(env, method, body) {
  const res = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, ok: !!data.ok, data: data };
}
const listenButton = (env) => ({ inline_keyboard: [[{ text: '🎧 Слушать', web_app: { url: appUrl(env) } }]] });
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- Подписчики: ключ sub:<id чата> есть — подписан ---
const subscribe = (env, chatId) => env.SUBS.put('sub:' + chatId, new Date().toISOString());
const unsubscribe = (env, chatId) => env.SUBS.delete('sub:' + chatId);
async function listSubscribers(env) {
  const ids = [];
  let cursor;
  do {
    const page = await env.SUBS.list({ prefix: 'sub:', cursor: cursor });
    page.keys.forEach((k) => ids.push(k.name.slice(4)));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return ids;
}

// --- Фразы: утренний набор из data.js приложения (без выполнения кода — просто вынимаем строки) ---
async function loadPhrases(env) {
  try {
    const res = await fetch(appUrl(env) + 'data.js', { cf: { cacheTtl: 300 } });
    if (res.ok) {
      const text = await res.text();
      const block = text.slice(text.indexOf('morning:'));
      const list = block.slice(block.indexOf('phrases:'), block.indexOf(']'));
      const phrases = [];
      list.replace(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g, (m, a, b) => { phrases.push((a || b).replace(/\\(.)/g, '$1')); return m; });
      if (phrases.length) return phrases;
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
const dailyText = (phrase) =>
  '🌅 <b>Аффирмация дня</b>\n\n«' + escapeHtml(phrase) + '»\n\nНайдите пару минут, чтобы послушать её спокойным голосом 🎧';

// --- Сообщения от Telegram ---
async function onUpdate(env, update) {
  if (update.my_chat_member) {
    const st = update.my_chat_member.new_chat_member && update.my_chat_member.new_chat_member.status;
    const chatId = update.my_chat_member.chat && update.my_chat_member.chat.id;
    if (chatId && (st === 'kicked' || st === 'left')) await unsubscribe(env, chatId);
    return;
  }
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  if (/^\/start\b/.test(text)) {
    await subscribe(env, chatId);
    await tg(env, 'sendMessage', { chat_id: chatId, text: WELCOME, parse_mode: 'HTML', reply_markup: listenButton(env) });
  } else if (/^\/stop\b/.test(text)) {
    await unsubscribe(env, chatId);
    await tg(env, 'sendMessage', { chat_id: chatId, text: STOPPED });
  } else {
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'Аффирмации живут в приложении — нажмите «Слушать» 👇', reply_markup: listenButton(env) });
  }
}

// --- Утренняя рассылка: одна порция за запуск ---
async function sendDailyBatch(env, now) {
  const day = new Date(now.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10); // дата по Москве
  const doneKey = 'daily:' + day;
  const done = parseInt((await env.SUBS.get(doneKey)) || '0', 10);
  const ids = (await listSubscribers(env)).sort();
  if (done >= ids.length) return { day: day, sent: 0, left: 0 };
  const phrase = phraseOfDay(await loadPhrases(env), now);
  const batch = ids.slice(done, done + BATCH);
  let sent = 0, off = 0, failed = 0;
  for (const chatId of batch) {
    const r = await tg(env, 'sendMessage', { chat_id: chatId, text: dailyText(phrase), parse_mode: 'HTML', reply_markup: listenButton(env) });
    if (r.ok) sent++;
    else if (r.status === 403) { await unsubscribe(env, chatId); off++; } // заблокировал бота
    else failed++;
  }
  await env.SUBS.put(doneKey, String(done + batch.length), { expirationTtl: 3 * 86400 });
  return { day: day, sent: sent, off: off, failed: failed, left: ids.length - done - batch.length };
}

export default {
  async fetch(request, env, ctx) {
    // Ручной запуск рассылки (проверить, не дожидаясь утра):
    //   <адрес воркера>/daily?key=<WEBHOOK_SECRET>          — разослать тем, кто сегодня ещё не получил
    //   <адрес воркера>/daily?key=<WEBHOOK_SECRET>&force=1  — разослать всем ещё раз (для проверки)
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/daily') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('unauthorized', { status: 401 });
      const now = new Date();
      if (url.searchParams.get('force') === '1') {
        await env.SUBS.delete('daily:' + new Date(now.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10));
      }
      const result = await sendDailyBatch(env, now);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    if (request.method !== 'POST') return new Response('Бот аффирмаций работает 🌙', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (!env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('unauthorized', { status: 401 });
    }
    let update;
    try { update = await request.json(); } catch (e) { return new Response('ok'); }
    try { await onUpdate(env, update); } catch (e) { console.error(e && e.message); }
    return new Response('ok'); // Telegram должен получить 200, иначе будет повторять
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyBatch(env, new Date(event.scheduledTime)).then((r) => console.log('Рассылка', JSON.stringify(r))));
  },
};

