import { createRoot } from 'react-dom/client';
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DirectoryEntry, WorkspaceActive } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { bindKeys } from '@lengmoxxl/sdk/keys';
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

// The directory above a path, which is the root for a path directly under it.
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
// The last name of a path, which is what sits under the path above it.
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
// A child's path, with the root's own slash left out of the join.
const childOf = (base: string, name: string) => `${base === '/' ? '' : base}/${name}`;

// The directory chain from what the path and the workspace have in common down to the path itself: the picker gives
// every level a column of its own.
function chain(path: string, workspace: string) {
  const directories: string[] = [];
  let current = path;
  for (; ; ) {
    directories.push(current);
    if (current === '/' || workspace === current || workspace.startsWith(`${current}/`)) return directories.reverse();
    current = parentOf(current);
  }
}

// Which child a folder takes its state from when several of them changed: the conflict first, the untracked last.
const gitRanks: Record<string, number> = { '!': 0, D: 1, M: 2, T: 3, A: 4, R: 5, C: 6, U: 7 };

// A changed path's own letter, plus the most severe letter among its changed descendants for each folder above it.
function markFolders({ root, states }: GitStatus) {
  const marks = new Map<string, string>();
  for (const [path, letter] of Object.entries(states)) {
    const file = childOf(root, path);
    marks.set(file, letter);
    for (let directory = parentOf(file); directory.length > root.length; directory = parentOf(directory)) {
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
  const [cursor, setCursor] = useState<{ column: string; name: string }>();
  // The columns the mouse widened, by the width the drag leaves them.
  const [widths, setWidths] = useState(new Map<string, number>());
  // The query the search box holds; `undefined` is the box closed.
  const [search, setSearch] = useState<string>();
  const drag = useRef<{ column: string; left: number; width: number }>(undefined);
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
  const repository = git?.root ? childOf(git.root, '.git') : '';
  useEffect(() => watch(context, directory.machine, holder, repository ? [...directories, repository] : directories, (path) => {
    setChanges((count) => count + 1);
    // The repository is here for the marks alone, and `stale` holds the columns.
    if (path !== repository) setStale((current) => new Set(current).add(path));
  }), [context, directory, workspace, holder, repository]);
  // The columns a chain dropped are offered their room again when the chain changes, since another chain packs
  // differently.
  useEffect(() => setDropped(0), [directory, workspace]);
  // The deepest column stays on screen whatever the pane had to drop.
  const deepestIndex = directories.length - 1;
  const widened = widths.size > 0;
  // A column is as wide as its own entries, so how much of the chain fits is only known once they are in: the pane
  // drops the shallowest column until the path's own column fits, leaving the workspace leftmost whenever it can.
  useLayoutEffect(() => {
    const element = pane.current;
    if (widened || !element || !element.clientWidth || element.scrollWidth <= element.clientWidth || dropped >= deepestIndex) return;
    setDropped(dropped + 1);
  }, [directory, entries, workspace, dropped, deepestIndex, widened]);
  const first = Math.min(dropped, deepestIndex);
  const shown = directories.slice(first);
  const deepest = directories[deepestIndex];
  // The entries a column lists, which is nothing while it is still being read.
  const listingOf = (column: string) => entries.get(column) ?? [];
  const namesOf = (column: string) => listingOf(column).map((item) => item.name);
  // The search looks through the deepest column, the level being picked from.
  const level = namesOf(deepest);
  const matchesOf = (query: string) => level.filter((name) => name.toLowerCase().includes(query.trim().toLowerCase()));
  const matches = search === undefined ? [] : matchesOf(search);
  const holds = (column: string, name: string) => cursor?.column === column && cursor.name === name;
  // Where the cursor sits among the matches, read as the first when it is not on one.
  const matchAt = Math.max(0, matches.findIndex((name) => holds(deepest, name)));
  const seat = (name: string) => setCursor({ column: deepest, name });
  // The cursor stays in the columns on screen: one that left gives it up, and the deepest column takes its first entry
  // when none of them holds it. An open search box picks its own entry, so this leaves the cursor to it.
  useEffect(() => {
    if (search !== undefined || (cursor && shown.includes(cursor.column))) return;
    if (level.length) seat(level[0]);
  }, [cursor, directory, dropped, entries, search, workspace]);
  // A column can be longer than the pane, so the cursor is scrolled into view whenever the keys move it.
  useLayoutEffect(() => {
    pane.current?.querySelector('[data-cursor]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [cursor]);
  // A move stops at either end of the list.
  const within = (index: number, length: number) => Math.min(length - 1, Math.max(0, index));
  // `land` answers the row the cursor lands on.
  const moveTo = (land: (at: number, count: number) => number) => {
    if (!cursor) return;
    const names = namesOf(cursor.column);
    if (!names.length) return;
    setCursor({ column: cursor.column, name: names[within(land(names.indexOf(cursor.name), names.length), names.length)] });
  };
  // What the page is asked to show, always on this tab's machine.
  const showPath = (type: FileClick['type'], path: string) => navigate({ type, machine: directory.machine, path });
  const pick = (column: string, item: DirectoryEntry) => {
    const path = childOf(column, item.name);
    // The chain follows a directory down and the cursor follows the chain, while a file is handed on and the cursor stays.
    if (item.isDirectory) setCursor(undefined);
    showPath(item.isDirectory ? 'directory' : 'file', path);
  };
  const into = () => {
    if (!cursor) return;
    const item = listingOf(cursor.column).find((one) => one.name === cursor.name);
    if (item) pick(cursor.column, item);
  };
  // A parent is where `h` goes, never above the workspace, which is where the chain starts.
  const out = () => {
    const path = directory.path;
    const parent = parentOf(path);
    if (parent === path || path === workspace) return;
    setCursor({ column: parent, name: nameOf(path) });
    showPath('directory', parent);
  };
  const down = () => moveTo((at) => at + 1);
  const up = () => moveTo((at) => at - 1);
  // A query picks its first match as it is typed, so the box and the columns agree on what is held.
  const type = (query: string) => {
    setSearch(query);
    const [found] = matchesOf(query);
    if (found) seat(found);
  };
  const searchStep = (delta: number) => {
    const next = matches[within(matchAt + delta, matches.length)];
    if (next) seat(next);
  };
  // The keys belong to the panel that holds the focus: the shell hands a tab its keys by focusing the panel, and a click
  // on a column focuses something inside it. The bindings are read after every render, so a press always moves over the
  // columns on screen rather than the ones a mount captured.
  useEffect(() => {
    const panel = pane.current?.closest<HTMLElement>('.sidebar-panel');
    if (!panel) return;
    const closeSearch = () => {
      setSearch(undefined);
      // The keys go back to the panel, since the box that held the focus unmounts with the press.
      panel.focus();
    };
    // While the box is open its own letters are the query: the box holds the keys, so the presses bound then say `insert`.
    return bindKeys(panel, search === undefined ? [
      { keys: 'j', run: down },
      { keys: '<Down>', run: down },
      { keys: 'k', run: up },
      { keys: '<Up>', run: up },
      { keys: 'gg', run: () => moveTo(() => 0) },
      { keys: 'G', run: () => moveTo((_, count) => count - 1) },
      { keys: 'l', run: into },
      { keys: '<Right>', run: into },
      { keys: '<Enter>', run: into },
      { keys: 'h', run: out },
      { keys: '<Left>', run: out },
      { keys: '/', run: () => setSearch('') },
    ] : [
      { keys: '<Escape>', insert: true, run: closeSearch },
      { keys: '<Enter>', insert: true, run: closeSearch },
      { keys: '<Down>', insert: true, run: () => searchStep(1) },
      { keys: '<Up>', insert: true, run: () => searchStep(-1) },
    ]);
  });
  const grab = (column: string) => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const box = event.currentTarget.parentElement!.getBoundingClientRect();
    drag.current = { column, left: event.clientX, width: box.width };
  };
  const widen = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (!held) return;
    // The narrowest a column may get is CSS's, which clamps what the drag stores.
    setWidths((current) => new Map(current).set(held.column, Math.round(held.width + event.clientX - held.left)));
  };
  const release = () => {
    drag.current = undefined;
  };
  if (error) return <div className="file-message" role="alert">{error}</div>;
  return <div className="file-columns">
    {search !== undefined && <div className="file-search">
      <input aria-label="搜索" placeholder="搜索本层" spellCheck={false} autoFocus value={search} onChange={(event) => type(event.target.value)} />
      <span className="file-search-count">{matches.length ? `${matchAt + 1}/${matches.length}` : '无匹配'}</span>
    </div>}
    <div className="file-column-row" ref={pane} data-resized={widened ? '' : undefined} onPointerDown={() => setSearch(undefined)}>
      {shown.map((column, index) => {
        const listing = entries.get(column);
        // The entry this column holds open, which is the level below it; the last column holds none.
        const opened = shown[index + 1] ?? '';
        const width = widths.get(column);
        return <div key={column} className="file-column" style={width === undefined ? undefined : { width, maxWidth: 'none' }}>
          <nav className="file-list" aria-label={column}>
            {listing?.map((entry) => {
              const path = childOf(column, entry.name);
              const mark = git?.workspace === workspace ? git.marks.get(path) : undefined;
              const badge = mark && !entry.isDirectory ? mark : undefined;
              return <button key={entry.name} title={badge ? `${entry.name} · ${gitLabels[badge]}` : entry.name} data-git={mark} data-cursor={holds(column, entry.name) ? '' : undefined} aria-current={path === opened || undefined} onClick={() => pick(column, entry)}>
                <svg className="file-icon" data-kind={entry.isDirectory ? 'folder' : 'file'} aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4">
                  {entry.isDirectory ? <path d="M2 5h6l2 2h8v10H2z" /> : <path d="M5 2h6l4 4v12H5z M11 2v5h4 M8 11h4 M8 14h4" />}
                </svg><span className="file-name">{entry.name}{entry.isDirectory ? '/' : ''}</span>{badge && <span className="file-git" aria-hidden="true">{badge}</span>}
              </button>;
            })}
            {listing?.length === 0 && <div className="file-message">空目录</div>}
          </nav>
          <div className="file-resize" role="separator" aria-orientation="vertical" aria-label={`调整 ${column} 的宽度`} onPointerDown={grab(column)} onPointerMove={widen} onPointerUp={release} onPointerCancel={release} />
        </div>;
      })}
    </div>
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
