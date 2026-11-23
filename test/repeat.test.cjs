const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { columnOf, columnRow, columns, cursor, entry, held, lists, names, openFilesWorkspace } = require('./files-ui.cjs');

test('a held `j`, `k` or arrow walks on with every repeat, and the other keys stay single', { timeout: 180000 }, () => withWindow('wangcai-repeat', lists, async ({ home, page, errors }) => {
  writeFileSync(join(home, 'alpha.md'), 'a\n');
  writeFileSync(join(home, 'beta.md'), 'b\n');
  writeFileSync(join(home, 'omega.md'), 'o\n');
  await openFilesWorkspace(page);
  const directory = columnOf(page, home);
  await entry(directory, 'omega.md').waitFor();
  await until(async () => (await cursor(page).count()) === 1);
  const listed = await names(directory);
  // The driver's presses are single ones, so the repeat the system would send for a held key is made here.
  const again = (key) => columnRow(page).evaluate((pane, key) => {
    pane.dispatchEvent(new KeyboardEvent('keydown', { key, repeat: true, bubbles: true }));
  }, key);
  assert.deepEqual(await held(page), [listed[0], home]);
  await again('j');
  assert.deepEqual(await held(page), [listed[1], home]);
  await again('j');
  assert.deepEqual(await held(page), [listed[2], home]);
  for (let step = 0; step < listed.length + 2; step += 1) await again('j');
  assert.deepEqual(await held(page), [listed.at(-1), home]);
  await again('ArrowUp');
  assert.deepEqual(await held(page), [listed.at(-2), home]);
  await again('k');
  assert.deepEqual(await held(page), [listed.at(-3), home]);
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  const opened = await columns(page).count();
  await again('l');
  assert.equal(await columns(page).count(), opened, 'a held `l` opened no column');
  await page.keyboard.press('G');
  await again('d');
  await page.waitForTimeout(300);
  assert.ok(!existsSync(join(home, 'Downloads')), 'a held `d` downloaded nothing');
  // With the box open the panel binds the `insert` set alone, so the column keys no longer answer.
  await page.keyboard.press('/');
  await page.locator('.file-search input').waitFor();
  const openedOn = await held(page);
  await again('j');
  assert.deepEqual(await held(page), openedOn);
  await page.keyboard.press('Escape');
  await page.locator('.file-search').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
}));