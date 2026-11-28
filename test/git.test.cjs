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
  const colour = (column, name) => entry(column, name).evaluate((element) => getComputedStyle(element).color);
  // The marks take the shell's own theme tokens, so the colours are read out of the page rather than written down here.
  const theme = (name) => page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, name);
  const [yellow, green, red] = [await theme('--wc-yellow'), await theme('--wc-green'), await theme('--wc-red')];
  assert.deepEqual([await mark(directory, 'kept.txt'), await colour(directory, 'kept.txt')], ['M', yellow]);
  assert.deepEqual([await mark(directory, 'fresh.txt'), await colour(directory, 'fresh.txt')], ['U', green]);
  assert.deepEqual([await mark(directory, 'staged.txt'), await colour(directory, 'staged.txt')], ['A', green]);
  assert.deepEqual([await mark(directory, 'new name.txt'), await colour(directory, 'new name.txt')], ['R', green]);
  // A deleted file is gone from the listing, so its folder is what carries the state.
  assert.deepEqual([await mark(directory, 'dropped/'), await colour(directory, 'dropped/')], ['D', red]);
  assert.deepEqual([await mark(directory, 'sub/'), await colour(directory, 'sub/')], ['M', yellow]);
  assert.equal(await entry(directory, 'clean.txt').getAttribute('data-git'), null);
  assert.deepEqual([await mark(directory, 'loose/'), await colour(directory, 'loose/')], ['U', green]);
  assert.equal(await entry(directory, 'kept.txt').getAttribute('title'), 'kept.txt · 已修改');
  // A level below keeps the marks it has, so a folder is only a way in.
  await entry(directory, 'sub/').click();
  const nested = columnOf(page, join(home, 'sub'));
  await nested.waitFor();
  assert.equal(await mark(nested, 'nested.txt'), 'M');
  assert.equal(await colour(nested, 'nested.txt'), yellow);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'test/output/screenshots/git-marks.png' });
}));
