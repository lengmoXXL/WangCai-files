const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { columnOf, cursor, entry, label, lists, openFilesWorkspace, shownPanel } = require('./files-ui.cjs');

test('a file is copied into the local Downloads from the cursor key or the right-click menu', { timeout: 180000 }, () => withWindow('wangcai-download', lists, async ({ home, page, errors }) => {
  mkdirSync(join(home, 'sub'));
  writeFileSync(join(home, 'alpha.md'), 'a\n');
  writeFileSync(join(home, 'note.md'), '# Note\n');
  await openFilesWorkspace(page);
  const directory = columnOf(page, home);
  await entry(directory, 'note.md').waitFor();
  const downloads = join(home, 'Downloads');
  // The cursor starts on the deepest column's first entry, which is the directory here, and a directory is not downloaded.
  await until(async () => (await cursor(page).count()) === 1);
  assert.equal(await label(cursor(page)).innerText(), '.config/');
  await page.keyboard.press('d');
  await page.keyboard.press('j');
  await page.keyboard.press('G');
  assert.equal(await label(cursor(page)).innerText(), 'note.md');
  await page.keyboard.press('d');
  await until(() => existsSync(join(downloads, 'note.md')));
  assert.deepEqual(readdirSync(downloads).sort(), ['note.md'], 'the directory under the cursor copied nothing');
  assert.equal(readFileSync(join(downloads, 'note.md'), 'utf8'), '# Note\n');
  // The name a download lands under is free by being numbered, so the file already there is left as it was.
  await page.keyboard.press('d');
  await until(() => existsSync(join(downloads, 'note-1.md')));
  assert.deepEqual(readdirSync(downloads).sort(), ['note-1.md', 'note.md']);
  assert.equal(readFileSync(join(downloads, 'note.md'), 'utf8'), '# Note\n');
  // A right-click holds the row it landed on and offers the same download.
  await entry(directory, 'alpha.md').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await menu.waitFor();
  assert.equal(await label(cursor(page)).innerText(), 'alpha.md');
  await page.screenshot({ path: 'test/output/screenshots/file-menu.png' });
  await menu.getByRole('menuitem', { name: '下载到 Downloads' }).click();
  await until(() => existsSync(join(downloads, 'alpha.md')));
  await menu.waitFor({ state: 'detached' });
  assert.equal(readFileSync(join(downloads, 'alpha.md'), 'utf8'), 'a\n');
  // A directory has nothing to take out of the machine, so its right-click opens no menu.
  await page.keyboard.press('Escape');
  await entry(directory, 'sub/').click({ button: 'right' });
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.deepEqual(await shownPanel(page).getByRole('alert').count(), 0, 'a download that worked says so rather than alarming');
  assert.deepEqual(errors, []);
}));