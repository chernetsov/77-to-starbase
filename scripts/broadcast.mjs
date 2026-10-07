#!/usr/bin/env node
// Sends an update to everyone following 77 to Starbase: Telegram subscribers of @starbase77bot, and email followers
// and seat requesters who aren't already reached on Telegram. Every real send is recorded in the broadcasts table.
//
//   node scripts/broadcast.mjs <draft.md>            preview: audience and rendered message, sends nothing
//   node scripts/broadcast.mjs <draft.md> --test     send to Misha only (Telegram and email), not recorded
//   node scripts/broadcast.mjs <draft.md> --send     send to everyone and record it
//   add --only telegram|email to limit the channels
//
// Draft format: the first line is the subject ("# " optional), the rest is the body. Blank lines split paragraphs;
// **bold** and [text](https://url) are the only markup.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import nodemailer from 'nodemailer';
import { PROFILE, REGION, ensureSecret, param, paramOrNull, stackOutput } from './lib/aws.mjs';

const OWNER_CHAT = '280121683';
const OWNER_EMAIL = 'chernetsov@gmail.com';
const SITE = 'https://chernetsov.github.io/77-to-starbase/';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only');
const mode = args.includes('--send') ? 'send' : args.includes('--test') ? 'test' : 'preview';
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
if (!file) {
  console.error('usage: node scripts/broadcast.mjs <draft.md> [--test | --send] [--only telegram|email]');
  process.exit(1);
}
const useTelegram = only !== 'email';
const useEmail = only !== 'telegram';

const [first, ...rest] = readFileSync(file, 'utf8').trim().split('\n');
const subject = first.replace(/^#\s*/, '').trim();
const body = rest.join('\n').trim();
if (!subject || !body) throw new Error('draft needs a subject line and a body');

process.env.AWS_PROFILE ??= PROFILE;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const tables = {
  signups: stackOutput('TableName'),
  users: stackOutput('BotUsersTableName'),
  broadcasts: stackOutput('BroadcastsTableName'),
};
const unsubscribeUrl = stackOutput('UnsubscribeUrl');
const unsubscribeKey = ensureSecret('/starbase-77/unsubscribe-secret');
const token = param('/starbase-77/telegram-token');
const gmailPassword = useEmail ? paramOrNull('/starbase-77/gmail-app-password') : null;

// ---- audience ----

async function scan(TableName) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await db.send(new ScanCommand({ TableName, ExclusiveStartKey }));
    items.push(...page.Items);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const users = (await scan(tables.users)).filter((u) => !u.chatId.startsWith('_'));
const signups = (await scan(tables.signups)).filter((s) => !s.email.startsWith('_'));
const tgChats = users.filter((u) => u.subscribed);
const tgSet = new Set(tgChats.map((u) => u.chatId));
const emailRows = signups.filter((s) => s.subscribed !== false && !tgSet.has(s.telegramChatId));
const skippedEmail = signups.filter((s) => s.subscribed !== false && tgSet.has(s.telegramChatId));

const telegramTo = !useTelegram ? [] : mode === 'test' ? [{ chatId: OWNER_CHAT, name: 'Misha (test)' }] : tgChats.map((u) => ({ chatId: u.chatId, name: who(u) }));
const emailTo = !useEmail ? [] : mode === 'test' ? [{ email: OWNER_EMAIL, name: 'Misha (test)' }] : emailRows.map((s) => ({ email: s.email, name: s.name ?? '' }));

// ---- rendering ----

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const inline = (s, linkAttrs = '') =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => `<a href="${u}"${linkAttrs}>${t}</a>`);
const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim());

const telegramText = `<b>${esc(subject)}</b>\n\n${paragraphs.map((p) => inline(p)).join('\n\n')}\n\n<i>Misha · /stop to unsubscribe</i>`;
if (telegramText.length > 4000) throw new Error(`Telegram message too long (${telegramText.length} chars, max ~4000)`);

const unsubLink = (email) => `${unsubscribeUrl}?e=${encodeURIComponent(email)}&t=${createHmac('sha256', unsubscribeKey).update(email).digest('base64url')}`;
const emailText = (email) =>
  [
    ...paragraphs.map((p) => p.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')),
    'Misha',
    '--',
    `77 to Starbase · ${SITE}`,
    `Unsubscribe: ${unsubLink(email)}`,
  ].join('\n\n');
const emailHtml = (email) => `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#ffffff;">
<div style="max-width:560px;margin:0 auto;font:16px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;">
<p style="margin:0 0 20px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#e8622c;">★ 77 to Starbase</p>
${paragraphs.map((p) => `<p style="margin:0 0 16px;">${inline(p, ' style="color:#e8622c;"').replace(/\n/g, '<br>')}</p>`).join('\n')}
<p style="margin:0 0 16px;">Misha</p>
<p style="margin:32px 0 0;font-size:12px;color:#777;"><a href="${SITE}" style="color:#777;">77 to Starbase</a> · You're getting this because you signed up on the site. <a href="${unsubLink(email)}" style="color:#777;">Unsubscribe</a></p>
</div></body></html>`;

// ---- preview ----

console.log(`\nSubject: ${subject}\nMode: ${mode}${only ? ` (${only} only)` : ''}\n`);
console.log(`Telegram (${telegramTo.length}): ${telegramTo.map((t) => t.name).join(', ') || '-'}`);
console.log(`Email (${emailTo.length}): ${emailTo.map((e) => e.email).join(', ') || '-'}`);
if (mode !== 'test' && skippedEmail.length) console.log(`  no email, reached on Telegram: ${skippedEmail.map((s) => s.email).join(', ')}`);
if (useEmail && !gmailPassword) console.log('  ! no Gmail app password in /starbase-77/gmail-app-password: email cannot be sent yet');
console.log(`\n--- Telegram ---\n${telegramText}\n\n--- Email (text) ---\n${emailText(emailTo[0]?.email ?? OWNER_EMAIL)}\n`);
writeFileSync('/tmp/77broadcast-preview.html', emailHtml(emailTo[0]?.email ?? OWNER_EMAIL));
console.log('Email HTML preview: /tmp/77broadcast-preview.html');
if (mode === 'preview') process.exit(0);
if (emailTo.length && !gmailPassword) throw new Error('email recipients but no Gmail app password; add it or pass --only telegram');

// ---- send ----

const id = new Date().toISOString();
const record = { id, subject, body, telegramText, status: 'sending', startedAt: id, results: [] };
if (mode === 'send') await db.send(new PutCommand({ TableName: tables.broadcasts, Item: record }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const t of telegramTo) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: t.chatId, text: telegramText, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const json = await res.json();
  record.results.push({ channel: 'telegram', to: t.chatId, name: t.name, ok: json.ok, ...(json.ok ? {} : { error: json.description }) });
  // 403: they blocked the bot, which is how Telegram users unsubscribe without /stop.
  if (res.status === 403 && mode === 'send') {
    await db.send(new UpdateCommand({
      TableName: tables.users,
      Key: { chatId: t.chatId },
      UpdateExpression: 'SET subscribed = :f, blockedAt = :now',
      ExpressionAttributeValues: { ':f': false, ':now': new Date().toISOString() },
    }));
  }
  await sleep(60);
}

if (emailTo.length) {
  const mail = nodemailer.createTransport({ service: 'gmail', auth: { user: OWNER_EMAIL, pass: gmailPassword } });
  for (const e of emailTo) {
    try {
      await mail.sendMail({
        from: { name: 'Misha · 77 to Starbase', address: OWNER_EMAIL },
        to: e.name ? { name: e.name, address: e.email } : e.email,
        subject,
        text: emailText(e.email),
        html: emailHtml(e.email),
        headers: { 'List-Unsubscribe': `<${unsubLink(e.email)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      record.results.push({ channel: 'email', to: e.email, ok: true });
    } catch (err) {
      record.results.push({ channel: 'email', to: e.email, ok: false, error: String(err.message ?? err) });
    }
    await sleep(1000);
  }
}

const count = (channel, ok) => record.results.filter((r) => r.channel === channel && r.ok === ok).length;
record.counts = {
  telegram: { sent: count('telegram', true), failed: count('telegram', false) },
  email: { sent: count('email', true), failed: count('email', false) },
};
record.status = 'sent';
record.finishedAt = new Date().toISOString();
if (mode === 'send') await db.send(new PutCommand({ TableName: tables.broadcasts, Item: record }));

console.log(`\n${mode === 'send' ? `Recorded broadcast ${id}` : 'Test sent (not recorded)'}:`, JSON.stringify(record.counts));
for (const r of record.results.filter((r) => !r.ok)) console.log(`  failed ${r.channel} ${r.to}: ${r.error}`);

function who(u) {
  return [u.firstName, u.lastName].filter(Boolean).join(' ') + (u.username ? ` @${u.username}` : '');
}
