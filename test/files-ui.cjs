const { createWorkspace, openView, until } = require('@lengmoxxl/wangcai-testkit');

// The machine the window works on, which is the one a case's paths are read from.
const machine = { id: 'local', name: '本机' };

// What a case's window lists: the workspace a file link comes from, and the views the sidebar picks from.
const lists = { workspaces: ['terminal-agent'], tabs: ['files', 'terminal'] };

// A list redraws as the app reports, which can take away the row a drag starts from between the wait that found it and
// the move that needs it, so a box is asked for again until one comes back.
const boxOf = async (locator) => {
  let locatorBox;
  await until(async () => (locatorBox = await locator.boundingBox()) !== null);
  return locatorBox;
};

// The terminal the workspace's session runs in: when it has drawn anything, a line of its output, which is where a
// link in it is clicked, and the line a command is typed into.
const terminalUp = (pane) => pane.locator('.xterm-rows').filter({ hasText: /\S/ }).waitFor();
const terminalRow = (pane, text) => pane.locator('.xterm-rows > div').filter({ hasText: text }).first();
const runIn = async (pane, line) => {
  const page = pane.page();
  await pane.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
};

// The columns the panel lays out, one per directory of the path it shows, a column's entries as buttons, and the
// note an empty directory shows in place of them.
const columns = (page) => page.locator('.file-column');
const columnOf = (page, path) => page.getByRole('navigation', { name: path, exact: true });
const entry = (column, name) => column.getByRole('button', { name, exact: true });
const emptyDirectory = (page) => page.getByText('空目录', { exact: true });

// The window's tab strips: a tab per workspace on the left, and the sidebar's own tabs on the right.
const workspaceBar = (page) => page.locator('.workspaces');
const workspaceTabs = (page) => workspaceBar(page).getByRole('tab');
const viewTab = (page, name) => page.getByRole('tablist', { name: '侧栏标签页' }).getByRole('tab', { name, exact: true });
const filesTab = (page) => viewTab(page, '文件');

// Every sidebar tab, hidden ones included, which is what their styles are read off; the one that is selected; the
// close button each of the drawn ones carries; and closing a named tab through the name its button is announced by.
const sidebarTabs = (page) => page.locator('.sidebar-tab');
const selectedViewTab = (page) => sidebarTabs(page).filter({ has: page.locator('[aria-selected=true]') });
const drawnCloseButtons = (page) => sidebarTabs(page).filter({ visible: true }).locator('.close-tab');
const closeTab = (page, name) => page.getByRole('button', { name: `关闭 ${name}`, exact: true });

// The window's two sidebars and the pane between them, plus the panel on show in the right one and every panel of
// this plugin, hidden ones included.
const sidebarLeft = (page) => page.locator('.sidebar-left');
const sidebarRight = (page) => page.locator('.sidebar-right');
const desktopMain = (page) => page.locator('.desktop-main');
const shownPanel = (page) => page.locator('.sidebar-panel:visible');
const filesPanels = (page) => page.locator('.sidebar-panel[data-plugin=files]');

// The two sections the plugin draws: the file it previews, and the picker for choosing one.
const filePreview = (page) => page.getByLabel('文件预览', { exact: true });
const filePicker = (page) => page.getByLabel('文件选择', { exact: true });

// The page a panel renders, waited for by the heading that page carries.
const renderedPage = (scope, name) => scope.getByRole('heading', { name });

// The window's errors, which the cases collect and assert are empty.
const collectErrors = (page, errors) => {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
};

// What the app keeps as it runs: the workspaces it has open, and the history the files plugin has stored for them.
const openWorkspaces = (page) => page.evaluate(async () => (await window.wangcai.call('request', 'terminal-agent', 'config')).workspaces);
const storedHistory = (page) => page.evaluate(() => window.wangcai.call('request', 'files', 'history'));

// A file link clicked in a terminal. The plugin subscribes as it mounts, so a click sent before that is gone.
const clickFile = (page, file) => page.evaluate((click) => window.wangcai.call('publish', 'onclick', click), file);

// The parts of a panel that shows a page: the mode button, the page it renders, the block inside that page which
// scrolls sideways, the pane both sit in, and the divider the page is dragged by.
const modeButton = (panel) => panel.locator('.preview-mode');
const markdownPage = (panel) => panel.locator('.markdown-preview');
const markdownScroll = (panel) => markdownPage(panel).locator('pre');
const markdownPane = (panel) => panel.locator('.markdown-pane');
const markdownDivider = (panel) => panel.locator('.markdown-divider');

// The menu a panel's switch opens, the modes it lists, and the switch to one of them.
const previewMenu = (panel) => panel.getByRole('menu', { name: '预览方式' });
const previewModes = async (panel) => {
  await modeButton(panel).click();
  return previewMenu(panel).getByRole('menuitem').allInnerTexts();
};
const previewMode = async (panel, mode) => {
  const modes = await previewModes(panel);
  await previewMenu(panel).getByRole('menuitem', { name: mode, exact: true }).click();
  return modes;
};

// The panel the 文件 tab shows, and the address box above it.
const filesTabPanel = (page) => page.getByRole('tabpanel', { name: '文件' });
const pathBox = (scope) => scope.getByRole('textbox', { name: '路径', exact: true });

// Pointing the panel at a path: the address box takes it and the panel reads that directory, and the entry form waits
// for that column to show the named entry.
const goToPath = async (scope, path) => {
  const box = pathBox(scope);
  await box.fill(path);
  await box.press('Enter');
};
const goToPathEntry = async (scope, path, name) => {
  await goToPath(scope, path);
  await entry(columnOf(scope, path), name).waitFor();
};

// The address box shows a path once the panel has taken it in.
const waitForPath = (scope, path) => until(async () => (await pathBox(scope).inputValue()) === path);

// The code a panel's editor shows, as monaco draws it line by line.
const editorLines = (scope) => scope.locator('.monaco-editor .view-lines');
const codeView = (scope, text) => editorLines(scope).filter({ hasText: text });

// The buttons of a panel's header.
const backButton = (page) => page.getByRole('button', { name: '后退', exact: true });
const forwardButton = (page) => page.getByRole('button', { name: '前进', exact: true });
const refreshButton = (page) => page.getByRole('button', { name: '刷新', exact: true });

// The right sidebar is shown and hidden by its own button, and added to from the button beside it.
const sidebarToggle = (page) => page.getByRole('button', { name: '切换右侧栏' });
const newSidebarTab = (page) => page.getByRole('button', { name: '新建侧栏标签页' });

// The menu a view is picked from, once that button has opened it.
const viewMenu = (page) => page.locator('#view-menu');

// A workspace and the files panel of it, which is the state most of these cases start from.
const openFilesWorkspace = async (page) => {
  await createWorkspace(page);
  await openView(page, '文件');
};

// Closes a workspace through the row's own menu, the way a person does.
const closeWorkspace = async (tab) => {
  await tab.click({ button: 'right' });
  await tab.page().getByRole('menuitem', { name: '关闭工作区', exact: true }).click();
};

module.exports = {
  machine,
  lists,
  boxOf,
  terminalUp,
  terminalRow,
  runIn,
  columns,
  columnOf,
  entry,
  emptyDirectory,
  workspaceBar,
  workspaceTabs,
  viewTab,
  filesTab,
  sidebarTabs,
  selectedViewTab,
  drawnCloseButtons,
  closeTab,
  sidebarLeft,
  sidebarRight,
  desktopMain,
  shownPanel,
  filesPanels,
  filePreview,
  filePicker,
  renderedPage,
  collectErrors,
  openWorkspaces,
  storedHistory,
  clickFile,
  modeButton,
  markdownPage,
  markdownScroll,
  markdownPane,
  markdownDivider,
  previewMenu,
  previewModes,
  previewMode,
  filesTabPanel,
  pathBox,
  goToPath,
  goToPathEntry,
  waitForPath,
  editorLines,
  codeView,
  backButton,
  forwardButton,
  refreshButton,
  sidebarToggle,
  newSidebarTab,
  viewMenu,
  openFilesWorkspace,
  closeWorkspace,
};
