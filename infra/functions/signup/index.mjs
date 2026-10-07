import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomBytes } from 'node:crypto';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const { TABLE_NAME, TELEGRAM_TOKEN_PARAM, TELEGRAM_CHAT_ID, BOT_USERNAME } = process.env;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Owner notifications per UTC day. Past the cap one warning goes out, then silence until tomorrow; every
// request is still saved. Counters live in the same table under keys starting with "_notifycount#".
const DAILY_NOTIFY_CAP = 30;
const FIELDS = ['name', 'origin', 'party', 'target', 'note'];
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  let input;
  try {
    input = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
  } catch {
    return reply(400, { error: 'invalid json' });
  }

  // Honeypot field: real visitors never fill it in.
  if (input.website) return reply(200, { ok: true });
  if (input.intent === 'updates') return follow(clip(input.email, 200).toLowerCase());

  const item = {
    email: clip(input.email, 200).toLowerCase(),
    name: clip(input.name, 100),
    origin: clip(input.origin, 100),
    party: Math.min(4, Math.max(1, Number(input.party) || 1)),
    // A flight label from the site's schedule, "later", "flexible", or a legacy value like "next".
    target: clip(input.target, 120),
    note: clip(input.note, 2000),
    subscribed: true,
    createdAt: new Date().toISOString(),
  };
  if (!item.name || !EMAIL_RE.test(item.email)) return reply(400, { error: 'name and valid email required' });

  // Only the form's own fields are written, so a linked Telegram chat survives a re-submit.
  const { email, ...fields } = item;
  const names = Object.keys(fields);
  const { Attributes: prev } = await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { email },
      UpdateExpression: `SET ${names.map((k) => (k === 'createdAt' ? `#${k} = if_not_exists(#${k}, :${k})` : `#${k} = :${k}`)).join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries(names.map((k) => [`#${k}`, k])),
      ExpressionAttributeValues: Object.fromEntries(names.map((k) => [`:${k}`, fields[k]])),
      ReturnValues: 'ALL_OLD',
    }),
  );
  const telegram = prev?.telegramChatId ? null : await telegramLink(email).catch(() => null);
  if (prev && FIELDS.every((k) => prev[k] === item[k])) return reply(200, { ok: true, telegram });

  // The request is saved; a notification hiccup shouldn't tell the visitor it failed.
  await notify(item, !!prev?.name).catch((err) => console.error('owner notification failed', err));
  return reply(200, { ok: true, telegram });
};

/** Updates without a seat request: just an email. A seat request on the same email later fills in the rest. */
async function follow(email) {
  if (!EMAIL_RE.test(email)) return reply(400, { error: 'valid email required' });
  const { Attributes: prev } = await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { email },
      UpdateExpression: 'SET subscribed = :t, createdAt = if_not_exists(createdAt, :now)',
      ExpressionAttributeValues: { ':t': true, ':now': new Date().toISOString() },
      ReturnValues: 'ALL_OLD',
    }),
  );
  const telegram = prev?.telegramChatId ? null : await telegramLink(email).catch(() => null);
  if (!prev?.subscribed) {
    await notifyCapped([`<b>New follower</b> · ${esc(email)}`, 'Updates only, no seat request yet.']).catch((err) =>
      console.error('owner notification failed', err),
    );
  }
  return reply(200, { ok: true, telegram });
}

/** One-time deep link that ties the visitor's Telegram chat to this request when they press Start. */
async function telegramLink(email) {
  const code = randomBytes(12).toString('base64url');
  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { email: `_tglink#${code}`, target: email, expiresAt: Math.floor(Date.now() / 1000) + 14 * 86400 },
    }),
  );
  return `https://t.me/${BOT_USERNAME}?start=${code}`;
}

function notify(item, isUpdate) {
  return notifyCapped([
    `<b>${isUpdate ? 'Updated' : 'New'} seat request</b> · ${esc(item.name)}`,
    esc(item.email),
    `From: ${esc(item.origin || '-')} · Party: ${item.party}`,
    `Flight: ${esc(TARGETS[item.target] ?? (item.target || '-'))}`,
    '',
    esc(item.note || '(no note)'),
  ]);
}

async function notifyCapped(lines) {
  const day = new Date().toISOString().slice(0, 10);
  const { Attributes } = await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { email: `_notifycount#${day}` },
      UpdateExpression: 'ADD sent :one',
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const n = Attributes.sent;
  if (n > DAILY_NOTIFY_CAP + 1) return;
  if (n === DAILY_NOTIFY_CAP + 1) {
    return telegram([
      `<b>Signup flood</b>: more than ${DAILY_NOTIFY_CAP} signups or changes today (${day}, UTC).`,
      'Notifications are paused until tomorrow; every signup is still saved in DynamoDB.',
    ]);
  }
  await telegram(lines);
}

const TARGETS = { later: 'A later one (month in the note)', flexible: 'Whichever fits / flexible' };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

let token;
async function telegram(lines) {
  token ??= (await ssm.send(new GetParameterCommand({ Name: TELEGRAM_TOKEN_PARAM, WithDecryption: true }))).Parameter.Value;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}: ${await res.text()}`);
}
