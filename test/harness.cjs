const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');

// The app runs in place, so the adjacent WangCai checkout must already be built.
exports.wangcaiApp = () => {
  const root = resolve(__dirname, '../../WangCai');
  const built = ['desktop/dist/main/index.js', 'desktop/node/bin/node', 'wangcaicli/dist/debug/wangcai'];
  if (!built.every((name) => existsSync(join(root, name)))) throw new Error('build the WangCai checkout next to this repository');
  return root;
};

// Core is what the app installs and builds into a home, so a case that started from an empty one would clone and
// build it on every run. The developer's prepared build is copied in instead; WANGCAI_CORE_SOURCE names another.
const coreSource = process.env.WANGCAI_CORE_SOURCE ?? join(homedir(), '.wangcai-dev/.local/share/wangcai/core-src');

const installCore = (home) => {
  const build = join(coreSource, 'dist');
  if (!existsSync(join(build, 'main.cjs'))) throw new Error(`no Core build at ${build}: build the checkout at ${coreSource}, or set WANGCAI_CORE_SOURCE to one that is built`);
  const storage = join(home, '.local/share/wangcai');
  mkdirSync(storage, { recursive: true });
  cpSync(build, join(storage, 'core'), { recursive: true });
  // The snapshot an agent reads is taken from these sources, so a case gets them as the app's own install would.
  for (const entry of ['main', 'ui']) cpSync(join(coreSource, entry), join(storage, 'core-src', entry), { recursive: true });
};

exports.testEnv = (home) => {
  const env = { ...process.env, HOME: home, WANGCAI_HOME: '', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  // The agent Core would install from a release is taken from this checkout instead, so a case needs no network.
  env.WANGCAI_AGENT_SOURCE = join(exports.wangcaiApp(), 'wangcaicli/dist/debug/wangcai');
  return env;
};

exports.cleanup = (home) => {
  const env = exports.testEnv(home);
  try { execFileSync(join(exports.wangcaiApp(), 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
  try { execFileSync('pkill', ['-f', join(home, 'electron')]); } catch {}
  rmSync(home, { recursive: true, force: true });
};

const launchApp = (home, env) => {
  const app = exports.wangcaiApp();
  // A case starts from a home that already holds Core, so no window has to report an install first.
  installCore(home);
  const { _electron: electron } = require(join(app, 'node_modules/playwright'));
  // The window never takes the focus, so a run does not pull the developer out of what they are doing.
  const desktop = electron.launch({ executablePath: require(join(app, 'node_modules/electron')), args: [join(app, 'desktop'), '--unfocused', `--user-data-dir=${join(home, 'electron')}`], cwd: app, env });
  // A run that is interrupted never reaches its own cleanup, so the app and the agent started with this home
  // are stopped by it here instead of being left for the next run to meet.
  process.once('exit', () => exports.cleanup(home));
  process.once('SIGINT', () => { exports.cleanup(home); process.exit(130); });
  process.once('SIGTERM', () => { exports.cleanup(home); process.exit(143); });
  // Steps here take seconds; a shorter default keeps a stuck run from holding the app on screen for half a minute.
  return desktop.then((running) => { running.context().setDefaultTimeout(15000); return running; });
};

exports.openWindow = async (home, env) => {
  const desktop = await launchApp(home, env);
  return { desktop, window: await desktop.firstWindow() };
};

// The test replaces both handles, so anything the reopen needs in place is set up before it, in the env it launches with.
exports.reopen = async (desktop, home, env) => {
  await desktop.close();
  return exports.openWindow(home, env);
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

// The terminal the workspace's session runs in: what it has drawn, the line a command is typed into, and a line of
// its output, which is where a link in it is clicked.
exports.activeTerminal = (page) => page.locator('.terminal-pane.active');
exports.terminalUp = (pane) => pane.locator('.xterm-rows').filter({ hasText: /\S/ }).waitFor();
exports.terminalRow = (pane, text) => pane.locator('.xterm-rows > div').filter({ hasText: text }).first();
exports.run = async (pane, line) => {
  const page = pane.page();
  await pane.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
};

// A reaction to a step the app takes arrives late, and one asked for too early is gone, so a step that waits for a
// reaction repeats its act until the predicate holds. A step with nothing to repeat only waits.
exports.until = async (holds, { act, attempts = 20, interval = 250 } = {}) => {
  for (let attempt = 0; attempt < attempts && !(await holds()); attempt++) {
    if (act) await act();
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  assert.ok(await holds(), 'the app did not react');
};

// The columns the panel lays out, one per directory of the path it shows, and a column's entries as buttons.
exports.columns = (page) => page.locator('.file-column');
exports.columnOf = (page, path) => page.getByRole('navigation', { name: path, exact: true });
exports.entry = (column, name) => column.getByRole('button', { name, exact: true });
exports.emptyDirectory = (page) => page.getByText('空目录', { exact: true });

// The window's tab strips: a tab per workspace on the left, and the sidebar's own tabs on the right.
exports.workspaceBar = (page) => page.locator('.workspaces');
exports.workspaceTabs = (page) => exports.workspaceBar(page).getByRole('tab');
exports.selectedWorkspace = (page) => page.locator('.workspace.selected');
exports.agentState = (page, state) => page.locator(`.workspaces .workspace .agent-state[data-state=${state}]`);
const viewStrip = (page) => page.getByRole('tablist', { name: '侧栏标签页' });
exports.viewTabs = (page) => viewStrip(page).getByRole('tab');
exports.viewTab = (page, name) => viewStrip(page).getByRole('tab', { name, exact: true });
exports.filesTab = (page) => exports.viewTab(page, '文件');

// The sidebar tabs as the window draws them, which is what their styles are read off, the one that is selected, and
// the close button each one carries.
exports.sidebarTabs = (page) => page.locator('.sidebar-tab');
exports.selectedViewTab = (page) => page.locator('.sidebar-tab:has([aria-selected=true])');
exports.closeTabs = (page) => page.locator('.sidebar-tab:visible .close-tab');
exports.closeTab = (page, name) => page.getByRole('button', { name: `关闭 ${name}`, exact: true });

// The window's two sidebars and the pane between them, plus the panel on show in the right one and every panel of
// this plugin, hidden ones included.
exports.sidebarLeft = (page) => page.locator('.sidebar-left');
exports.sidebarRight = (page) => page.locator('.sidebar-right');
exports.desktopMain = (page) => page.locator('.desktop-main');
exports.shownPanel = (page) => page.locator('.sidebar-panel:visible');
exports.filesPanels = (page) => page.locator('.sidebar-panel[data-plugin=files]');

// The two sections the plugin draws: the file it previews, and the picker for choosing one.
exports.filePreview = (page) => page.getByLabel('文件预览', { exact: true });
exports.filePicker = (page) => page.getByLabel('文件选择', { exact: true });

// The page a panel renders, waited for by the heading that page carries.
exports.renderedPage = (scope, name) => scope.getByRole('heading', { name });

// What the window reports as errors, which the tests collect and assert is empty.
exports.collectErrors = (page, errors) => {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
};

// What the app keeps as it runs: the workspaces it has open, and the history the files plugin has stored for them.
exports.openWorkspaces = (page) => page.evaluate(async () => (await window.wangcai.call('request', 'terminal-agent', 'config')).workspaces);
exports.storedHistory = (page) => page.evaluate(() => window.wangcai.call('request', 'files', 'history'));

// A file link clicked in a terminal. The plugin subscribes as it mounts, so a click sent before that is gone.
exports.clickFile = (page, file) => page.evaluate((click) => window.wangcai.call('publish', 'onclick', click), file);

// The parts of a panel that shows a page: the mode button, the page it renders, the block inside that page which
// scrolls sideways, the pane both sit in, and the divider the page is dragged by.
exports.modeButton = (panel) => panel.locator('.preview-mode');
exports.markdownPage = (panel) => panel.locator('.markdown-preview');
exports.markdownScroll = (panel) => exports.markdownPage(panel).locator('pre');
exports.markdownPane = (panel) => panel.locator('.markdown-pane');
exports.markdownDivider = (panel) => panel.locator('.markdown-divider');

// The modes a panel offers, and the switch to one of them: its mode button opens the menu they are listed in.
exports.previewMenu = (panel) => panel.getByRole('menu', { name: '预览方式' });
exports.previewModes = async (panel) => {
  await exports.modeButton(panel).click();
  return exports.previewMenu(panel).getByRole('menuitem').allInnerTexts();
};
exports.previewMode = async (panel, mode) => {
  const modes = await exports.previewModes(panel);
  await exports.previewMenu(panel).getByRole('menuitem', { name: mode, exact: true }).click();
  return modes;
};

// The panel of this plugin, and the address box inside one.
exports.filesPanel = (page) => page.getByRole('tabpanel', { name: '文件' });
exports.pathBox = (scope) => scope.getByRole('textbox', { name: '路径', exact: true });

// Pointing the panel at a path: the address box takes it and the panel reads that directory.
exports.goToPath = async (scope, path) => {
  const box = exports.pathBox(scope);
  await box.fill(path);
  await box.press('Enter');
};

exports.goToPathEntry = async (scope, path, name) => {
  await exports.goToPath(scope, path);
  await exports.entry(exports.columnOf(scope, path), name).waitFor();
};

// The address box shows a path once the panel has taken it in.
exports.waitForPath = (scope, path) => exports.until(async () => (await exports.pathBox(scope).inputValue()) === path, { attempts: 60, interval: 250 });

// The code a panel's editor shows, as monaco draws it line by line.
exports.editorLines = (scope) => scope.locator('.monaco-editor .view-lines');
exports.codeView = (scope, text) => exports.editorLines(scope).filter({ hasText: text });

// The buttons of a panel's header.
exports.backButton = (page) => page.getByRole('button', { name: '后退', exact: true });
exports.forwardButton = (page) => page.getByRole('button', { name: '前进', exact: true });
exports.refreshButton = (page) => page.getByRole('button', { name: '刷新', exact: true });

// The right sidebar is shown and hidden by its own button, and added to from the button beside it.
exports.sidebarToggle = (page) => page.getByRole('button', { name: '切换右侧栏' });
exports.newSidebarTab = (page) => page.getByRole('button', { name: '新建侧栏标签页' });

// The menu a view is picked from, once that button has opened it.
exports.viewMenu = (page) => page.locator('#view-menu');
exports.openView = async (page, name) => {
  await exports.newSidebarTab(page).click();
  await exports.viewMenu(page).getByRole('button', { name, exact: true }).click();
};

// The files panel is a tab of the right sidebar.
exports.openFilesTab = (page) => exports.openView(page, '文件');

// Whether the sidebar is closed already depends on the workspace on show.
exports.openFilesPanel = async (page) => {
  const picker = exports.newSidebarTab(page);
  await exports.until(() => picker.isVisible(), { act: () => exports.sidebarToggle(page).click() });
  await exports.openFilesTab(page);
};

exports.closeWorkspace = async (tab) => {
  await tab.click({ button: 'right' });
  await tab.page().getByRole('menuitem', { name: '关闭工作区', exact: true }).click();
};

exports.createWorkspace = async (page) => {
  await page.locator('.workspace-header').click({ button: 'right' });
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建 本机', exact: true }).click();
  await exports.terminalUp(exports.activeTerminal(page));
};

exports.openFilesWorkspace = async (page) => {
  await exports.createWorkspace(page);
  await exports.openFilesPanel(page);
};
