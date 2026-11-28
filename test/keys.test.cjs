const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { baseBar, basePath, columnOf, columnRow, columns, cursor, entry, held, lists, names, openFilesWorkspace, resizeHandle, searchBox, searchCount, searchField, shownPanel, width } = require('./files-ui.cjs');

test('the keys walk the columns, search tracks matches in the focused column, and a drag widens a column', { timeout: 180000 }, () => withWindow('wangcai-keys', lists, async ({ home, page, errors }) => {
  mkdirSync(join(home, 'sub/deep'), { recursive: true });
  writeFileSync(join(home, 'sub/inside.md'), '# Inside\n');
  writeFileSync(join(home, 'alpha.md'), 'a\n');
  writeFileSync(join(home, 'omega.md'), 'o\n');
  await openFilesWorkspace(page);
  const directory = columnOf(page, home);
  await entry(directory, 'alpha.md').waitFor();
  const [folderIcon, fileIcon] = await Promise.all(['sub/', 'alpha.md'].map(name =>
    entry(directory, name).evaluate(row => getComputedStyle(row, '::after').content)));
  assert.match(folderIcon, /\uf07b/);
  assert.match(fileIcon, /\uf016/);
  const search = async (query) => {
    await page.keyboard.press('/');
    await searchField(page).waitFor();
    await page.keyboard.type(query);
  };
  const boxGone = () => searchBox(page).waitFor({ state: 'detached' });
  const closeSearch = async () => {
    await page.keyboard.press('Enter');
    await boxGone();
  };
  const enter = async (path) => {
    await page.keyboard.press('L');
    const column = columnOf(page, path);
    await column.waitFor();
    return column;
  };
  // The deepest column holds the cursor as soon as its listing is in, so the keys move before anything is clicked.
  await until(async () => (await cursor(page).count()) === 1);
  const listed = await names(directory);
  assert.ok(listed.indexOf('sub/') < listed.indexOf('alpha.md'), 'directories precede files');
  assert.deepEqual(await held(page), [listed[0], home]);
  const block = directory.locator('.cm-fat-cursor').first();
  const blockX = async () => (await block.boundingBox())?.x;
  await block.waitFor();
  const start = await blockX();
  await page.keyboard.press('l');
  await until(async () => (await blockX()) > start);
  await page.keyboard.press('h');
  await until(async () => (await blockX()) === start);
  assert.deepEqual(await held(page), [listed[0], home]);
  await page.keyboard.type('2j');
  assert.deepEqual(await held(page), [listed[2], home]);
  await page.keyboard.type('2k');
  assert.deepEqual(await held(page), [listed[0], home]);
  await page.keyboard.type('dd');
  assert.deepEqual(await names(directory), listed.slice(1), 'Vim edits the directory buffer in place');
  await page.keyboard.press('u');
  assert.deepEqual(await names(directory), listed, 'Vim undo restores the directory row');
  await basePath(page).click();
  await page.keyboard.press('j');
  assert.deepEqual(await held(page), [listed[1], home]);
  await page.keyboard.press('k');
  assert.deepEqual(await held(page), [listed[0], home]);
  await page.keyboard.press('G');
  assert.deepEqual(await held(page), [listed.at(-1), home]);
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  assert.deepEqual(await held(page), [listed[0], home]);
  const pane = columnRow(page);
  const bounds = await pane.boundingBox();
  const corner = { x: bounds.x + bounds.width - 10, y: bounds.y + bounds.height - 10 };
  assert.ok(await pane.evaluate((element, { x, y }) => element === document.elementFromPoint(x, y), corner), 'the click lands on the pane, clear of the entries');
  // A click drops a waiting `g`, so the `g` after it waits again instead of landing anywhere.
  await page.keyboard.press('G');
  await page.keyboard.press('g');
  await page.mouse.click(corner.x, corner.y);
  await page.keyboard.press('g');
  assert.deepEqual(await held(page), [listed.at(-1), home]);
  await page.keyboard.press('g');
  assert.deepEqual(await held(page), [listed[0], home]);
  // `/` opens a box over the top right of the panel, and what it holds picks its match as it is typed.
  await search('sub');
  const box = await searchBox(page).boundingBox();
  const panel = await shownPanel(page).boundingBox();
  const bar = await baseBar(page).boundingBox();
  const drawn = await columns(page).evaluateAll((all) => all.map((element) => {
    const rect = element.getBoundingClientRect();
    return Math.round(rect.top);
  }));
  assert.ok(drawn.every((top) => top >= Math.round(bar.y + bar.height)), 'the columns start below the path bar');
  assert.ok(box.x > panel.x + panel.width / 2 && box.x + box.width <= panel.x + panel.width, 'the box is over the right of the path bar');
  assert.ok(box.y >= bar.y && box.y + box.height <= bar.y + bar.height + 1, 'the box sits in the path bar');
  await until(async () => (await held(page))[0] === 'sub/');
  await closeSearch();
  // `L` goes down a level and the cursor goes with it, while `H` comes back up onto the directory it left.
  const sub = await enter(join(home, 'sub'));
  await until(async () => (await held(page))[0] === 'deep/');
  assert.deepEqual(await held(page), ['deep/', join(home, 'sub')]);
  await page.keyboard.press(':');
  const vimPanel = shownPanel(page).locator('.file-vim-panels > .cm-panels-bottom');
  const [panelColor, themeColor] = await vimPanel.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement('canvas').getContext('2d');
    canvas.fillStyle = style.getPropertyValue('--wc-background').trim();
    const theme = canvas.fillStyle;
    canvas.fillStyle = style.backgroundColor;
    return [canvas.fillStyle, theme];
  });
  assert.equal(panelColor, themeColor);
  const strip = await vimPanel.boundingBox();
  const row = await pane.boundingBox();
  assert.equal(strip.x, row.x);
  assert.equal(strip.width, row.width);
  assert.equal(Math.round(strip.y), Math.round(row.y + row.height));
  await vimPanel.locator('input').fill('s/^deep/changed/');
  await page.keyboard.press('Enter');
  await vimPanel.locator('input').waitFor({ state: 'detached' });
  await entry(sub, 'changed/').waitFor();
  await page.keyboard.press('u');
  await entry(sub, 'deep/').waitFor();
  await page.keyboard.press('H');
  await sub.waitFor({ state: 'detached' });
  assert.deepEqual(await held(page), ['sub/', home]);
  // The search follows focus. `alpha.md` only matches in the column where it is listed.
  await enter(join(home, 'sub'));
  await page.keyboard.press('Shift+Tab');
  await until(async () => (await held(page))[1] === home);
  await search('alpha');
  await until(async () => (await searchCount(page)) === '1/1');
  await closeSearch();
  assert.deepEqual(await held(page), ['alpha.md', home], 'a search started in the left column stays there');
  await page.keyboard.press('Tab');
  await until(async () => (await held(page))[1] === join(home, 'sub'));
  await search('alpha');
  await until(async () => (await searchCount(page)) === '无匹配');
  await closeSearch();
  assert.deepEqual(await held(page), ['deep/', join(home, 'sub')], 'a query without a hit leaves the cursor alone');
  // `e` sits in both entries, so the arrows walk this level's two matches.
  await search('e');
  await until(async () => (await searchCount(page)) === '1/2');
  assert.deepEqual(await held(page), ['deep/', join(home, 'sub')]);
  await page.keyboard.press('ArrowDown');
  await until(async () => (await searchCount(page)) === '2/2');
  writeFileSync(join(home, 'sub/000.txt'), 'added during the search');
  await entry(sub, '000.txt').waitFor();
  assert.equal(await searchCount(page), '2/2');
  await closeSearch();
  assert.deepEqual(await held(page), ['inside.md', join(home, 'sub')], 'closing the box leaves the cursor where the arrows put it');
  // A click closes the box, because the pointer goes down on the pane before the entry is clicked.
  await search('md');
  await entry(directory, 'sub/').click();
  await boxGone();
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
  assert.equal(await pane.getAttribute('data-resized'), '', 'the pane is marked as widened');
  assert.equal(await columns(page).count(), 2, 'no column was dropped');
  await page.screenshot({ path: 'test/output/screenshots/keys-search.png' });
  assert.deepEqual(errors, []);
}));
