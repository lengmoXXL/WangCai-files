import { defaultKeymap, history, invertedEffects } from '@codemirror/commands';
import { Compartment, MapMode, StateEffect, StateField, Text, Transaction, type EditorState, type TransactionSpec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import type { DirectoryEntry } from '@lengmoxxl/sdk';
import { useLayoutEffect, useRef } from 'react';
import { childOf, entryText, relativeEntryPath, validEntryPath, type DirectoryChange } from './shared';

export type DirectoryLocation = { machine: string; path: string; id: number };
export type Origin = DirectoryEntry & { directory: DirectoryLocation; id: string };
type Origins = ReadonlyMap<number, Origin>;
type DirectoryLines = { directory: DirectoryLocation; baseline: { doc: Text; origins: Origins }; origins: Origins };
export const originPath = ({ directory, name }: Origin) => childOf(directory.path, name);
const originFor = (directory: DirectoryLocation, entry: DirectoryEntry): Origin =>
  ({ ...entry, directory, id: `${directory.id}/${entry.name}` });
const restoreOrigins = StateEffect.define<Origins>();
const replaceLines = StateEffect.define<DirectoryLines>();
type TransferredOrigins = { removed?: ReadonlySet<number>; pasted?: Origins };
export const transferOrigins = StateEffect.define<TransferredOrigins>();
const undoHistory = new Compartment();

export function listedLines(doc: Text, directory: DirectoryLocation, listing: DirectoryEntry[] = []): DirectoryLines {
  const origins = new Map(listing.map((entry, index) => [index + 1, originFor(directory, entry)]));
  return { directory, baseline: { doc, origins }, origins };
}

export const directoryLines = StateField.define<DirectoryLines>({
  create: (state) => listedLines(state.doc, { machine: '', path: '', id: 0 }),
  update(previous, transaction) {
    let restored: Origins | undefined;
    let transfer: TransferredOrigins | undefined;
    for (const effect of transaction.effects) {
      if (effect.is(replaceLines)) return effect.value;
      if (effect.is(restoreOrigins)) restored = effect.value;
      if (effect.is(transferOrigins)) transfer = effect.value;
    }
    if (restored) return { ...previous, origins: restored };
    if (!transaction.docChanged) return previous;
    const { doc } = transaction.startState;
    const nextDoc = transaction.newDoc;
    let reordered: Map<number, Origin> | undefined;
    let matched: Set<number> | undefined;
    let linesChanged = false;
    transaction.changes.iterChanges((from, to, nextFrom, nextTo, insert) => {
      const first = doc.lineAt(from);
      linesChanged ||= insert.lines > 1 || to > first.to;
      if (transfer || insert.lines < 2 || to <= first.to) return;

      // Vim can write a reordered range back as one replacement, for example with :sort.
      const rows = new Map<string, number[]>();
      for (let number = first.number; number <= doc.lineAt(to).number; number++) {
        const line = doc.line(number);
        if (line.from < from || line.to > to || !previous.origins.has(number)) continue;
        const same = rows.get(line.text) ?? [];
        same.push(number);
        rows.set(line.text, same);
      }
      for (let number = nextDoc.lineAt(nextFrom).number; number <= nextDoc.lineAt(nextTo).number; number++) {
        const line = nextDoc.line(number);
        if (line.from < nextFrom || line.to > nextTo) continue;
        const original = rows.get(line.text)?.shift();
        if (original === undefined) continue;
        (matched ??= new Set()).add(original);
        (reordered ??= new Map()).set(number, previous.origins.get(original)!);
      }
    });
    if (!linesChanged && !transfer) return previous;

    // Keep each row's ID through filename edits and shifts caused by edits to other rows.
    const origins = new Map<number, Origin>();
    for (const [number, entry] of previous.origins) {
      if (matched?.has(number) || transfer?.removed?.has(number)) continue;
      const { from, to } = doc.line(number);
      const start = transaction.changes.mapPos(from, 1, MapMode.TrackDel);
      if (start === null || transaction.changes.mapPos(to, -1, MapMode.TrackDel) === null) continue;
      const mapped = nextDoc.lineAt(start).number;
      if (!origins.has(mapped)) origins.set(mapped, entry);
    }
    for (const [number, entry] of reordered ?? []) origins.set(number, entry);
    for (const [number, entry] of transfer?.pasted ?? []) origins.set(number, entry);
    return { ...previous, origins };
  },
});

export const directoryEditing = [
  directoryLines,
  invertedEffects.of((transaction) => {
    const before = transaction.startState.field(directoryLines).origins;
    return transaction.state.field(directoryLines).origins === before ? [] : [restoreOrigins.of(before)];
  }),
  undoHistory.of(history()),
  keymap.of(defaultKeymap),
];

export function resetBuffer(state: EditorState, lines: DirectoryLines, update: TransactionSpec = {}) {
  const cleared = state.update(update, {
    effects: [replaceLines.of(lines), undoHistory.reconfigure([])],
    annotations: Transaction.addToHistory.of(false),
  });
  return [cleared, cleared.state.update({ effects: undoHistory.reconfigure(history()) })];
}

export function bufferChanged(state: EditorState) {
  const { baseline, origins } = state.field(directoryLines);
  if (origins.size !== baseline.origins.size || !state.doc.eq(baseline.doc)) return true;
  if (origins === baseline.origins) return false;
  for (const [line, entry] of origins) if (baseline.origins.get(line)?.id !== entry.id) return true;
  return false;
}

export type PlannedChange = { directory: string; sourceDirectory?: string; line?: number; change: DirectoryChange };

export function planChanges(columns: Iterable<EditorState>): PlannedChange[] {
  const remaining = new Map<string, Origin>();
  const retained = new Set<string>();
  const changed: Array<{ id?: string; operation: PlannedChange }> = [];
  const targets = new Set<string>();
  for (const state of columns) {
    if (!bufferChanged(state)) continue;
    const { directory: { path }, baseline, origins } = state.field(directoryLines);
    for (const entry of baseline.origins.values()) remaining.set(entry.id, entry);
    let line = 0;
    for (const text of state.doc.iterLines()) {
      const entry = origins.get(++line);
      if (!entry && text === '') continue;
      const slash = text.endsWith('/');
      const name = (slash ? text.slice(0, -1) : text).replace(/\\([\\rn])/g, (_, char) => char === 'n' ? '\n' : char === 'r' ? '\r' : '\\');
      if (!validEntryPath(name) || (entry?.isDirectory === false && slash)) throw new Error(`第 ${line} 行的路径无效`);
      const destination = childOf(path, name);
      const isDirectory = entry?.isDirectory ?? slash;
      if (targets.has(destination)) throw new Error(`名称重复：${entryText({ name, isDirectory })}`);
      targets.add(destination);
      const from = entry && originPath(entry);
      if (entry && destination === from) retained.add(entry.id);
      else changed.push({ id: entry?.id, operation: { directory: path, sourceDirectory: entry?.directory.path, line, change: { from, name: destination, isDirectory } } });
    }
  }
  for (const id of retained) remaining.delete(id);
  const plan: PlannedChange[] = [];
  for (const { id, operation } of changed) {
    // A missing original can move to one destination. Further occurrences copy the same source.
    if (id !== undefined && !remaining.delete(id)) operation.change.copy = true;
    plan.push(operation);
  }
  for (const entry of remaining.values()) {
    plan.push({ directory: entry.directory.path, change: { name: originPath(entry), isDirectory: entry.isDirectory, remove: true } });
  }
  return plan;
}

export function recordApplied(state: EditorState, applied: PlannedChange[], complete: boolean) {
  const previous = state.field(directoryLines);
  const directory = previous.directory.path;
  const origins = new Map(previous.origins);
  const originals = complete ? undefined : new Map([...previous.baseline.origins.values()].map((entry) => [entry.name, entry]));
  if (originals) {
    for (const { directory: target, sourceDirectory, change: { from, name, copy, remove } } of applied) {
      if (sourceDirectory === directory && from !== undefined && !copy) originals.delete(relativeEntryPath(directory, from));
      if (target === directory && remove) originals.delete(relativeEntryPath(directory, name));
    }
  }
  for (const { directory: target, line, change: { name, isDirectory } } of applied) {
    if (target !== directory || line === undefined) continue;
    const entry = originFor(previous.directory, { name: relativeEntryPath(directory, name), isDirectory });
    origins.set(line, entry);
    originals?.set(entry.name, entry);
  }
  let baseline = { doc: state.doc, origins };
  if (originals) {
    const ordered = new Set([...origins].sort(([left], [right]) => left - right)
      .filter(([, entry]) => entry.directory === previous.directory).map(([, entry]) => entry.name));
    for (const name of originals.keys()) ordered.add(name);
    const entries = [...ordered].flatMap((name) => {
      const entry = originals.get(name);
      return entry ? [entry] : [];
    });
    baseline = { doc: entries.length ? Text.of(entries.map(entryText)) : Text.empty,
      origins: new Map(entries.map((entry, index) => [index + 1, entry])) };
  }
  return resetBuffer(state, { ...previous, baseline, origins });
}

export function DirectoryEditReview({ path, plan, applying, onBack, onApply }: { path: string; plan: PlannedChange[]; applying: boolean; onBack: () => void; onApply: () => void }) {
  const confirm = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const panel = confirm.current?.closest('.sidebar-panel');
    const focus = () => confirm.current?.focus();
    focus();
    panel?.addEventListener('wangcai:shown', focus);
    return () => panel?.removeEventListener('wangcai:shown', focus);
  }, []);

  return <div className="file-edit-review" role="dialog" aria-label="文件变更预览" onKeyDown={(event) => {
    if (applying || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const action = event.key === 'Escape' || event.key === 'n' ? onBack : event.key === 'y' ? onApply : undefined;
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  }}>
    <div className="file-edit-summary">
      <strong>文件变更预览</strong>
      {plan.some(({ change }) => change.remove) && <span>删除的条目会移到废纸篓</span>}
      {plan.some(({ change }) => !change.remove && relativeEntryPath(path, change.name).includes('/')) && <span>缺少的上级目录会一并创建</span>}
    </div>
    <ul className="file-edit-changes">
      {plan.map(({ change }) => {
        const name = relativeEntryPath(path, change.name);
        const from = change.from === undefined ? undefined : relativeEntryPath(path, change.from);
        if (change.remove) return <li key={`-${change.name}`}>删除 {entryText({ ...change, name })}</li>;
        if (from === undefined) return <li key={change.name}>新建 {entryText({ ...change, name })}</li>;
        const sameDirectory = from.slice(0, from.lastIndexOf('/') + 1) === name.slice(0, name.lastIndexOf('/') + 1);
        const action = change.copy ? '复制' : sameDirectory ? '重命名' : '移动';
        return <li key={change.name}>{action} {entryText({ ...change, name: from })} → {entryText({ ...change, name })}</li>;
      })}
    </ul>
    <div className="file-edit-footer">
      <button type="button" className="file-edit-button" title="取消 (Esc 或 n)" disabled={applying} onClick={onBack}>取消<kbd aria-hidden="true">Esc</kbd></button>
      <button type="button" className="file-edit-button file-edit-primary" title="应用变更 (Enter 或 y)" ref={confirm} disabled={applying} onClick={onApply}>
        {applying ? '正在应用…' : <>应用变更<kbd aria-hidden="true">Enter</kbd></>}
      </button>
    </div>
  </div>;
}
