const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { backButton, boxOf, columnOf, entry, lists, openFilesWorkspace } = require('./files-ui.cjs');

test('the picker and the editor gutter mark git changes the way VS Code does', { timeout: 180000 }, () => withWindow('wangcai-git', lists, async ({ home, page, errors }) => {
  const git = (...args) => execFileSync('git', args, { cwd: home, encoding: 'utf8' });
  // One repository holding a modified, an added, a renamed, an untracked and a deleted path, and folders over some of them.
  mkdirSync(join(home, 'sub'));
  mkdirSync(join(home, 'dropped'));
  writeFileSync(join(home, 'clean.txt'), 'none\n');
  writeFileSync(join(home, 'kept.txt'), Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join('\n') + '\n');
  writeFileSync(join(home, 'dropped/dropped.txt'), 'two\n');
  writeFileSync(join(home, 'old name.txt'), 'three\n');
  writeFileSync(join(home, 'sub/nested.txt'), 'four\n');
  git('init', '-q');
  // The window keeps its own profile in the same home and writes to it the whole time, so git is told to skip it.
  writeFileSync(join(home, '.git/info/exclude'), 'electron/\n');
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
  await openFilesWorkspace(page);
  const directory = columnOf(page, home);
  const stateOf = async (column, name) => {
    const one = entry(column, name);
    return (await one.count()) ? one.getAttribute('data-git') : null;
  };
  const mark = async (column, name) => {
    let letter;
    await until(async () => (letter = await stateOf(column, name)) !== null);
    return letter;
  };
  const colour = (column, name) => entry(column, name).locator('.file-name').evaluate((element) => getComputedStyle(element).color);
  const badge = (column, name) => entry(column, name).locator('.file-git');
  assert.deepEqual([await mark(directory, 'kept.txt'), await colour(directory, 'kept.txt')], ['M', 'rgb(228, 197, 144)']);
  assert.deepEqual([await mark(directory, 'fresh.txt'), await colour(directory, 'fresh.txt')], ['U', 'rgb(155, 199, 188)']);
  assert.deepEqual([await mark(directory, 'staged.txt'), await colour(directory, 'staged.txt')], ['A', 'rgb(155, 199, 188)']);
  assert.deepEqual([await mark(directory, 'new name.txt'), await colour(directory, 'new name.txt')], ['R', 'rgb(155, 199, 188)']);
  // A deleted file is gone from the listing, so its folder is what carries the state.
  assert.deepEqual([await mark(directory, 'dropped/'), await colour(directory, 'dropped/')], ['D', 'rgb(230, 140, 140)']);
  // A folder holding a change takes its colour without a badge, and a file git never mentions takes neither.
  assert.deepEqual([
    await mark(directory, 'sub/'),
    await colour(directory, 'sub/'),
    await badge(directory, 'sub/').count(),
  ], ['M', 'rgb(228, 197, 144)', 0]);
  assert.deepEqual([
    await stateOf(directory, 'clean.txt'),
    await badge(directory, 'clean.txt').count(),
  ], [null, 0]);
  assert.deepEqual([await mark(directory, 'loose/'), await colour(directory, 'loose/')], ['U', 'rgb(155, 199, 188)']);
  // The badge names the state to a pointing reader, while the row's accessible name stays the file's own.
  assert.deepEqual([
    await badge(directory, 'kept.txt').innerText(),
    await entry(directory, 'kept.txt').getAttribute('title'),
  ], ['M', 'kept.txt · 已修改']);
  // Opening a changed file draws VS Code's gutter on the lines the change touched.
  await entry(directory, 'kept.txt').click();
  const modified = page.locator('.git-line-modified');
  const added = page.locator('.git-line-added');
  const removed = page.locator('.git-line-deleted');
  await modified.waitFor();
  assert.deepEqual([await added.count(), await modified.count(), await removed.count()], [1, 1, 1]);
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
  await until(async () => (await modified.count()) === 0);
  assert.deepEqual([await added.count(), await removed.count()], [0, 0]);
  // The sidebar comes back from the editor it opened, and a click that arrived while it was still closing is lost, so
  // the column is waited for on show, with the click repeated.
  await until(() => directory.isVisible(), { act: () => backButton(page).click() });
  // A staged change is still a change, so the row keeps its mark until the commit takes it away.
  await until(async () => (await stateOf(directory, 'kept.txt')) === 'M');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'second');
  await until(async () => (await stateOf(directory, 'kept.txt')) === null);
  assert.equal(await badge(directory, 'kept.txt').count(), 0);
  // A level below keeps the marks it has, so a folder is only a way in.
  await entry(directory, 'sub/').click();
  const nested = columnOf(page, join(home, 'sub'));
  await nested.waitFor();
  assert.equal(await mark(nested, 'nested.txt'), 'M');
  assert.equal(await badge(nested, 'nested.txt').innerText(), 'M');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'test/output/screenshots/git-marks.png' });
}));
