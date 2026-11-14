/**
 * Local stdio entrypoint: the same tools as the hosted server, without HTTP,
 * OAuth or a tunnel. OpenCode (or any MCP client that launches commands) starts
 * this per session with KT_EMAIL and KT_PASSWORD in the environment.
 *
 * This is a local addition to the upstream project, which only ships the
 * hosted HTTP + OAuth entrypoint (`src/index.ts`). Secrets belong in
 * ~/.config/kt-mcp/env, which `bin/kt-mcp-stdio` sources before starting us.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { KtClient } from './kt/client.js';
import { createServer } from './mcp/server.js';

// stdout is the MCP transport. The tool guard and the HTTP entrypoint log with
// console.log, which would corrupt the stream here, so send it to stderr.
console.log = console.error;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name} (see ~/.config/kt-mcp/env)`);
  }
  return value;
}

const kt = new KtClient({ email: required('KT_EMAIL'), password: required('KT_PASSWORD') });
const server = createServer(kt);

// stdout carries the MCP protocol, so anything else must go to stderr.
console.error('[kt-mcp] starting on stdio');
await server.connect(new StdioServerTransport());
