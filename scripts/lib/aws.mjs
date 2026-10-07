// AWS CLI helpers for local scripts. Secrets pass through the CLI's stdout or a private temp file, never argv.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PROFILE = 'pronounce';
export const REGION = 'us-east-1';
export const STACK = 'starbase-77';
const AWS = ['--profile', PROFILE, '--region', REGION];

export const aws = (args) => execFileSync('aws', [...args, ...AWS, '--output', 'text'], { encoding: 'utf8', stdio: 'pipe' }).trim();

export const param = (name) => aws(['ssm', 'get-parameter', '--name', name, '--with-decryption', '--query', 'Parameter.Value']);

export function paramOrNull(name) {
  try {
    return param(name);
  } catch {
    return null;
  }
}

/** Returns the SecureString at `name`, creating it with a random value first if it doesn't exist. */
export function ensureSecret(name) {
  const existing = paramOrNull(name);
  if (existing) return existing;
  const dir = mkdtempSync(join(tmpdir(), 'ssm-'));
  const file = join(dir, 'param.json');
  try {
    writeFileSync(file, JSON.stringify({ Name: name, Type: 'SecureString', Value: randomBytes(32).toString('base64url') }), { mode: 0o600 });
    aws(['ssm', 'put-parameter', '--cli-input-json', `file://${file}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('created', name);
  return param(name);
}

export const stackOutput = (key) =>
  aws(['cloudformation', 'describe-stacks', '--stack-name', STACK, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`]);
