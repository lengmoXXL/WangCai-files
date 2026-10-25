const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { backButton, boxOf, cleanup, collectErrors, columnOf, entry, openFilesWorkspace, openWindow, testEnv, until, writeInit } = require('./harness.cjs');

test('the picker and the editor gutter mark git changes the way VS Code does', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-git-')));
  const env = testEnv(home);
  let desktop, page;
  try {
    // One repository holding a modified, an added, a renamed, an untracked and a deleted path, and folders over some of them.
    const git = (...args) => execFileSync('git', args, { cwd: home, stdio: 'ignore' });
    writeInit(home);
    mkdirSync(join(home, 'sub'));
    mkdirSync(join(home, 'dropped'));
    writeFileSync(join(home, 'clean.txt'), 'none\n');
    writeFileSync(join(home, 'kept.txt'), Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join('\n') + '\n');
    writeFileSync(join(home, 'dropped/dropped.txt'), 'two\n');
    writeFileSync(join(home, 'old name.txt'), 'three\n');
    writeFileSync(join(home, 'sub/nested.txt'), 'four\n');
    git('init', '-q');
    git('add', '-A');
    // A commit is the only call that reads an identity.
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'first');
    writeFileSync(join(home, 'kept.txt'), 'line1\nline2 changed\nline3\nline4\ninserted\nline5\nline6\nline7\nline9\nline10\n');
    writeFileSync(join(home, 'sub/nested.txt'), 'four changed\n');
    rmSync(join(home, 'dropped/dropped.txt'));
    mkdirSync(join(home, 'loose'));
    writeFileSync(join(home, 'loose/new.txt'), 'five\n');
    writeFileSync(join(home, 'fresh.txt'), 'six\n');
    writeFileSync(join(home, 'staged.txt'), 'seven\n');
    git('add', 'staged.txt');
    git('mv', 'old name.txt', 'new name.txt');
    ({ desktop, window: page } = await openWindow(home, env));
    const errors = [];
    collectErrors(page, errors);
    await openFilesWorkspace(page);
    const directory = columnOf(page, home);
    const mark = async (name) => {
      let letter;
      await until(async () => (letter = await entry(directory, name).getAttribute('data-git')) !== null);
      return letter;
    };
    const colour = (name) => entry(directory, name).locator('.file-name').evaluate((element) => getComputedStyle(element).color);
    assert.deepEqual([await mark('kept.txt'), await colour('kept.txt')], ['M', 'rgb(228, 197, 144)']);
    assert.deepEqual([await mark('fresh.txt'), await colour('fresh.txt')], ['U', 'rgb(155, 199, 188)']);
    assert.deepEqual([await mark('staged.txt'), await colour('staged.txt')], ['A', 'rgb(155, 199, 188)']);
    assert.deepEqual([await mark('new name.txt'), await colour('new name.txt')], ['R', 'rgb(155, 199, 188)']);
    // A deleted file is gone from the listing, so its folder is what carries the state.
    assert.deepEqual([await mark('dropped/'), await colour('dropped/')], ['D', 'rgb(230, 140, 140)']);
    // A folder holding a change takes its colour without a badge, and a file git never mentions takes neither.
    assert.deepEqual([
      await mark('sub/'),
      await colour('sub/'),
      await entry(directory, 'sub/').locator('.file-git').count(),
    ], ['M', 'rgb(228, 197, 144)', 0]);
    assert.deepEqual([
      await entry(directory, 'clean.txt').getAttribute('data-git'),
      await entry(directory, 'clean.txt').locator('.file-git').count(),
    ], [null, 0]);
    assert.deepEqual([await mark('loose/'), await colour('loose/')], ['U', 'rgb(155, 199, 188)']);
    // The badge names the state to a pointing reader, while the row's accessible name stays the file's own.
    assert.deepEqual([
      await entry(directory, 'kept.txt').locator('.file-git').innerText(),
      await entry(directory, 'kept.txt').getAttribute('title'),
    ], ['M', 'kept.txt · 已修改']);
    // Opening a changed file draws VS Code's gutter on the lines the change touched.
    await entry(directory, 'kept.txt').click();
    const modified = page.locator('.git-line-modified');
    await modified.waitFor();
    assert.deepEqual([
      await page.locator('.git-line-added').count(),
      await modified.count(),
      await page.locator('.git-line-deleted').count(),
    ], [1, 1, 1]);
    // A click on a mark opens that block: the same three changes, diffed in a peek of their own.
    const markBox = await boxOf(modified.first());
    await page.mouse.click(markBox.x + 3, markBox.y + markBox.height / 2);
    const peek = page.getByRole('dialog', { name: '行变更' });
    await peek.waitFor();
    assert.match(await peek.innerText(), /已修改 · 第 2 行/);
    // The editor draws a space as a non-breaking one, so the block is matched by shape rather than by exact bytes.
    await until(async () => /line2\schanged/.test(await peek.innerText()));
    await page.keyboard.press('Escape');
    await peek.waitFor({ state: 'hidden' });
    // Staging the file empties the diff it held, so the gutter clears without the file being opened again.
    git('add', 'kept.txt');
    await until(async () => (await page.locator('.git-line-modified').count()) === 0);
    assert.deepEqual([
      await page.locator('.git-line-added').count(),
      await page.locator('.git-line-deleted').count(),
    ], [0, 0]);
    await backButton(page).click();
    // A staged change is still a change, so the row keeps its mark until the commit takes it away.
    await until(async () => (await entry(directory, 'kept.txt').getAttribute('data-git')) === 'M');
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'second');
    await until(async () => (await entry(directory, 'kept.txt').getAttribute('data-git')) === null);
    assert.equal(await entry(directory, 'kept.txt').locator('.file-git').count(), 0);
    // A level below keeps the marks it has, so a folder is only a way in.
    await entry(directory, 'sub/').click();
    const nested = columnOf(page, join(home, 'sub'));
    await nested.waitFor();
    await until(async () => (await entry(nested, 'nested.txt').getAttribute('data-git')) === 'M');
    assert.equal(await entry(nested, 'nested.txt').locator('.file-git').innerText(), 'M');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: 'test/output/screenshots/git-marks.png' });
  } finally {
    await desktop?.close();
    cleanup(home);
  }
});
