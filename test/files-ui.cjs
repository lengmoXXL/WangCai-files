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

// The row of output a terminal drew, which is where a link in it is clicked.
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

// The line the caret is drawn on: monaco gives the caret the offset of the line it sits in, and draws only the lines
// its viewport holds, so the caret's line is the one whose offset it shares.
const cursorLine = (page) => page.evaluate(() => {
  const caret = document.querySelector('.code-preview .cursors-layer > .cursor');
  const top = caret && getComputedStyle(caret).top;
  const line = [...document.querySelectorAll('.code-preview .view-line')].find((element) => getComputedStyle(element).top === top);
  return line ? line.textContent.replace(/\u00a0/g, ' ') : null;
});
const waitForLine = (page, text) => until(async () => (await cursorLine(page)) === text);

// The buttons of a panel's header.
const backButton = (page) => page.getByRole('button', { name: '后退', exact: true });
const forwardButton = (page) => page.getByRole('button', { name: '前进', exact: true });
const refreshButton = (page) => page.getByRole('button', { name: '刷新', exact: true });

// The right sidebar is shown and hidden by its own button, and added to from the button beside it.
const sidebarToggle = (page) => page.getByRole('button', { name: '切换右侧栏' });
const newSidebarTab = (page) => page.getByRole('button', { name: '新建侧栏标签页' });

// The menu a view is picked from, once that button has opened it.
const viewMenu = (page) => page.locator('#view-menu');

// The search picker a panel opens: the panel it draws in, the input a query goes into, the rows it found, the note it
// shows, and the message a search for files shows when it finds none.
const searchPanel = (scope) => scope.getByRole('dialog', { name: '搜索' });
const searchInput = (scope) => searchPanel(scope).getByRole('textbox', { name: '搜索' });
const searchRows = (scope) => searchPanel(scope).locator('.search-row');
const searchRow = (scope, text) => searchRows(scope).filter({ hasText: text }).first();
const searchNote = (scope) => searchPanel(scope).locator('.search-note');
const filesEmpty = (scope) => searchPanel(scope).getByText('没有匹配的文件', { exact: true });
// What a row prints: its title, and the folder or container beside it. Both take the scope to look in, which is the
// panel or one row.
const searchTitle = (scope) => scope.locator('.search-title');
const searchDetail = (scope) => scope.locator('.search-detail');
// The characters the picker marked in a row: the ones the query matched in the title, and in the folder beside it.
const searchMarks = async (row) => ({
  title: await searchTitle(row).locator('b').allInnerTexts(),
  detail: await searchDetail(row).locator('b').allInnerTexts(),
});

// The picker opened from the panel's header, with nothing in it yet.
const openSearch = async (scope) => {
  await scope.getByRole('button', { name: '搜索', exact: true }).click();
  await searchPanel(scope).waitFor();
};

// Enter opens the row under the selection, which closes the picker.
const submitSearch = async (scope) => {
  await searchInput(scope).press('Enter');
  await searchPanel(scope).waitFor({ state: 'detached' });
};

// Escape leaves the picker without opening anything.
const dismissSearch = async (scope) => {
  await searchInput(scope).press('Escape');
  await searchPanel(scope).waitFor({ state: 'detached' });
};

// The picker opened with a query in it, waited for its rows: a search answers a moment after the query is typed.
const search = async (scope, query) => {
  await openSearch(scope);
  await searchInput(scope).fill(query);
  await until(async () => (await searchRows(scope).count()) > 0);
};

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
  cursorLine,
  waitForLine,
  backButton,
  forwardButton,
  refreshButton,
  sidebarToggle,
  newSidebarTab,
  viewMenu,
  searchPanel,
  searchInput,
  searchRows,
  searchRow,
  searchNote,
  filesEmpty,
  searchTitle,
  searchDetail,
  searchMarks,
  openSearch,
  submitSearch,
  dismissSearch,
  search,
  openFilesWorkspace,
  closeWorkspace,
};
