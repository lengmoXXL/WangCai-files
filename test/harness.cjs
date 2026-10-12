const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

// The app runs in place, so the adjacent WangCai checkout must already be built.
exports.wangcaiApp = () => {
  const root = resolve(__dirname, '../../WangCai');
  const built = ['desktop/dist/main/index.js', 'desktop/node/bin/node', 'wangcaicli/dist/debug/wangcai'];
  if (!built.every((name) => existsSync(join(root, name)))) throw new Error('build the WangCai checkout next to this repository');
  return root;
};

exports.testEnv = (home) => {
  const env = { ...process.env, HOME: home, WANGCAI_HOME: '', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};

exports.cleanup = (home) => {
  const env = exports.testEnv(home);
  try { execFileSync(join(exports.wangcaiApp(), 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
  try { execFileSync('pkill', ['-f', join(home, 'electron')]); } catch {}
  rmSync(home, { recursive: true, force: true });
};

exports.launchApp = (home, env) => {
  const app = exports.wangcaiApp();
  const { _electron: electron } = require(join(app, 'node_modules/playwright'));
  const desktop = electron.launch({ executablePath: require(join(app, 'node_modules/electron')), args: [join(app, 'desktop'), `--user-data-dir=${join(home, 'electron')}`], cwd: app, env });
  // A run that is interrupted never reaches its own cleanup, so the app and the agent started with this home
  // are stopped by it here instead of being left for the next run to meet.
  process.once('exit', () => exports.cleanup(home));
  process.once('SIGINT', () => { exports.cleanup(home); process.exit(130); });
  process.once('SIGTERM', () => { exports.cleanup(home); process.exit(143); });
  // Steps here take seconds; a shorter default keeps a stuck run from holding the app on screen for half a minute.
  return desktop.then((running) => { running.context().setDefaultTimeout(15000); return running; });
};

exports.writeInit = (home, lists) => {
  const { workspaces = [], tabs = [] } = lists ?? { workspaces: ['terminal-agent'], tabs: ['files', 'terminal'] };
  const entry = (item) => {
    const spec = typeof item === 'string' ? { id: item } : item;
    if (!spec.directory && !spec.repo) {
      const directory = resolve(__dirname, `../../WangCai-${spec.id}`);
      if (existsSync(join(directory, 'main.cjs'))) spec.directory = directory;
    }
    return JSON.stringify(spec);
  };
  mkdirSync(join(home, '.config/wangcai'), { recursive: true });
  writeFileSync(join(home, '.config/wangcai/init.ts'), `export default { workspaces: [${workspaces.map(entry).join(', ')}], tabs: [${tabs.map(entry).join(', ')}] };\n`);
};

exports.run = async (page, line) => {
  await page.locator('.terminal-pane.active .xterm-helper-textarea').focus();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
};

exports.createWorkspace = async (page) => {
  await page.locator('.workspace-header').click({ button: 'right' });
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建 本机', exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('.terminal-pane.active .xterm-rows')?.textContent ?? '').trim().length > 0);
};
