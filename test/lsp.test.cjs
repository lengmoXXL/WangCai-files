const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, realpathSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { cleanup, closeWorkspace, codeView, collectErrors, goToPath, openFilesWorkspace, openWindow, pathBox, testEnv, until, waitForPath, workspaceTabs, writeInit } = require('./harness.cjs');

// The language servers running in this test's fixture: another test's window starts its own, with its own home.
const languageServers = (home) => execFileSync('sh', ['-c', 'ps -Ao pid,command | grep "[b]in/typescript-language-server --stdio" || true'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
  .map((line) => line.split(' ')[0])
  .filter((pid) => execFileSync('sh', ['-c', `lsof -p ${pid} -a -d cwd -Fn 2>/dev/null || true`], { encoding: 'utf8' }).includes(`n${home}`));
// Where the mouse has to land to hover one token: the screen position of the token on a visible line of the editor.
const tokenAt = (page, lineIndex, token) => page.evaluate(([index, text]) => {
  const line = document.querySelectorAll('.monaco-editor .view-line')[index];
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
}, [lineIndex, token]);

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
    const at = await tokenAt(page, 1, 'answer');
    await page.mouse.move(at.x, at.y);
    await hover.waitFor();
    assert.equal(await definitionLink.count(), 0);
    // Holding the trigger key makes monaco draw a link; it must not move the preview on its own.
    await page.keyboard.down('ControlOrMeta');
    await page.mouse.move(at.x + 1, at.y);
    // The link needs the model of the file it points into, which the plugin reads in.
    await definitionLink.waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await pathBox(page).inputValue(), source);
    // Following the link opens the definition's file, which monaco cannot open by itself.
    await page.mouse.click(at.x + 1, at.y);
    await page.keyboard.up('ControlOrMeta');
    await waitForPath(page, definition);
    // The definition's file was read in for the link, so the jump resolves against it and reports nothing.
    assert.deepEqual(errors, []);

    // The status dot restarts the server of the file it is drawn for, and the new one takes over this window.
    await status.click();
    await detail.filter({ hasText: '运行中' }).waitFor();
    await page.mouse.move(0, 0);
    // The jump left the editor on the definition's file, so its own `answer` token is where a hover can land.
    const definitionAt = await tokenAt(page, 0, 'answer');
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
