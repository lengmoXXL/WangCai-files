const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');
const { withWindow } = require('@lengmoxxl/wangcai-testkit');
const { basePath, columnOf, columns, entry, held, lists, openFilesWorkspace, resetBase } = require('./files-ui.cjs');

test('the path bar names the base path, `h` raises it above the workspace, and the button puts it back', { timeout: 180000 }, () => withWindow('wangcai-base', lists, async ({ home, page, errors }) => {
  mkdirSync(join(home, 'sub'));
  await openFilesWorkspace(page);
  const directory = columnOf(page, home);
  await entry(directory, 'sub/').waitFor();
  const above = dirname(home);
  assert.equal(await basePath(page).innerText(), home, 'the workspace is the base until something else is asked for');
  assert.equal(await resetBase(page).isDisabled(), true);
  assert.equal(await columns(page).count(), 1);
  // The top column is where climbing used to stop, so `h` there raises the base and takes the view with it.
  await page.keyboard.press('h');
  const raised = columnOf(page, above);
  await raised.waitFor();
  assert.equal(await basePath(page).innerText(), above);
  assert.equal(await columns(page).count(), 1, 'the view went up a level rather than growing a column');
  assert.deepEqual(await held(page), [`${basename(home)}/`, above], 'the cursor holds what it left');
  // Going down again keeps the raised base as the first column.
  await page.keyboard.press('l');
  await columnOf(page, home).waitFor();
  assert.equal(await columns(page).count(), 2);
  assert.equal(await basePath(page).innerText(), above);
  await page.screenshot({ path: 'test/output/screenshots/base-path.png' });
  // The button drops the columns above the workspace with the base it resets.
  await resetBase(page).click();
  await raised.waitFor({ state: 'detached' });
  assert.equal(await basePath(page).innerText(), home);
  assert.equal(await columns(page).count(), 1);
  assert.equal(await resetBase(page).isDisabled(), true);
  assert.deepEqual(errors, []);
}));