/**
 * Smoke test for the local server: starts bin/kt-mcp-stdio over stdio, calls
 * get_day_summary and prints what came back. Used by bin/kt-mcp-login to check
 * the credentials it has just written, and handy on its own after changing them.
 *
 * Exit code 0 when the site answered, 1 when the tool reported an error.
 */

import { spawn } from 'node:child_process';

const entrypoint = process.argv[2];
if (!entrypoint) {
  console.error('usage: node scripts/check-login.mjs <path-to-kt-mcp-stdio>');
  process.exit(2);
}

const child = spawn(entrypoint, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';
let nextId = 0;
const pending = new Map();
const timer = setTimeout(() => {
  console.error('check-login: timed out');
  child.kill();
  process.exit(1);
}, 30_000);

child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const resolve = message.id !== undefined ? pending.get(message.id) : undefined;
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

function call(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 30_000);
  });
}

try {
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'login-check', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const response = await call('tools/call', { name: 'get_day_summary', arguments: {} });
  const result = response.result ?? {};
  const text = (result.content ?? []).map(part => part.text ?? '').join('\n');

  if (result.isError) {
    console.error(`Přihlášení neprošlo: ${text.replace(/^Error:\s*/, '')}`);
    process.exitCode = 1;
  } else {
    const summary = JSON.parse(text).summary ?? {};
    const energy = summary.energy ?? summary.energyTotal ?? summary.energyValue ?? null;
    const protein = summary.protein ?? summary.proteinTotal ?? summary.proteinValue ?? null;
    const energyUnit = summary.energyUnit ?? 'kcal';
    const parts = [];
    if (energy !== null) parts.push(`${energy} ${energyUnit}`);
    if (protein !== null) parts.push(`${protein} g bílkovin`);
    console.log(
      parts.length > 0
        ? `Přihlášení funguje. Dnes v deníku: ${parts.join(', ')}.`
        : 'Přihlášení funguje (deník odpověděl, dnešní součty jsou prázdné).',
    );
  }
} catch (error) {
  console.error(`Kontrola selhala: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  child.kill();
}
