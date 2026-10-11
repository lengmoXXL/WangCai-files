const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { activate } = require('../main.cjs');

test('navigation histories persist across plugin activations and removals', () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'wangcai-files-history-'));
  const handlers = new Map();
  const context = {
    host: { dataDirectory },
    ui: { handle(method, handler) { handlers.set(method, handler); return () => handlers.delete(method); } },
  };
  let dispose = activate(context);
  try {
    assert.deepEqual(handlers.get('history')(), {});
    const file = { type: 'file', machine: { id: 'local', name: 'local' }, path: '/work/file.ts', line: 2, column: 3 };
    const directory = { type: 'directory', machine: { id: 'remote', name: 'remote', host: 'example.com' }, path: '/work' };
    const histories = {
      '': { entries: [file, directory], index: 0 },
      workspace: { entries: [directory], index: 0 },
    };
    handlers.get('save-history')(histories);
    dispose();
    assert.equal(handlers.size, 0);
    dispose = activate(context);
    assert.deepEqual(handlers.get('history')(), histories);
    delete histories.workspace;
    handlers.get('save-history')(histories);
    dispose();
    dispose = activate(context);
    assert.deepEqual(handlers.get('history')(), histories);
    handlers.get('save-history')({});
    dispose();
    dispose = activate(context);
    assert.deepEqual(handlers.get('history')(), {});
  } finally {
    dispose();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
