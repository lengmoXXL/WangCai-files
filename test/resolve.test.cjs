const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activate } = require('../main.cjs');

test('address resolution uses the requested machine and directory, and releases connections', async () => {
  const machine = { id: 'remote', name: 'remote', host: 'example.com' };
  const handlers = new Map();
  const paths = [];
  let disconnected = 0;
  const dispose = activate({
    host: { dataDirectory: __dirname },
    ui: { handle(method, handler) { handlers.set(method, handler); return () => handlers.delete(method); } },
    async connect(target, signal) {
      assert.equal(target, machine);
      assert.ok(!signal.aborted);
      return {
        pty: { async cwd(sessionId) { assert.equal(sessionId, 'session'); return '/work'; } },
        fs: { async stat(path) {
          paths.push(path);
          return path === '/work/missing' ? null : { isDirectory: path === '/work' };
        } },
        disconnect() { disconnected++; },
      };
    },
  });
  try {
    const resolve = handlers.get('resolve');
    assert.deepEqual(await resolve({ machine, path: '../file.md', base: '/work/src' }),
      { type: 'file', machine, path: '/work/file.md' });
    assert.deepEqual(await resolve({ machine, path: '/work/notes with spaces.md', base: '/elsewhere' }),
      { type: 'file', machine, path: '/work/notes with spaces.md' });
    assert.deepEqual(await resolve({ machine, path: '..', base: '/work/src' }),
      { type: 'directory', machine, path: '/work' });
    assert.deepEqual(await resolve({ machine, sessionId: 'session' }),
      { type: 'directory', machine, path: '/work' });
    await assert.rejects(resolve({ machine, path: 'missing', base: '/work' }),
      (error) => error.message.includes('/work/missing'));
    assert.deepEqual(paths, ['/work/file.md', '/work/notes with spaces.md', '/work', '/work', '/work/missing']);
    assert.equal(disconnected, 5);
  } finally {
    dispose();
  }
  assert.equal(handlers.size, 0);
});
