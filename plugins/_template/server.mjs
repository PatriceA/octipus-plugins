// A minimal Octipus plugin server: MCP over stdio, JSON-RPC, no dependencies.
//
// Copy this directory to plugins/<your-name>/, rename the plugin in
// octipus-plugin.json (the directory and the manifest name must match), and
// replace the hello tool with yours. Every tool the server offers must be
// declared in the manifest with its effect (read, write or external).
//
// Keep runtime state in OCTIPUS_PLUGIN_DATA_DIR: the package directory is
// read-only under the sandbox.
import { createInterface } from 'node:readline';

const VERSION = '0.1.0';

const TOOLS = [
  {
    name: 'hello',
    description: 'Greet someone by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Who to greet', maxLength: 100 } },
      required: ['name'],
    },
  },
];

class ToolError extends Error {}

function hello(args) {
  const name = typeof args.name === 'string' ? args.name.trim().slice(0, 100) : '';
  if (!name) throw new ToolError('name is required');
  return `Hello, ${name}!`;
}

const HANDLERS = { hello };

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

async function callTool(params) {
  const handler = Object.hasOwn(HANDLERS, params?.name) ? HANDLERS[params.name] : null;
  if (!handler) return { isError: true, ...text(`Unknown tool ${params?.name}`) };
  try {
    return text(await handler(params.arguments ?? {}));
  } catch (err) {
    if (err instanceof ToolError) return { isError: true, ...text(err.message) };
    return { isError: true, ...text(`The tool failed: ${err?.message ?? String(err)}`) };
  }
}

export function onMessage(msg) {
  if (msg.id === undefined || msg.id === null) return; // a notification
  switch (msg.method) {
    case 'initialize':
      send({ id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'my-plugin', version: VERSION } } });
      return;
    case 'tools/list':
      send({ id: msg.id, result: { tools: TOOLS } });
      return;
    case 'tools/call':
      callTool(msg.params).then((result) => send({ id: msg.id, result }));
      return;
    case 'ping':
      send({ id: msg.id, result: {} });
      return;
    default:
      send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  try {
    onMessage(JSON.parse(line));
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
});
