import { Fragment, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import fuzzysort, { type KeysResult } from 'fuzzysort';
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
import { LanguageServices, buffer, languageFor, ownProviders, type FileSymbol } from './lsp';
import { vimCommand, vimKeys } from './vim';
import { imageMime, machineKey, type FileClick, type Font, type GitHunk, type GitLines, type GitStatus, type History, type HistoryEntry, type Position, type SearchHit, type Settings, type VimKeys } from './shared';
import './style.css';

export const title = '文件';
let activeWorkspaceId: string | undefined;
let preview: { url: string; message: string };
let font: Font;
let editorLineHeight = 0;
let vimSettings: VimKeys | undefined;
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

type Remember = (entry: HistoryEntry, at: Partial<Position>) => void;
// A position a jump left or landed on.
type Jump = { path: string; line: number; column: number };
type Jumps = { entries: Jump[]; index: number };
type NavigationProps = { context: UiContext; file: HistoryEntry; navigate: (file: FileClick) => void; refresh: () => void; back?: () => void; forward?: () => void; openPicker: () => void; openSearch: () => void };

function Navigation({ context, file, navigate, refresh, back, forward, openPicker, openSearch, children }: NavigationProps & { children?: ReactNode }) {
  const [path, setPath] = useState(file.path);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => { setPath(file.path); setError(''); return () => { request.current++; }; }, [file]);
  return <>
    <header className="preview-header">
      <button className="preview-icon" aria-label="后退" title="后退" disabled={!back} onClick={back}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3 2 8l5 5 M2 8h12" /></svg>
      </button>
      <button className="preview-icon" aria-label="前进" title="前进" disabled={!forward} onClick={forward}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9 3 5 5-5 5 M2 8h12" /></svg>
      </button>
      <button className="preview-icon" aria-label="刷新" title="刷新" onClick={refresh}>
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
      <button className="preview-icon" aria-label="搜索" title="搜索文件、内容与符号" onClick={openSearch}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4" /><path d="m10 10 4 4" /></svg>
      </button>
    </header>
    {error && <div className="file-message" role="alert">{error}</div>}
  </>;
}

type Mode = 'text' | 'markdown' | 'html';
const modeLabels: Record<Mode, string> = { text: '文本', markdown: 'Markdown 预览', html: 'HTML 预览' };

function ModeMenu({ modes, mode, select }: { modes: Mode[]; mode: Mode; select: (mode: Mode) => void }) {
  const [open, setOpen] = useState(false);
  if (!modes.length) return null;
  // One way to read the file is still worth naming.
  if (modes.length === 1) return <span className="preview-mode">{modeLabels[mode]}</span>;
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

const stateLabels = { connecting: '正在启动', open: '运行中', closed: '已退出', missing: '未启动' };

// The dot in the toolbar for this file's language service: hovering it names that service and how it is doing, and
// clicking it starts the server behind the file, or starts it again when one was running.
function LspStatus({ model }: { model?: monaco.editor.ITextModel }) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [hover, setHover] = useState(false);
  useEffect(() => services?.subscribe(rerender), []);
  const status = model && services?.status(model);
  if (!model || !status) return null;
  return <div className="preview-lsp-wrap" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    <button className={`preview-icon preview-lsp ${status.state}`} type="button" aria-label={`语言服务：${status.server}`} onClick={() => void services?.restart(model)}>
      <span className="preview-lsp-dot" />
    </button>
    {hover && <div className="preview-lsp-detail" role="tooltip">
      <span className="preview-lsp-name">{status.server}</span>
      <span>{stateLabels[status.state]}</span>
      {status.root && <span>{status.root}</span>}
      {status.error && <span>{status.error}</span>}
      {status.log && <span>{status.log}</span>}
      <span>{status.state === 'missing' ? '点击重试' : '点击重启这个服务'}</span>
    </div>}
  </div>;
}

// The right-click menu's four location features, each with the monaco action that asks its server for the answer.
const lspActions = [
  { method: ownProviders.definitionProvider, action: 'editor.action.revealDefinition', label: '转到定义' },
  { method: ownProviders.implementationProvider, action: 'editor.action.goToImplementation', label: '转到实现' },
  { method: ownProviders.typeDefinitionProvider, action: 'editor.action.goToTypeDefinition', label: '转到类型定义' },
  { method: ownProviders.referencesProvider, action: 'editor.action.referenceSearch.trigger', label: '查找引用' },
];

// A gutter mark, carrying the hunk a click on it opens.
type GitMark = { line: number; kind: 'added' | 'modified' | 'deleted'; hunk: GitHunk };

// The gutter states a diff implies: removed lines paired with added ones read as a modification, and whatever is left
// over is an addition, or a deletion marked on the line that now follows it.
function lineStates(hunks: GitHunk[], lineCount: number) {
  const states: GitMark[] = [];
  for (const hunk of hunks) {
    let line = hunk.newStart;
    let block: { start: number; removed: number; added: number } | undefined;
    const flush = () => {
      if (!block) return;
      const paired = Math.min(block.removed, block.added);
      for (let index = 0; index < paired; index++) states.push({ line: block.start + index, kind: 'modified', hunk });
      for (let index = paired; index < block.added; index++) states.push({ line: block.start + index, kind: 'added', hunk });
      if (block.removed > block.added) states.push({ line: Math.min(block.start + block.added, lineCount), kind: 'deleted', hunk });
      block = undefined;
    };
    for (const { kind } of hunk.lines) {
      if (kind === 'context') { flush(); line++; }
      else {
        if (!block) block = { start: line, removed: 0, added: 0 };
        if (kind === 'removed') block.removed++;
        else { block.added++; line++; }
      }
    }
    flush();
  }
  return states;
}

const gitLineLabels = { added: '已新增', modified: '已修改', deleted: '已删除' };

// The block a gutter mark stands for: its own lines diffed in a peek, the way a language server's jump opens one.
function DiffPeek({ path, change, area, rowTop, close }: { path: string; change: GitMark; area: DOMRect; rowTop: number; close: () => void }) {
  const shell = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // A row is only as tall as the editor makes it, so the block is built before the first paint.
  useLayoutEffect(() => {
    const language = languageFor(path);
    const original = monaco.editor.createModel(change.hunk.lines.filter(({ kind }) => kind !== 'added').map(({ text }) => text).join('\n'), language);
    const modified = monaco.editor.createModel(change.hunk.lines.filter(({ kind }) => kind !== 'removed').map(({ text }) => text).join('\n'), language);
    const editor = monaco.editor.createDiffEditor(content.current!, {
      readOnly: true, renderSideBySide: false, minimap: { enabled: false }, renderOverviewRuler: false,
      scrollBeyondLastLine: false, automaticLayout: true, theme: 'wangcai',
      fontSize: font.size, fontFamily: font.family, lineHeight: editorLineHeight,
    });
    editor.setModel({ original, modified });
    // The peek prints a hunk rather than the whole file, so both sides count from the line each one starts at.
    editor.getOriginalEditor().updateOptions({ lineNumbers: (line) => String(change.hunk.oldStart + line - 1) });
    editor.getModifiedEditor().updateOptions({ lineNumbers: (line) => String(change.hunk.newStart + line - 1) });
    // An inline diff gives every line of the hunk a row, and a block taller than the page scrolls inside the peek.
    const body = content.current!;
    body.style.height = `${change.hunk.lines.length * editor.getModifiedEditor().getOption(monaco.editor.EditorOption.lineHeight)}px`;
    return () => {
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [change, path]);
  // A new area moves the peek, and the block it shows is left as it is.
  useLayoutEffect(() => {
    const panel = shell.current!;
    // A row with no room left below it rides the peek up rather than past the page's bottom edge.
    panel.style.top = `${Math.max(area.top, Math.min(rowTop, area.bottom - panel.offsetHeight))}px`;
  }, [area, rowTop]);
  // The peek takes the page's own box, which is what lines it up with the files page edge to edge.
  return <div className="git-peek" ref={shell} role="dialog" aria-label="行变更" style={{ left: area.left, width: area.width, maxHeight: area.height }}>
    <div className="git-peek-head">
      <span>{gitLineLabels[change.kind]} · 第 {change.line} 行</span>
      <button type="button" aria-label="关闭行变更" title="关闭" onClick={close}>×</button>
    </div>
    <div className="git-peek-body" ref={content} />
  </div>;
}

function Preview({ file, text, mode, hunks, navigate, onModel, remember, previewing, jumps, openSearch, nextMode }: { file: HistoryEntry; text: string; mode: Mode; hunks: GitHunk[]; navigate: (file: FileClick) => void; onModel: (model?: monaco.editor.ITextModel) => void; remember: Remember; previewing: boolean; jumps: Jumps; openSearch: () => void; nextMode: () => void }) {
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
  const control = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  // The marks of the decorations on screen, which is what a gutter click resolves against.
  const marks = useRef<GitMark[]>([]);
  // The entry the editor shows now: the editor outlives the entry it was built for, so what its callbacks record is
  // read from here. The ref is updated after the commit, before the effects below can record through it.
  const shown = useRef(file);
  useEffect(() => { shown.current = file; });
  const [menu, setMenu] = useState<{ x: number; y: number; actions: typeof lspActions }>();
  const [peek, setPeek] = useState<{ area: DOMRect; rowTop: number; change: GitMark }>();
  // A layer over the editor takes the caret with it, so closing one hands the caret back.
  const closeMenu = () => { setMenu(undefined); control.current?.focus(); };
  const closePeek = () => { setPeek(undefined); control.current?.focus(); };
  // A line's offset is a content coordinate, so the page's own top and the current scroll are what turn it into a
  // viewport one.
  const placePeek = (change: GitMark) => {
    const editor = control.current!;
    const area = element.current!.getBoundingClientRect();
    return { area, rowTop: area.top + editor.getTopForLineNumber(change.line) - editor.getScrollTop() };
  };
  useEffect(() => {
    if (!peek) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') closePeek(); };
    addEventListener('keydown', escape);
    return () => removeEventListener('keydown', escape);
  }, [peek?.change]);
  // The page resizes with the window, and the peek covers it, so the peek is placed again whenever it does.
  useEffect(() => {
    if (!peek) return;
    const observer = new ResizeObserver(() => setPeek((current) => current && { ...placePeek(current.change), change: current.change }));
    observer.observe(element.current!);
    return () => observer.disconnect();
  }, [peek?.change]);
  // The peek shows one block of the code view, so it goes when that block is gone, has changed, or the code view is
  // left. A repository event elsewhere only reads the marks again, so the block on show is compared by content and an
  // unchanged one keeps its peek open.
  useEffect(() => {
    if (!peek) return;
    const peeked = JSON.stringify(peek.change.hunk);
    if (mode === 'text' && hunks.some((hunk) => JSON.stringify(hunk) === peeked)) return;
    setPeek(undefined);
  }, [hunks, mode]);
  // The editor is built again when the text or the mode changes, and never for a jump: a jump moves the same editor, so
  // the language server keeps the model it already synchronizes.
  useEffect(() => {
    if (mode !== 'text') return;
    const language = languageFor(file.path);
    // A file shown from another machine is the same model.
    const model = buffer(monaco.Uri.file(file.path), language, text);
    onModel(model);
    const editor = monaco.editor.create(element.current!, {
      model, theme: 'wangcai', readOnly: true, domReadOnly: true,
      automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
      fontSize: font.size, lineHeight: editorLineHeight, fontFamily: font.family, lineNumbersMinChars: 3, renderLineHighlight: 'none',
      // The caret is a block that holds still, which is how a reader of the normal mode expects to see it.
      cursorStyle: 'block', cursorBlinking: 'solid',
      ariaLabel: '代码预览', contextmenu: false,
    });
    control.current = editor;
    const scrolled = editor.onDidScrollChange(() => remember(shown.current, { top: editor.getScrollTop() }));
    const moved = editor.onDidChangeCursorPosition(({ position }) => remember(shown.current, { line: position.lineNumber, column: position.column }));
    // A landing position in the file shown moves the caret; one in another file opens that file at its line.
    const jumpTo = (target: Jump) => {
      if (target.path === file.path) {
        const position = new monaco.Position(target.line, target.column);
        editor.setPosition(position);
        editor.revealPositionInCenterIfOutsideViewport(position);
        return;
      }
      navigate({ type: 'file', machine: file.machine, path: target.path, line: target.line, column: target.column });
    };
    const walk = (by: number) => {
      const at = jumps.index + by;
      const target = jumps.entries[at];
      if (!target) return;
      jumps.index = at;
      jumpTo(target);
    };
    // A jump leaves its starting position and its landing one in the list, and a jump made after going back starts the
    // list over from the position it was made at.
    const jumped = (origin: Jump, target: Jump) => {
      jumps.entries.length = jumps.index + 1;
      for (const entry of [origin, target]) {
        // Walking the list must not stop twice in one place.
        const last = jumps.entries[jumps.entries.length - 1];
        if (!last || last.path !== entry.path || last.line !== entry.line || last.column !== entry.column) jumps.entries.push(entry);
      }
      jumps.index = jumps.entries.length - 1;
    };
    // `gd` asks this file's server where the name under the caret is defined, and jumps there. An answer that only names
    // this file is the import a name came in through, which a server that has read the program answers differently, so a
    // short round of asking again is worth the wait; a name declared here keeps answering the same line.
    const definition = async () => {
      const position = editor.getPosition();
      const current = editor.getModel();
      const proxy = current && services?.for(current);
      if (!position || !current || !proxy) return;
      const here = current.uri.toString(true).toLowerCase();
      const elsewhere = (locations: monaco.languages.Location[]) => locations.some((location) => location.uri.toString(true).toLowerCase() !== here);
      const found = await proxy.settled(() => proxy.definition(current, position), elsewhere, 3);
      const first = found[0];
      if (!first) return;
      const origin: Jump = { path: file.path, line: position.lineNumber, column: position.column };
      const target: Jump = { path: first.uri.path, line: first.range.startLineNumber, column: first.range.startColumn };
      jumped(origin, target);
      jumpTo(target);
    };
    // The page answers vim-style keys while its text has the keyboard; the picker's box and monaco's own widgets keep theirs.
    const vim = vimKeys(editor, {
      keys: vimSettings, jumpBack: () => walk(-1), jumpForward: () => walk(1), definition, search: openSearch,
      nextMode, copy: (text) => void navigator.clipboard.writeText(text).catch(() => undefined),
    });
    const opened = editor.onMouseDown((event) => {
      // A click on a gutter mark opens the block it stands for.
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
      const change = marks.current.find((mark) => mark.line === event.target.position?.lineNumber);
      if (!change) return;
      event.event.preventDefault();
      setPeek({ ...placePeek(change), change });
    });
    void services?.open({ machine: file.machine, path: file.path, language, model, navigate });
    const host = element.current!;
    // A right click asks this plugin's menu instead of the browser's.
    const openMenu = (event: MouseEvent) => {
      const target = editor.getTargetAtClientPoint(event.clientX, event.clientY);
      // Empty space below the text and the gutter beside it are not places to ask the server about.
      const at = target?.type === monaco.editor.MouseTargetType.CONTENT_TEXT ? target.position : null;
      // Nor is the spacing between words: every entry asks about an identifier.
      if (!at || !model.getLineContent(at.lineNumber)[at.column - 1]?.trim()) return;
      const actions = lspActions.filter(({ method }) => services?.for(model)?.supports(method));
      if (!actions.length) return;
      event.preventDefault();
      // Every entry asks the server about the cursor, so it goes where the click landed.
      editor.setPosition(at);
      setMenu({ x: event.clientX, y: event.clientY, actions });
    };
    host.addEventListener('contextmenu', openMenu);
    return () => {
      host.removeEventListener('contextmenu', openMenu);
      control.current = undefined;
      scrolled.dispose(); moved.dispose(); opened.dispose(); vim.dispose(); editor.dispose(); onModel(undefined);
    };
  }, [text, mode, remember]);
  // Every open, and every rebuild of the editor, puts the caret and the keyboard in the preview — unless the page is
  // only showing what a picker's selection stands for, where taking the keyboard would end the name being typed.
  useEffect(() => {
    if (!previewing) control.current?.focus();
  }, [previewing, text, mode]);
  // Where the view sits: the offset the file was left at, or else the line the entry was opened at, which a jump inside
  // the file moves to as well. An editor that was built again starts at its own top, so the offset is taken for it once
  // more; a panel that has given it no height yet places it on the first layout instead.
  const placement = useRef<{ editor: monaco.editor.IStandaloneCodeEditor; offset?: number }>(undefined);
  useEffect(() => {
    const editor = control.current;
    if (!editor) return;
    if (placement.current?.editor !== editor) placement.current = { editor, offset: file.top };
    const state = placement.current;
    const place = () => {
      if (!editor.getLayoutInfo().height) return false;
      if (state.offset !== undefined) { editor.setScrollTop(state.offset); state.offset = undefined; }
      else if (file.line !== undefined) {
        const position = { lineNumber: file.line, column: file.column ?? 1 };
        editor.setPosition(position);
        editor.revealPositionInCenter(position);
      }
      return true;
    };
    if (place()) return;
    const laidOut = editor.onDidLayoutChange(() => { if (place()) laidOut.dispose(); });
    return () => laidOut.dispose();
  }, [file.line, file.column, text, mode]);
  // Git can report new marks without the text changing, so they are applied whenever the read returns them.
  useEffect(() => {
    const editor = control.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    // A decoration carries a class name rather than the change behind it, so the marks are kept for the click to find.
    marks.current = lineStates(hunks, model.getLineCount());
    const decoration = editor.createDecorationsCollection(marks.current.map(({ line, kind }) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: { linesDecorationsClassName: `git-line-${kind}` },
    })));
    return () => decoration.clear();
  }, [hunks, text, mode]);
  if (mode === 'markdown') return <MarkdownPage text={text} top={file.top} remember={(at) => remember(file, at)} />;
  if (mode === 'html') return <iframe className="html-frame" ref={frame} title="HTML 预览" sandbox="allow-scripts" src={preview.url} />;
  return <>
    <div className="code-preview" ref={element} />
    {menu && <>
      <div className="menu-backdrop" onClick={closeMenu} />
      <div className="code-menu" role="menu" aria-label="语言服务" style={{ left: menu.x, top: menu.y }}
        onKeyDown={(event) => { if (event.key === 'Escape') closeMenu(); }}>
        {menu.actions.map(({ action, label }, index) => <button key={action} role="menuitem" autoFocus={index === 0}
          onClick={() => {
            // The button holds the focus, and the peek an action opens takes its keyboard from the editor, so the focus
            // goes back first: swapping these two lines is silent and costs the peek its keys.
            closeMenu();
            control.current?.trigger('code-menu', action, null);
          }}>{label}</button>)}
      </div>
    </>}
    {peek && <DiffPeek path={file.path} change={peek.change} area={peek.area} rowTop={peek.rowTop} close={closePeek} />}
  </>;
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
function MarkdownPage({ text, top, remember }: { text: string; top?: number; remember: (at: Partial<Position>) => void }) {
  const pane = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const drag = useRef<{ left: number; width: number } | undefined>(undefined);
  const painted = useRef(0);
  // A page can mount while its panel is hidden, where the pane has no size to measure: until a layout gives it one,
  // the offset it was left at waits, and the ratio it was left at is drawn as it is.
  const pending = useRef(top ?? 0);
  const restoreTop = () => {
    if (!pending.current || !pane.current!.clientHeight) return;
    pane.current!.scrollTop = pending.current;
    pending.current = 0;
  };
  const { fields, body } = splitFrontmatter(text);
  const paint = (ratio: number) => {
    const width = pane.current!.clientWidth;
    // A page that reached the pane's right edge would carry its divider out of reach, so the divider keeps its width.
    const room = width - divider.current!.offsetWidth;
    painted.current = room > 0 ? Math.min(room / width, Math.max(240 / width, ratio)) : ratio;
    page.current!.style.width = `${painted.current * 100}%`;
  };

  // The page takes the fraction its divider was dragged to, or a readable measure when it was never dragged.
  useLayoutEffect(() => {
    const restore = () => {
      const ratio = Number(localStorage.getItem('markdown-width'));
      paint(ratio > 0 ? ratio : 0.6);
    };
    const observer = new ResizeObserver(() => { restore(); restoreTop(); });
    observer.observe(pane.current!);
    restore();
    restoreTop();
    return () => observer.disconnect();
  }, []);

  return <div className="markdown-pane" ref={pane} onScroll={(event) => remember({ top: event.currentTarget.scrollTop })}>
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

// Whether the keyboard is being typed into a box, which keeps its keys to itself.
const writing = (target: EventTarget | null) => target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(target.tagName);

function FileView(props: NavigationProps & { holder: string; remember: Remember; previewing: boolean; jumps: Jumps }) {
  const { context, file, holder, navigate, remember, previewing, jumps, openSearch } = props;
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  const [hunks, setHunks] = useState<GitHunk[]>([]);
  const markdown = /\.(md|markdown)$/i.test(file.path);
  const html = /\.html?$/i.test(file.path);
  const image = imageMime(file.path);
  const modes: Mode[] = image ? [] : ['text', ...(markdown ? ['markdown' as const] : []), ...(html ? ['html' as const] : [])];
  // A file is read again when the path it names changes, not when the cursor moves inside it.
  useEffect(() => {
    let alive = true;
    let stop: () => void;
    let root = '';
    setText(undefined); setError(''); setHunks([]);
    const read = () => {
      void context.ui.request<string>('read', file).then((text) => { if (alive) { setText(text); setError(''); } })
        .catch((error: Error) => { if (alive) setError(error.message); });
      // The marks describe this text, so they are read with it; an image is a data URL with no lines to mark.
      if (image) return;
      void context.ui.request<GitLines | null>('git-lines', { machine: file.machine, path: file.path })
        .then((lines) => {
          if (!alive) return;
          setHunks(lines?.hunks ?? []);
          // A commit or a stage takes the marks away without touching the file, so the repository is watched too.
          if (!lines || lines.root === root) return;
          root = lines.root;
          stop();
          stop = watch(context, file.machine, holder, [file.path, `${root}/.git`], read);
        })
        .catch(() => { if (alive) setHunks([]); });
    };
    stop = watch(context, file.machine, holder, [file.path], read);
    read();
    return () => { alive = false; stop(); };
  }, [context, holder, file.path]);
  // A file with a text view opens as that text.
  const [mode, setMode] = useState<Mode>('text');
  const nextMode = () => setMode((current) => modes[(modes.indexOf(current) + 1) % modes.length]);
  // A rendered view has no editor to hold the keys of the normal mode, so the one key that leaves it is taken here; the
  // editor's own keys answer first, which is what `defaultPrevented` reports.
  useEffect(() => {
    if (modes.length < 2) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || writing(event.target) || vimCommand(event, vimSettings) !== 'vim.nextMode') return;
      event.preventDefault();
      nextMode();
    };
    addEventListener('keydown', onKeyDown);
    return () => removeEventListener('keydown', onKeyDown);
  }, [modes.length]);
  const [model, setModel] = useState<monaco.editor.ITextModel>();
  return <section className="file-preview" aria-label="文件预览">
    <Navigation {...props}>
      <ModeMenu modes={modes} mode={mode} select={setMode} />
      <LspStatus model={model} />
    </Navigation>
    {error ? <div className="file-message" role="alert">{error}</div>
      : text === undefined ? <div className="file-message">正在读取…</div>
      : image ? <div className="image-preview"><img src={text} alt={file.path} /></div>
      : <Preview file={file} text={text} mode={mode} hunks={hunks} onModel={setModel} navigate={navigate} remember={remember} previewing={previewing} jumps={jumps} openSearch={openSearch} nextMode={nextMode} />}
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

function Picker(props: NavigationProps & { workspace: string; holder: string }) {
  const { context, file, workspace, holder, navigate } = props;
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
  const directories = chain(file, workspace);
  // A reload reads the columns again and asks for the marks again, since it is what a missed change is repaired with.
  const reload = () => { setStale(new Set(directories)); setChanges((count) => count + 1); };
  useEffect(() => {
    let alive = true;
    setError('');
    const reading = directories.filter((directory) => !entries.has(directory) || stale.has(directory));
    for (const directory of reading) {
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
  // The marks belong to the repository rather than to the columns, so they are read in a request of their own.
  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    void context.ui.request<GitStatus | null>('git-status', { machine: file.machine, path: workspace })
      .then((status) => { if (alive) setGit({ workspace, root: status?.root ?? '', marks: status ? markFolders(status) : new Map() }); })
      .catch(() => { if (alive) setGit({ workspace, root: '', marks: new Map() }); });
    return () => { alive = false; };
  }, [context, file, workspace, changes]);
  // A reload keeps the watch: it follows the same chain, and giving it up would lose the changes that arrive while
  // it is gone. The repository joins it once its root is known.
  const repository = git?.root ? `${git.root}/.git` : '';
  useEffect(() => watch(context, file.machine, holder, repository ? [...directories, repository] : directories, (path) => {
    setChanges((count) => count + 1);
    // The repository is here for the marks alone, and `stale` holds the columns.
    if (path !== repository) setStale((current) => new Set(current).add(path));
  }), [context, file, workspace, holder, repository]);
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
              const mark = git?.workspace === workspace ? git.marks.get(path) : undefined;
              const badge = mark && !entry.isDirectory ? mark : undefined;
              return <button key={entry.name} title={badge ? `${entry.name} · ${gitLabels[badge]}` : entry.name} data-git={mark} aria-current={path === opened || undefined} onClick={() => navigate({ type: entry.isDirectory ? 'directory' : 'file', machine: file.machine, path })}>
                <svg className="file-icon" data-kind={entry.isDirectory ? 'folder' : 'file'} aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4">
                  {entry.isDirectory ? <path d="M2 5h6l2 2h8v10H2z" /> : <path d="M5 2h6l4 4v12H5z M11 2v5h4 M8 11h4 M8 14h4" />}
                </svg><span className="file-name">{entry.name}{entry.isDirectory ? '/' : ''}</span>{badge && <span className="file-git" aria-hidden="true">{badge}</span>}
              </button>;
            })}
            {listing?.length === 0 && <div className="file-message">空目录</div>}
          </nav>;
        })}
      </div>}
  </section>;
}

// How many rows the page draws of a search's answer, and the number the note about a cut list names.
const rowLimit = 200;
// How well a match has to score to be listed: a name or path with the query in a run scores .7 and up, letters
// scattered across one score around .3. A row whose matched side stays under it is left out of either search below.
const matchThreshold = 0.6;

// What the picker looks for, and the character that asks for each: a file's name, a pattern in the workspace's text, and
// the symbols of the entry the tab is on.
type SearchMode = 'files' | 'grep' | 'symbols';
const searchLabels: Record<SearchMode, { hint: string; empty: string }> = {
  files: { hint: '文件名', empty: '没有匹配的文件' },
  grep: { hint: '内容', empty: '没有匹配的内容' },
  symbols: { hint: '符号', empty: '没有匹配的符号' },
};
// A row of the picker: what it says, and which of its characters the query matched, which the row marks.
type SearchRow = { key: string; title: string; detail?: string; target: FileClick; marks?: ReadonlyArray<number>; detailMarks?: ReadonlyArray<number> };
// `shown` is the path the row prints. The query is matched against it as printed rather than against the file's own
// path, so that a marked character lands on the character it matched.
type FileRow = { shown: string; row: SearchRow };

// A text with the characters at those indexes marked, so a row shows why it is on the list. The indexes count UTF-16
// code units, as fuzzysort reports them, so the text is split the same way rather than by code point; a text with
// nothing marked is handed back whole, as one node rather than one per character.
const marked = (text: string, marks?: ReadonlyArray<number>) => {
  if (!marks?.length) return text;
  const at = new Set(marks);
  return text.split('').map((letter, index) => (at.has(index) ? <b key={index}>{letter}</b> : letter));
};

// The search picker: one input whose first character chooses what it looks for, and the rows it finds under it. The page
// follows the row under the selection, so what a row stands for is seen before Enter opens it.
function Search({ context, visited, workspace, peek, navigate, close }: { context: UiContext; visited: HistoryEntry; workspace: string; peek: (file: FileClick) => void; navigate: (file: FileClick) => void; close: () => void }) {
  const [query, setQuery] = useState('');
  // A row is chosen by the user or not at all: until one is, the selection marks the row of the entry the tab is on and
  // nothing is followed, so opening the picker does not take the reader away from what they were reading.
  const [chosen, setChosen] = useState<number>();
  const [files, setFiles] = useState<{ paths: string[]; truncated: boolean }>();
  const [matches, setMatches] = useState<{ hits: SearchHit[]; truncated: boolean }>({ hits: [], truncated: false });
  const [symbols, setSymbols] = useState<FileSymbol[]>();
  // The message the picker shows, tagged with the source it speaks for: the search that wrote it may have been left
  // behind.
  const [status, setStatus] = useState<{ mode: SearchMode; text: string }>();
  const clearStatus = (source: SearchMode) => setStatus((current) => (current?.mode === source ? undefined : current));
  const list = useRef<HTMLDivElement>(null);
  // Where a search starts: the workspace, or else the directory the tab's own entry sits in.
  const directory = workspace || (visited.type === 'directory' ? visited.path : visited.path.slice(0, visited.path.lastIndexOf('/')) || '/');
  const mode: SearchMode = query.startsWith('>') ? 'grep' : query.startsWith('@') ? 'symbols' : 'files';
  const pattern = mode === 'files' ? query : query.slice(1);
  useEffect(() => {
    let alive = true;
    void context.ui.request<{ files: string[]; truncated: boolean }>('find-files', { machine: visited.machine, path: directory })
      .then((listed) => { if (alive) { setFiles({ paths: listed.files, truncated: listed.truncated }); clearStatus('files'); } })
      .catch((problem: Error) => { if (alive) { setFiles({ paths: [], truncated: false }); setStatus({ mode: 'files', text: problem.message }); } });
    return () => { alive = false; };
  }, [context, visited.machine, directory]);
  // Asking for these makes the language service open the document and answer for it.
  useEffect(() => {
    if (mode !== 'symbols') return;
    let alive = true;
    const model = monaco.editor.getModel(monaco.Uri.file(visited.path));
    if (!model) return;
    void services?.symbols(model).then((found) => { if (alive) setSymbols(found ?? []); });
    return () => { alive = false; };
  }, [mode, visited.path]);
  // The answer that arrives for a pattern no longer in the input is dropped, since the rows on show belong to the current
  // one.
  const asked = useRef(0);
  useEffect(() => {
    if (mode !== 'grep') return;
    const needle = pattern.trim();
    if (!needle) { setMatches({ hits: [], truncated: false }); clearStatus('grep'); return; }
    const id = ++asked.current;
    setStatus({ mode: 'grep', text: '正在搜索…' });
    // rg is asked once typing pauses: a key pressed mid-word would otherwise start a search for a pattern already gone.
    const timer = setTimeout(() => {
      void context.ui.request<{ hits: SearchHit[]; truncated: boolean }>('grep', { machine: visited.machine, path: directory, query: needle })
        .then((found) => {
          if (id !== asked.current) return;
          setMatches({ hits: found.hits, truncated: found.truncated });
          clearStatus('grep');
        })
        .catch((problem: Error) => { if (id !== asked.current) return; setMatches({ hits: [], truncated: false }); setStatus({ mode: 'grep', text: problem.message }); });
    }, 150);
    return () => clearTimeout(timer);
  }, [mode, pattern, context, visited.machine, directory]);
  // The rows the page draws, and how many the source offered before the page kept its share. Every branch stops at the
  // row limit.
  const { rows, matched } = useMemo<{ rows: SearchRow[]; matched: number }>(() => {
    const needle = pattern.trim();
    if (mode === 'grep') {
      const candidates = matches.hits.map((hit) => ({
        key: `${hit.path}:${hit.line}`, title: hit.text || ' ',
        detail: `${hit.path.startsWith(`${directory}/`) ? hit.path.slice(directory.length + 1) : hit.path}:${hit.line}`,
        target: { type: 'file' as const, machine: visited.machine, path: hit.path, line: hit.line, column: hit.column },
      }));
      return { rows: candidates.slice(0, rowLimit), matched: candidates.length };
    }
    if (mode === 'symbols') {
      const candidates = (symbols ?? []).map((symbol) => ({ key: `${symbol.line}:${symbol.column}`, title: symbol.name, detail: symbol.container, target: { type: 'file' as const, machine: visited.machine, path: visited.path, line: symbol.line, column: symbol.column } }));
      if (!needle) return { rows: candidates.slice(0, rowLimit), matched: candidates.length };
      const found = fuzzysort.go(needle, candidates, { key: 'title', threshold: matchThreshold, limit: rowLimit });
      return { rows: found.map((one) => ({ ...one.obj, marks: one.indexes })), matched: found.total };
    }
    const candidates = (files?.paths ?? []).map((path) => {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const folder = path.startsWith(`${directory}/`) ? path.slice(directory.length + 1, path.length - name.length - 1) : path.slice(0, path.lastIndexOf('/'));
      return { shown: folder ? `${folder}/${name}` : name, row: { key: path, title: name, detail: folder, target: { type: 'file' as const, machine: visited.machine, path } } };
    });
    if (!needle) return { rows: candidates.slice(0, rowLimit).map(({ row }) => row), matched: candidates.length };
    // Which side of a row the query matched well enough to rank it and to mark it: the name, or else the path it sits
    // on.
    const byName = (one: KeysResult<FileRow>) => one[0].score >= matchThreshold;
    // A name match lifts its row a tier above every row only its path matched: a path score cannot pass 1, so the 2
    // puts it out of reach.
    const found = fuzzysort.go(needle, candidates, {
      keys: ['row.title', 'shown'], threshold: matchThreshold, limit: rowLimit,
      // A shorter path settles a tie inside one tier. The floor only lifts a score that cleared the threshold, so the
      // nudge cannot push a listed row out, and a weaker match keeps its own score.
      scoreFn: (one) => {
        const score = byName(one) ? 2 + one[0].score : one[1].score;
        return score < matchThreshold ? score : Math.max(matchThreshold, score - one.obj.shown.length / 10000);
      },
    });
    return {
      rows: found.map((one) => {
        if (byName(one)) return { ...one.obj.row, marks: one[0].indexes };
        // A path match is marked on the side of the row it fell on: the folder, the name, or both when the query runs
        // across the slash between them.
        const detail = one.obj.row.detail ?? '';
        const fromName = one.obj.shown.length - one.obj.row.title.length;
        return {
          ...one.obj.row,
          detailMarks: one[1].indexes.filter((at) => at < detail.length),
          marks: one[1].indexes.filter((at) => at >= fromName).map((at) => at - fromName),
        };
      }),
      matched: found.total,
    };
  }, [mode, pattern, directory, visited.machine, visited.path, files, matches, symbols]);
  const cutBySource = mode === 'grep' ? matches.truncated : mode === 'files' ? files?.truncated ?? false : false;
  const cut = matched > rowLimit || cutBySource;
  const note = (status?.mode === mode ? status.text : '') || (cut ? `结果过多，只显示前 ${rowLimit} 条` : '');
  // The index of the row standing for the entry the tab is on, if the rows hold it.
  const current = rows.findIndex((row) => row.target.path === visited.path && (row.target.line === undefined || row.target.line === visited.line));
  // Rows arrive after the keystroke that asked for them, so the chosen one is kept within what is on show.
  const at = Math.min(chosen ?? Math.max(current, 0), Math.max(rows.length - 1, 0));
  useEffect(() => { list.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' }); }, [at, rows]);
  // A name typed a letter at a time would otherwise read a file per letter, so the row under the selection is taken
  // once the selection rests.
  useEffect(() => {
    const target = rows[at]?.target;
    if (chosen === undefined || !target) return;
    const timer = setTimeout(() => peek(target), 120);
    return () => clearTimeout(timer);
  }, [chosen, at, rows]);
  return <div className="search-panel" role="dialog" aria-label="搜索">
    <div className="search-head">
      <span className="search-mode">{searchLabels[mode].hint}</span>
      <input className="search-input" aria-label="搜索" autoFocus value={query} spellCheck={false} placeholder="文件名 · > 内容 · @ 符号"
        onChange={(event) => { setQuery(event.target.value); setChosen(0); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); close(); }
          else if (event.key === 'Enter') { event.preventDefault(); const row = rows[at]; if (row) navigate(row.target); }
          else if (event.key === 'ArrowDown') { event.preventDefault(); setChosen(Math.min(at + 1, Math.max(rows.length - 1, 0))); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setChosen(Math.max(at - 1, 0)); }
        }} />
      <button className="search-close" type="button" aria-label="关闭搜索" title="关闭" onClick={close}>×</button>
    </div>
    {note && <div className="search-note">{note}</div>}
    <div className="search-list" ref={list}>
      {rows.map((row, index) => <button key={row.key} type="button" className="search-row" aria-current={index === at || undefined} onClick={() => navigate(row.target)} onMouseEnter={() => setChosen(index)}>
        <span className="search-title">{marked(row.title, row.marks)}</span>
        {row.detail && <span className="search-detail">{marked(row.detail, row.detailMarks)}</span>}
      </button>)}
      {!rows.length && <div className="file-message">{searchLabels[mode].empty}</div>}
    </div>
  </div>;
}

// The page a tab draws: the file on show or the columns of the directory picker, and the search picker over it.

// `file` is what the page shows, which a picker's selection may stand in for; `visited` is the entry the tab is on,
// which the picker anchors to — the file whose symbols it lists, and the directory it searches in.
function BrowserView({ context, workspaceId, holder, file, visited, picking, searching, remember, jumps, closeSearch, peek, ...navigation }: Omit<NavigationProps, 'file'> & { workspaceId?: string; holder: string; file?: HistoryEntry; visited?: HistoryEntry; picking: boolean; searching: boolean; remember: Remember; jumps: Jumps; closeSearch: () => void; peek: (file: FileClick) => void }) {
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
  // Only a different path or machine rebuilds the page.
  const key = JSON.stringify([file.machine.id, file.machine.host, file.path]);
  // A machine lists its own directories, while a walk through one keeps the columns it opened, so only a
  // different machine rebuilds the picker.
  const pickerKey = machineKey(file.machine);
  return <div className={searching ? 'browser-view searching' : 'browser-view'}>
    {file.type === 'directory' || picking
      ? <Picker key={pickerKey} context={context} file={file} workspace={workspace} holder={holder} {...navigation} />
      : <FileView key={key} context={context} file={file} holder={holder} remember={remember} jumps={jumps} previewing={searching} {...navigation} />}
    {visited && searching && <Search context={context} visited={visited} workspace={workspace} peek={peek} navigate={navigation.navigate} close={closeSearch} />}
  </div>;
}

export function open(context: UiContext, record?: TabRecord) {
  if (!record || record.id === 'directory') openTab(context, record?.workspaceId ?? activeWorkspaceId);
}

const openFiles = () => [...histories.values()].map((history) => history.entries[history.index]).filter((file): file is FileClick => file?.type === 'file');

function openTab(context: UiContext, workspaceId?: string, file?: FileClick) {
  const key = workspaceId ?? '';
  const history = histories.get(key) ?? { entries: [], index: -1 };
  histories.set(key, history);
  // Kept on the tab so it outlives the page each jump lands on.
  const jumps: Jumps = { entries: [], index: -1 };
  // What the tab shows on top of the page the history points at: the two pickers, and the file a picker's selection
  // stands for, which is shown without being visited.
  const view: { picking: boolean; searching: boolean; preview?: FileClick } = { picking: false, searching: false };
  const push = (file: FileClick) => {
    const current = history.entries[history.index];
    const same = current && machineKey(current.machine) === machineKey(file.machine) && current.type === file.type && current.path === file.path;
    // A file opened without a line is the visit already there, which keeps where it was left; a jump to a line of it is a
    // visit of its own, so going back returns to the line it left.
    if (same && (file.line === undefined || (file.line === current.line && file.column === current.column))) {
      // The view reads a new entry as a new visit, which is what puts back the path the address box was typed over.
      history.entries[history.index] = { ...current };
      return;
    }
    history.entries = [...history.entries.slice(0, history.index + 1), file];
    history.index++;
    void context.ui.request('save-history', Object.fromEntries(histories));
  };
  if (file) push(file);
  context.host.tabs({ id: 'directory', title: '文件', workspaceId, onClose() {
    for (const [key, value] of histories) if (value === history) histories.delete(key);
    void context.ui.request('save-history', Object.fromEntries(histories));
    void services?.closeUnused(openFiles());
  }, mount(container: HTMLElement) {
    container.style.fontFamily = font.family;
    const root = createRoot(container);
    // Every move of what the tab shows goes through here: a caller says what it opens, and what no longer holds is
    // cleared for it, so no caller has to remember the parts it is not touching.
    const show = (next: Partial<typeof view> = {}) => {
      Object.assign(view, { picking: false, searching: false, preview: undefined }, next);
      render();
    };
    // A view is handed the same callbacks on every render: its effect depends on navigate, and a new identity each
    // render would run that effect again, which asks for the workspace again, which navigates and renders again.
    const navigate = (file: FileClick) => { push(file); show(); };
    const openPicker = () => show({ picking: true });
    const openSearch = () => show({ searching: true });
    const closeSearch = () => show();
    // The picker stays open where the name is being typed.
    const peek = (file: FileClick) => show({ searching: true, preview: file });
    const refresh = () => { history.entries[history.index] = { ...history.entries[history.index] }; render(); };
    // Walking the tab's history: the entry it lands on is saved with the rest, and the pickers it leaves are cleared.
    const step = (by: number) => {
      history.index += by;
      void context.ui.request('save-history', Object.fromEntries(histories));
      show();
    };
    // The entry is the one the view shows rather than whatever the history points at now: a cursor move monaco reports
    // after a jump belongs to the file that was left, not to the one the jump opened.
    const remember = (entry: HistoryEntry, at: Partial<Position>) => {
      Object.assign(entry, at);
      // A file left at its top is where a fresh open puts it, so there is no offset worth keeping.
      if (entry.top === 0) delete entry.top;
    };
    const render = () => root.render(<BrowserView context={context} workspaceId={workspaceId} holder={key} file={view.preview ?? history.entries[history.index]} visited={history.entries[history.index]} picking={view.picking} searching={view.searching}
      navigate={navigate}
      remember={remember}
      jumps={jumps}
      openPicker={openPicker}
      openSearch={openSearch}
      closeSearch={closeSearch}
      peek={peek}
      refresh={refresh}
      back={history.index > 0 ? () => step(-1) : undefined}
      forward={history.index < history.entries.length - 1 ? () => step(1) : undefined} />);
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
      'diffEditor.insertedLineBackground': alpha(theme.green, 0.12),
      'diffEditor.removedLineBackground': alpha(theme.red, 0.12),
      'diffEditor.insertedTextBackground': alpha(theme.green, 0.2),
      'diffEditor.removedTextBackground': alpha(theme.red, 0.2),
      'scrollbarSlider.background': alpha(theme.muted, 0.25),
      'scrollbarSlider.hoverBackground': alpha(theme.muted, 0.4),
      'scrollbarSlider.activeBackground': alpha(theme.muted, 0.5),
    },
  };
}

export async function mount(_container: HTMLElement, context: UiContext) {
  const profile: Settings = context.host.config;
  font = profile.font;
  vimSettings = profile.vim?.keys;
  editorLineHeight = font.lineHeight ? Math.round(font.size * font.lineHeight) : 0;
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
  const providers = [
    monaco.languages.registerDefinitionProvider({ scheme: 'file' }, {
      provideDefinition: (model, position) => services?.for(model)?.definition(model, position) ?? null,
    }),
    monaco.languages.registerImplementationProvider({ scheme: 'file' }, {
      provideImplementation: (model, position) => services?.for(model)?.implementation(model, position) ?? null,
    }),
    monaco.languages.registerTypeDefinitionProvider({ scheme: 'file' }, {
      provideTypeDefinition: (model, position) => services?.for(model)?.typeDefinition(model, position) ?? null,
    }),
    monaco.languages.registerReferenceProvider({ scheme: 'file' }, {
      provideReferences: (model, position) => services?.for(model)?.references(model, position) ?? null,
    }),
  ];
  // monaco opens only the models the window already has, so a jump into another file lands here.
  const opener = monaco.editor.registerEditorOpener({
    openCodeEditor: (source, resource, selection) => {
      const at = !selection ? undefined
        : 'lineNumber' in selection ? new monaco.Position(selection.lineNumber, selection.column)
        : new monaco.Position(selection.startLineNumber, selection.startColumn);
      // A jump within the file on show is answered false, which leaves monaco to move the cursor itself.
      return services?.openResource(source.getModel(), resource, at) ?? false;
    },
  });
  return () => {
    opener.dispose();
    for (const provider of providers) provider.dispose();
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
