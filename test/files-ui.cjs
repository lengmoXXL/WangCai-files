const { until } = require('@lengmoxxl/wangcai-testkit');

// What a case does to the window's own chrome.
//
// The menu that makes a workspace is the space under the rows: the rows have to end above the list's bottom edge, so the
// click lands on the list rather than on a row.
const openWorkspaceMenu = async (page) => {
  const list = page.locator('.workspaces');
  const box = await list.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 4, { button: 'right' });
};

/** Waits until the terminal in front draws that text, which it does once the shell has written it. */
const terminalShows = (page, text) => page.locator('.terminal-pane.active .xterm-screen').filter({ hasText: text }).waitFor();

/** Opens a local workspace, and waits for the shell its pane draws a moment after the workspace appears. */
const createWorkspace = async (page) => {
  await openWorkspaceMenu(page);
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建 本机', exact: true }).click();
  await terminalShows(page, /\S/);
};

/** Opens a view in the sidebar, showing the sidebar first when it is off screen. */
const openView = async (page, name) => {
  const newTab = page.getByRole('button', { name: '新建侧栏标签页' });
  if (!(await newTab.isVisible())) await page.getByRole('button', { name: '切换右侧栏' }).click();
  await newTab.click();
  await page.locator('#view-menu').getByRole('button', { name, exact: true }).click();
};

// The machine the window works on, which is the one a case's paths are read from.
const machine = { id: 'local', name: '本机' };

// What a case's window lists: the workspace a directory link comes from, and the editor a file is handed to.
const lists = { workspaces: ['terminal-agent'], tabs: ['files', 'editor'] };

// The columns the panel lays out, one per directory of the path it shows, a column's entries as buttons, and the note an
// empty directory shows in place of them.
const columns = (page) => page.locator('.file-column');
const columnOf = (page, path) => page.getByRole('navigation', { name: path, exact: true });
const entry = (column, name) => column.getByRole('button', { name, exact: true });
const emptyDirectory = (page) => page.getByText('空目录', { exact: true });

// The sidebar's own tabs, as the window draws them, plus the panel on show in the right sidebar and every panel of this
// plugin, hidden ones included.
const viewTab = (page, name) => page.getByRole('tablist', { name: '侧栏标签页' }).getByRole('tab', { name, exact: true });
const filesTab = (page) => viewTab(page, '文件');
const editorTab = (page) => viewTab(page, '编辑器');
const shownPanel = (page) => page.locator('.sidebar-panel:visible');
const filesPanels = (page) => page.locator('.sidebar-panel[data-plugin=files]');

// The message the editor shows for a path it cannot read, which is where clicking one here ends up.
const alert = (page) => page.getByRole('alert');

// A file or directory link clicked in a terminal, which is the event a file of a column is sent on as well.
const clickFile = (page, file) => page.evaluate((click) => window.wangcai.call('publish', 'onclick', click), file);

// A workspace and this panel of it, which is the state most of these cases start from.
const openFilesWorkspace = async (page) => {
  await createWorkspace(page);
  await openView(page, '文件');
};

// Reading a file through the editor, whose panel is the one the file was handed to.
const editorLines = (scope) => scope.locator('.monaco-editor .view-lines');
const codeView = (scope, text) => editorLines(scope).filter({ hasText: text });

// The address box in the editor's header, and the path it shows once the panel has taken one in.
const pathBox = (scope) => scope.getByRole('textbox', { name: '路径', exact: true });
const waitForPath = (scope, path) => until(async () => (await pathBox(scope).first().inputValue()) === path);

// The row the keys stand on.
const cursor = (page) => page.locator('.file-list button[data-cursor]');

// The label of a row.
const label = (row) => row.locator('.file-name');

// What the cursor holds: the name it shows and the column that lists it.
const held = async (page) => [
  await label(cursor(page)).innerText(),
  await cursor(page).evaluate((element) => element.closest('nav').getAttribute('aria-label')),
];

// The box `/` opens over the path bar, its field, and the count it shows.
const searchBox = (page) => page.locator('.file-search');
const searchField = (page) => searchBox(page).getByRole('textbox', { name: '搜索', exact: true });
const searchCount = (page) => searchBox(page).locator('.file-search-count').innerText();

// The path bar over the columns: the base path it names, and the button that puts it back on the workspace.
const baseBar = (page) => page.locator('.file-header');
const basePath = (page) => page.locator('.file-base');
const resetBase = (page) => baseBar(page).getByRole('button', { name: '回到工作区', exact: true });

// The row of columns, which is the pane a widened column scrolls in.
const columnRow = (page) => page.locator('.file-column-row');

// The names one column lists, in the order it lists them.
const names = (column) => label(column).evaluateAll((elements) => elements.map((element) => element.innerText));

// The handle on a column's right edge, which the mouse drags to widen it.
const resizeHandle = (column) => column.locator('.file-resize');

// How wide a column is drawn, which that drag changes.
const width = (column) => column.evaluate((element) => element.getBoundingClientRect().width);

// An entry of a column, waited for by the mark it carries rather than by the listing it came with.
const mark = async (column, name) => {
  let letter;
  await until(async () => (letter = await entry(column, name).getAttribute('data-git')) !== null);
  return letter;
};

module.exports = {
  machine,
  lists,
  columns,
  columnOf,
  entry,
  emptyDirectory,
  filesTab,
  editorTab,
  shownPanel,
  filesPanels,
  alert,
  clickFile,
  openFilesWorkspace,
  codeView,
  waitForPath,
  cursor,
  label,
  held,
  searchBox,
  searchField,
  searchCount,
  baseBar,
  basePath,
  resetBase,
  columnRow,
  names,
  resizeHandle,
  width,
  mark,
};
