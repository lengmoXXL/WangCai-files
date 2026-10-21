const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, realpathSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { backButton, cleanup, closeWorkspace, codeView, collectErrors, goToPath, openFilesWorkspace, openWindow, pathBox, storedHistory, testEnv, until, waitForPath, workspaceTabs, writeInit } = require('./harness.cjs');

// The language servers running in this test's fixture: another test's window starts its own, with its own home.
const languageServers = (home) => execFileSync('sh', ['-c', 'ps -Ao pid,command | grep "[b]in/typescript-language-server --stdio" || true'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
  .map((line) => line.split(' ')[0])
  .filter((pid) => execFileSync('sh', ['-c', `lsof -p ${pid} -a -d cwd -Fn 2>/dev/null || true`], { encoding: 'utf8' }).includes(`n${home}`));
// Where a word is drawn. Monaco keeps its lines absolutely positioned, so the element holding a given line is looked
// for by what it says rather than by its place among the others.
const tokenAt = (page, lineText, token) => page.evaluate(([lineText, text]) => {
  const line = [...document.querySelectorAll('.code-preview .view-line')].find((row) => row.textContent.replace(/\u00a0/g, ' ').includes(lineText));
  if (!line) return null;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let node; node = walker.nextNode();) {
    const at = node.textContent.indexOf(text);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.x + 1, y: rect.y + rect.height / 2 };
  }
  return null;
}, [lineText, token]);

test('a code file keeps a language server for hover, jump, and diagnostics until its workspace closes', { timeout: 60000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-files-lsp-')));
  const env = testEnv(home);
  let desktop, page;
  try {
    writeInit(home, { workspaces: ['terminal-agent'], tabs: ['files'] });
    const source = join(home, 'main.ts');
    const definition = join(home, 'answer.ts');
    writeFileSync(join(home, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
    writeFileSync(definition, 'export const answer = 42;\n');
    writeFileSync(source, [
      'import { answer } from "./answer";',
      'answer;',
      "const value: number = 'TYPE_ERROR';",
      '',
    ].join('\n'));
    ({ desktop, window: page } = await openWindow(home, env));
    const errors = [];
    collectErrors(page, errors);
    await openFilesWorkspace(page);
    await goToPath(page, source);
    await codeView(page, 'TYPE_ERROR').waitFor();
    // The widgets a hover and a jump draw in the editor, and the status dot whose menu names the server behind it.
    const status = page.locator('.preview-lsp');
    const hover = page.locator('.monaco-hover').filter({ hasText: 'const answer: 42' });
    const definitionLink = page.locator('.goto-definition-link');
    const detail = page.locator('.preview-lsp-detail');
    await status.hover();
    await detail.filter({ hasText: 'typescript-language-server' }).waitFor();
    await page.mouse.move(0, 0);
    // A diagnostic arrives as a marker, which the editor paints as a squiggle over the offending text.
    await page.locator('.view-overlays div[class*=squiggly]').first().waitFor();
    const at = await tokenAt(page, 'answer;', 'answer');
    await page.mouse.move(at.x, at.y);
    await hover.waitFor();
    assert.equal(await definitionLink.count(), 0);
    // Holding the trigger key draws the link under the pointer as it is, without another move. Following it is the
    // click's job, so the preview is given the moment a jump would take, then asked to still be on the same file.
    await page.keyboard.down('ControlOrMeta');
    await definitionLink.waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await pathBox(page).inputValue(), source);
    // Following the link opens the definition's file, which monaco cannot open by itself.
    await page.mouse.click(at.x, at.y);
    await page.keyboard.up('ControlOrMeta');
    await waitForPath(page, definition);
    // The definition's file was read in for the link, so the jump resolves against it and reports nothing.
    assert.deepEqual(errors, []);

    // The status dot restarts the server of the file it is drawn for, and the new one takes over this window.
    await status.click();
    await detail.filter({ hasText: '运行中' }).waitFor();
    await page.mouse.move(0, 0);
    // The jump left the editor on the definition's file, so its own `answer` token is where a hover can land.
    const definitionAt = await tokenAt(page, 'export const answer = 42;', 'answer');
    await page.mouse.move(definitionAt.x, definitionAt.y);
    // A restarted server answers only once it has synced the document, and monaco does not repeat a hover that
    // missed, so the pointer is moved again until it answers. The budget here is the 15s the default timeout allows.
    await until(() => hover.isVisible(), {
      act: async () => { await page.mouse.move(definitionAt.x + 8, definitionAt.y); await page.mouse.move(definitionAt.x, definitionAt.y); },
      attempts: 30, interval: 500,
    });
    // Closing the workspace takes the server with it: no file of this window is left to need it.
    assert.equal(languageServers(home).length, 1);
    await closeWorkspace(workspaceTabs(page).first());
    await until(() => !languageServers(home).length);
  } finally {
    await desktop?.close();
    cleanup(home);
  }
});

test('the right-click menu answers definitions, type definitions, and references', { timeout: 90000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-files-menu-')));
  const env = testEnv(home);
  let desktop, page;
  try {
    writeInit(home, { workspaces: ['terminal-agent'], tabs: ['files'] });
    const shapes = join(home, 'shapes.ts');
    const main = join(home, 'main.ts');
    writeFileSync(join(home, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
    writeFileSync(shapes, 'export const answer = 42;\n\nexport interface Shape {\n  area(): number;\n}\n\nexport class Square implements Shape {\n  area(): number {\n    return 4;\n  }\n}\n');
    writeFileSync(main, 'import { Shape, Square, answer } from "./shapes";\n\nconst first = answer;\nconst second = answer;\nconst shape: Shape = new Square();\nshape.area();\n');
    ({ desktop, window: page } = await openWindow(home, env));
    const errors = [];
    collectErrors(page, errors);
    await openFilesWorkspace(page);
    await goToPath(page, main);
    await codeView(page, 'new Square').waitFor();
    // The line the cursor is drawn on: monaco gives the caret the offset of the line it sits in.
    const cursorLine = () => page.evaluate(() => {
      const caret = document.querySelector('.code-preview .cursors-layer > .cursor');
      const top = caret && getComputedStyle(caret).top;
      const line = [...document.querySelectorAll('.code-preview .view-line')].find((element) => getComputedStyle(element).top === top);
      return line ? line.textContent.replace(/\u00a0/g, ' ') : null;
    });
    const focused = () => page.evaluate(() => Boolean(document.activeElement?.closest('.code-preview')));
    const waitForLine = (text) => until(async () => (await cursorLine()) === text, { attempts: 40, interval: 250 });
    const lastEntryOf = async (path) => Object.values(await storedHistory(page)).flatMap((history) => history.entries)
      .filter((entry) => entry.path === path).at(-1);
    const menu = page.getByRole('menu', { name: '语言服务' });
    const openMenu = async (line, token) => {
      // Waited for: the token being drawn, the menu opening, and the click landing on the line asked for, since the
      // panel moves while it settles and a click reads whichever line it then finds.
      let at;
      await until(async () => {
        if (await menu.count()) {
          // A menu left by an earlier round would answer the count below at once, so it is closed first.
          await page.keyboard.press('Escape');
          await menu.waitFor({ state: 'detached' });
        }
        at = await tokenAt(page, line, token);
        if (!at) return false;
        await page.mouse.click(at.x, at.y, { button: 'right' });
        // The menu is offered only after the server has answered the handshake, which lands a moment after the click.
        await menu.waitFor({ timeout: 1500 }).catch(() => {});
        return (await menu.count()) > 0 && (await cursorLine()) === line;
      }, { attempts: 40, interval: 250 });
      const box = await menu.boundingBox();
      assert.ok(Math.abs(box.x - at.x) <= 2 && Math.abs(box.y - at.y) <= 2, `menu at ${box.x},${box.y}, click at ${at.x},${at.y}`);
    };
    const choose = async (name) => {
      await menu.getByRole('menuitem', { name }).click();
      await menu.waitFor({ state: 'detached' });
    };
    // A server answers a request only once it has synced the file, so a jump that lands nowhere is asked for again.
    const jump = async (line, token, name, target) => {
      await until(async () => (await pathBox(page).inputValue()) === target, {
        act: async () => {
          await openMenu(line, token);
          await choose(name);
        },
        attempts: 40, interval: 250,
      });
    };
    await openMenu('const shape: Shape = new Square();', 'Square');
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['转到定义', '转到实现', '转到类型定义', '查找引用']);
    // The class of a type annotation is a file of its own, which the jump opens at the class with the cursor in it.
    await jump('const shape: Shape = new Square();', 'Square', '转到定义', shapes);
    await waitForLine('export class Square implements Shape {');
    // The jump is recorded against the file it left.
    assert.equal((await lastEntryOf(main)).line, 5);
    assert.equal(await focused(), true);
    // Going back returns to the line the jump started from, with the cursor focused there.
    await backButton(page).click();
    await waitForPath(page, main);
    await waitForLine('const shape: Shape = new Square();');
    assert.equal(await focused(), true);
    // The type of the annotation is the interface the class implements.
    await jump('const shape: Shape = new Square();', 'Shape', '转到类型定义', shapes);
    await waitForLine('export interface Shape {');
    await backButton(page).click();
    await waitForPath(page, main);
    // References are shown in monaco's own peek, which lists a file of its own for each; opening one moves the
    // preview to the file and line it names.
    await openMenu('const first = answer;', 'answer');
    await choose('查找引用');
    const rows = page.locator('.peekview-widget .monaco-list-row');
    const group = rows.filter({ hasText: 'shapes.ts' });
    await group.waitFor();
    await group.locator('.monaco-tl-twistie').click();
    const declaration = rows.filter({ hasText: 'const answer = 42;' });
    await declaration.waitFor();
    await declaration.click();
    const shown = page.locator('.peekview-widget .preview .view-line').filter({ hasText: 'answer = 42' });
    await shown.waitFor();
    await shown.dblclick();
    await waitForPath(page, shapes);
    await waitForLine('export const answer = 42;');
    assert.equal(await focused(), true);
    // The menu follows what the server answers, not where the cursor is: a declaration offers the jumps too.
    await openMenu('export const answer = 42;', 'answer');
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['转到定义', '转到实现', '转到类型定义', '查找引用']);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    // A menu that must not open is given the moment it would have taken to appear before the absence is asserted.
    const noMenu = async (click) => {
      await click();
      await page.waitForTimeout(500);
      assert.equal(await menu.count(), 0);
    };
    // A right click below the last line opens nothing.
    const editor = await page.locator('.code-preview .monaco-editor').boundingBox();
    await noMenu(() => page.mouse.click(editor.x + 200, editor.y + editor.height - 40, { button: 'right' }));
    // A file no language server answers gets no menu at all.
    writeFileSync(join(home, 'notes.txt'), 'notes\n');
    await goToPath(page, join(home, 'notes.txt'));
    await codeView(page, 'notes').waitFor();
    const plain = await tokenAt(page, 'notes', 'notes');
    await noMenu(() => page.mouse.click(plain.x, plain.y, { button: 'right' }));
    assert.deepEqual(errors, []);
  } finally {
    await desktop?.close();
    cleanup(home);
  }
});
