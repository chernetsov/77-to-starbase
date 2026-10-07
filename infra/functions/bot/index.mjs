import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Telegram webhook for @starbase77bot. Anyone may press Start; that subscribes their chat for future updates.
// A start code from the site's form links the chat to that seat request. Misha hears about new subscribers and
// gets anything people write to the bot, under a daily cap.

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const { USERS_TABLE, SIGNUPS_TABLE, TELEGRAM_TOKEN_PARAM, WEBHOOK_SECRET_PARAM, OWNER_CHAT_ID, SITE_URL } = process.env;

const DAILY_NOTIFY_CAP = 50;
const ok = { statusCode: 200, body: '' };

const secrets = {};
const secret = async (name) =>
  (secrets[name] ??= (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter.Value);

export const handler = async (event) => {
  if (event.headers?.['x-telegram-bot-api-secret-token'] !== (await secret(WEBHOOK_SECRET_PARAM))) {
    return { statusCode: 401, body: '' };
  }
  let update;
  try {
    update = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
  } catch {
    return ok;
  }
  const msg = update.message;
  // Telegram retries anything but a 2xx, so failures are logged and swallowed.
  if (msg?.chat?.type === 'private' && msg.from && !msg.from.is_bot) {
    await onMessage(msg).catch((err) => console.error('bot update failed', err));
  }
  return ok;
};

async function onMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text ?? '').trim();
  const [command, arg = ''] = text.split(/\s+/, 2);
  const cmd = command.startsWith('/') ? command.slice(1).split('@')[0].toLowerCase() : '';
  if (chatId === OWNER_CHAT_ID && !cmd) return send(chatId, 'You are the host. Replies to guests from the bot come in a later version.');

  if (cmd === 'start') return start(msg, chatId, arg);
  if (cmd === 'stop') {
    await saveUser(msg, { subscribed: false });
    return send(chatId, 'Done, no more updates. Send /start any time to get them again.');
  }
  if (cmd === 'site') return send(chatId, 'The trip site: flight plan, launch schedule, and the seat request form.', siteButton());

  await saveUser(msg, {});
  await notifyOwner(`💬 <b>${esc(who(msg.from))}</b> wrote:\n${esc(text || `(${messageKind(msg)})`)}`);
  return send(chatId, 'Thanks, I passed that to Misha.');
}

async function start(msg, chatId, code) {
  const { Attributes: prev } = await saveUser(msg, { subscribed: true }, 'ALL_OLD');
  const request =
    (/^[A-Za-z0-9_-]{8,64}$/.test(code) ? await linkRequest(code, chatId) : null) ??
    (msg.from.username ? await linkByUsername(msg.from.username, chatId) : null);
  if (request) await saveUser(msg, { email: request.email });

  const lines = [
    request
      ? `Howdy, ${esc(request.name || msg.from.first_name)}! This chat is now linked to your seat request (${esc(flightLabel(request.target))}).`
      : `Howdy, ${esc(msg.from.first_name)}! You're subscribed to 77 to Starbase.`,
    '',
    'I post launch-date changes, trip news and new things on the site here. Trips run for every Starbase launch, so pick any flight that suits you.',
    '',
    'Send /stop to unsubscribe, /site for the link. Anything else you write goes to Misha.',
  ];
  await send(chatId, lines.join('\n'), siteButton());

  if (!prev || !prev.subscribed || request) {
    const what = request ? `linked their seat request (${esc(request.email)})` : prev ? 'resubscribed' : 'subscribed';
    await notifyOwner(`🤖 <b>${esc(who(msg.from))}</b> ${what}.`);
  }
}

/** Resolves a one-time start code from the site's form to that seat request and marks it linked. */
async function linkRequest(code, chatId) {
  const key = { email: `_tglink#${code}` };
  const { Item: link } = await db.send(new GetCommand({ TableName: SIGNUPS_TABLE, Key: key }));
  if (!link || link.expiresAt < Date.now() / 1000) return null;
  await db.send(new DeleteCommand({ TableName: SIGNUPS_TABLE, Key: key }));
  return setChat(link.target, chatId);
}

/** Misha can pre-assign a Telegram username to a seat request with a `_tguser#<lowercase username>` row. */
async function linkByUsername(username, chatId) {
  const key = { email: `_tguser#${username.toLowerCase()}` };
  const { Item: link } = await db.send(new GetCommand({ TableName: SIGNUPS_TABLE, Key: key }));
  if (!link) return null;
  const request = await setChat(link.target, chatId);
  if (request) await db.send(new DeleteCommand({ TableName: SIGNUPS_TABLE, Key: key }));
  return request;
}

async function setChat(email, chatId) {
  const { Attributes } = await db.send(
    new UpdateCommand({
      TableName: SIGNUPS_TABLE,
      Key: { email },
      UpdateExpression: 'SET telegramChatId = :c',
      ConditionExpression: 'attribute_exists(email)',
      ExpressionAttributeValues: { ':c': chatId },
      ReturnValues: 'ALL_NEW',
    }),
  ).catch(() => ({}));
  return Attributes ?? null;
}

function saveUser(msg, extra, returnValues = 'NONE') {
  const now = new Date().toISOString();
  const fields = {
    firstName: msg.from.first_name ?? '',
    lastName: msg.from.last_name ?? '',
    username: msg.from.username ?? '',
    languageCode: msg.from.language_code ?? '',
    lastSeenAt: now,
    ...extra,
  };
  const names = Object.keys(fields);
  return db.send(
    new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { chatId: String(msg.chat.id) },
      UpdateExpression: `SET firstSeenAt = if_not_exists(firstSeenAt, :now), ${names.map((k) => `#${k} = :${k}`).join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries(names.map((k) => [`#${k}`, k])),
      ExpressionAttributeValues: { ':now': now, ...Object.fromEntries(names.map((k) => [`:${k}`, fields[k]])) },
      ReturnValues: returnValues,
    }),
  );
}

/** Owner notifications share one per-UTC-day cap; past it, one warning and then silence until tomorrow. */
async function notifyOwner(html) {
  const day = new Date().toISOString().slice(0, 10);
  const { Attributes } = await db.send(
    new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { chatId: `_notifycount#${day}` },
      UpdateExpression: 'ADD sent :one',
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const n = Attributes.sent;
  if (n > DAILY_NOTIFY_CAP + 1) return;
  if (n === DAILY_NOTIFY_CAP + 1) {
    return send(OWNER_CHAT_ID, `<b>Bot flood</b>: more than ${DAILY_NOTIFY_CAP} bot notifications today (${day}, UTC). Quiet until tomorrow; everything is still saved.`);
  }
  return send(OWNER_CHAT_ID, html);
}

const TARGETS = { later: 'a later flight', flexible: 'whichever fits' };
const flightLabel = (t) => TARGETS[t] ?? (t || 'no flight picked yet');
const who = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') + (u.username ? ` @${u.username}` : '');
const messageKind = (m) => ['photo', 'sticker', 'voice', 'video', 'document', 'location', 'contact'].find((k) => m[k]) ?? 'message';
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const siteButton = () => ({ reply_markup: { inline_keyboard: [[{ text: 'Open 77 to Starbase', url: SITE_URL }]] } });

async function send(chatId, text, extra = {}) {
  const token = await secret(TELEGRAM_TOKEN_PARAM);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}: ${await res.text()}`);
}
