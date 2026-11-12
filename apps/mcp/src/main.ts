#!/usr/bin/env node
// stdio entry point. Configuration comes from the environment only:
//   FACTORY_API_URL    base URL of the factory API (required)
//   FACTORY_TOKEN      the developer's bearer token (required; never logged)
//   FACTORY_DASHBOARD_URL  optional, used to link inbox items
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FactoryClient } from '@factory/client';
import { createFactoryMcpServer } from './server.ts';

const baseUrl = process.env.FACTORY_API_URL;
const token = process.env.FACTORY_TOKEN;
if (!baseUrl || !token) {
  process.stderr.write('factory-mcp: FACTORY_API_URL and FACTORY_TOKEN are required\n');
  process.exit(2);
}
const dashboardUrl = process.env.FACTORY_DASHBOARD_URL;
const server = createFactoryMcpServer(new FactoryClient({ baseUrl, token: () => token }), dashboardUrl ? { dashboardUrl } : {});
await server.connect(new StdioServerTransport());
