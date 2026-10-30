const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { until, wangcaiApp, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { backButton, closeWorkspace, codeView, cursorLine, filePreview, goToPath, lists, lspDetail, lspDot, openFilesWorkspace, pathBox, refreshButton, storedHistory, waitForLine, waitForPath, workspaceTabs } = require('./files-ui.cjs');

// The processes whose command line holds this text: ps is read once and cut here, so every probe cuts the same way.
const pids = (text) => execFileSync('sh', ['-c', 'ps -Ao pid,command'], { encoding: 'utf8' })
  .split('\n').filter((line) => line.includes(text))
  .map((line) => line.trim().split(' ')[0]);

// The language servers running in this test's fixture: another test's window starts its own, with its own home.
const languageServers = (home) => pids('bin/typescript-language-server --stdio')
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

test('a code file keeps a language server for hover, jump, and diagnostics until its workspace closes', { timeout: 60000 }, () => withWindow('wangcai-files-lsp', lists, async ({ home, page, errors }) => {
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
  await openFilesWorkspace(page);
  await goToPath(page, source);
  await codeView(page, 'TYPE_ERROR').waitFor();
  // The widgets a hover and a jump draw in the editor.
  const hover = page.locator('.monaco-hover').filter({ hasText: 'const answer: 42' });
  const definitionLink = page.locator('.goto-definition-link');
  // The dot, and the tooltip that names the service behind the file and how it is doing.
  const dot = lspDot(page);
  const detail = lspDetail(page);
  await dot.hover();
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
  await dot.click();
  await detail.filter({ hasText: '运行中' }).waitFor();
  await page.mouse.move(0, 0);
  // The jump left the editor on the definition's file, so its own `answer` token is where a hover can land.
  const definitionAt = await tokenAt(page, 'export const answer = 42;', 'answer');
  await page.mouse.move(definitionAt.x, definitionAt.y);
  // A restarted server answers only once it has synced the document, and monaco does not repeat a hover that
  // missed, so the pointer is moved again until it answers.
  await until(() => hover.isVisible(), {
    act: async () => { await page.mouse.move(definitionAt.x + 8, definitionAt.y); await page.mouse.move(definitionAt.x, definitionAt.y); },
    interval: 500,
  });
  // A server started again is a process of its own, which takes its moment to appear where it is looked for.
  await until(() => languageServers(home).length === 1);
  // Closing the workspace takes the server with it: no file of this window is left to need it.
  await closeWorkspace(workspaceTabs(page).first());
  await until(() => !languageServers(home).length);
}));

test('the right-click menu answers definitions, type definitions, and references', { timeout: 90000 }, () => withWindow('wangcai-files-menu', lists, async ({ home, page, errors }) => {
  const shapes = join(home, 'shapes.ts');
  const main = join(home, 'main.ts');
  writeFileSync(join(home, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
  writeFileSync(shapes, 'export const answer = 42;\n\nexport interface Shape {\n  area(): number;\n}\n\nexport class Square implements Shape {\n  area(): number {\n    return 4;\n  }\n}\n');
  writeFileSync(main, 'import { Shape, Square, answer } from "./shapes";\n\nconst first = answer;\nconst second = answer;\nconst shape: Shape = new Square();\nshape.area();\n');
  await openFilesWorkspace(page);
  await goToPath(page, main);
  await codeView(page, 'new Square').waitFor();
  const focused = () => page.evaluate(() => Boolean(document.activeElement?.closest('.code-preview')));
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
      return (await menu.count()) > 0 && (await cursorLine(page)) === line;
    });
    const menuBox = await menu.boundingBox();
    assert.ok(Math.abs(menuBox.x - at.x) <= 2 && Math.abs(menuBox.y - at.y) <= 2, `menu at ${menuBox.x},${menuBox.y}, click at ${at.x},${at.y}`);
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
    });
  };
  await openMenu('const shape: Shape = new Square();', 'Square');
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['转到定义', '转到实现', '转到类型定义', '查找引用']);
  // The class of a type annotation is a file of its own, which the jump opens at the class with the cursor in it.
  await jump('const shape: Shape = new Square();', 'Square', '转到定义', shapes);
  await waitForLine(page, 'export class Square implements Shape {');
  // The jump is recorded against the file it left.
  const leftEntry = Object.values(await storedHistory(page)).flatMap((history) => history.entries).filter((entry) => entry.path === main).at(-1);
  assert.equal(leftEntry.line, 5);
  assert.ok(await focused());
  // Going back returns to the line the jump started from, with the cursor focused there.
  await backButton(page).click();
  await waitForPath(page, main);
  await waitForLine(page, 'const shape: Shape = new Square();');
  assert.ok(await focused());
  // The type of the annotation is the interface the class implements.
  await jump('const shape: Shape = new Square();', 'Shape', '转到类型定义', shapes);
  await waitForLine(page, 'export interface Shape {');
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
  await waitForLine(page, 'export const answer = 42;');
  assert.ok(await focused());
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
  const editorBox = await page.locator('.code-preview .monaco-editor').boundingBox();
  await noMenu(() => page.mouse.click(editorBox.x + 200, editorBox.y + editorBox.height - 40, { button: 'right' }));
  // A file no language server answers gets no menu at all.
  writeFileSync(join(home, 'notes.txt'), 'notes\n');
  await goToPath(page, join(home, 'notes.txt'));
  await codeView(page, 'notes').waitFor();
  const plainAt = await tokenAt(page, 'notes', 'notes');
  await noMenu(() => page.mouse.click(plainAt.x, plainAt.y, { button: 'right' }));
  assert.deepEqual(errors, []);
}));

// A window whose rust server is the command given: the rest of its plugin list is the one every case runs.
const rustServer = (command) => ({ ...lists, tabs: [{ id: 'files', config: { lsp: { rust: { command } } } }, 'terminal'] });

// Rust's server is asked for by a command this machine does not have, so the window finds out it has none.
test('a language with no server on this machine says so on its dot, and the page stays quiet', { timeout: 120000 }, () => withWindow('wangcai-files-missing-server', rustServer(['no-such-language-server']), async ({ home, page, errors }) => {
  writeFileSync(join(home, 'main.rs'), 'fn main() {}\n');
  await openFilesWorkspace(page);
  await goToPath(page, join(home, 'main.rs'));
  await codeView(page, 'fn main').waitFor();
  const dot = lspDot(page, 'missing');
  const detail = lspDetail(page);
  await dot.waitFor();
  await dot.hover();
  // The reason a server is not there is read on the dot, and the page raises nothing of its own about it.
  await until(async () => (await detail.innerText()).includes('未启动'));
  assert.match(await detail.innerText(), /no-such-language-server/);
  assert.equal(await filePreview(page).getByRole('alert').count(), 0);
  assert.deepEqual(errors, []);
}));

// The agent a window talks to, whose going away takes every server it spawned with it.
const agent = join(wangcaiApp(), 'wangcaicli/dist/debug/wangcai');
// Whether that agent is up again, which is the moment before the window's next request can reach it.
const agentRunning = (home) => pids('wangcai server start --foreground')
  .some((pid) => execFileSync('sh', ['-c', `ps eww -o command= -p ${pid} 2>/dev/null || true`], { encoding: 'utf8' }).includes(`HOME=${home}`));

test('a language server the node lost is started again by the window', { timeout: 180000 }, () => withWindow('wangcai-files-revive', lists, async ({ home, page, errors }) => {
  writeFileSync(join(home, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
  writeFileSync(join(home, 'main.ts'), 'export function computeTotal() {\n  return 1;\n}\n');
  await openFilesWorkspace(page);
  await goToPath(page, join(home, 'main.ts'));
  await codeView(page, 'computeTotal').waitFor();
  await lspDot(page, 'open').waitFor();
  // The process is looked for rather than assumed: lsof can miss one that has only just started.
  await until(() => languageServers(home).length === 1, { timeout: 30000 });
  // The agent goes away and takes its language server with it.
  execFileSync(agent, ['server', 'stop'], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
  await until(() => !languageServers(home).length, { timeout: 30000 });
  // The window reconnects to a fresh agent on its own; the next write then lands on a server that node no longer has,
  // which is the failure the window starts one again from.
  await until(() => agentRunning(home), { timeout: 60000 });
  writeFileSync(join(home, 'main.ts'), 'export function computeTotal() {\n  return 2;\n}\n');
  await refreshButton(page).click();
  await codeView(page, 'return 2').waitFor();
  await until(() => languageServers(home).length === 1, { timeout: 90000 });
  await lspDot(page, 'open').waitFor();
  assert.deepEqual(errors, []);
}));

const dyingLife = 3;
// The command this case runs as a server: it comes up, takes a write, and dies again. The probe below looks for that same
// command line, so the fixture and the probe cannot drift apart.
const dyingCommand = `sleep ${dyingLife}; exit 1 # wangcai-dying-server`;
// Its processes while they live: one per start, which is what the tries are counted by.
const dyingServers = () => pids(dyingCommand);

test('a server that keeps dying is left stopped once its tries are spent', { timeout: 180000 }, () => withWindow('wangcai-files-dying-server', rustServer(['/bin/sh', '-c', dyingCommand]), async ({ home, page, errors }) => {
  writeFileSync(join(home, 'main.rs'), 'fn main() {}\n');
  await openFilesWorkspace(page);
  await goToPath(page, join(home, 'main.rs'));
  await codeView(page, 'fn main').waitFor();
  // What the tries are worth is counted rather than timed: each start of this server is a process of its own, and once
  // the tries are spent no new one comes up.
  const started = new Set();
  let grownAt = Date.now();
  // The waits between tries add up to about eleven seconds and each life lasts `dyingLife`, so the last start comes at
  // around twenty seconds; the window is long enough to watch twenty more go by without one.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const before = started.size;
    for (const pid of dyingServers()) started.add(pid);
    if (started.size > before) grownAt = Date.now();
    await page.waitForTimeout(250);
  }
  assert.ok(started.size > 0, 'the server was never started');
  // The stretch at the end of the window that no start has interrupted.
  assert.ok(Date.now() - grownAt > 20000, `a server started ${Date.now() - grownAt}ms ago`);
  await lspDot(page, 'closed').waitFor();
  assert.deepEqual(errors, []);
}));

const attempts = join(tmpdir(), `wangcai-attempts-${process.pid}-${Date.now()}`);
// The command this case runs as a server counts its own starts in that file: the first three die at once, which spends the
// tries, and the fourth stays up past the window that gives a server them back. Its life has to clear that window plus the
// moment between its start and the write the window is measured from.
const countingServer = rustServer(['/bin/sh', '-c', `n=$(($(cat '${attempts}' 2>/dev/null || echo 0)+1)); echo $n > '${attempts}'; [ $n -ge 4 ] && sleep 40; exit 1`]);
// How many times the server of a case has started, as its own command counts them in that file.
const count = (file) => (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0);

test('a server that stayed up long enough is given its tries back', { timeout: 240000 }, () => withWindow('wangcai-files-forgiven', countingServer, async ({ home, page, errors }) => {
  writeFileSync(join(home, 'main.rs'), 'fn main() {}\n');
  await openFilesWorkspace(page);
  await goToPath(page, join(home, 'main.rs'));
  await codeView(page, 'fn main').waitFor();
  // The fourth server's death is what should earn one more start — the one a budget that never forgives would not make.
  await until(() => count(attempts) >= 5, { timeout: 120000 });
  rmSync(attempts, { force: true });
  assert.deepEqual(errors, []);
}));

const healedOnce = join(tmpdir(), `wangcai-healed-${process.pid}-${Date.now()}`);
// The first start of this server stays up past the window and every later start exits at once, so the starts that follow
// are the ones a spent budget allows.
const healedServer = rustServer(['/bin/sh', '-c', `n=$(($(cat '${healedOnce}' 2>/dev/null || echo 0)+1)); echo $n > '${healedOnce}'; [ $n -eq 1 ] && sleep 40; exit 1`]);

test('a healthy server\'s death leaves the restarts after it bounded', { timeout: 240000 }, () => withWindow('wangcai-files-healed', healedServer, async ({ home, page, errors }) => {
  writeFileSync(join(home, 'main.rs'), 'fn main() {}\n');
  await openFilesWorkspace(page);
  await goToPath(page, join(home, 'main.rs'));
  await codeView(page, 'fn main').waitFor();
  // Its death has been met by now, so the tries after it are on their way.
  await until(() => count(healedOnce) >= 2, { timeout: 120000 });
  // Four starts is the first server plus the three tries its death earns: the waits between them add up to about eleven
  // seconds, and the window leaves room for all three to be spent.
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) await page.waitForTimeout(250);
  assert.ok(count(healedOnce) <= 4, `started ${count(healedOnce)} times`);
  rmSync(healedOnce, { force: true });
  assert.deepEqual(errors, []);
}));
