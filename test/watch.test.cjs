const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { columnOf, entry, lists, openFilesWorkspace } = require('./files-ui.cjs');

test('a column follows the machine without a refresh', { timeout: 180000 }, () => withWindow('wangcai-files-watch', lists, async ({ home, page, errors }) => {
  writeFileSync(join(home, 'sample.ts'), 'const first = 1;\n');
  await openFilesWorkspace(page);
  const directory = columnOf(page, home);
  await entry(directory, 'sample.ts').waitFor();
  const appeared = entry(directory, 'appeared.md');
  const renamed = entry(directory, 'renamed.md');
  await until(() => appeared.isVisible(), { act: () => writeFileSync(join(home, 'appeared.md'), '# appeared\n') });
  renameSync(join(home, 'appeared.md'), join(home, 'renamed.md'));
  await renamed.waitFor();
  await appeared.waitFor({ state: 'detached' });
  rmSync(join(home, 'renamed.md'));
  await renamed.waitFor({ state: 'detached' });
  // The directory the panel walks into is watched as well, not only the one it started at.
  mkdirSync(join(home, 'sub'));
  await entry(directory, 'sub/').click();
  const sub = columnOf(page, join(home, 'sub'));
  await until(() => entry(sub, 'deep.txt').isVisible(), { act: () => writeFileSync(join(home, 'sub', 'deep.txt'), 'deep\n') });
  assert.deepEqual(errors, []);
}));
