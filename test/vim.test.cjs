const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { codeView, collectErrors, cursorLine, goToPath, lists, lspDot, openFilesWorkspace, waitForLine, waitForPath } = require('./files-ui.cjs');

// What `y` takes is read where it goes: the clipboard.
const taken = (page, text) => until(async () => (await page.evaluate(() => navigator.clipboard.readText())) === text);

test('the preview answers vim keys while its text has the keyboard', { timeout: 120000 }, () => withWindow('wangcai-files-vim', lists, async ({ home, page, errors }) => {
  const file = join(home, 'lines.ts');
  writeFileSync(file, Array.from({ length: 60 }, (_, index) => `line${index + 1}`).join('\n'));
  collectErrors(page, errors);
  await openFilesWorkspace(page);
  await goToPath(page, file);
  await codeView(page, 'line1').waitFor();
  await waitForLine(page, 'line1');
  await page.keyboard.press('G');
  await waitForLine(page, 'line60');
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await waitForLine(page, 'line1');
  await page.keyboard.press('3');
  await page.keyboard.press('j');
  await waitForLine(page, 'line4');
  await page.keyboard.press('k');
  await waitForLine(page, 'line3');
  // A search opens the widget the editor already keeps, and the query is typed into it rather than read as keys.
  await page.keyboard.press('/');
  const find = page.locator('.find-widget');
  await find.waitFor();
  await page.keyboard.type('line42');
  assert.equal(await find.locator('.find-part textarea').inputValue(), 'line42');
  await page.keyboard.press('Escape');
  await until(async () => !(await page.locator('.find-widget').getAttribute('class')).includes('visible'));
  assert.deepEqual(errors, []);
}));

test('v selects by characters, V by lines, and y takes the selection', { timeout: 120000 }, () => withWindow('wangcai-files-vim-visual', lists, async ({ home, page, errors }) => {
  const file = join(home, 'lines.ts');
  writeFileSync(file, Array.from({ length: 12 }, (_, index) => `line${index + 1}`).join('\n'));
  collectErrors(page, errors);
  await openFilesWorkspace(page);
  await goToPath(page, file);
  await codeView(page, 'line1').waitFor();
  await page.keyboard.press('j');
  await waitForLine(page, 'line2');
  await page.keyboard.press('v');
  await page.keyboard.press('3');
  await page.keyboard.press('l');
  await page.keyboard.press('y');
  await taken(page, 'line');
  // A linewise selection takes the whole line, and the newline it ends with.
  await page.keyboard.press('j');
  await page.keyboard.press('V');
  await page.keyboard.press('y');
  await taken(page, 'line3\n');
  assert.deepEqual(errors, []);
}));

test('f finds a character on the line, and t stops one short of it', { timeout: 120000 }, () => withWindow('wangcai-files-vim-seek', lists, async ({ home, page, errors }) => {
  const file = join(home, 'seek.ts');
  writeFileSync(file, 'abcXdefXghi\n');
  collectErrors(page, errors);
  await openFilesWorkspace(page);
  await goToPath(page, file);
  await codeView(page, 'abcXdefXghi').waitFor();
  // What a seek lands on is read through the selection it makes, which starts on the character under the caret.
  await page.keyboard.press('v');
  await page.keyboard.press('f');
  await page.keyboard.press('X');
  await page.keyboard.press('y');
  await taken(page, 'abcX');
  // A count reaches the second X, and `t` stops one short of it.
  await page.keyboard.press('v');
  await page.keyboard.press('2');
  await page.keyboard.press('f');
  await page.keyboard.press('X');
  await page.keyboard.press('y');
  await taken(page, 'abcXdefX');
  await page.keyboard.press('v');
  await page.keyboard.press('t');
  await page.keyboard.press('X');
  await page.keyboard.press('y');
  await taken(page, 'abc');
  // `;` repeats that search and `,` repeats it the other way, so the same selection lands on different characters.
  await page.keyboard.press('0');
  await page.keyboard.press('f');
  await page.keyboard.press('X');
  await page.keyboard.press(';');
  await page.keyboard.press('v');
  await page.keyboard.press('$');
  await page.keyboard.press('y');
  await taken(page, 'Xghi');
  await page.keyboard.press(',');
  await page.keyboard.press('v');
  await page.keyboard.press('$');
  await page.keyboard.press('y');
  await taken(page, 'XdefXghi');
  assert.deepEqual(errors, []);
}));

const rebound = { ...lists, tabs: [{ id: 'files', config: { vim: { keys: { G: 'cursorTop', gg: false } } } }, 'terminal'] };

test('a page can rebind a key of that mode and drop another', { timeout: 120000 }, () => withWindow('wangcai-files-vim-keys', rebound, async ({ home, page, errors }) => {
  const file = join(home, 'lines.ts');
  writeFileSync(file, Array.from({ length: 60 }, (_, index) => `line${index + 1}`).join('\n'));
  collectErrors(page, errors);
  await openFilesWorkspace(page);
  await goToPath(page, file);
  await codeView(page, 'line1').waitFor();
  await page.keyboard.press('2');
  await page.keyboard.press('0');
  await page.keyboard.press('j');
  await waitForLine(page, 'line21');
  // `gg` was dropped, so the top of the file is not where two of them go; `G` was pointed at the movement up.
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await page.waitForTimeout(500);
  assert.equal(await cursorLine(page), 'line21');
  await page.keyboard.press('G');
  await waitForLine(page, 'line1');
  assert.deepEqual(errors, []);
}));

test('gd jumps to the definition and ctrl-o comes back', { timeout: 180000 }, () => withWindow('wangcai-files-vim-jumps', lists, async ({ home, page, errors }) => {
  const source = join(home, 'main.ts');
  const shapes = join(home, 'shapes.ts');
  writeFileSync(join(home, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
  writeFileSync(shapes, 'export interface Shape {\n  area(): number;\n}\n\nexport class Square implements Shape {\n  area(): number {\n    return 4;\n  }\n}\n');
  writeFileSync(source, 'const first = 1;\nconst two = 2;\nconst three = 3;\nfirst;\nSquare;\nimport { Square } from "./shapes";\n');
  collectErrors(page, errors);
  await openFilesWorkspace(page);
  await goToPath(page, source);
  await codeView(page, 'const three').waitFor();
  await lspDot(page, 'open').waitFor();
  // The name is used in the middle of the file, so coming back to it says whether the line was kept and not just the file.
  await page.keyboard.press('3');
  await page.keyboard.press('j');
  await waitForLine(page, 'first;');
  // A name declared in this file is a jump like any other: `ctrl-o` comes back to the line it was jumped from.
  await page.keyboard.press('g');
  await page.keyboard.press('d');
  await waitForLine(page, 'const first = 1;');
  await page.keyboard.press('Control+o');
  await waitForLine(page, 'first;');
  // The answer names the import the name came in through before it names the declaration, so one key press still lands.
  await page.keyboard.press('j');
  await waitForLine(page, 'Square;');
  await page.keyboard.press('g');
  await page.keyboard.press('d');
  await waitForPath(page, shapes);
  await waitForLine(page, 'export class Square implements Shape {');
  await page.keyboard.press('Control+o');
  await waitForPath(page, source);
  await waitForLine(page, 'Square;');
  await page.keyboard.press('Control+i');
  await waitForPath(page, shapes);
  await waitForLine(page, 'export class Square implements Shape {');
  // A jump made again after walking back starts the list over, and coming back still reaches the line it left.
  await page.keyboard.press('Control+o');
  await waitForPath(page, source);
  await waitForLine(page, 'Square;');
  await page.keyboard.press('g');
  await page.keyboard.press('d');
  await waitForPath(page, shapes);
  await page.keyboard.press('Control+o');
  await waitForPath(page, source);
  await waitForLine(page, 'Square;');
  assert.deepEqual(errors, []);
}));
