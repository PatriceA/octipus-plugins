// The plugin's own tests: `npm test` in this directory (CI runs them on
// every pull request). They start the server over stdio as Octipus does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function start() {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  const call = (method, params = {}) => new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { call, stop: () => child.kill() };
}

test('lists the declared tools and greets', async () => {
  const s = start();
  try {
    const init = await s.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'my-plugin');
    const list = await s.call('tools/list');
    assert.deepEqual(list.result.tools.map((t) => t.name), ['hello']);
    const res = await s.call('tools/call', { name: 'hello', arguments: { name: 'Ada' } });
    assert.equal(res.result.content[0].text, 'Hello, Ada!');
    const bad = await s.call('tools/call', { name: 'hello', arguments: {} });
    assert.equal(bad.result.isError, true);
  } finally {
    s.stop();
  }
});
