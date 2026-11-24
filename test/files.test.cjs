const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { alert, clickFile, codeView, columnOf, columns, cursor, editorTab, emptyDirectory, entry, filesPanels, filesTab, held, lists, machine, openFilesWorkspace, revealFile, shownPanel, waitForPath } = require('./files-ui.cjs');

test('a directory opens a column of its own, and a file is handed to the editor instead of being read here', { timeout: 180000 }, () => withWindow('wangcai-files', lists, async ({ home, page, errors }) => {
  mkdirSync(join(home, 'sub/empty'), { recursive: true });
  writeFileSync(join(home, 'sample.ts'), 'const first = 1;\n');
  writeFileSync(join(home, 'sub/inside.md'), '# Inside\n');
  await openFilesWorkspace(page);
  // The tab's root is the columns alone; the path bar sits inside them, above the columns.
  assert.deepEqual(await filesPanels(page).locator('.file-browser').evaluate((element) => [...element.children].map((child) => child.className)), ['file-columns']);
  const directory = columnOf(page, home);
  await entry(directory, 'sub/').click();
  const subColumn = columnOf(page, join(home, 'sub'));
  await subColumn.waitFor();
  await entry(subColumn, 'inside.md').waitFor();
  assert.equal(await columns(page).count(), 2, 'a directory below the workspace gets a column of its own');
  // A file is the editor's: the click opens its tab, and this panel keeps the columns it had.
  await entry(directory, 'sample.ts').click();
  await editorTab(page).waitFor();
  await codeView(shownPanel(page), 'const first = 1;').waitFor();
  await waitForPath(page, join(home, 'sample.ts'));
  assert.equal(await columns(page).count(), 2);
  await page.screenshot({ path: 'test/output/screenshots/files-editor.png' });
  // A file link lands in the editor too.
  await clickFile(page, { type: 'file', machine, path: join(home, 'sub/inside.md') });
  await codeView(shownPanel(page), '# Inside').waitFor();
  // A directory link is shown here, and one the panel is not showing yet is what proves it: a level below `sub` puts a
  // column of its own on screen.
  mkdirSync(join(home, 'sub/deep'));
  await clickFile(page, { type: 'directory', machine, path: join(home, 'sub/deep') });
  const deepColumn = columnOf(page, join(home, 'sub/deep'));
  await deepColumn.waitFor();
  assert.equal(await columns(page).count(), 3, 'the link opened a column the panel was not showing');
  // Nothing here reads a file, so a path that cannot be read is the editor's message to show; this panel stays on its
  // columns.
  writeFileSync(join(home, 'binary.bin'), Buffer.from([0, 1, 255, 2]));
  await clickFile(page, { type: 'file', machine, path: join(home, 'binary.bin') });
  await alert(page).filter({ hasText: '暂不支持二进制' }).waitFor();
  assert.equal(await columns(page).count(), 3);
  // The editor has the sidebar at this point, so it is given back before a column is clicked again.
  await filesTab(page).click();
  await entry(subColumn, 'empty/').click();
  // The chain is now home, sub and empty, so the column of the sibling walked into before it is gone.
  await deepColumn.waitFor({ state: 'detached' });
  // An empty directory says so rather than showing nothing at all.
  await emptyDirectory(page).waitFor();
  await page.screenshot({ path: 'test/output/screenshots/files-columns.png' });
  assert.deepEqual(errors, []);
}));
test('a reveal seats the file it names, wherever the cursor was', { timeout: 180000 }, () => withWindow('wangcai-files-reveal', lists, async ({ home, page, errors }) => {
  mkdirSync(join(home, 'sub'), { recursive: true });
  writeFileSync(join(home, 'alpha.md'), 'a\n');
  writeFileSync(join(home, 'omega.md'), 'o\n');
  writeFileSync(join(home, 'sub/inside.md'), '# Inside\n');
  writeFileSync(join(home, 'sub/other.md'), '# Other\n');
  await openFilesWorkspace(page);
  const directory = columnOf(page, home);
  await entry(directory, 'omega.md').waitFor();
  await until(async () => (await cursor(page).count()) === 1);
  // The cursor starts on the first entry; a reveal of another file in the same column moves it onto that file.
  await revealFile(page, { type: 'file', machine, path: join(home, 'omega.md') });
  await until(async () => (await held(page))[0] === 'omega.md');
  // A reveal into another directory seats the file there once its column is read, not the column's first entry.
  await revealFile(page, { type: 'file', machine, path: join(home, 'sub/other.md') });
  await columnOf(page, join(home, 'sub')).waitFor();
  await until(async () => (await held(page))[0] === 'other.md');
  assert.deepEqual(await held(page), ['other.md', join(home, 'sub')]);
  // Moving off it and revealing it again seats it again.
  await page.keyboard.press('k');
  assert.deepEqual(await held(page), ['inside.md', join(home, 'sub')]);
  await revealFile(page, { type: 'file', machine, path: join(home, 'sub/other.md') });
  await until(async () => (await held(page))[0] === 'other.md');
  assert.deepEqual(errors, []);
}));
