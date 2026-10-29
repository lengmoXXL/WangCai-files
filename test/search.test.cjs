const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { codeView, collectErrors, dismissSearch, goToPath, lists, openFilesWorkspace, openSearch, pathBox, search, searchInput, searchPanel, searchRow, submitSearch, waitForLine, waitForPath } = require('./files-ui.cjs');

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
  await searchRow(page, 'main.ts').waitFor();
  // Longer than the picker's rest before it follows a selection, so a page that was going to move has moved.
  await page.waitForTimeout(400);
  assert.equal(await pathBox(page).inputValue(), main);
  assert.equal(await searchRow(page, 'main.ts').getAttribute('aria-current'), 'true');
  assert.equal(await searchPanel(page).evaluate((element) => getComputedStyle(element).fontSize), '12px');
  // Typed a letter at a time, with a pause long enough for the page to follow each one: none of that may take the
  // keyboard out of the input.
  await page.keyboard.type('nest', { delay: 150 });
  assert.equal(await searchInput(page).inputValue(), 'nest');
  await searchRow(page, 'nested-name.ts').waitFor();
  // The row marks the letters it matched, so what put it on the list is visible.
  assert.ok((await searchRow(page, 'nested-name.ts').locator('b').count()) > 0);
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
  assert.equal(await searchPanel(page).locator('.search-note').count(), 0);
  await dismissSearch(page);

  // The picker is opened again from the header, and Escape leaves without moving the page.
  await openSearch(page);
  await dismissSearch(page);
  assert.equal(await pathBox(page).inputValue(), main);
  assert.deepEqual(errors, []);
}));
