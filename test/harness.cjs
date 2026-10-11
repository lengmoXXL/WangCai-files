const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
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

exports.launchApp = (home, env) => {
  const app = exports.wangcaiApp();
  const { _electron: electron } = require(join(app, 'node_modules/playwright'));
  return electron.launch({ executablePath: require(join(app, 'node_modules/electron')), args: [join(app, 'desktop'), `--user-data-dir=${join(home, 'electron')}`], cwd: app, env });
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
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '本机', exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('.terminal-pane.active .xterm-rows')?.textContent ?? '').trim().length > 0);
};
