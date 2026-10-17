const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { cleanup, codeView, columnOf, entry, filesPanel, filesTab, goToPath, openFilesWorkspace, openWindow, pathBox, testEnv, until, workspaceTabs, writeInit } = require('./harness.cjs');

test('a directory the panel shows follows the machine without a refresh', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-files-watch-')));
  const env = testEnv(home);
  let desktop, page;
  try {
    writeInit(home);
    writeFileSync(join(home, 'sample.ts'), 'const first = 1;\n');
    ({ desktop, window: page } = await openWindow(home, env));
    await openFilesWorkspace(page);
    const directory = columnOf(page, home);
    await entry(directory, 'sample.ts').waitFor();

    const appeared = entry(directory, 'appeared.md');
    const renamed = entry(directory, 'renamed.md');
    await until(() => appeared.isVisible(), { act: () => writeFileSync(join(home, 'appeared.md'), '# appeared\n') });
    renameSync(join(home, 'appeared.md'), join(home, 'renamed.md'));
    await renamed.waitFor();
    await appeared.waitFor({ state: 'detached' });
    rmSync(join(home, 'renamed.md'));
    await renamed.waitFor({ state: 'detached' });

    // The directory the panel walks into is watched as well, not only the one it started at.
    mkdirSync(join(home, 'sub'));
    await entry(directory, 'sub/').click();
    const sub = columnOf(page, join(home, 'sub'));
    await until(() => entry(sub, 'deep.txt').isVisible(), { act: () => writeFileSync(join(home, 'sub', 'deep.txt'), 'deep\n') });
  } finally {
    await desktop?.close();
    cleanup(home);
  }
});

test('an open preview shows what the file holds now', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-files-watch-file-')));
  const env = testEnv(home);
  let desktop, page;
  try {
    writeInit(home);
    const code = join(home, 'sample.ts');
    writeFileSync(code, 'const first = "CODE_FIRST";\n');
    ({ desktop, window: page } = await openWindow(home, env));
    await openFilesWorkspace(page);
    const panel = filesPanel(page);
    const directory = columnOf(page, home);
    await entry(directory, 'sample.ts').click();
    await codeView(panel, 'CODE_FIRST').waitFor();

    await until(() => codeView(panel, 'CODE_SECOND').isVisible(), { act: () => writeFileSync(code, 'const second = "CODE_SECOND";\n') });
    assert.equal(await pathBox(panel).inputValue(), code);
  } finally {
    await desktop?.close();
    cleanup(home);
  }
});

test('a tab that is shown again follows the machine', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-files-watch-tab-')));
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-files-watch-other-')));
  const env = testEnv(home);
  let desktop, page;
  try {
    writeInit(home);
    writeFileSync(join(home, 'sample.ts'), 'const first = 1;\n');
    ({ desktop, window: page } = await openWindow(home, env));
    await openFilesWorkspace(page);
    const directory = columnOf(page, home);
    await entry(directory, 'sample.ts').waitFor();

    // A second workspace with a tab of its own, pointed at another directory, so that the first tab is hidden while
    // the change below arrives.
    await openFilesWorkspace(page);
    await goToPath(page, other);
    await columnOf(page, other).waitFor();

    writeFileSync(join(home, 'early.md'), 'early\n');
    // Showing the first tab again finds the file that arrived while it was hidden.
    await until(() => entry(directory, 'early.md').isVisible(), {
      act: async () => { await workspaceTabs(page).first().click(); await filesTab(page).click(); },
    });
    // And the watch is still on it: a later write arrives without a refresh.
    await until(() => entry(directory, 'late.md').isVisible(), { act: () => writeFileSync(join(home, 'late.md'), 'late\n') });
  } finally {
    await desktop?.close();
    cleanup(home);
    rmSync(other, { recursive: true, force: true });
  }
});