const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { columnOf, columnRow, columns, cursor, entry, held, lists, names, openFilesWorkspace, resizeHandle, searchBox, searchCount, searchField, shownPanel, width } = require('./files-ui.cjs');

test('the keys walk the columns and the search jumps across them, and a drag widens a column', { timeout: 180000 }, () => withWindow('wangcai-keys', lists, async ({ home, page, errors }) => {
  mkdirSync(join(home, 'sub/deep'), { recursive: true });
  writeFileSync(join(home, 'sub/inside.md'), '# Inside\n');
  writeFileSync(join(home, 'alpha.md'), 'a\n');
  writeFileSync(join(home, 'omega.md'), 'o\n');
  await openFilesWorkspace(page);
  const directory = columnOf(page, home);
  await entry(directory, 'alpha.md').waitFor();
  const search = async (query) => {
    await page.keyboard.press('/');
    await searchField(page).waitFor();
    await page.keyboard.type(query);
  };
  const closeSearch = async () => {
    await page.keyboard.press('Enter');
    await searchBox(page).waitFor({ state: 'detached' });
  };
  const enter = async (path) => {
    await page.keyboard.press('l');
    const column = columnOf(page, path);
    await column.waitFor();
    return column;
  };
  // The deepest column holds the cursor as soon as its listing is in, so the keys move before anything is clicked.
  await until(async () => (await cursor(page).count()) === 1);
  const listed = await names(directory);
  assert.deepEqual(await held(page), [listed[0], home]);
  await page.keyboard.press('j');
  assert.deepEqual(await held(page), [listed[1], home]);
  await page.keyboard.press('k');
  assert.deepEqual(await held(page), [listed[0], home]);
  // `/` opens a box over the top right of the panel, and what it holds picks its match as it is typed.
  await search('sub');
  const box = await searchBox(page).boundingBox();
  const row = await columnRow(page).boundingBox();
  const panel = await shownPanel(page).boundingBox();
  assert.equal(Math.round(row.y), Math.round(panel.y), 'the columns still start at the panel top');
  assert.ok(box.x > panel.x + panel.width / 2 && box.x + box.width <= panel.x + panel.width, 'the box is over the right of the columns');
  assert.ok(box.y - row.y < row.height / 2, 'the box is over the top of the columns');
  await until(async () => (await held(page))[0] === 'sub/');
  await closeSearch();
  // `l` goes down a level and the cursor goes with it, while `h` comes back up onto the directory it left.
  const sub = await enter(join(home, 'sub'));
  await until(async () => (await held(page))[0] === 'deep/');
  assert.deepEqual(await held(page), ['deep/', join(home, 'sub')]);
  await page.keyboard.press('h');
  await sub.waitFor({ state: 'detached' });
  assert.deepEqual(await held(page), ['sub/', home]);
  // A query looks through every column on screen, and the arrows move the cursor from one column to the next.
  await enter(join(home, 'sub'));
  await search('md');
  await until(async () => (await searchCount(page)) === '1/3');
  assert.deepEqual(await held(page), ['alpha.md', home]);
  await page.keyboard.press('ArrowDown');
  await until(async () => (await searchCount(page)) === '2/3');
  assert.deepEqual(await held(page), ['omega.md', home]);
  await page.keyboard.press('ArrowDown');
  await until(async () => (await searchCount(page)) === '3/3');
  assert.deepEqual(await held(page), ['inside.md', join(home, 'sub')]);
  await closeSearch();
  assert.deepEqual(await held(page), ['inside.md', join(home, 'sub')], 'closing the box leaves the cursor where the arrows put it');
  // A column is widened from the edge it shares with the next one, and keeps the width the drag leaves it.
  const first = columns(page).first();
  const before = await width(first);
  const handle = await resizeHandle(first).boundingBox();
  const from = { x: handle.x + handle.width / 2, y: handle.y + 20 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 140, from.y, { steps: 8 });
  await page.mouse.up();
  const after = await width(first);
  assert.ok(after > before + 100, `the column widened: ${before} -> ${after}`);
  assert.equal(await columnRow(page).getAttribute('data-resized'), '', 'the pane is marked as widened');
  assert.equal(await columns(page).count(), 2, 'no column was dropped');
  await page.screenshot({ path: 'test/output/screenshots/keys-search.png' });
  assert.deepEqual(errors, []);
}));
