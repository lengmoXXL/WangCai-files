import { Compartment, EditorState, Facet, Prec, Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, drawSelection, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { Vim, getCM, vim } from '@replit/codemirror-vim';
import type { DirectoryEntry } from '@lengmoxxl/sdk';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { childOf, type GitLetter } from './shared';

const commands = {
  parent: ['H', '<Left>'],
  open: ['L', '<Right>', '<CR>'],
  download: ['D'],
  search: ['/'],
} as const;
export type ColumnCommand = keyof typeof commands;
const commandKeys = new Set<string>(Object.values(commands).flat());
const columnCommands = new WeakMap<EditorView, (command: ColumnCommand) => void>();
for (const command of Object.keys(commands) as ColumnCommand[]) {
  const action = `files-${command}`;
  Vim.defineAction(action, (cm) => {
    const view = (cm as { cm6?: EditorView }).cm6;
    if (view) columnCommands.get(view)?.(command);
  });
  for (const key of commands[command]) Vim.mapCommand(key, 'action', action, {}, { context: 'normal' });
}

type Rows = { path: string; listing?: DirectoryEntry[]; opened?: string; marks?: ReadonlyMap<string, GitLetter> };
const rows = Facet.define<Rows, Rows | undefined>({ combine: (values) => values[0] });
const gitLabels: Record<GitLetter, string> = { M: '已修改', A: '已新增', D: '已删除', R: '已重命名', C: '已复制', T: '类型已更改', U: '未跟踪', '!': '有冲突' };

const rowMarks = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = this.draw(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.startState.facet(rows) !== update.state.facet(rows)) {
      this.decorations = this.draw(update.view);
    }
  }

  draw(view: EditorView) {
    const config = view.state.facet(rows);
    if (!config?.listing?.length) return Decoration.none;
    const { doc } = view.state;
    const first = doc.lineAt(view.viewport.from).number;
    const last = doc.lineAt(view.viewport.to).number;
    const marks = [];
    for (let number = first; number <= last; number += 1) {
      const entry = config.listing[number - 1];
      const path = childOf(config.path, entry.name);
      const git = config.marks?.get(path);
      const attributes: Record<string, string> = {
        'data-kind': entry.isDirectory ? 'directory' : 'file',
        title: git ? `${entry.name} · ${gitLabels[git]}` : entry.name,
      };
      if (git) attributes['data-git'] = git;
      if (path === config.opened) attributes['aria-current'] = 'true';
      marks.push(Decoration.line({ attributes }).range(doc.line(number).from));
    }
    return Decoration.set(marks);
  }
}, { decorations: (plugin) => plugin.decorations });

const entryAt = (state: EditorState, pos = state.selection.main.head) =>
  state.facet(rows)?.listing?.[state.doc.lineAt(pos).number - 1];

type ColumnProps = Rows & {
  active: boolean;
  target?: { name?: string };
  views: Map<string, EditorView>;
  onFocus: (path: string) => void;
  onCommand: (command: ColumnCommand, path: string, entry?: DirectoryEntry) => void;
  onMenu: (event: MouseEvent, path: string, entry: DirectoryEntry) => void;
};

export function FileColumn(props: ColumnProps) {
  const { path, views, listing, marks, opened, active, target } = props;
  const list = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const config = useMemo(() => new Compartment(), []);
  const rowsConfig = useMemo(() => ({ path, listing, marks, opened }), [path, listing, marks, opened]);
  const doc = useMemo(() => listing?.length ? Text.of(listing.map(({ name, isDirectory }) =>
    name.replace(/[\\\r\n]/g, (character) => character === '\n' ? '\\n' : character === '\r' ? '\\r' : '\\\\') + (isDirectory ? '/' : ''))) : Text.empty, [listing]);
  const applied = useRef<ColumnProps['target']>(undefined);
  const latest = useRef({ props, rowsConfig, doc });
  useLayoutEffect(() => { latest.current = { props, rowsConfig, doc }; });

  useLayoutEffect(() => {
    const pointerLine = (event: MouseEvent, view: EditorView) => {
      const line = event.target instanceof Element ? event.target.closest('.cm-line') : null;
      return line && view.contentDOM.contains(line) ? view.posAtDOM(line) : undefined;
    };
    const view = new EditorView({
      doc: latest.current.doc,
      parent: host.current!,
      extensions: [
        config.of(rows.of(latest.current.rowsConfig)),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': path }),
        Prec.highest(EditorView.domEventHandlers({
          keydown(event, view) {
            if (!event.repeat) return false;
            const state = getCM(view)?.state.vim;
            if (!state || state.insertMode || state.visualMode) return false;
            const key = Vim.vimKeyFromEvent(event, state);
            return key !== undefined && commandKeys.has(key);
          },
          click(event, view) {
            const at = pointerLine(event, view);
            const entry = at === undefined ? undefined : entryAt(view.state, at);
            if (entry && view.state.selection.main.empty) latest.current.props.onCommand('open', path, entry);
          },
          contextmenu(event, view) {
            const at = pointerLine(event, view);
            const entry = at === undefined ? undefined : entryAt(view.state, at);
            if (at === undefined || !entry || entry.isDirectory) return false;
            view.dispatch({ selection: { anchor: at } });
            view.focus();
            latest.current.props.onMenu(event, path, entry);
            return true;
          },
        })),
        vim(), drawSelection(), rowMarks,
        EditorView.domEventObservers({
          focus: () => latest.current.props.onFocus(path),
        }),
      ],
    });
    views.set(path, view);
    columnCommands.set(view, (command) => latest.current.props.onCommand(command, path, entryAt(view.state)));
    return () => {
      views.delete(path);
      columnCommands.delete(view);
      view.destroy();
    };
  }, [config, path, views]);

  useLayoutEffect(() => {
    const view = views.get(path)!;
    const previous = view.state.facet(rows);
    const changed = previous?.listing !== listing && !doc.eq(view.state.doc);
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const name = entryAt(view.state)?.name;
    // Apply a search or reveal once its listing arrives. Later refreshes follow the live Vim cursor.
    const requested = target === applied.current ? undefined : target?.name;
    const index = changed || (requested !== undefined && requested !== name)
      ? listing?.findIndex((entry) => entry.name === (requested ?? name)) ?? -1 : -1;
    if (listing !== undefined) applied.current = target;
    const next = doc.line(index < 0 ? Math.min(line.number, doc.lines) : index + 1);
    const selection = changed || (index >= 0 && index + 1 !== line.number)
      ? { anchor: next.from + (changed && name === listing?.[next.number - 1]?.name ? Math.min(head - line.from, next.length) : 0) }
      : undefined;
    if (changed || selection || previous !== rowsConfig) view.dispatch({
      changes: changed ? { from: 0, to: view.state.doc.length, insert: doc } : undefined,
      selection,
      scrollIntoView: selection !== undefined,
      effects: previous !== rowsConfig ? config.reconfigure(rows.of(rowsConfig)) : undefined,
    });
  }, [config, doc, listing, path, rowsConfig, target, views]);

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

  return <nav className="file-list" aria-label={path} data-active={active ? '' : undefined} data-empty={!listing?.length ? '' : undefined} ref={list}>
    <div className="file-view" ref={host} />
    {listing?.length === 0 && <div className="file-message file-empty">空目录</div>}
  </nav>;
}
