const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createWorkspace, openView, until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { codeView, collectErrors, cursorLine, dismissSearch, editorLines, filesPanels, goToPath, lists, lspDot, openFilesWorkspace, pathBox, picture, previewPanels, searchPanel, waitForLine, waitForPath, workspaceTabs } = require('./files-ui.cjs');

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
  // A seek waiting for its character ends when the keyboard leaves the page.
  await page.keyboard.press('f');
  await page.evaluate(() => document.activeElement?.blur());
  await editorLines(page).click();
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
  await page.keyboard.press('Control+f');
  await searchPanel(page).waitFor();
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));

// A window that has the preview plugin too: `<C-p>` sends the file to it and brings its tab forward.
const withPreview = { workspaces: ['terminal-agent'], tabs: ['files', 'preview', 'terminal'] };

test('ctrl-p hands the page to the preview plugin, which draws what this page only reads as text', { timeout: 120000 }, () => withWindow('wangcai-files-vim-preview', withPreview, async ({ home, page, errors }) => {
  const file = join(home, 'notes.md');
  writeFileSync(file, '# Notes title\n\nbody\n');
  await openFilesWorkspace(page);
  await goToPath(page, file);
  await codeView(page, '# Notes title').waitFor();
  // A box keeps the keys that are typed into it, the address box included.
  await pathBox(page).focus();
  await page.keyboard.press('Control+p');
  await page.waitForTimeout(300);
  assert.equal(await previewPanels(page).count(), 0);
  // With the keyboard back in the text, the same key hands the file over.
  await codeView(page, '# Notes title').click();
  await page.keyboard.press('Control+p');
  const preview = previewPanels(page);
  await preview.getByRole('heading', { name: 'Notes title' }).waitFor();
  // The file is still the text this page was reading: the preview is another view of it, not another mode of this one.
  assert.equal(await codeView(filesPanels(page), '# Notes title').count(), 1);
  assert.deepEqual(errors, []);
}));

test('a file this page cannot read is handed over by the same key, from the message it shows', { timeout: 120000 }, () => withWindow('wangcai-files-vim-picture', withPreview, async ({ home, page, errors }) => {
  const photo = join(home, 'photo.png');
  writeFileSync(photo, picture);
  await openFilesWorkspace(page);
  await goToPath(page, photo);
  await page.getByRole('alert').filter({ hasText: '暂不支持二进制' }).waitFor();
  // No editor was built for a picture, so the key is answered at the window instead of inside one.
  await page.keyboard.press('Control+p');
  const preview = previewPanels(page);
  const image = preview.locator('.preview-image img');
  await image.waitFor();
  assert.match(await image.getAttribute('src'), /^data:image\/png;base64,/);
  assert.deepEqual(errors, []);
}));

test('only the page on show answers the key, though a window keeps the pages of every workspace', { timeout: 120000 }, () => withWindow('wangcai-files-vim-workspaces', withPreview, async ({ home, page, errors }) => {
  const first = join(home, 'one.md');
  const second = join(home, 'two.md');
  writeFileSync(first, '# First page\n\nfirst-body\n');
  writeFileSync(second, '# Second page\n\nsecond-body\n');
  await openFilesWorkspace(page);
  await goToPath(page, first);
  await codeView(page, '# First page').waitFor();
  await createWorkspace(page);
  await openView(page, '文件');
  await goToPath(page, second);
  await codeView(page, '# Second page').waitFor();
  // The page of the workspace left behind stays mounted, so the key has to know which one was asked for.
  await workspaceTabs(page).first().click();
  await codeView(page, '# First page').waitFor();
  // The click that switched workspaces left the keyboard in the terminal, which keeps its own keys.
  await codeView(page, '# First page').click();
  await page.keyboard.press('Control+p');
  await previewPanels(page).locator('.preview-name').filter({ hasText: 'one.md' }).waitFor();
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
  writeFileSync(file, 'abcXdefXghi\nsecond line\nthird line');
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
  // A capital comes with a `Shift` keydown of its own, which must leave the seek waiting for the character.
  await page.keyboard.press('f');
  await page.keyboard.press('Shift+X');
  await page.keyboard.press('v');
  await page.keyboard.press('y');
  await taken(page, 'X');
  // A count reaches the second X, and `t` stops one short of it.
  await page.keyboard.press('0');
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
  // A key that is not a character ends the seek it interrupts.
  await page.keyboard.press('f');
  await page.keyboard.press('Control+f');
  await searchPanel(page).waitFor();
  await dismissSearch(page);
  await editorLines(page).click();
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await waitForLine(page, 'abcXdefXghi');
  await page.keyboard.press('f');
  await page.keyboard.press('ArrowDown');
  await waitForLine(page, 'second line');
  await page.keyboard.press('G');
  await waitForLine(page, 'third line');
  assert.deepEqual(errors, []);
}));

const rebound = { ...lists, tabs: [{ id: 'files', config: { vim: { keys: { G: 'cursorTop', gg: false, '<C-f>': false } } } }, 'terminal'] };

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
  // This page dropped `gg` and pointed `G` at the movement up.
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await page.waitForTimeout(500);
  assert.equal(await cursorLine(page), 'line21');
  await page.keyboard.press('G');
  await waitForLine(page, 'line1');
  // This page dropped `ctrl-f`.
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(500);
  assert.equal(await searchPanel(page).count(), 0);
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
