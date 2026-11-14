/**
 * The MCP server object itself, shared by the hosted (HTTP + OAuth) entrypoint
 * and the local stdio one, so both expose the same tools and instructions.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KtClient } from '../kt/client.js';
import { registerTools } from './tools.js';

export const SERVER_INSTRUCTIONS =
  'Logs food into the user\'s kaloricketabulky.cz diary. The food database is Czech: search with Czech terms for the best matches. ' +
  'When the user gives a count rather than a weight ("3 eggs"), call get_food_portions and log a natural portion unit instead of estimating grams. ' +
  'Drinks, water included, are logged like food and count toward the day\'s drinking target. ' +
  'Body weight can be recorded with log_weight, but only when the user explicitly asks for the weight to be written.';

/** One configured server instance; the transport is attached by the entrypoint. */
export function createServer(kt: KtClient): McpServer {
  const server = new McpServer(
    { name: 'kaloricketabulky', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, kt);
  return server;
}
