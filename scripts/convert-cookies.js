#!/usr/bin/env node
/**
 * Convert Chrome cookies JSON to Playwright state format
 * Usage: node convert-cookies.js cookies.json output-state.json
 */

const fs = require('fs');

const cookiesFile = process.argv[2];
const outputFile = process.argv[3];

if (!cookiesFile || !outputFile) {
  console.error('Usage: node convert-cookies.js <cookies.json> <output-state.json>');
  process.exit(1);
}

const cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf-8'));

// Convert Chrome cookies to Playwright format
const playwrightCookies = cookies.map(c => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path || '/',
  expires: c.expirationDate ? c.expirationDate : -1,
  httpOnly: c.httpOnly || false,
  secure: c.secure || false,
  sameSite: c.sameSite || 'Lax'
}));

const state = {
  cookies: playwrightCookies,
  origins: []
};

fs.writeFileSync(outputFile, JSON.stringify(state, null, 2));
console.log(`✓ Converted ${playwrightCookies.length} cookies to ${outputFile}`);
