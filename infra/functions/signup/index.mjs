import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESv2Client({});
const { TABLE_NAME, OWNER_EMAIL } = process.env;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

  await db.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: OWNER_EMAIL,
      Destination: { ToAddresses: [OWNER_EMAIL] },
      ReplyToAddresses: [item.email],
      Content: {
        Simple: {
          Subject: { Data: `77 to Starbase · seat request from ${item.name}` },
          Body: {
            Text: {
              Data: [
                `${item.name} <${item.email}>`,
                `From: ${item.origin || '-'}`,
                `Party: ${item.party}`,
                `Flight: ${item.target === 'flexible' ? 'Whichever flies first / flexible' : item.target || '-'}`,
                '',
                item.note || '(no note)',
              ].join('\n'),
            },
          },
        },
      },
    }),
  );

  return reply(200, { ok: true });
};
