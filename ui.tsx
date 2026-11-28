import type { EditorView } from '@codemirror/view';
import { Vim, getCM } from '@replit/codemirror-vim';
import { createRoot } from 'react-dom/client';
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DirectoryEntry, WorkspaceActive } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { bindKeys } from '@lengmoxxl/sdk/keys';
import { FileColumn, type ColumnCommand } from './column';
import { childOf, type FileClick, type Font, type GitLetter, type GitStatus, type Settings } from './shared';
import './style.css';

// What the tab is called, and the id the window remembers it by when it opens it again.
const identity = { id: 'directory', title: '文件' };
export const title = identity.title;
let activeWorkspaceId: string | undefined;
let font: Font;

// A directory, which is the only kind of entry a tab here shows: a file is handed to the editor instead.
type Directory = Omit<FileClick, 'type'> & { type: 'directory' };

// One tab: the directory its columns start from, the file a reveal asked to hold, and the call that draws it, which
// `openTab` fills in once the mount has a root and hands back to the window as the tab's `onSelect`. A window keeps one
// tab per workspace, so this is what a workspace's browsing has of its own.
type Tab = { shown?: Directory; held?: FileClick; paint: () => void };
const tabs = new Map<string, Tab>();
// A directory can be sent before its tab was opened, since the sender asks for the tab after sending it: it waits
// here, per workspace, for the tab that will show it, with the file a reveal wants held.
const waiting = new Map<string, { shown: Directory; held?: FileClick }>();

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
// Whether one path tops another: it is that path, or a directory the other sits under.
const tops = (base: string, path: string) => base === path || path.startsWith(`${base}/`);

// The directory chain from what the path and the base path have in common down to the path itself: the picker gives
// every level a column of its own.
function chain(path: string, base: string) {
  const directories: string[] = [];
  let current = path;
  for (; ; ) {
    directories.push(current);
    if (current === '/' || tops(current, base)) return directories.reverse();
    current = parentOf(current);
  }
}

// Which child a folder takes its state from when several of them changed: the conflict first, the untracked last.
const gitRanks: Record<GitLetter, number> = { '!': 0, D: 1, M: 2, T: 3, A: 4, R: 5, C: 6, U: 7 };

// A changed path's own letter, plus the most severe letter among its changed descendants for each folder above it.
function markFolders({ root, states }: GitStatus) {
  const marks = new Map<string, GitLetter>();
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

function Picker({ context, directory, workspace, holder, held, navigate }: { context: UiContext; directory: Directory; workspace: string; holder: string; held?: FileClick; navigate: (file: FileClick) => void }) {
  const [entries, setEntries] = useState(new Map<string, DirectoryEntry[]>());
  const [error, setError] = useState('');
  const [dropped, setDropped] = useState(0);
  // Columns to read again: one is read again when the machine reports a change in it, and the listing already on
  // screen stays until the new one is in, so a directory that changes often does not blink.
  const [stale, setStale] = useState(new Set<string>());
  // Marks move with anything on disk, a column or the repository, so their read counts the changes this watch reports.
  const [changes, setChanges] = useState(0);
  const [git, setGit] = useState<{ workspace: string; root: string; marks: Map<string, GitLetter> }>();
  const [target, setTarget] = useState<{ column: string; name?: string }>();
  // The columns the mouse widened, by the width the drag leaves them.
  const [widths, setWidths] = useState(new Map<string, number>());
  // The query the search box holds; `undefined` is the box closed.
  const [search, setSearch] = useState<string>();
  // The open context menu, placed against the panel, and the file it was opened on.
  const [menu, setMenu] = useState<{ column: string; name: string; x: number; y: number }>();
  // What the last download says, under the columns, until it is old enough to leave.
  const [note, setNote] = useState<{ text: string; problem?: boolean }>();
  const [raised, setRaised] = useState<string>();
  const drag = useRef<{ column: string; left: number; width: number }>(undefined);
  const pane = useRef<HTMLDivElement>(null);
  const views = useRef(new Map<string, EditorView>());
  const restoreFocus = useRef(false);
  const base = raised ?? workspace;
  const directories = chain(directory.path, base);
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
  }, [context, directory, base, stale]);
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
  }), [context, directory, base, holder, repository]);
  // The columns a chain dropped are offered their room again when the chain changes, since another chain packs
  // differently.
  useEffect(() => setDropped(0), [directory, base]);
  // The deepest column stays on screen whatever the pane had to drop.
  const deepestIndex = directories.length - 1;
  const widened = widths.size > 0;
  const first = Math.min(dropped, deepestIndex);
  const shown = directories.slice(first);
  const deepest = directories[deepestIndex];
  const active = target && shown.includes(target.column) ? target.column : deepest;
  const matchesOf = (query: string) => {
    const needle = query.trim().toLowerCase();
    return (entries.get(deepest) ?? []).filter(({ name }) => name.toLowerCase().includes(needle));
  };
  const matches = search === undefined ? [] : matchesOf(search);
  const matchAt = Math.max(0, matches.findIndex(({ name }) => target?.column === deepest && target.name === name));
  const activate = (column: string) => {
    setTarget((current) => current?.column === column ? current : { column });
  };
  // A reveal is spent when its file arrives so a later read leaves the Vim cursor where the keys put it.
  const taken = useRef<FileClick>(undefined);
  useEffect(() => {
    if (!held || taken.current === held) return;
    const name = nameOf(held.path);
    if (!entries.get(deepest)?.some((item) => item.name === name)) return;
    taken.current = held;
    if (active !== deepest && pane.current?.contains(document.activeElement)) restoreFocus.current = true;
    setTarget({ column: deepest, name });
  }, [held, entries, active, deepest]);
  useLayoutEffect(() => {
    const panel = pane.current?.closest<HTMLElement>('.sidebar-panel');
    if (!panel) return;
    const focus = (event?: Event) => {
      if (search !== undefined) {
        // A bare panel focus lets the shell's Ctrl+Shift+Q leave the search field.
        if (event?.type !== 'focus') panel.querySelector<HTMLInputElement>('.file-search input')?.focus();
        return;
      }
      const view = views.current.get(active);
      if (!view || document.activeElement === view.contentDOM) return;
      view.focus();
      view.dom.closest('.file-column')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    panel.addEventListener('focus', focus);
    panel.addEventListener('wangcai:shown', focus);
    if (restoreFocus.current || document.activeElement === panel) {
      restoreFocus.current = false;
      focus();
    }
    return () => {
      panel.removeEventListener('focus', focus);
      panel.removeEventListener('wangcai:shown', focus);
    };
  }, [active, base, directory, dropped, error, menu, search]);
  // Fit the widths after the columns have laid out, transferring focus if a column has to be dropped.
  useLayoutEffect(() => {
    const element = pane.current;
    if (widened || !element || !element.clientWidth || element.scrollWidth <= element.clientWidth || dropped >= deepestIndex) return;
    restoreFocus.current ||= element.contains(document.activeElement);
    setDropped(dropped + 1);
  }, [directory, entries, dropped, deepestIndex, widened]);
  // What the page is asked to show, always on this tab's machine.
  const showPath = (type: FileClick['type'], path: string) => navigate({ type, machine: directory.machine, path });
  const pick = (column: string, item: DirectoryEntry) => {
    const path = childOf(column, item.name);
    if (item.isDirectory) {
      restoreFocus.current = true;
      setTarget({ column: path });
    }
    showPath(item.isDirectory ? 'directory' : 'file', path);
  };
  const download = (column: string, name: string) => {
    restoreFocus.current ||= menu !== undefined;
    setMenu(undefined);
    void context.ui.request<{ path: string }>('download', { machine: directory.machine, path: childOf(column, name) })
      .then((saved) => setNote({ text: `已下载到 ${saved.path}` }))
      .catch((problem: Error) => setNote({ text: problem.message, problem: true }));
  };
  // The menu is placed against the panel, so the pointer's place in it is where it opens, kept inside its edges.
  const openMenu = (event: MouseEvent, column: string, item: DirectoryEntry) => {
    const box = pane.current!.parentElement!.getBoundingClientRect();
    setMenu({ column, name: item.name, x: Math.min(event.clientX - box.left, box.width - 144), y: Math.min(event.clientY - box.top, box.height - 36) });
  };
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(undefined), 4000);
    return () => clearTimeout(timer);
  }, [note]);
  // Going above the base raises it to the parent.
  const out = () => {
    const path = directory.path;
    const parent = parentOf(path);
    if (parent === path) return;
    if (path === base) setRaised(parent);
    restoreFocus.current = true;
    setTarget({ column: parent, name: nameOf(path) });
    showPath('directory', parent);
  };
  // The button puts the base path back on the workspace. The columns above it go, and a path the workspace does not
  // top comes back to it, since the chain has to start from the base.
  const resetBase = () => {
    restoreFocus.current = true;
    setRaised(undefined);
    if (!tops(workspace, directory.path)) showPath('directory', workspace);
  };
  const command = (key: ColumnCommand, column: string, entry?: DirectoryEntry) => {
    if (key === 'parent') out();
    else if (key === 'search') {
      setTarget({ column, name: entry?.name });
      setSearch('');
    }
    else if (key === 'open' && entry) pick(column, entry);
    else if (key === 'download' && entry && !entry.isDirectory) download(column, entry.name);
  };
  // A query picks its first match as it is typed, so the box and the columns agree on what is held.
  const type = (query: string) => {
    setSearch(query);
    const [found] = matchesOf(query);
    if (found) setTarget({ column: deepest, name: found.name });
  };
  const searchStep = (delta: number) => {
    const next = matches[Math.min(matches.length - 1, Math.max(0, matchAt + delta))];
    if (next) setTarget({ column: deepest, name: next.name });
  };
  useEffect(() => {
    const panel = pane.current?.closest<HTMLElement>('.sidebar-panel');
    if (!panel) return;
    if (search === undefined) {
      if (menu) return bindKeys(panel, [{ keys: '<Escape>', run: () => setMenu(undefined) }]);
      return;
    }
    const closeSearch = () => {
      restoreFocus.current = true;
      setSearch(undefined);
    };
    return bindKeys(panel, [
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
    <div className="file-header">
      <button className="file-button" aria-label="回到工作区" title={`回到工作区 ${workspace}`} disabled={base === workspace} onClick={resetBase}>
        <svg className="file-glyph" aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 9.5 10 3l7 6.5V17H3z" /><path d="M8 17v-4h4v4" /></svg>
      </button>
      <div className="file-base" title={base}>{base}</div>
      {search !== undefined && <div className="file-search">
        <input aria-label="搜索" placeholder="搜索本层" spellCheck={false} autoFocus value={search} onChange={(event) => type(event.target.value)} />
        <span className="file-search-count">{matches.length ? `${matchAt + 1}/${matches.length}` : '无匹配'}</span>
      </div>}
    </div>
    <div className="file-column-row" ref={pane} data-resized={widened ? '' : undefined} onPointerDown={() => {
      const view = views.current.get(active);
      const cm = view && getCM(view);
      if (cm?.state.vim?.inputState.keyBuffer.length) Vim.handleKey(cm, '<Esc>', 'user');
      restoreFocus.current ||= search !== undefined;
      setSearch(undefined);
      setMenu(undefined);
    }}>
      {shown.map((column, index) => {
        const width = widths.get(column);
        return <div key={column} className="file-column" style={width === undefined ? undefined : { width, maxWidth: 'none' }}>
          <FileColumn path={column} views={views.current} listing={entries.get(column)} opened={shown[index + 1]}
            marks={git?.workspace === workspace ? git.marks : undefined} active={column === active}
            target={target?.column === column ? target : undefined} onFocus={activate} onCommand={command} onMenu={openMenu} />
          <div className="file-resize" role="separator" aria-orientation="vertical" aria-label={`调整 ${column} 的宽度`} onPointerDown={grab(column)} onPointerMove={widen} onPointerUp={release} onPointerCancel={release} />
        </div>;
      })}
    </div>
    {menu && <div className="file-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      <button role="menuitem" onClick={() => download(menu.column, menu.name)}>下载到 Downloads</button>
    </div>}
    {note && <div className="file-note" role={note.problem ? 'alert' : undefined}>{note.text}</div>}
  </div>;
}

// The page a tab draws: the path bar and the columns under it, or the one line about why there is no
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
      ? <Picker context={context} directory={directory} workspace={workspace} holder={workspaceId ?? ''} held={tab.held} navigate={(file) => show(context, tab, file)} />
      : <div className="file-message" role={error ? 'alert' : undefined}>{error || (loading ? '正在读取…' : '请选择一个已连接的终端')}</div>}
  </section>;
}

// The click as the directory it is: a file never stays in this panel, so what a tab or a waiting workspace keeps of one
// is always a directory.
const asDirectory = (file: FileClick): Directory => ({ ...file, type: 'directory' });

// What a tab shows: a directory is its own, and a file goes to the editor, which is where it is read. A reveal's file
// rides along as `held` for the picker to seat; any other move clears it.
function show(context: UiContext, tab: Tab, file: FileClick, held?: FileClick) {
  if (file.type === 'file') {
    void context.global.publish('onclick', file);
    return;
  }
  tab.shown = asDirectory(file);
  tab.held = held;
  tab.paint();
}

export function open(context: UiContext, record?: TabRecord) {
  if (!record || record.id === identity.id) openTab(context, record?.workspaceId ?? activeWorkspaceId);
}

function openTab(context: UiContext, workspaceId?: string) {
  const key = workspaceId ?? '';
  const tab: Tab = { paint: () => {}, ...waiting.get(key) };
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
    else waiting.set(key, { shown: asDirectory(file) });
    // A view is asked for by the name the plugin has in `init.ts`, which is `files`; this tab's own id is `directory`.
    void context.global.publish('core:show-view', { plugin: 'files' });
  });
  // A reveal names a file rather than its directory: the directory is shown and the file is what the picker holds.
  const offReveal = context.global.subscribe<FileClick>('files:reveal', (file) => {
    const key = activeWorkspaceId ?? '';
    const tab = tabs.get(key);
    const parent = asDirectory({ ...file, path: parentOf(file.path) });
    if (tab) show(context, tab, parent, file);
    else waiting.set(key, { shown: parent, held: file });
    void context.global.publish('core:show-view', { plugin: 'files' });
  });
  return () => { offActive(); off(); offReveal(); };
}
