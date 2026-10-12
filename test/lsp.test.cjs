const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, realpathSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { cleanup, createWorkspace, launchApp, testEnv, writeInit } = require('./harness.cjs');

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

test('a code file gets its language server: hover, jump to a definition, and diagnostics', { timeout: 60000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-files-lsp-')));
  const env = testEnv(home);
  let desktop;
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
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await createWorkspace(page);
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    const address = page.getByRole('textbox', { name: '路径', exact: true });
    await address.fill(source);
    await address.press('Enter');
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'TYPE_ERROR' }).waitFor();
    // The status dot in the toolbar names the server behind it on hover.
    await page.locator('.preview-lsp').hover();
    await page.locator('.preview-lsp-detail').filter({ hasText: 'typescript-language-server' }).waitFor();
    await page.mouse.move(0, 0);
    // A diagnostic arrives as a marker, which the editor paints as a squiggle over the offending text.
    await page.locator('.view-overlays div[class*=squiggly]').first().waitFor();
    const at = await tokenAt(page, 1, 'answer');
    await page.mouse.move(at.x, at.y);
    await page.locator('.monaco-hover').filter({ hasText: 'const answer: 42' }).waitFor();
    // Holding the trigger key makes monaco draw a link; it must not move the preview on its own.
    await page.keyboard.down('ControlOrMeta');
    await page.mouse.move(at.x + 1, at.y);
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('.preview-path').inputValue(), source);
    // Following the link opens the definition's file, which monaco cannot open by itself.
    await page.mouse.click(at.x + 1, at.y);
    await page.keyboard.up('ControlOrMeta');
    await page.waitForFunction((path) => document.querySelector('.preview-path').value === path, definition);
    // A jump resolves its target through monaco's model service, which knows only the models this window has, so
    // the definition's file is reported as missing once, right before the click opens it.
    assert.deepEqual(errors, ['Model not found']);

    // The status dot restarts the server of the file it is drawn for, and the new one takes over this window.
    await page.locator('.preview-lsp').click();
    await page.locator('.preview-lsp-detail').filter({ hasText: '运行中' }).waitFor();
    await page.mouse.move(0, 0);
    // The jump left the editor on the definition's file, so its own `answer` token is where a hover can land.
    const definitionAt = await tokenAt(page, 0, 'answer');
    await page.mouse.move(definitionAt.x, definitionAt.y);
    // A restarted server answers only once it has synced the document, and monaco does not repeat a hover that
    // missed, so the pointer is moved again until it answers.
    const hover = page.locator('.monaco-hover').filter({ hasText: 'const answer: 42' });
    for (let attempt = 0; attempt < 6 && !(await hover.count()); attempt++) {
      await page.waitForTimeout(500);
      await page.mouse.move(definitionAt.x + 8, definitionAt.y);
      await page.mouse.move(definitionAt.x, definitionAt.y);
    }
    await hover.waitFor();
  } finally {
    await desktop?.close();
    cleanup(home);
  }
});
