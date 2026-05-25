#!/usr/bin/env node
// Exchanges a short-lived Instagram token for a long-lived one (60 days).
// Usage: node exchange-token.js
// Reads credentials from .env in the same directory.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const dir = dirname(fileURLToPath(import.meta.url));

const env = {};
readFileSync(join(dir, '.env'), 'utf8').split('\n').forEach(line => {
  line = line.trim();
  if (line && !line.startsWith('#') && line.includes('=')) {
    const [k, ...v] = line.split('=');
    env[k.trim()] = v.join('=').trim();
  }
});

const igAppId     = env.INSTAGRAM_APP_ID   || env.META_APP_ID;
const igAppSecret = env.INSTAGRAM_APP_SECRET || env.META_APP_SECRET;
const token       = env.INSTAGRAM_KODA_TOKEN;

if (!igAppId || !igAppSecret || !token) {
  console.error('Missing app credentials or INSTAGRAM_KODA_TOKEN in .env');
  process.exit(1);
}

console.log(`Token length: ${token.length}`);
console.log(`Starts with:  ${token.slice(0, 12)}...`);
console.log('');

const url = `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_id=${igAppId}&client_secret=${igAppSecret}&access_token=${token}`;

const res  = await fetch(url);
const data = await res.json();

if (data.error) {
  console.error('Exchange failed:', JSON.stringify(data.error, null, 2));
  process.exit(1);
}

console.log('Long-lived token:');
console.log(data.access_token);
console.log('');
console.log(`Expires in: ${Math.round(data.expires_in / 86400)} days`);
console.log('');
console.log('Paste this into INSTAGRAM_KODA_TOKEN in your .env');
