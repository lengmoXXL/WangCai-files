import * as monaco from 'monaco-editor/editor/editor.api.js';
import type { VimKeys } from './shared';

// The keys a preview answers to, each with the command it runs: a `vim.*` name is this module's own, every other value
// is a monaco command id.
const defaults: Record<string, string> = {
  h: 'cursorLeft', l: 'cursorRight', j: 'cursorDown', k: 'cursorUp',
  w: 'cursorWordStartRight', b: 'cursorWordStartLeft', e: 'cursorWordEndRight',
  '0': 'cursorLineStart', '^': 'cursorHome', $: 'cursorLineEnd',
  gg: 'cursorTop', G: 'cursorBottom',
  '<C-d>': 'cursorPageDown', '<C-u>': 'cursorPageUp',
  zz: 'vim.center', zt: 'vim.top', zb: 'vim.bottom',
  '/': 'actions.find', n: 'editor.action.nextMatchFindAction', N: 'editor.action.previousMatchFindAction',
  gd: 'vim.definition',
  '<C-o>': 'vim.jumpBack', '<C-i>': 'vim.jumpForward',
  v: 'vim.visual', V: 'vim.visualLine', y: 'vim.yank',
  f: 'vim.seek', F: 'vim.seekBack', t: 'vim.seekTill', T: 'vim.seekTillBack',
  ';': 'vim.seekAgain', ',': 'vim.seekAgainBack',
};

// A sequence is a run of keys a reader presses: `gg` is two of them, `<C-o>` is one.
const tokens = (sequence: string) => sequence.match(/<[^>]+>|./gu) ?? [];

// One step into a sequence: the command it completes, and the keys that would carry it on.
type Step = { command?: string; next: Map<string, Step> };

type VimOptions = {
  // What a page's config says on top of the keys above: a command id rebinds a key, and false drops it.
  keys?: VimKeys;
  // The page's position history, which `<C-o>` and `<C-i>` walk.
  jumpBack?: () => void;
  jumpForward?: () => void;
  // What `gd` asks: the page knows its server, and which file the answer is in.
  definition?: () => void;
  // Where `y` puts what the selection holds.
  copy?: (text: string) => void;
};

// The normal mode of a preview: it moves the caret, pages and searches, and never writes, since the text is a reader's.
export function vimKeys(editor: monaco.editor.IStandaloneCodeEditor, { keys = {}, jumpBack, jumpForward, definition, copy }: VimOptions = {}) {
  const bindings: Record<string, string> = { ...defaults };
  for (const [sequence, command] of Object.entries(keys)) {
    if (command === false) delete bindings[sequence];
    else bindings[sequence] = command;
  }
  const root: Step = { next: new Map() };
  for (const [sequence, command] of Object.entries(bindings)) {
    let node = root;
    for (const token of tokens(sequence)) {
      let child = node.next.get(token);
      if (!child) node.next.set(token, child = { next: new Map() });
      node = child;
    }
    node.command = command;
  }

  // A selection is being made: by characters, or by whole lines.
  let visual: 'char' | 'line' | undefined;
  const selectionLines = () => {
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection) return;
    const from = Math.min(selection.selectionStartLineNumber, selection.positionLineNumber);
    const to = Math.max(selection.selectionStartLineNumber, selection.positionLineNumber);
    editor.setSelection(new monaco.Selection(from, 1, to, model.getLineMaxColumn(to)));
  };
  const enter = (kind: 'char' | 'line') => {
    if (visual === kind) {
      visual = undefined;
      return;
    }
    visual = kind;
    if (kind === 'line') return selectionLines();
    // The character under the caret is the first the selection holds, which is where vim starts it.
    const position = editor.getPosition();
    const model = editor.getModel();
    if (!position || !model) return;
    const column = Math.min(position.column, model.getLineMaxColumn(position.lineNumber));
    editor.setSelection(new monaco.Selection(position.lineNumber, column, position.lineNumber, Math.min(column + 1, model.getLineMaxColumn(position.lineNumber))));
  };
  const yank = () => {
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection || selection.isEmpty()) return;
    const text = model.getValueInRange(selection) + (visual === 'line' ? '\n' : '');
    copy?.(text);
    // The caret comes back to where the selection began, which is where vim leaves it after a yank.
    editor.setPosition(selection.getStartPosition());
    visual = undefined;
  };
  // Only a cursor command has a form that extends a selection.
  const extend = (command: string) => (command.startsWith('cursor') ? `${command}Select` : undefined);

  const reveal = (where: (position: monaco.Position) => void) => {
    const position = editor.getPosition();
    if (position) where(position);
  };
  const goTo = (target: monaco.Position) => {
    const selection = editor.getSelection();
    if (!visual || !selection) {
      editor.setPosition(target);
      editor.revealPositionInCenterIfOutsideViewport(target);
      return;
    }
    // A selection holds the character it reaches, so its end stands one column past it.
    const model = editor.getModel();
    const end = visual === 'char' && model ? Math.min(target.column + 1, model.getLineMaxColumn(target.lineNumber)) : target.column;
    editor.setSelection(new monaco.Selection(selection.selectionStartLineNumber, selection.selectionStartColumn, target.lineNumber, end));
    if (visual === 'line') selectionLines();
  };
  // The count-th `char` on this line, `till` stopping one short of it.
  const seek = (char: string, ahead: boolean, till: boolean, times: number) => {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) return;
    const line = model.getLineContent(position.lineNumber);
    const direction = ahead ? 1 : -1;
    let left = times;
    for (let index = position.column - 1 + direction; index >= 0 && index < line.length; index += direction) {
      if (line[index] !== char || --left > 0) continue;
      goTo(new monaco.Position(position.lineNumber, index + 1 - (till ? direction : 0)));
      return;
    }
  };
  // A key that takes the next one as its argument: `f`, `F`, `t` and `T` are told which character to find.
  let awaiting: ((char: string) => void) | undefined;
  // What `;` repeats, and `,` the other way round.
  let lastSeek: { char: string; ahead: boolean; till: boolean } | undefined;
  const seeker = (ahead: boolean, till: boolean) => (times: number) => {
    awaiting = (char) => {
      lastSeek = { char, ahead, till };
      seek(char, ahead, till, times);
    };
  };
  const seekAgain = (back: boolean) => (times: number) => {
    if (lastSeek) seek(lastSeek.char, back ? !lastSeek.ahead : lastSeek.ahead, lastSeek.till, times);
  };
  const own: Record<string, (times: number) => void> = {
    'vim.center': () => reveal(editor.revealPositionInCenter),
    'vim.top': () => reveal(editor.revealPositionNearTop),
    // No command centres a line at the foot, so the line half a page above the caret is centred instead, which leaves the
    // caret at the bottom of what the page shows.
    'vim.bottom': () => reveal((position) => {
      const page = editor.getLayoutInfo().height / editor.getOption(monaco.editor.EditorOption.lineHeight);
      editor.revealPositionInCenter({ lineNumber: Math.max(1, position.lineNumber - Math.floor(page / 2)), column: position.column });
    }),
    'vim.jumpBack': () => jumpBack?.(),
    'vim.jumpForward': () => jumpForward?.(),
    'vim.definition': () => definition?.(),
    'vim.visual': () => enter('char'),
    'vim.visualLine': () => enter('line'),
    'vim.yank': yank,
    'vim.seek': seeker(true, false),
    'vim.seekBack': seeker(false, false),
    'vim.seekTill': seeker(true, true),
    'vim.seekTillBack': seeker(false, true),
    'vim.seekAgain': seekAgain(false),
    'vim.seekAgainBack': seekAgain(true),
  };
  const run = (command: string, times: number) => {
    const action = own[command];
    if (action) return action(times);
    const extending = visual && extend(command);
    for (let index = 0; index < times; index++) editor.trigger('vim', extending || command, null);
    if (visual === 'line' && extending) selectionLines();
    // A command that is not a motion ends the selection it would otherwise have gone on extending.
    if (visual && !extending) visual = undefined;
  };

  // A key as a sequence token: a modified letter is its own token, so `<C-o>` is one and `gg` is two.
  const tokenOf = (event: KeyboardEvent) => {
    if (event.ctrlKey && event.key.length === 1) return `<C-${event.key.toLowerCase()}>`;
    if (event.key === 'Escape') return '<Esc>';
    return event.key.length === 1 ? event.key : '';
  };

  let node = root;
  let count = 0;
  const onKeyDown = (event: KeyboardEvent) => {
    // The window's own shortcuts, and typing that belongs to whatever widget holds it, are not this mode's.
    if (event.metaKey || event.altKey || event.isComposing || !editor.hasTextFocus()) return;
    const token = tokenOf(event);
    if (!token) return;
    // A key that is the argument of a seek is read as that, whatever else it would have meant.
    if (awaiting) {
      const take = awaiting;
      awaiting = undefined;
      // A key that is not a character ends the seek and keeps the meaning it has on its own.
      if (token.length !== 1) return;
      event.preventDefault();
      take(token);
      return;
    }
    // Leaving a selection is this mode's own business; with none, the key is the window's, as before.
    if (token === '<Esc>' && visual) {
      event.preventDefault();
      const selection = editor.getSelection();
      if (selection) editor.setPosition(selection.getStartPosition());
      visual = undefined;
      return;
    }
    // Digits before a command count the times it runs; `0` alone is the start of the line.
    if (/^[0-9]$/.test(token) && (count > 0 || token !== '0')) {
      event.preventDefault();
      count = count * 10 + Number(token);
      return;
    }
    // A key that does not carry the sequence on drops it, and is read again as the start of one.
    let next = node.next.get(token);
    if (!next && node !== root) {
      node = root;
      next = root.next.get(token);
    }
    if (!next) {
      count = 0;
      return;
    }
    event.preventDefault();
    if (!next.command) {
      node = next;
      return;
    }
    const times = Math.max(count, 1);
    count = 0;
    node = root;
    run(next.command, times);
  };
  // A sequence waiting for its next key also ends when the keyboard leaves the page.
  const onBlur = () => { node = root; count = 0; };

  const host = editor.getDomNode();
  host?.addEventListener('keydown', onKeyDown, true);
  host?.addEventListener('blur', onBlur, true);
  return {
    dispose() {
      host?.removeEventListener('keydown', onKeyDown, true);
      host?.removeEventListener('blur', onBlur, true);
    },
  };
}
