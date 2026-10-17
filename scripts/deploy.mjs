#!/usr/bin/env node
// Builds and deploys the infra/ SAM stack with the same AWS credentials as the other scripts (see lib/aws.mjs).
// Stack parameters default to the deployed stack's current values; set ALLOWED_ORIGIN or TELEGRAM_CHAT_ID to change
// them (both are required for a first deploy).
//   node scripts/deploy.mjs
import { execFileSync } from 'node:child_process';
import { REGION, STACK, stackParameter } from './lib/aws.mjs';

const current = (key) => stackParameter(key).catch(() => undefined);
const allowedOrigin = process.env.ALLOWED_ORIGIN ?? (await current('AllowedOrigin'));
const chatId = process.env.TELEGRAM_CHAT_ID ?? (await current('TelegramChatId'));
if (!allowedOrigin || !chatId) throw new Error('set ALLOWED_ORIGIN and TELEGRAM_CHAT_ID for the first deploy');

// Without a SAM CLI install, uv fetches and runs it.
const hasSam = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v sam'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const [bin, pre] = hasSam ? ['sam', []] : ['uvx', ['--from', 'aws-sam-cli', 'sam']];
const sam = (args) => execFileSync(bin, [...pre, ...args], { cwd: 'infra', stdio: 'inherit' });
sam(['build']);
sam([
  'deploy',
  '--region', REGION,
  '--stack-name', STACK,
  '--resolve-s3',
  '--capabilities', 'CAPABILITY_IAM',
  '--no-confirm-changeset',
  '--no-fail-on-empty-changeset',
  '--parameter-overrides', `AllowedOrigin=${allowedOrigin}`, `TelegramChatId=${chatId}`,
]);
