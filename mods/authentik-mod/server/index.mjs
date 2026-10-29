#!/usr/bin/env node
// authentik MCP server over stdio. stdout is the protocol channel: log only to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.mjs';
import { makeClient } from './client.mjs';
import { makeAudit } from './safety.mjs';
import { buildRegistry } from './tools.mjs';

const cfg = loadConfig();
if (cfg.problems.length) {
  console.error(`authentik-mod: cannot start.\n- ${cfg.problems.join('\n- ')}\nSet them with /plugin configure authentik-mod@claude-code-linux.`);
  process.exit(1);
}

const server = new McpServer({ name: 'authentik', version: "0.1.1" });
const count = buildRegistry(cfg).register(server, cfg, { api: makeClient(cfg), audit: makeAudit(cfg.dataDir), cfg });
console.error(`authentik-mod: ${count} tools for ${cfg.url}${cfg.readOnly ? ' (read-only)' : ''}`);
await server.connect(new StdioServerTransport());
