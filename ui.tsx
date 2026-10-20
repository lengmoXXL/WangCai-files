import { Fragment, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import 'monaco-editor/languages/features/json/jsonMode.js';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
// What a language server answers through: hovering, going to a definition, and the symbols of a file.
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js';
import type { DirectoryEntry, Theme, WorkspaceActive } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { LanguageServices, buffer, languageFor } from './lsp';
import { imageMime, machineKey, type FileClick, type Font, type History, type Settings } from './shared';
import './style.css';

export const title = '文件';
let activeWorkspaceId: string | undefined;
let preview: { url: string; message: string };
let font: Font;
const histories = new Map<string, History>();
// The window's language servers, which mount() starts and every tab shares.
let services: LanguageServices | undefined;
jsonDefaults.setModeConfiguration({ tokens: true });

const watch = (context: UiContext, machine: FileClick['machine'], holder: string, paths: string[], act: (path: string) => void) => {
  // The plugin can be disposed before either request lands, and the machine can be gone; neither is worth a pageerror.
  void context.ui.request('watch', { holder, machine, paths }).catch(() => undefined);
  const off = context.ui.subscribe<string>('changed', (path) => { if (paths.includes(path)) act(path); });
  return () => { off(); void context.ui.request('watch', { holder, machine, paths: [] }).catch(() => undefined); };
};

type NavigationProps = { context: UiContext; file: FileClick; navigate: (file: FileClick) => void; refresh: () => void; back?: () => void; forward?: () => void; openPicker: () => void };

function Navigation({ context, file, navigate, refresh, back, forward, openPicker, children }: NavigationProps & { children?: ReactNode }) {
  const [path, setPath] = useState(file.path);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => { setPath(file.path); setError(''); return () => { request.current++; }; }, [file]);
  return <>
    <header className="preview-header">
      <button className="preview-arrow" aria-label="后退" title="后退" disabled={!back} onClick={back}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3 2 8l5 5 M2 8h12" /></svg>
      </button>
      <button className="preview-arrow" aria-label="前进" title="前进" disabled={!forward} onClick={forward}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9 3 5 5-5 5 M2 8h12" /></svg>
      </button>
      <button className="preview-arrow" aria-label="刷新" title="刷新" onClick={refresh}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.3 6.7A5.3 5.3 0 1 0 12 12 M13.3 2.7v4h-4" /></svg>
      </button>
      <form className="preview-address" onSubmit={(event) => {
        event.preventDefault();
        if (!path.trim()) return;
        const id = ++request.current;
        setError('');
        const base = file.type === 'directory' ? file.path : file.path.slice(0, file.path.lastIndexOf('/')) || '/';
        void context.ui.request<FileClick>('resolve', { machine: file.machine, path: path.trim(), base })
          .then((file) => { if (id === request.current) navigate(file); })
          .catch((error: Error) => { if (id === request.current) setError(error.message); });
      }}>
        <input className="preview-path" aria-label="路径" title={file.path} value={path} spellCheck={false}
          onClick={openPicker}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => { request.current++; setPath(event.target.value); setError(''); }}
          onKeyDown={(event) => { if (event.key === 'Escape') { request.current++; setPath(file.path); setError(''); } }} />
      </form>
      {children}
    </header>
    {error && <div className="file-message" role="alert">{error}</div>}
  </>;
}

type Mode = 'text' | 'markdown' | 'html';
const modeLabels: Record<Mode, string> = { text: '文本', markdown: 'Markdown 预览', html: 'HTML 预览' };

function ModeMenu({ modes, mode, select }: { modes: Mode[]; mode: Mode; select: (mode: Mode) => void }) {
  const [open, setOpen] = useState(false);
  return <div className="preview-modes">
    <button className="preview-mode" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{modeLabels[mode]}
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
    </button>
    {open && <>
      <div className="menu-backdrop" onClick={() => setOpen(false)} />
      <div className="preview-menu" role="menu" aria-label="预览方式">
        {modes.map((item) => <button key={item} role="menuitem" autoFocus={item === mode} onClick={() => { setOpen(false); select(item); }}>{modeLabels[item]}</button>)}
      </div>
    </>}
  </div>;
}

// Frontmatter would otherwise render as a thematic break plus a setext heading.
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function splitFrontmatter(text: string): { fields: [string, string][]; body: string } {
  const match = frontmatter.exec(text);
  if (!match) return { fields: [], body: text };
  const fields: [string, string][] = [];
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1 || /^\s/.test(line)) continue;
    fields.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
  }
  if (!fields.length) return { fields, body: text };
  return { fields, body: text.slice(match[0].length) };
}

const stateLabels = { connecting: '正在启动', open: '运行中', closed: '已退出' };

// The dot in the toolbar for this file's language server: hovering it names the server and how it is doing, and
// clicking it restarts the server behind the file.
function LspStatus({ model }: { model?: monaco.editor.ITextModel }) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [hover, setHover] = useState(false);
  useEffect(() => services?.subscribe(rerender), []);
  const status = model && services?.status(model);
  if (!model || !status) return null;
  return <div className="preview-lsp-wrap" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    <button className={`preview-lsp ${status.state}`} type="button" aria-label={`语言服务：${status.server}`} onClick={() => void services?.restart(model)}>
      <span className="preview-lsp-dot" />
    </button>
    {hover && <div className="preview-lsp-detail" role="tooltip">
      <span className="preview-lsp-name">{status.server}</span>
      <span>{stateLabels[status.state]}</span>
      <span>{status.root}</span>
      {status.error && <span>{status.error}</span>}
      {status.log && <span>{status.log}</span>}
      <span>点击重启这个服务</span>
    </div>}
  </div>;
}

function Preview({ file, text, mode, navigate, notify, onModel }: { file: FileClick; text: string; mode: Mode; navigate: (file: FileClick) => void; notify: (reason: string) => void; onModel: (model?: monaco.editor.ITextModel) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  // The preview document asks for its content as soon as it loads, so the listener has to be in place first.
  useLayoutEffect(() => {
    if (mode !== 'html') return;
    const deliver = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (target && event.data === preview.message && event.source === target) target.postMessage(text, '*');
    };
    addEventListener('message', deliver);
    return () => removeEventListener('message', deliver);
  }, [mode, text]);
  useEffect(() => {
    if (mode !== 'text') return;
    const size = font.size;
    const language = languageFor(file.path);
    // A file shown from another machine is the same model.
    const model = buffer(monaco.Uri.file(file.path), language, text);
    onModel(model);
    const editor = monaco.editor.create(element.current!, {
      model, theme: 'wangcai', readOnly: true, domReadOnly: true,
      automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
      fontSize: size, lineHeight: font.lineHeight ? Math.round(size * font.lineHeight) : 0, fontFamily: font.family, lineNumbersMinChars: 3, renderLineHighlight: 'none',
      ariaLabel: '代码预览', contextmenu: false,
    });
    const position = { lineNumber: file.line ?? 1, column: file.column ?? 1 };
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    let alive = true;
    void services?.open({ machine: file.machine, path: file.path, language, model, navigate, notify: (reason) => { if (alive) notify(reason); } });
    return () => { alive = false; editor.dispose(); onModel(undefined); };
  }, [file, text, mode]);
  if (mode === 'markdown') return <MarkdownPage text={text} />;
  if (mode === 'html') return <iframe className="html-frame" ref={frame} title="HTML 预览" sandbox="allow-scripts" src={preview.url} />;
  return <div className="code-preview" ref={element} />;
}

// A block is highlighted with the same languages and theme as the code editor, so a fence and a code file read alike.
function CodeBlock({ language, text }: { language: string; text: string }) {
  const code = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  // Monaco colorizes the element itself and stays in charge of its markup, so a changed text needs a new element
  // (the `key` below) and this effect to run again; that is what the text dependency is for.
  useEffect(() => {
    const resolved = monaco.languages.getLanguages().find(({ id, aliases }) => id === language || aliases?.includes(language))?.id;
    if (resolved) void monaco.editor.colorizeElement(code.current!, { theme: 'wangcai', mimeType: resolved });
  }, [language, text]);
  return <div className="markdown-code">
    <div className="markdown-code-head">
      {language && <span>{language}</span>}
      <button className="markdown-code-copy" type="button" title="复制代码" onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}>{copied ? '已复制' : '复制'}</button>
    </div>
    <pre className="markdown-code-body"><code key={text} ref={code}>{text}</code></pre>
  </div>;
}

// The markdown page is sized by its own divider: the width is a fraction of the pane, so a window resize keeps the
// proportion, and one fraction is shared by every markdown file the window shows.
function MarkdownPage({ text }: { text: string }) {
  const pane = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const drag = useRef<{ left: number; width: number } | undefined>(undefined);
  const painted = useRef(0);
  const { fields, body } = splitFrontmatter(text);
  const paint = (ratio: number) => {
    const width = pane.current!.clientWidth;
    // A page that reached the pane's right edge would carry its divider out of reach, so the divider keeps its width.
    const room = width - divider.current!.offsetWidth;
    // A restored tab that is not the one in front mounts its markdown page while its panel is hidden, so there is no
    // width to measure yet: the ratio it was left at is all there is to draw.
    painted.current = room > 0 ? Math.min(room / width, Math.max(240 / width, ratio)) : ratio;
    page.current!.style.width = `${painted.current * 100}%`;
  };

  // The page takes the fraction its divider was dragged to, or a readable measure when it was never dragged.
  useLayoutEffect(() => {
    const restore = () => {
      const ratio = Number(localStorage.getItem('markdown-width'));
      paint(ratio > 0 ? ratio : 0.6);
    };
    const observer = new ResizeObserver(restore);
    observer.observe(pane.current!);
    restore();
    return () => observer.disconnect();
  }, []);

  return <div className="markdown-pane" ref={pane}>
    <article className="markdown-preview" ref={page}>
      {fields.length > 0 && <dl className="markdown-meta">
        {fields.map(([key, value], index) => <Fragment key={index}><dt>{key}</dt><dd>{value}</dd></Fragment>)}
      </dl>}
      <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
        a: ({ children }) => <span>{children}</span>,
        img: ({ alt }) => <span>{alt}</span>,
        // The language is not in `pre`'s props: it is on the `code` element the fence opened, which is the `pre`'s only child.
        pre: ({ node }) => {
          const child = node?.children[0];
          const code = child?.type === 'element' ? child : undefined;
          const language = String(code?.properties.className ?? '').replace('language-', '').toLowerCase();
          const text = code?.children[0].type === 'text' ? code.children[0].value.replace(/\n$/, '') : '';
          return <CodeBlock language={language} text={text} />;
        },
      }}>{body}</Markdown>
    </article>
    <div className="markdown-divider" ref={divider} role="separator" aria-label="调整预览宽度" aria-orientation="vertical"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { left: pane.current!.getBoundingClientRect().left, width: pane.current!.clientWidth };
      }}
      onPointerMove={(event) => {
        const from = drag.current;
        if (from && event.currentTarget.hasPointerCapture(event.pointerId)) paint((event.clientX - from.left) / from.width);
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        drag.current = undefined;
        localStorage.setItem('markdown-width', String(painted.current));
      }} />
  </div>;
}

function FileView(props: NavigationProps & { holder: string }) {
  const { context, file, holder } = props;
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let alive = true;
    setText(undefined); setError(''); setNotice('');
    const read = () => void context.ui.request<string>('read', file).then((text) => { if (alive) { setText(text); setError(''); } })
      .catch((error: Error) => { if (alive) setError(error.message); });
    read();
    const unwatch = watch(context, file.machine, holder, [file.path], read);
    return () => { alive = false; unwatch(); };
  }, [context, file, holder]);
  const markdown = /\.(md|markdown)$/i.test(file.path);
  const html = /\.html?$/i.test(file.path);
  const image = imageMime(file.path);
  const modes: Mode[] = image ? [] : ['text', ...(markdown ? ['markdown' as const] : []), ...(html ? ['html' as const] : [])];
  const [mode, setMode] = useState<Mode>(html ? 'html' : markdown ? 'markdown' : 'text');
  const [model, setModel] = useState<monaco.editor.ITextModel>();
  useEffect(() => {
    if (!model) return;
    // The notice describes a server that is not running, so it goes once this file's server is up again.
    return services?.subscribe(() => { if (services?.status(model)?.state === 'open') setNotice(''); });
  }, [model]);
  return <section className="file-preview" aria-label="文件预览">
    <Navigation {...props}>
      {modes.length > 1 && <ModeMenu modes={modes} mode={mode} select={setMode} />}
      <LspStatus model={model} />
    </Navigation>
    {notice && <div className="preview-notice" role="alert">
      <span>{notice}</span>
      <button type="button" aria-label="关闭语言服务提示" title="关闭" onClick={() => setNotice('')}>×</button>
    </div>}
    {error ? <div className="file-message" role="alert">{error}</div>
      : text === undefined ? <div className="file-message">正在读取…</div>
      : image ? <div className="image-preview"><img src={text} alt={file.path} /></div>
      : <Preview file={file} text={text} mode={mode} onModel={setModel} navigate={props.navigate} notify={setNotice} />}
  </section>;
}

// The directory chain from what the path and the workspace have in common down to the directory holding the path:
// the picker gives every level a column of its own.
function chain(file: FileClick, workspace: string) {
  const directories: string[] = [];
  let current = file.type === 'directory' ? file.path : file.path.slice(0, file.path.lastIndexOf('/')) || '/';
  for (; ; ) {
    directories.push(current);
    if (current === '/' || workspace === current || workspace.startsWith(`${current}/`)) return directories.reverse();
    current = current.slice(0, current.lastIndexOf('/')) || '/';
  }
}

function Picker(props: NavigationProps & { workspace: string; holder: string }) {
  const { context, file, workspace, holder, navigate } = props;
  const [entries, setEntries] = useState(new Map<string, DirectoryEntry[]>());
  const [error, setError] = useState('');
  const [dropped, setDropped] = useState(0);
  // Columns to read again: one is read again when the machine reports a change in it, and the listing already on
  // screen stays until the new one is in, so a directory that changes often does not blink.
  const [stale, setStale] = useState(new Set<string>());
  const pane = useRef<HTMLDivElement>(null);
  const directories = chain(file, workspace);
  const reload = () => setStale(new Set(directories));
  useEffect(() => {
    let alive = true;
    setError('');
    for (const directory of directories) {
      if (entries.has(directory) && !stale.has(directory)) continue;
      void context.ui.request<{ path: string; entries: DirectoryEntry[] }>('list', { machine: file.machine, path: directory })
        .then((listing) => {
          if (!alive) return;
          setEntries((current) => new Map(current).set(directory, listing.entries));
          // A mark is spent by the read it asked for, so a pass that runs for another reason reads nothing again.
          setStale((current) => {
            if (!current.has(directory)) return current;
            const next = new Set(current);
            next.delete(directory);
            return next;
          });
        })
        .catch((problem: Error) => { if (alive) setError(problem.message); });
    }
    return () => { alive = false; };
  }, [context, file, workspace, stale]);
  // A reload keeps the watch: it follows the same chain, and giving it up would lose the changes that arrive while
  // it is gone.
  useEffect(() => watch(context, file.machine, holder, directories, (path) => setStale((current) => new Set(current).add(path))), [context, file, workspace, holder]);
  // The columns a chain dropped are offered their room again when the chain changes, since another chain packs
  // differently.
  useEffect(() => setDropped(0), [file, workspace]);
  // A column is as wide as its own entries, so how much of the chain fits is only known once they are in: the pane
  // drops the shallowest column until the path's own column fits, leaving the workspace leftmost whenever it can.
  useLayoutEffect(() => {
    const element = pane.current;
    if (element && element.clientWidth && element.scrollWidth > element.clientWidth && dropped < directories.length - 1) setDropped(dropped + 1);
  }, [file, entries, workspace, dropped, directories.length]);
  const first = Math.min(dropped, directories.length - 1);
  return <section className="file-preview" aria-label="文件选择">
    <Navigation {...props} refresh={reload} />
    {error ? <div className="file-message" role="alert">{error}</div>
      : <div className="file-columns" ref={pane}>
        {directories.slice(first).map((directory, index) => {
          const listing = entries.get(directory);
          // The entry this column holds open: the level below it, which is the path itself under the last one.
          const opened = directories[index + first + 1] ?? (file.type === 'file' ? file.path : '');
          return <nav key={directory} className="file-column" aria-label={directory}>
            {listing?.map((entry) => {
              const path = `${directory === '/' ? '' : directory}/${entry.name}`;
              return <button key={entry.name} title={entry.name} aria-current={path === opened || undefined} onClick={() => navigate({ type: entry.isDirectory ? 'directory' : 'file', machine: file.machine, path })}>
                <svg className="file-icon" data-kind={entry.isDirectory ? 'folder' : 'file'} aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4">
                  {entry.isDirectory ? <path d="M2 5h6l2 2h8v10H2z" /> : <path d="M5 2h6l4 4v12H5z M11 2v5h4 M8 11h4 M8 14h4" />}
                </svg><span>{entry.name}{entry.isDirectory ? '/' : ''}</span>
              </button>;
            })}
            {listing?.length === 0 && <div className="file-message">空目录</div>}
          </nav>;
        })}
      </div>}
  </section>;
}

function BrowserView({ context, workspaceId, holder, file, picking, ...navigation }: Omit<NavigationProps, 'file'> & { workspaceId?: string; holder: string; file?: FileClick; picking: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [workspace, setWorkspace] = useState('');
  // Following the workspace in front: a tab with no path of its own opens the workspace directory itself, and every
  // tab learns that directory either way, since it is where its picker starts.
  const following = !file;
  useEffect(() => {
    let alive = true;
    let request = 0;
    const off = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => {
      if (workspaceId !== undefined && value !== null && value.workspaceId !== workspaceId) return;
      const id = ++request;
      setError(''); setLoading(value !== null);
      if (!value) return;
      void context.ui.request<FileClick>('resolve', value)
        .then((resolved) => { if (alive && id === request) { setWorkspace(resolved.path); if (following) navigation.navigate(resolved); } })
        .catch((problem: Error) => { if (alive && id === request) { setLoading(false); setError(problem.message); } });
    });
    void context.global.publish('workspace:query', null);
    return () => { alive = false; off(); };
  }, [context, workspaceId, following, navigation.navigate]);
  if (!file) return <div className="file-message" role={error ? 'alert' : undefined}>{error || (loading ? '正在读取…' : '请选择一个已连接的终端')}</div>;
  const key = JSON.stringify([file.machine.id, file.machine.host, file.path, file.line, file.column]);
  // A machine lists its own directories, while a walk through one keeps the columns it opened, so only a
  // different machine rebuilds the picker.
  const pickerKey = machineKey(file.machine);
  return file.type === 'directory' || picking
    ? <Picker key={pickerKey} context={context} file={file} workspace={workspace} holder={holder} {...navigation} />
    : <FileView key={key} context={context} file={file} holder={holder} {...navigation} />;
}

export function open(context: UiContext, record?: TabRecord) {
  if (!record || record.id === 'directory') openTab(context, record?.workspaceId ?? activeWorkspaceId);
}

const openFiles = () => [...histories.values()].map((history) => history.entries[history.index]).filter((file): file is FileClick => file?.type === 'file');

function openTab(context: UiContext, workspaceId?: string, file?: FileClick) {
  const key = workspaceId ?? '';
  const history = histories.get(key) ?? { entries: [], index: -1 };
  histories.set(key, history);
  let picking = false;
  const push = (file: FileClick) => {
    const current = history.entries[history.index];
    if (!current || current.machine.id !== file.machine.id || current.machine.host !== file.machine.host || current.type !== file.type || current.path !== file.path || current.line !== file.line || current.column !== file.column) {
      history.entries = [...history.entries.slice(0, history.index + 1), file];
      history.index++;
      void context.ui.request('save-history', Object.fromEntries(histories));
    } else history.entries[history.index] = file;
  };
  if (file) push(file);
  context.host.tabs({ id: 'directory', title: '文件', workspaceId, onClose() {
    for (const [key, value] of histories) if (value === history) histories.delete(key);
    void context.ui.request('save-history', Object.fromEntries(histories));
    void services?.closeUnused(openFiles());
  }, mount(container: HTMLElement) {
    container.style.fontFamily = font.family;
    const root = createRoot(container);
    // A view is handed the same callbacks on every render: its effect depends on navigate, and a new identity each
    // render would run that effect again, which asks for the workspace again, which navigates and renders again.
    const navigate = (file: FileClick) => { picking = false; push(file); render(); };
    const openPicker = () => { picking = true; render(); };
    const refresh = () => { history.entries[history.index] = { ...history.entries[history.index] }; render(); };
    const render = () => root.render(<BrowserView context={context} workspaceId={workspaceId} holder={key} file={history.entries[history.index]} picking={picking}
      navigate={navigate}
      openPicker={openPicker}
      refresh={refresh}
      back={history.index > 0 ? () => {
        picking = false;
        history.index--;
        void context.ui.request('save-history', Object.fromEntries(histories));
        render();
      } : undefined}
      forward={history.index < history.entries.length - 1 ? () => {
        picking = false;
        history.index++;
        void context.ui.request('save-history', Object.fromEntries(histories));
        render();
      } : undefined} />);
    return { onSelect: render, dispose: () => root.unmount() };
  } });
}

function editorTheme(theme: Theme): monaco.editor.IStandaloneThemeData {
  const alpha = (color: string, value: number) => `${color}${Math.round(value * 255).toString(16).padStart(2, '0')}`;
  return {
    base: getComputedStyle(document.documentElement).colorScheme === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: theme.muted.slice(1) },
      { token: 'string', foreground: theme.green.slice(1) },
      { token: 'number', foreground: theme.yellow.slice(1) },
      { token: 'keyword', foreground: theme.magenta.slice(1) },
      { token: 'type', foreground: theme.cyan.slice(1) },
      { token: 'function', foreground: theme.blue.slice(1) },
      { token: 'constant', foreground: theme.brightMagenta.slice(1) },
      { token: 'delimiter', foreground: theme.foreground.slice(1) },
    ],
    colors: {
      'editor.background': theme.background,
      'editor.foreground': theme.foreground,
      'editorLineNumber.foreground': theme.muted,
      'editorCursor.foreground': theme.cursor,
      'editor.selectionBackground': theme.selection,
      'editorWidget.background': theme.overlay,
      'editorWidget.border': theme.border,
      'editorGutter.background': theme.background,
      'scrollbarSlider.background': alpha(theme.muted, 0.25),
      'scrollbarSlider.hoverBackground': alpha(theme.muted, 0.4),
      'scrollbarSlider.activeBackground': alpha(theme.muted, 0.5),
    },
  };
}

export async function mount(_container: HTMLElement, context: UiContext) {
  const profile: Settings = context.host.config;
  font = profile.font;
  preview = context.host.preview;
  monaco.editor.defineTheme('wangcai', editorTheme(profile.theme));
  for (const [key, history] of Object.entries(await context.ui.request<Record<string, History>>('history'))) histories.set(key, history);
  const response = await fetch(new URL('./ui.worker.js', import.meta.url));
  if (!response.ok) throw new Error('Cannot load file preview worker');
  const workerURL = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
  const workers = new Set<Worker>();
  self.MonacoEnvironment = { getWorker() {
    const worker = new Worker(workerURL, { type: 'module' });
    workers.add(worker);
    return worker;
  } };
  const offActive = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => {
    activeWorkspaceId = value?.workspaceId;
    // The shell moves unscoped tabs into the first selected workspace.
    const unassigned = histories.get('');
    if (activeWorkspaceId !== undefined && unassigned) {
      histories.delete('');
      histories.set(activeWorkspaceId, unassigned);
      void context.ui.request('save-history', Object.fromEntries(histories));
    }
  });
  void context.global.publish('workspace:query', null);
  const off = context.global.subscribe<FileClick>('onclick', (file) => openTab(context, activeWorkspaceId, file));
  services = new LanguageServices(context);
  const definition = monaco.languages.registerDefinitionProvider({ scheme: 'file' }, {
    provideDefinition: (model, position) => services?.for(model)?.definition(model, position) ?? null,
  });
  // monaco opens only the models the window already has, so a jump into another file lands here.
  const opener = monaco.editor.registerEditorOpener({
    openCodeEditor: (source, resource, selection) => {
      const at = !selection ? undefined
        : 'lineNumber' in selection ? new monaco.Position(selection.lineNumber, selection.column)
        : new monaco.Position(selection.startLineNumber, selection.startColumn);
      return services?.openResource(source.getModel(), resource, at) ?? false;
    },
  });
  return () => {
    opener.dispose();
    definition.dispose();
    services?.dispose();
    services = undefined;
    offActive();
    off();
    histories.clear();
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerURL);
    delete self.MonacoEnvironment;
  };
}
