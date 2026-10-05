import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESv2Client({});
const { TABLE_NAME, OWNER_EMAIL } = process.env;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Owner notifications per UTC day. Past the cap one warning goes out, then silence until tomorrow; every
// request is still saved. Counters live in the same table under keys starting with "_mailcount#".
const DAILY_MAIL_CAP = 30;
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

  // The request is saved; a mail hiccup shouldn't tell the visitor it failed.
  await notify(item, !!prev).catch((err) => console.error('owner notification failed', err));
  return reply(200, { ok: true });
};

async function notify(item, isUpdate) {
  const day = new Date().toISOString().slice(0, 10);
  const { Attributes } = await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { email: `_mailcount#${day}` },
      UpdateExpression: 'ADD sent :one',
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const n = Attributes.sent;
  if (n > DAILY_MAIL_CAP + 1) return;
  if (n === DAILY_MAIL_CAP + 1) {
    return mail(OWNER_EMAIL, '77 to Starbase · signup flood', [
      `More than ${DAILY_MAIL_CAP} seat requests or changes today (${day}, UTC).`,
      'Emails are paused until tomorrow; every request is still saved in DynamoDB.',
    ]);
  }
  await mail(item.email, `77 to Starbase · ${isUpdate ? 'updated' : 'seat'} request from ${item.name}`, [
    `${item.name} <${item.email}>`,
    `From: ${item.origin || '-'}`,
    `Party: ${item.party}`,
    `Flight: ${item.target === 'flexible' ? 'Whichever flies first / flexible' : item.target || '-'}`,
    '',
    item.note || '(no note)',
  ]);
}

function mail(replyTo, subject, lines) {
  return ses.send(
    new SendEmailCommand({
      FromEmailAddress: OWNER_EMAIL,
      Destination: { ToAddresses: [OWNER_EMAIL] },
      ReplyToAddresses: [replyTo],
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: { Text: { Data: lines.join('\n') } },
        },
      },
    }),
  );
}
