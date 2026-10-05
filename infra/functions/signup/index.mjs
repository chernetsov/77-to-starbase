import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const { TABLE_NAME, TELEGRAM_TOKEN_PARAM, TELEGRAM_CHAT_ID } = process.env;

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

  const item = {
    email: clip(input.email, 200).toLowerCase(),
    name: clip(input.name, 100),
    origin: clip(input.origin, 100),
    party: Math.min(4, Math.max(1, Number(input.party) || 1)),
    // A flight label from the site's schedule, "flexible", or a legacy value like "next".
    target: clip(input.target, 120),
    note: clip(input.note, 2000),
    subscribed: true,
    createdAt: new Date().toISOString(),
  };
  if (!item.name || !EMAIL_RE.test(item.email)) return reply(400, { error: 'name and valid email required' });

  const { Attributes: prev } = await db.send(new PutCommand({ TableName: TABLE_NAME, Item: item, ReturnValues: 'ALL_OLD' }));
  if (prev && FIELDS.every((k) => prev[k] === item[k])) return reply(200, { ok: true });

  // The request is saved; a notification hiccup shouldn't tell the visitor it failed.
  await notify(item, !!prev).catch((err) => console.error('owner notification failed', err));
  return reply(200, { ok: true });
};

async function notify(item, isUpdate) {
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
      `<b>Signup flood</b>: more than ${DAILY_NOTIFY_CAP} seat requests or changes today (${day}, UTC).`,
      'Notifications are paused until tomorrow; every request is still saved in DynamoDB.',
    ]);
  }
  await telegram([
    `<b>${isUpdate ? 'Updated' : 'New'} seat request</b> · ${esc(item.name)}`,
    esc(item.email),
    `From: ${esc(item.origin || '-')} · Party: ${item.party}`,
    `Flight: ${esc(item.target === 'flexible' ? 'Whichever flies first / flexible' : item.target || '-')}`,
    '',
    esc(item.note || '(no note)'),
  ]);
}

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
