import { Compartment, EditorState, Facet, Prec, Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, drawSelection, panels, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { Vim, getCM, vim } from '@replit/codemirror-vim';
import type { DirectoryEntry } from '@lengmoxxl/sdk';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { directoryEditing, directoryLines, bufferChanged, listedLines, originPath, resetBuffer, type DirectoryLocation } from './edit';
import { entryText, type GitLetter } from './shared';
import { trackVimEntries } from './vim-registers';

export type ColumnCommand = 'parent' | 'open' | 'download' | 'search' | 'review';
const commands = new Map<string, ColumnCommand>([
  ['H', 'parent'], ['<Left>', 'parent'],
  ['L', 'open'], ['<Right>', 'open'], ['<CR>', 'open'],
  ['D', 'download'], ['/', 'search'], ['=', 'review'],
]);

type Rows = { opened?: string; marks?: ReadonlyMap<string, GitLetter> };
const rows = Facet.define<Rows, Rows | undefined>({ combine: (values) => values[0] });
const config = new Compartment();
const bindings = new Compartment();
const columnConfig = (data: Rows, writable: boolean) => [rows.of(data), EditorState.readOnly.of(!writable), EditorView.editable.of(writable)];
const gitLabels: Record<GitLetter, string> = { M: '已修改', A: '已新增', D: '已删除', R: '已重命名', C: '已复制', T: '类型已更改', U: '未跟踪', '!': '有冲突' };

const rowMarks = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = this.draw(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.startState.facet(rows) !== update.state.facet(rows) ||
      update.startState.field(directoryLines).origins !== update.state.field(directoryLines).origins) {
      this.decorations = this.draw(update.view);
    }
  }

  draw(view: EditorView) {
    const config = view.state.facet(rows);
    if (!config) return Decoration.none;
    const { doc } = view.state;
    const { origins } = view.state.field(directoryLines);
    const first = doc.lineAt(view.viewport.from).number;
    const last = doc.lineAt(view.viewport.to).number;
    const marks = [];
    for (let number = first; number <= last; number += 1) {
      const { from, text } = doc.line(number);
      const entry = origins.get(number);
      if (!entry && !text) continue;
      const path = entry && originPath(entry);
      const git = path ? config.marks?.get(path) : undefined;
      const name = entry && text === entryText(entry) ? entry.name : text;
      const attributes: Record<string, string> = {
        'data-kind': (entry?.isDirectory ?? text.endsWith('/')) ? 'directory' : 'file',
        title: git ? `${name} · ${gitLabels[git]}` : name,
      };
      if (git) attributes['data-git'] = git;
      if (path && path === config.opened) attributes['aria-current'] = 'true';
      marks.push(Decoration.line({ attributes }).range(from));
    }
    return Decoration.set(marks);
  }
}, { decorations: (plugin) => plugin.decorations });

const entryAt = (state: EditorState, pos = state.selection.main.head) =>
  state.field(directoryLines).origins.get(state.doc.lineAt(pos).number);

export type ColumnBuffers = Map<DirectoryLocation, EditorView | EditorState>;
export const columnState = (buffer: EditorView | EditorState) => buffer instanceof EditorView ? buffer.state : buffer;

type ColumnProps = Rows & {
  location: DirectoryLocation;
  bottomContainer: HTMLElement;
  listing?: DirectoryEntry[];
  active: boolean;
  target?: { name?: string; line?: number };
  buffers: ColumnBuffers;
  onFocus: (path: string) => void;
  onCommand: (command: ColumnCommand, path: string, entry?: DirectoryEntry) => void;
  onMenu: (event: MouseEvent, path: string, entry: DirectoryEntry) => void;
};

export function FileColumn(props: ColumnProps) {
  const { location, bottomContainer, buffers, listing, marks, opened, active, target } = props;
  const { path } = location;
  const list = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [inserting, setInserting] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const loaded = useRef<DirectoryEntry[]>(undefined);
  const rowsConfig = useMemo(() => ({ marks, opened }), [marks, opened]);
  const doc = useMemo(() => listing?.length ? Text.of(listing.map(entryText)) : Text.empty, [listing]);
  const applied = useRef<ColumnProps['target']>(undefined);
  const latest = useRef({ props, rowsConfig, doc });
  useLayoutEffect(() => { latest.current = { props, rowsConfig, doc }; });

  useLayoutEffect(() => {
    const clipboard = trackVimEntries(location.machine);
    const pointerLine = (event: MouseEvent, view: EditorView) => {
      const line = event.target instanceof Element ? event.target.closest('.cm-line') : null;
      return line && view.contentDOM.contains(line) ? view.posAtDOM(line) : undefined;
    };
    const handlers = [
        vim(),
        panels({ bottomContainer }),
        clipboard.extension,
        EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': path }),
        Prec.highest(EditorView.domEventHandlers({
          keydown(event, view) {
            const cm = getCM(view);
            const state = cm?.state.vim;
            if (!cm || !state || state.insertMode || state.visualMode || state.inputState.operator || state.inputState.keyBuffer.length) return false;
            const key = Vim.vimKeyFromEvent(event, state);
            const command = key === undefined ? undefined : commands.get(key);
            if (!command) return false;
            if (!event.repeat) {
              if (state.inputState.prefixRepeat.length) Vim.handleKey(cm, '<Esc>', 'user');
              const entry = entryAt(view.state);
              const from = command === 'open' || command === 'download' ? entry?.directory.path ?? path : path;
              latest.current.props.onCommand(command, from, entry);
            }
            return true;
          },
          click(event, view) {
            if (getCM(view)?.state.vim?.insertMode) return false;
            const at = pointerLine(event, view);
            const entry = at === undefined ? undefined : entryAt(view.state, at);
            if (entry && view.state.selection.main.empty) latest.current.props.onCommand('open', entry.directory.path, entry);
          },
          contextmenu(event, view) {
            if (getCM(view)?.state.vim?.insertMode) return false;
            const at = pointerLine(event, view);
            const entry = at === undefined ? undefined : entryAt(view.state, at);
            if (at === undefined || !entry || entry.isDirectory) return false;
            view.dispatch({ selection: { anchor: at } });
            view.focus();
            latest.current.props.onMenu(event, entry.directory.path, entry);
            return true;
          },
        })),
        EditorView.domEventObservers({
          focus: () => latest.current.props.onFocus(path),
        }),
        EditorView.updateListener.of(({ startState, state }) => {
          const hasContent = state.doc.length > 0;
          if (hasContent !== (startState.doc.length > 0)) setHasContent(hasContent);
        }),
    ];
    const { props: initial, rowsConfig, doc } = latest.current;
    const saved = buffers.get(location);
    const restored = saved instanceof EditorState ? saved : undefined;
    const extensions = columnConfig(rowsConfig, initial.listing !== undefined || restored !== undefined);
    const state = restored
      ? restored.update({ effects: [bindings.reconfigure(handlers), config.reconfigure(extensions)] }).state
      : EditorState.create({ doc, extensions: [config.of(extensions), bindings.of(handlers), directoryEditing,
        directoryLines.init(() => listedLines(doc, location, initial.listing)), drawSelection(), rowMarks] });
    const view = new EditorView({ state, parent: host.current! });
    const cm = getCM(view);
    if (cm) clipboard.connect(cm, view);
    cm?.on('vim-mode-change', () => setInserting(Boolean(cm.state.vim?.insertMode)));
    loaded.current = restored ? undefined : initial.listing;
    setHasContent(state.doc.length > 0);
    buffers.set(location, view);
    if (restored) view.dispatch({ scrollIntoView: true });
    return () => {
      if (bufferChanged(view.state)) buffers.set(location, view.state.update({ effects: bindings.reconfigure([]) }).state);
      else buffers.delete(location);
      view.destroy();
    };
  }, [location, path, bottomContainer, buffers]);

  useLayoutEffect(() => {
    const view = buffers.get(location) as EditorView;
    const { state } = view;
    const modified = bufferChanged(state);
    const refresh = loaded.current !== listing && !getCM(view)?.state.vim?.insertMode && !modified;
    const changed = refresh && !doc.eq(state.doc);
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const name = entryAt(state)?.name;
    // Apply a search or reveal once its listing arrives. Later refreshes follow the live Vim cursor.
    const requested = target === applied.current ? undefined : target;
    const nextDoc = changed ? doc : state.doc;
    const lines = state.field(directoryLines);
    const nextLines = changed ? listedLines(doc, lines.directory, listing) : lines;
    const wanted = requested?.name ?? name;
    let number = Math.min(requested?.line ?? line.number, nextDoc.lines);
    if (requested?.line === undefined && wanted !== undefined && (changed || requested !== undefined)) {
      for (const [at, entry] of nextLines.origins) if (entry.name === wanted) { number = at; break; }
    }
    const writable = listing !== undefined || modified;
    if (writable) applied.current = target;
    const next = nextDoc.line(number);
    const selection = changed || number !== line.number
      ? { anchor: next.from + (name !== undefined && name === nextLines.origins.get(number)?.name ? Math.min(head - line.from, next.length) : 0) }
      : undefined;
    const effects = state.facet(rows) !== rowsConfig || state.readOnly === writable
      ? config.reconfigure(columnConfig(rowsConfig, writable)) : undefined;
    if (refresh) loaded.current = listing;
    if (changed) {
      view.update(resetBuffer(state, nextLines, { changes: { from: 0, to: state.doc.length, insert: doc }, selection, effects, scrollIntoView: true }));
    } else if (selection || effects) view.dispatch({ selection, effects, scrollIntoView: selection !== undefined });
  }, [doc, hasContent, location, inserting, listing, rowsConfig, target, buffers]);

  // CodeMirror draws a window of lines, so measure the listing for the column's width before fitting the columns.
  useLayoutEffect(() => {
    const element = list.current!;
    const column = element.parentElement!;
    if (column.style.width) return;
    const limit = parseFloat(getComputedStyle(column).maxWidth);
    const { fontSize, fontFamily, paddingLeft, paddingRight } = getComputedStyle(element.querySelector('.cm-line')!);
    const inset = parseFloat(paddingLeft) + parseFloat(paddingRight);
    const measure = document.createElement('canvas').getContext('2d')!;
    measure.font = `${fontSize} ${fontFamily}`;
    let width = 0;
    for (const line of doc.iterLines()) {
      width = Math.max(width, Math.ceil(measure.measureText(line).width) + inset);
      if (width >= limit) break;
    }
    element.style.width = `${width}px`;
  }, [doc]);

  const empty = !listing?.length && !hasContent && !inserting;
  return <nav className="file-list" aria-label={path} data-active={active ? '' : undefined} data-empty={empty ? '' : undefined} ref={list}>
    <div className="file-view" ref={host} />
    {empty && listing?.length === 0 && <div className="file-message file-empty">空目录</div>}
  </nav>;
}
