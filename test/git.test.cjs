const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withWindow } = require('@lengmoxxl/wangcai-testkit');
const { columnOf, entry, lists, mark, openFilesWorkspace } = require('./files-ui.cjs');

test('the columns mark git changes the way VS Code does', { timeout: 180000 }, () => withWindow('wangcai-git', lists, async ({ home, page, errors }) => {
  const git = (...args) => execFileSync('git', args, { cwd: home, encoding: 'utf8' });
  // One repository holding a modified, an added, a renamed, an untracked, a deleted and an untouched path, and folders
  // over some of them.
  mkdirSync(join(home, 'sub'));
  mkdirSync(join(home, 'dropped'));
  writeFileSync(join(home, 'clean.txt'), 'none\n');
  writeFileSync(join(home, 'kept.txt'), 'line1\nline2\n');
  writeFileSync(join(home, 'dropped/dropped.txt'), 'two\n');
  writeFileSync(join(home, 'old name.txt'), 'three\n');
  writeFileSync(join(home, 'sub/nested.txt'), 'four\n');
  git('init', '-q');
  // The window keeps its own profile in the same home and writes to it the whole time, so git is told to skip it.
  writeFileSync(join(home, '.git/info/exclude'), 'electron/\n');
  git('add', '-A');
  // A commit is the only call that reads an identity.
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'first');
  writeFileSync(join(home, 'kept.txt'), 'line1\nline2 changed\n');
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
  const colour = (column, name) => entry(column, name).locator('.file-name').evaluate((element) => getComputedStyle(element).color);
  const badge = (column, name) => entry(column, name).locator('.file-git');
  assert.deepEqual([await mark(directory, 'kept.txt'), await colour(directory, 'kept.txt')], ['M', 'rgb(228, 197, 144)']);
  assert.deepEqual([await mark(directory, 'fresh.txt'), await colour(directory, 'fresh.txt')], ['U', 'rgb(155, 199, 188)']);
  assert.deepEqual([await mark(directory, 'staged.txt'), await colour(directory, 'staged.txt')], ['A', 'rgb(155, 199, 188)']);
  assert.deepEqual([await mark(directory, 'new name.txt'), await colour(directory, 'new name.txt')], ['R', 'rgb(155, 199, 188)']);
  // A deleted file is gone from the listing, so its folder is what carries the state.
  assert.deepEqual([await mark(directory, 'dropped/'), await colour(directory, 'dropped/')], ['D', 'rgb(230, 140, 140)']);
  // A folder holding a change takes its colour without a badge, and a file git never mentions takes neither.
  assert.deepEqual([await mark(directory, 'sub/'), await colour(directory, 'sub/'), await badge(directory, 'sub/').count()], ['M', 'rgb(228, 197, 144)', 0]);
  assert.deepEqual([await stateOf(directory, 'clean.txt'), await badge(directory, 'clean.txt').count()], [null, 0]);
  assert.deepEqual([await mark(directory, 'loose/'), await colour(directory, 'loose/')], ['U', 'rgb(155, 199, 188)']);
  // The badge names the state to a pointing reader, while the row's accessible name stays the file's own.
  assert.deepEqual([await badge(directory, 'kept.txt').innerText(), await entry(directory, 'kept.txt').getAttribute('title')], ['M', 'kept.txt · 已修改']);
  // A level below keeps the marks it has, so a folder is only a way in.
  await entry(directory, 'sub/').click();
  const nested = columnOf(page, join(home, 'sub'));
  await nested.waitFor();
  assert.equal(await mark(nested, 'nested.txt'), 'M');
  assert.equal(await badge(nested, 'nested.txt').innerText(), 'M');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'test/output/screenshots/git-marks.png' });
}));
