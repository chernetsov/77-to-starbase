#!/usr/bin/env node
// Points @starbase77bot at the deployed webhook and sets its public profile. Safe to re-run after a deploy.
//   node scripts/telegram-setup.mjs
import { ensureSecret, param, stackOutput } from './lib/aws.mjs';

const SITE = 'https://chernetsov.github.io/77-to-starbase/';

const secret = ensureSecret('/starbase-77/telegram-webhook-secret');
const token = param('/starbase-77/telegram-token');
const webhook = stackOutput('BotWebhook');

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
