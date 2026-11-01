import { createRoot } from 'react-dom/client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DirectoryEntry, WorkspaceActive } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { type FileClick, type Font, type GitStatus, type Settings } from './shared';
import './style.css';

// What the tab is called, and the id the window remembers it by when it opens it again.
const identity = { id: 'directory', title: '文件' };
export const title = identity.title;
let activeWorkspaceId: string | undefined;
let font: Font;

// A directory, which is the only kind of entry a tab here shows: a file is handed to the editor instead.
type Directory = Omit<FileClick, 'type'> & { type: 'directory' };

// One tab: the directory its columns start from, and the call that draws it, which `openTab` fills in once the mount has
// a root and hands back to the window as the tab's `onSelect`. A window keeps one tab per workspace, so this is what a
// workspace's browsing has of its own.
type Tab = { shown?: Directory; paint: () => void };
const tabs = new Map<string, Tab>();
// A directory can be sent before its tab was opened, since the sender asks for the tab after sending it: it waits
// here, per workspace, for the tab that will show it.
const waiting = new Map<string, Directory>();

const watch = (context: UiContext, machine: FileClick['machine'], holder: string, paths: string[], act: (path: string) => void) => {
  // The plugin can be disposed before either request lands, and the machine can be gone; neither is worth a pageerror.
  void context.ui.request('watch', { holder, machine, paths }).catch(() => undefined);
  const off = context.ui.subscribe<string>('changed', (path) => { if (paths.includes(path)) act(path); });
  return () => { off(); void context.ui.request('watch', { holder, machine, paths: [] }).catch(() => undefined); };
};

// The directory chain from what the path and the workspace have in common down to the path itself: the picker gives
// every level a column of its own.
function chain(path: string, workspace: string) {
  const directories: string[] = [];
  let current = path;
  for (; ; ) {
    directories.push(current);
    if (current === '/' || workspace === current || workspace.startsWith(`${current}/`)) return directories.reverse();
    current = current.slice(0, current.lastIndexOf('/')) || '/';
  }
}

// Which child a folder takes its state from when several of them changed: the conflict first, the untracked last.
const gitRanks: Record<string, number> = { '!': 0, D: 1, M: 2, T: 3, A: 4, R: 5, C: 6, U: 7 };

// A changed path's own letter, plus the most severe letter among its changed descendants for each folder above it.
function markFolders({ root, states }: GitStatus) {
  const marks = new Map<string, string>();
  for (const [path, letter] of Object.entries(states)) {
    const file = `${root === '/' ? '' : root}/${path}`;
    marks.set(file, letter);
    for (let directory = file.slice(0, file.lastIndexOf('/')) || '/'; directory.length > root.length; directory = directory.slice(0, directory.lastIndexOf('/')) || '/') {
      const held = marks.get(directory);
      if (!held || gitRanks[letter] < gitRanks[held]) marks.set(directory, letter);
    }
  }
  return marks;
}

const gitLabels: Record<string, string> = { M: '已修改', A: '已新增', D: '已删除', R: '已重命名', C: '已复制', T: '类型已更改', U: '未跟踪', '!': '有冲突' };

function Picker({ context, directory, workspace, holder, navigate }: { context: UiContext; directory: Directory; workspace: string; holder: string; navigate: (file: FileClick) => void }) {
  const [entries, setEntries] = useState(new Map<string, DirectoryEntry[]>());
  const [error, setError] = useState('');
  const [dropped, setDropped] = useState(0);
  // Columns to read again: one is read again when the machine reports a change in it, and the listing already on
  // screen stays until the new one is in, so a directory that changes often does not blink.
  const [stale, setStale] = useState(new Set<string>());
  // Marks move with anything on disk, a column or the repository, so their read counts the changes this watch reports.
  const [changes, setChanges] = useState(0);
  const [git, setGit] = useState<{ workspace: string; root: string; marks: Map<string, string> }>();
  const pane = useRef<HTMLDivElement>(null);
  const directories = chain(directory.path, workspace);
  // `entries` and `directories` are left out of the dependencies on purpose: they only say which columns this pass reads,
  // and what comes back is stored in them, so depending on them would read a column again for every column read.
  useEffect(() => {
    let alive = true;
    setError('');
    const reading = directories.filter((column) => !entries.has(column) || stale.has(column));
    for (const column of reading) {
      void context.ui.request<{ path: string; entries: DirectoryEntry[] }>('list', { machine: directory.machine, path: column })
        .then((listing) => {
          if (!alive) return;
          setEntries((current) => new Map(current).set(column, listing.entries));
          // A mark is spent by the read it asked for, so a pass that runs for another reason reads nothing again.
          setStale((current) => {
            if (!current.has(column)) return current;
            const next = new Set(current);
            next.delete(column);
            return next;
          });
        })
        .catch((problem: Error) => { if (alive) setError(problem.message); });
    }
    return () => { alive = false; };
  }, [context, directory, workspace, stale]);
  // The marks belong to the repository rather than to the columns, so they are read in a request of their own.
  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    void context.ui.request<GitStatus | null>('git-status', { machine: directory.machine, path: workspace })
      .then((status) => { if (alive) setGit({ workspace, root: status?.root ?? '', marks: status ? markFolders(status) : new Map() }); })
      .catch(() => { if (alive) setGit({ workspace, root: '', marks: new Map() }); });
    return () => { alive = false; };
  }, [context, directory, workspace, changes]);
  // The watch follows the whole chain, columns and the repository once its root is known, so a change on disk reaches
  // the column it belongs to and the marks.
  const repository = git?.root ? `${git.root}/.git` : '';
  useEffect(() => watch(context, directory.machine, holder, repository ? [...directories, repository] : directories, (path) => {
    setChanges((count) => count + 1);
    // The repository is here for the marks alone, and `stale` holds the columns.
    if (path !== repository) setStale((current) => new Set(current).add(path));
  }), [context, directory, workspace, holder, repository]);
  // The columns a chain dropped are offered their room again when the chain changes, since another chain packs
  // differently.
  useEffect(() => setDropped(0), [directory, workspace]);
  // A column is as wide as its own entries, so how much of the chain fits is only known once they are in: the pane
  // drops the shallowest column until the path's own column fits, leaving the workspace leftmost whenever it can.
  useLayoutEffect(() => {
    const element = pane.current;
    if (element && element.clientWidth && element.scrollWidth > element.clientWidth && dropped < directories.length - 1) setDropped(dropped + 1);
  }, [directory, entries, workspace, dropped, directories.length]);
  if (error) return <div className="file-message" role="alert">{error}</div>;
  const first = Math.min(dropped, directories.length - 1);
  return <div className="file-columns" ref={pane}>
    {directories.slice(first).map((column, index) => {
      const listing = entries.get(column);
      // The entry this column holds open, which is the level below it; the last column holds none.
      const opened = directories[index + first + 1] ?? '';
      return <nav key={column} className="file-column" aria-label={column}>
        {listing?.map((entry) => {
          const path = `${column === '/' ? '' : column}/${entry.name}`;
          const mark = git?.workspace === workspace ? git.marks.get(path) : undefined;
          const badge = mark && !entry.isDirectory ? mark : undefined;
          return <button key={entry.name} title={badge ? `${entry.name} · ${gitLabels[badge]}` : entry.name} data-git={mark} aria-current={path === opened || undefined} onClick={() => navigate({ type: entry.isDirectory ? 'directory' : 'file', machine: directory.machine, path })}>
            <svg className="file-icon" data-kind={entry.isDirectory ? 'folder' : 'file'} aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4">
              {entry.isDirectory ? <path d="M2 5h6l2 2h8v10H2z" /> : <path d="M5 2h6l4 4v12H5z M11 2v5h4 M8 11h4 M8 14h4" />}
            </svg><span className="file-name">{entry.name}{entry.isDirectory ? '/' : ''}</span>{badge && <span className="file-git" aria-hidden="true">{badge}</span>}
          </button>;
        })}
        {listing?.length === 0 && <div className="file-message">空目录</div>}
      </nav>;
    })}
  </div>;
}

// The page a tab draws: the columns of a directory and nothing above them, or the one line about why there is no
// directory to draw — a failure, still connecting, or no terminal to take one from.
function Page({ context, workspaceId, tab }: { context: UiContext; workspaceId?: string; tab: Tab }) {
  const [workspace, setWorkspace] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Following the workspace in front: a tab with no directory of its own starts at the workspace's, and every tab
  // learns that directory either way, since it is where its columns start.
  useEffect(() => {
    let alive = true;
    let request = 0;
    const off = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => {
      if (workspaceId !== undefined && value !== null && value.workspaceId !== workspaceId) return;
      const id = ++request;
      setError(''); setLoading(value !== null);
      if (!value) return;
      void context.ui.request<FileClick>('resolve', value)
        .then((resolved) => {
          if (!alive || id !== request) return;
          setWorkspace(resolved.path);
          setLoading(false);
          if (!tab.shown) show(context, tab, resolved);
        })
        .catch((problem: Error) => { if (alive && id === request) { setLoading(false); setError(problem.message); } });
    });
    void context.global.publish('workspace:query', null);
    return () => { alive = false; off(); };
  }, [context, workspaceId]);
  const directory = tab.shown;
  return <section className="file-browser" aria-label="文件选择">
    {directory
      ? <Picker context={context} directory={directory} workspace={workspace} holder={workspaceId ?? ''} navigate={(file) => show(context, tab, file)} />
      : <div className="file-message" role={error ? 'alert' : undefined}>{error || (loading ? '正在读取…' : '请选择一个已连接的终端')}</div>}
  </section>;
}

// The click as the directory it is: a file never stays in this panel, so what a tab or a waiting workspace keeps of one
// is always a directory.
const asDirectory = (file: FileClick): Directory => ({ ...file, type: 'directory' });

// What a tab shows: a directory is its own, and a file goes to the editor, which is where it is read.
function show(context: UiContext, tab: Tab, file: FileClick) {
  if (file.type === 'file') {
    void context.global.publish('onclick', file);
    return;
  }
  tab.shown = asDirectory(file);
  tab.paint();
}

export function open(context: UiContext, record?: TabRecord) {
  if (!record || record.id === identity.id) openTab(context, record?.workspaceId ?? activeWorkspaceId);
}

function openTab(context: UiContext, workspaceId?: string) {
  const key = workspaceId ?? '';
  const tab: Tab = { paint: () => {}, shown: waiting.get(key) };
  waiting.delete(key);
  tabs.set(key, tab);
  context.host.tabs({ ...identity, workspaceId, onClose() {
    if (tabs.get(key) === tab) tabs.delete(key);
  }, mount(container: HTMLElement) {
    container.style.fontFamily = font.family;
    const mounted = createRoot(container);
    tab.paint = () => mounted.render(<Page context={context} workspaceId={workspaceId} tab={tab} />);
    tab.paint();
    return { onSelect: tab.paint, dispose: () => mounted.unmount() };
  } });
}

export async function mount(_container: HTMLElement, context: UiContext) {
  font = (context.host.config as Settings).font;
  const offActive = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => {
    activeWorkspaceId = value?.workspaceId;
    // The shell moves unscoped tabs into the first selected workspace.
    const unassigned = tabs.get('');
    if (activeWorkspaceId !== undefined && unassigned) {
      tabs.delete('');
      tabs.set(activeWorkspaceId, unassigned);
    }
  });
  void context.global.publish('workspace:query', null);
  // A directory link clicked elsewhere is shown here rather than in the editor.
  const off = context.global.subscribe<FileClick>('onclick', (file) => {
    if (file.type !== 'directory') return;
    const key = activeWorkspaceId ?? '';
    const tab = tabs.get(key);
    if (tab) show(context, tab, file);
    else waiting.set(key, asDirectory(file));
    // A view is asked for by the name the plugin has in `init.ts`, which is `files`; this tab's own id is `directory`.
    void context.global.publish('core:show-view', { plugin: 'files' });
  });
  return () => { offActive(); off(); };
}
