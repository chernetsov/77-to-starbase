#!/usr/bin/env node
// Points @starbase77bot at the deployed webhook and sets its public profile. Safe to re-run after a deploy.
// Secrets stay in SSM: they are read and written through the AWS CLI's stdin/stdout, never on a command line.
//   node scripts/telegram-setup.mjs
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AWS = ['--profile', 'pronounce', '--region', 'us-east-1'];
const STACK = 'starbase-77';
const TOKEN_PARAM = '/starbase-77/telegram-token';
const SECRET_PARAM = '/starbase-77/telegram-webhook-secret';
const SITE = 'https://chernetsov.github.io/77-to-starbase/';

const aws = (args, input) => execFileSync('aws', [...args, ...AWS, '--output', 'text'], { input, encoding: 'utf8', stdio: 'pipe' }).trim();
const param = (name) => aws(['ssm', 'get-parameter', '--name', name, '--with-decryption', '--query', 'Parameter.Value']);

try {
  param(SECRET_PARAM);
} catch {
  const dir = mkdtempSync(join(tmpdir(), 'tg-'));
  const file = join(dir, 'param.json');
  try {
    const value = randomBytes(32).toString('base64url');
    writeFileSync(file, JSON.stringify({ Name: SECRET_PARAM, Type: 'SecureString', Value: value }), { mode: 0o600 });
    aws(['ssm', 'put-parameter', '--cli-input-json', `file://${file}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('created', SECRET_PARAM);
}
const token = param(TOKEN_PARAM);
const secret = param(SECRET_PARAM);
const webhook = aws(['cloudformation', 'describe-stacks', '--stack-name', STACK, '--query', "Stacks[0].Outputs[?OutputKey=='BotWebhook'].OutputValue"]);

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(method, json.ok ? 'ok' : json.description);
  if (!json.ok && method === 'setWebhook') process.exit(1);
}

await call('setWebhook', { url: webhook, secret_token: secret, allowed_updates: ['message'] });
await call('setMyName', { name: '77 to Starbase' });
await call('setMyShortDescription', {
  short_description: 'Friends-only road trips from Austin to Starship launches at Starbase, hosted by Misha.',
});
await call('setMyDescription', {
  description: [
    "Howdy! This is Misha's 77 to Starbase bot.",
    '',
    'We ride a Cybertruck from Austin down US Highway 77 to watch Starship launch from the beach. Trips run for every Starbase launch.',
    '',
    'Press Start to get launch-date changes, trip news and site updates here. Anything you write goes to Misha.',
  ].join('\n'),
});
await call('setMyCommands', {
  commands: [
    { command: 'start', description: 'Get trip and launch updates' },
    { command: 'site', description: 'Open the trip site' },
    { command: 'stop', description: 'Stop updates' },
  ],
});
await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Site', web_app: { url: SITE } } });
console.log('webhook', webhook);
