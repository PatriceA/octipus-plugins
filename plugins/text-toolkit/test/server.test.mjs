import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeText, normalizeWhitespace, ToolError } from '../tools.mjs';

test('analysis counts Unicode characters and mixed line endings', () => {
  assert.deepEqual(analyzeText({ text: '' }), { words: 0, characters: 0, lines: 0, readingTimeSeconds: 0 });
  assert.equal(analyzeText({ text: '👨‍👩‍👧‍👦' }).characters, 1);
  assert.equal(analyzeText({ text: 'e\u0301' }).characters, 1);
  const result = analyzeText({ text: 'Hello world.\r\nMeet Octipus.\n' });
  assert.equal(result.words, 4);
  assert.equal(result.lines, 3);
  assert.equal(result.readingTimeSeconds, 2);
});

test('reading time is explicitly an estimate at 200 words a minute', () => {
  assert.equal(analyzeText({ text: Array(200).fill('word').join(' ') }).readingTimeSeconds, 60);
});

test('cleanup preserves indentation and paragraph boundaries', () => {
  const text = '\r\n  First  \r\n\r\n\r\n\tSecond\t\r\n';
  assert.deepEqual(normalizeWhitespace({ text }), { text: '  First\n\n\tSecond', changed: true });
  assert.deepEqual(normalizeWhitespace({ text: '  unchanged' }), { text: '  unchanged', changed: false });
  assert.deepEqual(normalizeWhitespace({ text: 'a\n\n\nb', collapseBlankLines: false }), { text: 'a\n\n\nb', changed: false });
  assert.deepEqual(normalizeWhitespace({ text: ' \t\r\n' }), { text: '', changed: true });
});

test('invalid inputs and oversized text fail without echoing user content', () => {
  for (const handler of [analyzeText, normalizeWhitespace]) {
    for (const args of [null, [], {}, { text: 4 }, { text: 'private-canary', unexpected: true }, { text: 'x'.repeat(100_001) }]) {
      assert.throws(() => handler(args), (error) => error instanceof ToolError && !error.message.includes('private-canary'));
    }
  }
  assert.throws(() => normalizeWhitespace({ text: 'valid', collapseBlankLines: 'yes' }), /true or false/);
});

function start() {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let id = 0;
  const fail = (error) => { for (const pending of waiting.values()) pending.reject(error); waiting.clear(); };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Plugin server exited')));
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    const pending = waiting.get(message.id);
    if (pending) { waiting.delete(message.id); pending.resolve(message); }
  });
  return {
    call: (method, params = {}) => new Promise((resolve, reject) => {
      id++;
      waiting.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    }),
    stop: () => child.kill(),
  };
}

test('real stdio MCP transport exposes exactly the declared tools and handles errors', { timeout: 5000 }, async () => {
  const server = start();
  try {
    const manifest = JSON.parse(readFileSync(new URL('../octipus-plugin.json', import.meta.url), 'utf8'));
    const init = await server.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, manifest.name);
    assert.equal(init.result.serverInfo.version, manifest.version);
    const listed = (await server.call('tools/list')).result.tools;
    assert.deepEqual(listed.map((tool) => tool.name).sort(), Object.keys(manifest.tools).sort());
    assert.deepEqual((await server.call('ping')).result, {});
    assert.equal((await server.call('unknown')).error.code, -32601);
    const analysis = await server.call('tools/call', { name: 'analyze_text', arguments: { text: 'Hello Octipus' } });
    assert.equal(JSON.parse(analysis.result.content[0].text).words, 2);
    const cleaned = await server.call('tools/call', { name: 'normalize_whitespace', arguments: { text: 'Text  \r\n' } });
    assert.equal(JSON.parse(cleaned.result.content[0].text).text, 'Text');
    for (const params of [{ name: 'analyze_text', arguments: {} }, { name: 'constructor', arguments: {} }, { name: 'normalize_whitespace', arguments: [] }]) {
      assert.equal((await server.call('tools/call', params)).result.isError, true);
    }
    assert.equal((await server.call('ping')).result.constructor, Object);
  } finally { server.stop(); }
});
