import { createInterface } from 'node:readline';
import { callTool, ToolError, TOOL_DEFINITIONS } from './tools.mjs';

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

function handle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    send({ id: null, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  if (message.id === undefined) return;
  if (typeof message.id !== 'string' && !(typeof message.id === 'number' && Number.isFinite(message.id))) {
    send({ id: null, error: { code: -32600, message: 'Invalid request identifier' } });
    return;
  }
  const id = message.id;
  if (message.method === 'initialize') {
    send({ id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'text-toolkit', version: '0.1.0' } } });
  } else if (message.method === 'tools/list') {
    send({ id, result: { tools: TOOL_DEFINITIONS } });
  } else if (message.method === 'tools/call') {
    try {
      const result = callTool(message.params?.name, message.params?.arguments ?? {});
      send({ id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    } catch (error) {
      if (!(error instanceof ToolError)) console.error('Text toolkit execution failed:', error.name);
      send({ id, result: { isError: true, content: [{ type: 'text', text: error instanceof ToolError ? error.message : 'Text processing failed.' }] } });
    }
  } else if (message.method === 'ping') {
    send({ id, result: {} });
  } else {
    send({ id, error: { code: -32601, message: 'Method not found' } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  handle(message);
});
