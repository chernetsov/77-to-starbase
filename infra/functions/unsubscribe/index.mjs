import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Unsubscribe link from update emails: /unsubscribe?e=<email>&t=<hmac>. GET shows a confirm button, because mail
// scanners open links; POST unsubscribes (the button, or a mail app's RFC 8058 one-click request).

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const { TABLE_NAME, UNSUBSCRIBE_SECRET_PARAM, SITE_URL } = process.env;

let secret;
const sign = async (email) => {
  secret ??= (await ssm.send(new GetParameterCommand({ Name: UNSUBSCRIBE_SECRET_PARAM, WithDecryption: true }))).Parameter.Value;
  return createHmac('sha256', secret).update(email).digest('base64url');
};

export const handler = async (event) => {
  const { e: email = '', t: token = '' } = event.queryStringParameters ?? {};
  const expected = Buffer.from(await sign(email));
  const given = Buffer.from(token);
  if (!email || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return page(400, 'This unsubscribe link looks broken. Reply to any update email and Misha will take you off the list.');
  }

  if (event.requestContext.http.method !== 'POST') {
    return page(
      200,
      `Stop 77 to Starbase updates to <b>${esc(email)}</b>?`,
      `<form method="post"><button type="submit">Unsubscribe</button></form>`,
    );
  }
  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { email },
      UpdateExpression: 'SET subscribed = :f, unsubscribedAt = :now',
      ConditionExpression: 'attribute_exists(email)',
      ExpressionAttributeValues: { ':f': false, ':now': new Date().toISOString() },
    }),
  ).catch((err) => {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
  });
  return page(200, `Done. No more update emails to <b>${esc(email)}</b>.`, `<p>Changed your mind? Sign up again on the <a href="${SITE_URL}">site</a>.</p>`);
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const page = (statusCode, message, extra = '') => ({
  statusCode,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>77 to Starbase · updates</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #f2f2f2;
    font: 17px/1.5 system-ui, sans-serif; }
  main { max-width: 34rem; padding: 32px; }
  .mark { color: #e8622c; letter-spacing: 0.12em; font-size: 13px; text-transform: uppercase; }
  button { margin-top: 12px; font: inherit; padding: 10px 22px; background: #e8622c; color: #000; border: 0; cursor: pointer; }
  a { color: #e8622c; }
</style>
<main><p class="mark">★ 77 to Starbase</p><p>${message}</p>${extra}</main>`,
});
