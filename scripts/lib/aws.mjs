// AWS access for local scripts. Credentials come from the standard AWS chain: either AWS_PROFILE (put it in the
// gitignored .env, see .env.example) or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment.
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

if (existsSync('.env')) process.loadEnvFile('.env');

export const REGION = process.env.AWS_REGION ?? 'us-east-1';
export const STACK = process.env.STACK_NAME ?? 'starbase-77';

const ssm = new SSMClient({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });

export async function param(name) {
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  return res.Parameter.Value;
}

export async function paramOrNull(name) {
  try {
    return await param(name);
  } catch (err) {
    if (err.name === 'ParameterNotFound') return null;
    throw err;
  }
}

/** Returns the SecureString at `name`, creating it with a random value first if it doesn't exist. */
export async function ensureSecret(name) {
  const existing = await paramOrNull(name);
  if (existing) return existing;
  const value = randomBytes(32).toString('base64url');
  await ssm.send(new PutParameterCommand({ Name: name, Type: 'SecureString', Value: value }));
  console.log('created', name);
  return value;
}

let stack;
async function describeStack() {
  stack ??= (await cfn.send(new DescribeStacksCommand({ StackName: STACK }))).Stacks[0];
  return stack;
}

export async function stackOutput(key) {
  return (await describeStack()).Outputs.find((o) => o.OutputKey === key)?.OutputValue;
}

export async function stackParameter(key) {
  return (await describeStack()).Parameters.find((p) => p.ParameterKey === key)?.ParameterValue;
}
