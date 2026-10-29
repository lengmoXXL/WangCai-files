const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { codeView, collectErrors, dismissSearch, filesEmpty, goToPath, lists, openFilesWorkspace, openSearch, pathBox, search, searchInput, searchMarks, searchNote, searchPanel, searchRow, searchRows, submitSearch, waitForLine, waitForPath } = require('./files-ui.cjs');

test('the search box finds files, text and symbols, and Enter opens what it found', { timeout: 120000 }, () => withWindow('wangcai-files-search', lists, async ({ home, page, errors }) => {
  const main = join(home, 'main.ts');
  const nested = join(home, 'nested-name.ts');
  writeFileSync(join(home, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
  writeFileSync(join(home, 'answer.ts'), 'export const answer = 42;\n');
  writeFileSync(main, [
    'import { answer } from "./answer";',
    'const GREP_TARGET = answer;',
    'export function computeTotal() {',
    '  return GREP_TARGET;',
    '}',
    '',
  ].join('\n'));
  writeFileSync(nested, 'export const nested = 1;\n');
  collectErrors(page, errors);
  await openFilesWorkspace(page);
  await goToPath(page, main);
  await codeView(page, 'computeTotal').waitFor();
  // A name is looked for under the workspace's own directory, and Enter opens the file it names.
  await openSearch(page);
  // Nothing is chosen yet: the list marks the row of the entry the tab is on, and the page stays on it.
  const mainRow = searchRow(page, 'main.ts');
  await mainRow.waitFor();
  // Longer than the picker's rest before it follows a selection, so a page that was going to move has moved.
  await page.waitForTimeout(400);
  assert.equal(await pathBox(page).inputValue(), main);
  assert.equal(await mainRow.getAttribute('aria-current'), 'true');
  assert.equal(await searchPanel(page).evaluate((element) => getComputedStyle(element).fontSize), '12px');
  // Typed a letter at a time, with a pause long enough for the page to follow each one: none of that may take the
  // keyboard out of the input.
  await page.keyboard.type('nest', { delay: 150 });
  assert.equal(await searchInput(page).inputValue(), 'nest');
  const nestedRow = searchRow(page, 'nested-name.ts');
  await nestedRow.waitFor();
  // The row marks the letters it matched, so what put it on the list is visible.
  assert.ok((await searchMarks(nestedRow)).title.length > 0);
  // The page above the picker follows the chosen row, so the file is there before Enter closes the picker.
  await waitForPath(page, nested);
  assert.equal(await searchPanel(page).count(), 1);
  await codeView(page, 'nested = 1').waitFor();
  await submitSearch(page);
  // The picker that closes hands the keyboard to the page it opened.
  await until(async () => page.evaluate(() => Boolean(document.activeElement?.closest('.code-preview'))));

  // A leading > asks rg for the pattern, and a row says the file and line it was found on.
  await search(page, '>GREP_TARGET');
  await searchRow(page, 'main.ts:2').waitFor();
  // The row under the selection is where the page sits already, so the match is shown before Enter.
  await waitForPath(page, main);
  await waitForLine(page, 'const GREP_TARGET = answer;');
  await submitSearch(page);

  // A leading @ asks the file's language server for its symbols.
  await search(page, '@compute');
  await waitForLine(page, 'export function computeTotal() {');
  await submitSearch(page);
  await waitForPath(page, main);

  // A grep that was still running when the picker switched to symbols leaves no message of its own behind.
  await openSearch(page);
  await searchInput(page).fill('>computeTotal');
  await searchInput(page).fill('@compute');
  await searchRow(page, 'computeTotal').waitFor();
  assert.equal(await searchNote(page).count(), 0);
  await dismissSearch(page);

  // The picker is opened again from the header, and Escape leaves without moving the page.
  await openSearch(page);
  await dismissSearch(page);
  assert.equal(await pathBox(page).inputValue(), main);

  // A folder is searched as the row prints it, and each side of the row marks what it matched: here the query runs
  // through the folder into the name.
  mkdirSync(join(home, 'deep/dir'), { recursive: true });
  writeFileSync(join(home, 'deep/dir/path-only.ts'), 'export const only = 1;\n');
  await search(page, 'dir/path');
  const pathRow = searchRow(page, 'path-only.ts');
  await pathRow.waitFor();
  const pathMarks = await searchMarks(pathRow);
  assert.deepEqual(pathMarks.detail, ['d', 'i', 'r'], 'dir is marked in the folder');
  assert.deepEqual(pathMarks.title, ['p', 'a', 't', 'h'], 'path is marked in the name');
  await dismissSearch(page);

  // A name holding a character outside the basic plane keeps its marks on the letters they belong to: the indexes count
  // code units, so the emoji's two of them are not letters of their own.
  writeFileSync(join(home, '📁abc.ts'), 'export const emoji = 1;\n');
  await search(page, 'abc');
  const emojiRow = searchRow(page, 'abc.ts');
  await emojiRow.waitFor();
  assert.deepEqual((await searchMarks(emojiRow)).title, ['a', 'b', 'c']);
  assert.equal(await emojiRow.innerText(), '📁abc.ts');
  await dismissSearch(page);

  // Letters the query finds scattered score below what the page lists, so a weak query reports nothing rather than a
  // screen of near misses.
  await openSearch(page);
  // The list has to be in before the query is typed: an empty list is also what the picker shows while it waits for one.
  await searchRows(page).first().waitFor();
  await searchInput(page).fill('nst');
  await filesEmpty(page).waitFor();
  assert.equal(await searchRows(page).count(), 0);
  await dismissSearch(page);

  // A grep answer longer than the page draws is cut where the note says it is: 25 files of 10 matching lines, and 200
  // rows drawn.
  for (let index = 0; index < 25; index++) {
    writeFileSync(join(home, `hits${index}.txt`), Array.from({ length: 10 }, (_, line) => `HIT_${index}_${line}`).join('\n'));
  }
  await search(page, '>HIT_');
  assert.equal(await searchRows(page).count(), 200);
  assert.match(await searchNote(page).innerText(), /200/);
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));
