import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { Vim, type getCM, type Pos } from '@replit/codemirror-vim';
import { directoryLines, transferOrigins, type Origin } from './edit';

type RegisteredRows = { text: string; rows: ReadonlyMap<number, Origin> };
type Read = { state: EditorState; from: number; to: number; start?: Pos; end?: Pos };
type Operation = {
  editor: NonNullable<ReturnType<typeof getCM>>;
  view: EditorView;
  machine: string;
  read?: Read;
  register?: RegisteredRows;
  removed?: ReadonlySet<number>;
};
const registers = new WeakMap<string[], RegisteredRows & { machine: string }>();
let current: Operation | undefined;

function wholeLines({ state, from, to }: Read): RegisteredRows | undefined {
  if (from >= to) return undefined;
  const { doc } = state;
  const { origins } = state.field(directoryLines);
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;
  const rows = new Map<number, Origin>();
  for (let number = first; number <= last; number++) {
    const line = doc.line(number);
    const entry = origins.get(number);
    if (!entry || line.from < from || line.from >= to || line.to > to) continue;
    rows.set(number - first, entry);
  }
  if (!rows.size) return undefined;
  const text = doc.sliceString(from, to);
  return { text: text.endsWith('\n') ? text : `${text}\n`, rows };
}

// Follow the native register, including commands executed by Ex and dot repeat.
const controller = Vim.getRegisterController();
const getRegister = controller.getRegister.bind(controller);
const pushText = controller.pushText.bind(controller);
controller.getRegister = (name) => {
  const register = getRegister(name);
  if (current) {
    const vim = current.editor.state.vim;
    const value = name === '+' ? undefined : registers.get(register.keyBuffer);
    current.register = !vim?.insertMode && !vim?.visualBlock && value?.machine === current.machine &&
      register.linewise && !register.blockwise && value.text === register.toString() ? value : undefined;
  }
  return register;
};
controller.pushText = (name, operator, text, linewise, blockwise) => {
  const operation = current;
  pushText(name, operator, text, linewise, blockwise);
  if (!operation) return;
  const read = operation.read;
  operation.read = undefined;
  operation.register = undefined;
  if (!read || !linewise || blockwise || name === '_' || name === '+' || (operator !== 'yank' && operator !== 'delete')) return;
  const content = wholeLines(read);
  if (content?.text !== (text.endsWith('\n') ? text : `${text}\n`)) return;
  const chosen = getRegister(controller.isValidRegister(name) ? name : operator === 'yank' ? '0' : '1');
  const saved = chosen.toString();
  if (!chosen.linewise || chosen.blockwise || !saved.endsWith(content.text)) return;
  const prefix = saved.slice(0, saved.length - content.text.length);
  if (prefix && !prefix.endsWith('\n')) return;
  const previous = registers.get(chosen.keyBuffer);
  const rows = new Map(previous?.machine === operation.machine && previous.text === prefix ? previous.rows : undefined);
  const offset = prefix.split('\n').length - 1;
  for (const [line, entry] of content.rows) rows.set(offset + line, entry);
  const value = { machine: operation.machine, text: saved, rows };
  // keyBuffer identifies a native register write even if the next write has identical text.
  registers.set(chosen.keyBuffer, value);
  const unnamed = controller.unnamedRegister;
  if (unnamed.linewise && !unnamed.blockwise && unnamed.toString() === saved) registers.set(unnamed.keyBuffer, value);
};

export function trackVimEntries(machine: string) {
  const extension = EditorState.transactionExtender.of((transaction) => {
    const operation = current;
    if (!transaction.docChanged || operation?.view.state !== transaction.startState) return null;
    if (operation.removed?.size) return { effects: transferOrigins.of({ removed: operation.removed }) };
    const content = operation.register;
    if (!content) return null;
    operation.register = undefined;
    const visual = operation.editor.state.vim?.visualMode;
    const replace = operation.editor.state.vim?.visualLine;
    if (visual && !replace) return null;
    const pasted = new Map<number, Origin>();
    const removed = new Set<number>();
    transaction.changes.iterChanges((from, to, newFrom, _newTo, insert) => {
      if (!insert.length || (from !== to && !replace)) return;
      const text = insert.toString();
      const copies = (value: string) => value.length % content.text.length === 0 &&
        value === content.text.repeat(value.length / content.text.length) ? value.length / content.text.length : 0;
      let count = copies(replace ? `${text}\n` : text);
      const after = !replace && !count && text.startsWith('\n');
      if (after) count = copies(`${text.slice(1)}\n`);
      if (!count) return;
      if (replace) {
        const { doc } = transaction.startState;
        for (let number = doc.lineAt(from).number; number <= doc.lineAt(to).number; number++) {
          const line = doc.line(number);
          if (line.from >= from && line.to <= to) removed.add(number);
        }
      }
      const first = transaction.newDoc.lineAt(newFrom).number + Number(after);
      const rowsPerPaste = content.text.split('\n').length - 1;
      for (let copy = 0; copy < count; copy++) {
        for (const [offset, entry] of content.rows) pasted.set(first + copy * rowsPerPaste + offset, entry);
      }
    });
    return pasted.size ? { effects: transferOrigins.of({ pasted, removed }) } : null;
  });

  const connect = (editor: Operation['editor'], view: EditorView) => {
    const operation = editor.operation.bind(editor);
    editor.operation = (fn, force) => {
      const previous = current;
      current = { editor, view, machine };
      try { return operation(fn, force); }
      finally { current = previous; }
    };
    const getRange = editor.getRange.bind(editor);
    editor.getRange = (start, end) => {
      if (current?.editor === editor) current.read = start.line === end.line ? undefined : {
        start, end, state: view.state, from: editor.indexFromPos(start), to: editor.indexFromPos(end),
      };
      return getRange(start, end);
    };
    const getSelection = editor.getSelection.bind(editor);
    editor.getSelection = () => {
      if (current?.editor === editor) {
        const { from, to } = view.state.selection.main;
        current.read = { state: view.state, from, to };
      }
      return getSelection();
    };
    const replaceRange = editor.replaceRange.bind(editor);
    editor.replaceRange = (text, start, end, source) => {
      const scope = current;
      const read = scope?.read;
      if (!text && scope?.editor === editor && read?.state.doc === view.state.doc && end &&
          read.start?.line === start.line && read.start.ch === start.ch &&
          read.end?.line === end.line && read.end.ch === end.ch) {
        const first = read.state.doc.lineAt(read.from).number;
        const rows = wholeLines(read)?.rows.keys() ?? [];
        scope.removed = new Set([...rows].map((offset) => first + offset));
      }
      try { replaceRange(text, start, end, source); }
      finally { if (scope?.editor === editor) scope.removed = undefined; }
    };
    // Visual paste can leave Vim's saved selection beyond the end of the shortened document.
    const posFromIndex = editor.posFromIndex.bind(editor);
    editor.posFromIndex = (offset) => posFromIndex(Math.max(0, Math.min(offset, view.state.doc.length)));
  };

  return { extension, connect };
}
