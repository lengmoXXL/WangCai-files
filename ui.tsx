import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import 'monaco-editor/languages/features/json/jsonMode.js';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import type { DirectoryEntry, Theme, WorkspaceActive } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { imageMime, type FileClick, type Font, type Settings } from './shared';
import './style.css';

export const title = '文件';
let activeWorkspaceId: string | undefined;
let preview: { url: string; message: string };
let font: Font;
type History = { entries: FileClick[]; index: number };
const histories = new Map<string | undefined, History>();
jsonDefaults.setModeConfiguration({ tokens: true });

type NavigationProps = { context: UiContext; file: FileClick; navigate: (file: FileClick) => void; refresh: () => void; back?: () => void; forward?: () => void };

function Navigation({ context, file, navigate, refresh, back, forward, children }: NavigationProps & { children?: ReactNode }) {
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

function Preview({ file, text, mode }: { file: FileClick; text: string; mode: Mode }) {
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
    const name = file.path.split('/').pop()!;
    const language = monaco.languages.getLanguages().find((item) => item.filenames?.includes(name) || item.extensions?.some((extension) => name.endsWith(extension)))?.id ?? 'plaintext';
    const editor = monaco.editor.create(element.current!, {
      value: text, language, theme: 'wangcai', readOnly: true, domReadOnly: true,
      automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
      fontSize: size, lineHeight: font.lineHeight ? Math.round(size * font.lineHeight) : 0, fontFamily: font.family, lineNumbersMinChars: 3, renderLineHighlight: 'none',
      ariaLabel: '代码预览', contextmenu: false,
    });
    const position = { lineNumber: file.line ?? 1, column: file.column ?? 1 };
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    return () => editor.dispose();
  }, [file, text, mode]);
  if (mode === 'markdown') return <article className="markdown-preview"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children }) => <span>{children}</span>,
    img: ({ alt }) => <span>{alt}</span>,
  }}>{text}</Markdown></article>;
  if (mode === 'html') return <iframe className="html-frame" ref={frame} title="HTML 预览" sandbox="allow-scripts" src={preview.url} />;
  return <div className="code-preview" ref={element} />;
}

function FileView(props: NavigationProps) {
  const { context, file } = props;
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setText(undefined); setError('');
    void context.ui.request<string>('read', file).then((text) => { if (alive) setText(text); })
      .catch((error: Error) => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [context, file]);
  const markdown = /\.(md|markdown)$/i.test(file.path);
  const html = /\.html?$/i.test(file.path);
  const image = imageMime(file.path);
  const modes: Mode[] = image ? [] : ['text', ...(markdown ? ['markdown' as const] : []), ...(html ? ['html' as const] : [])];
  const [mode, setMode] = useState<Mode>(html ? 'html' : markdown ? 'markdown' : 'text');
  return <section className="file-preview" aria-label="文件预览">
    <Navigation {...props}>
      {modes.length > 1 && <ModeMenu modes={modes} mode={mode} select={setMode} />}
    </Navigation>
    {error ? <div className="file-message" role="alert">{error}</div>
      : text === undefined ? <div className="file-message">正在读取…</div>
      : image ? <div className="image-preview"><img src={text} alt={file.path} /></div>
      : <Preview file={file} text={text} mode={mode} />}
  </section>;
}

function Directory(props: NavigationProps) {
  const { context, file, navigate } = props;
  const [directory, setDirectory] = useState<{ path: string; entries: DirectoryEntry[] }>();
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setDirectory(undefined); setError('');
    void context.ui.request<{ path: string; entries: DirectoryEntry[] }>('list', file).then((result) => {
      if (alive) setDirectory(result);
    }).catch((error: Error) => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [context, file]);
  return <section className="file-preview" aria-label="文件浏览">
    <Navigation {...props} />
    {error ? <div className="file-message" role="alert">{error}</div>
      : !directory ? <div className="file-message">正在读取…</div>
      : <div className="file-directory">
        <nav aria-label="当前目录文件">
          {directory.path !== '/' && <button onClick={() => navigate({ type: 'directory', machine: file.machine, path: directory.path.slice(0, directory.path.lastIndexOf('/')) || '/' })} aria-label="上级目录">../</button>}
          {directory.entries.map((entry) => <button key={entry.name} onClick={() => {
            const path = `${directory.path === '/' ? '' : directory.path}/${entry.name}`;
            navigate({ type: entry.isDirectory ? 'directory' : 'file', machine: file.machine, path });
          }}><svg className="file-icon" data-kind={entry.isDirectory ? 'folder' : 'file'} aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4">
            {entry.isDirectory ? <path d="M2 5h6l2 2h8v10H2z" /> : <path d="M5 2h6l4 4v12H5z M11 2v5h4 M8 11h4 M8 14h4" />}
          </svg><span>{entry.name}{entry.isDirectory ? '/' : ''}</span></button>)}
          {!directory.entries.length && <div className="file-message">空目录</div>}
        </nav>
      </div>}
  </section>;
}

function BrowserView({ context, workspaceId, file, ...navigation }: Omit<NavigationProps, 'file'> & { workspaceId?: string; file?: FileClick }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (file) return;
    let alive = true;
    let request = 0;
    const off = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => {
      if (workspaceId !== undefined && value !== null && value.workspaceId !== workspaceId) return;
      const id = ++request;
      setError(''); setLoading(value !== null);
      if (!value) return;
      void context.ui.request<FileClick>('resolve', value)
        .then((file) => { if (alive && id === request) navigation.navigate(file); })
        .catch((error: Error) => { if (alive && id === request) { setLoading(false); setError(error.message); } });
    });
    void context.global.publish('workspace:query', null);
    return () => { alive = false; off(); };
  }, [context, workspaceId, file, navigation.navigate]);
  if (!file) return <div className="file-message" role={error ? 'alert' : undefined}>{error || (loading ? '正在读取…' : '请选择一个已连接的终端')}</div>;
  const key = JSON.stringify([file.machine.id, file.machine.host, file.path, file.line, file.column]);
  return file.type === 'directory'
    ? <Directory key={key} context={context} file={file} {...navigation} />
    : <FileView key={key} context={context} file={file} {...navigation} />;
}

export function open(context: UiContext, record?: TabRecord) {
  if (!record || record.id === 'directory') openTab(context, record?.workspaceId ?? activeWorkspaceId);
}

function openTab(context: UiContext, workspaceId?: string, file?: FileClick) {
  const history = histories.get(workspaceId) ?? { entries: [], index: -1 };
  histories.set(workspaceId, history);
  const push = (file: FileClick) => {
    const current = history.entries[history.index];
    if (!current || current.machine.id !== file.machine.id || current.machine.host !== file.machine.host || current.type !== file.type || current.path !== file.path || current.line !== file.line || current.column !== file.column) {
      history.entries = [...history.entries.slice(0, history.index + 1), file];
      history.index++;
    } else history.entries[history.index] = file;
  };
  if (file) push(file);
  context.host.tabs({ id: 'directory', title: '文件', workspaceId, onClose: () => histories.delete(workspaceId), mount(container: HTMLElement) {
    container.style.fontFamily = font.family;
    const root = createRoot(container);
    const render = () => root.render(<BrowserView context={context} workspaceId={workspaceId} file={history.entries[history.index]}
      navigate={(file) => { push(file); render(); }}
      refresh={() => { history.entries[history.index] = { ...history.entries[history.index] }; render(); }}
      back={history.index > 0 ? () => { history.index--; render(); } : undefined}
      forward={history.index < history.entries.length - 1 ? () => { history.index++; render(); } : undefined} />);
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
  const response = await fetch(new URL('./ui.worker.js', import.meta.url));
  if (!response.ok) throw new Error('Cannot load file preview worker');
  const workerURL = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
  const workers = new Set<Worker>();
  self.MonacoEnvironment = { getWorker() {
    const worker = new Worker(workerURL, { type: 'module' });
    workers.add(worker);
    return worker;
  } };
  const offActive = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => { activeWorkspaceId = value?.workspaceId; });
  void context.global.publish('workspace:query', null);
  const off = context.global.subscribe<FileClick>('onclick', (file) => openTab(context, activeWorkspaceId, file));
  return () => {
    offActive();
    off();
    histories.clear();
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerURL);
    delete self.MonacoEnvironment;
  };
}
