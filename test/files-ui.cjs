const { createWorkspace, openView, until } = require('@lengmoxxl/wangcai-testkit');

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
  mark,
};
