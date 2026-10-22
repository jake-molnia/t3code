import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Session, privateLog, mcpReady } from './session.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 't3-session-test-'));
  const session = new Session({ cwd: directory, env: process.env, graceMs: 20 });
  t.after(async () => { await session.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, session };
}

test('an essential process exit stops the worker process group', { timeout: 10000 }, async (t) => {
  const { session } = await fixture(t);
  const worker = session.start(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { output: () => {} });
  await once(worker.child.stdout, 'data');
  session.start(process.execPath, ['-e', 'process.exit(17)']);
  await session.done;
  const exit = await worker.exited;
  assert.equal(exit.signal, 'SIGTERM');
  assert.match(session.failure.message, /17/);
});

test('a restartable browser exits and restarts without stopping the worker', { timeout: 10000 }, async (t) => {
  const { directory, session } = await fixture(t);
  const program = join(directory, 'browser.mjs');
  await writeFile(program, `import { existsSync, writeFileSync } from 'node:fs';
    if (!existsSync('profile')) { writeFileSync('profile', 'saved'); process.exit(0); }
    process.stdout.write('restarted'); setInterval(() => {}, 1000);`);
  let notify;
  const restarted = new Promise((resolve) => { notify = resolve; });
  const loop = session.restart(process.execPath, [program], { restartMs: 1, output: (data) => notify(data.toString()) });
  assert.equal(await restarted, 'restarted');
  assert.equal(await readFile(join(directory, 'profile'), 'utf8'), 'saved');
  assert.equal(session.abort.signal.aborted, false);
  await session.stop();
  await loop;
});

test('shutdown escalates for a child which ignores SIGTERM', { timeout: 10000 }, async (t) => {
  const { session } = await fixture(t);
  const child = session.start(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'], { output: () => {} });
  await once(child.child.stdout, 'data');
  await session.stop();
  assert.equal((await child.exited).signal, 'SIGKILL');
  assert.equal(session.failure, undefined);
});

test('private IDE diagnostics rotate without leaking or growing unbounded', { timeout: 10000 }, async (t) => {
  const { directory } = await fixture(t);
  const path = join(directory, 'ide.log');
  const log = privateLog(path, 8);
  log(Buffer.from('abcdefghijklmnopqrst'));
  assert.equal(await readFile(path, 'utf8'), 'qrst');
  assert.equal(await readFile(`${path}.1`, 'utf8'), 'ijklmnop');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('a missing essential executable fails the session', { timeout: 10000 }, async (t) => {
  const { session } = await fixture(t);
  session.start('/does-not-exist-t3-session-test');
  await session.done;
  assert.equal(session.failure.code, 'ENOENT');
});


test('MCP readiness negotiates protocol, reads paginated SSE tools, and closes its session', { timeout: 10000 }, async (t) => {
  const methods = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') {
      methods.push('DELETE');
      assert.equal(request.headers['mcp-session-id'], 'test-session');
      response.writeHead(204).end(); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    methods.push(message.method);
    if (message.method !== 'initialize') {
      assert.equal(request.headers['mcp-session-id'], 'test-session');
      assert.equal(request.headers['mcp-protocol-version'], '2025-03-26');
    }
    if (!message.id) { response.writeHead(202).end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26' }
      : message.params.cursor ? { tools: [{ name: 'second' }] }
      : { tools: [{ name: 'first' }], nextCursor: 'page2' };
    response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'test-session' });
    response.write('data: {"jsonrpc":"2.0","method":"notifications/ignored"}\r\n\r\n');
    response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\r\n\r\n`);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await mcpReady(`http://127.0.0.1:${server.address().port}/mcp`, ['first', 'second']);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
});
