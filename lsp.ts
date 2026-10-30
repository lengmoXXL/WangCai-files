import { MonacoLspClient } from 'monaco-lsp-client';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import { machineKey, type FileClick, type LspData, type LspExit, type LspLog, type LspSession } from './shared';

type Transport = ConstructorParameters<typeof MonacoLspClient>[0];
type Message = Parameters<Transport['send']>[0];

// The location features this plugin answers itself, and the capability each method is announced under: a location may
// name a file the window has not opened, which monaco's client translates against its open models only.
export const ownProviders = {
  definitionProvider: 'textDocument/definition',
  implementationProvider: 'textDocument/implementation',
  typeDefinitionProvider: 'textDocument/typeDefinition',
  referencesProvider: 'textDocument/references',
};
const ownMethods = new Set<string>(Object.values(ownProviders));

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const blankLine = encoder.encode('\r\n\r\n');

// The document a request or notification is about, and the params it sits in so a rewritten URI can go back.
const messageDocument = (message: Message) => {
  const { params } = message as { params?: { uri?: string; textDocument?: { uri?: string } } };
  return { params, uri: params?.textDocument?.uri ?? params?.uri };
};

const frame = (message: Message) => {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  return bytes;
};

const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const unbase64 = (text: string) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

// A server's output arrives in arbitrary chunks: a frame is the header, a blank line, and a JSON body the
// header measures in bytes, so a chunk boundary in any of them has to wait for the rest.
class Frames {
  private buffered = new Uint8Array(0);

  push(bytes: Uint8Array) {
    const joined = new Uint8Array(this.buffered.length + bytes.length);
    joined.set(this.buffered);
    joined.set(bytes, this.buffered.length);
    const messages: Message[] = [];
    let offset = 0;
    for (;;) {
      let end = -1;
      for (let index = offset; index + 3 < joined.length && end < 0; index++) {
        if (blankLine.every((byte, at) => joined[index + at] === byte)) end = index;
      }
      if (end < 0) break;
      const length = Number(/content-length:\s*(\d+)/i.exec(decoder.decode(joined.subarray(offset, end)))?.[1]);
      const start = end + 4;
      // A server writing to stdout behind the protocol would otherwise stall every frame behind it.
      if (!Number.isFinite(length)) { offset = start; continue; }
      if (joined.length - start < length) break;
      messages.push(JSON.parse(decoder.decode(joined.subarray(start, start + length))));
      offset = start + length;
    }
    this.buffered = joined.slice(offset);
    return messages;
  }
}

// The model of a file this window shows or links to: monaco keeps one per URI and the model belongs to the window
// rather than to the view showing it, so a view borrows it and reading the file again refreshes it in place.
export function buffer(uri: monaco.Uri, language: string, text: string) {
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, language, uri);
  if (model.getValue() !== text) model.setValue(text);
  return model;
}

export function languageFor(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return monaco.languages.getLanguages().find((item) => item.filenames?.includes(name) || item.extensions?.some((extension) => name.endsWith(extension)))?.id ?? 'plaintext';
}

type ConnectionState = Transport['state']['value'];

// What monaco's client reads to know whether it can send.
class State {
  private current: ConnectionState = { state: 'connecting' };
  private listeners = new Set<(state: ConnectionState) => void>();

  get value() { return this.current; }

  get onChange() {
    return (listener: (state: ConnectionState) => void) => {
      this.listeners.add(listener);
      return { dispose: () => { this.listeners.delete(listener); } };
    };
  }

  set(state: ConnectionState) {
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }
}

type Range = { start: { line: number; character: number } };
type OpenOptions = { machine: FileClick['machine']; path: string; language: string; model: monaco.editor.ITextModel; navigate: (file: FileClick) => void };

// One language server over the plugin channel: the transport monaco's client speaks to, plus the requests
// this plugin sends itself, and the answer to requests the client has no handler for.
class LspProxy {
  readonly state = new State();
  private frames = new Frames();
  private listener?: (message: Message) => void;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private next = 0;
  private initializing?: unknown;
  private stopped = false;
  private retired = false;
  private uris = new Map<string, string>();
  private methods = new Set<string>();

  constructor(private context: UiContext, readonly info: LspSession, readonly options: OpenOptions) {}

  // Whether the server answers a method, which the preview's menu offers only then.
  supports(method: string) { return this.methods.has(method); }

  toString() { return `旺财语言服务 ${this.info.session}`; }

  setListener(listener?: (message: Message) => void) { this.listener = listener; }

  // monaco's features wait for an answer to every request, so a request this proxy will not forward is closed with an
  // empty result instead of being dropped: it lets the feature move on to the client of another server.
  private answerEmpty(message: Message) {
    const { id } = message as { id?: unknown };
    if (typeof id === 'string' || typeof id === 'number') this.deliver({ jsonrpc: '2.0', id, result: null });
  }

  async send(message: Message) {
    // A server that stopped answers nothing, so the request is closed here instead of being left waiting.
    if (this.stopped) { this.answerEmpty(message); return; }
    const { id, method, params } = message as { id?: unknown; method?: string; params?: Record<string, unknown> };
    // monaco's client asks for no root and no folder, which leaves the server indexing nothing.
    if (method === 'initialize' && params) {
      this.initializing = id;
      // Both fields are URIs the server parses, so the root is spelled the way every other URI here is.
      const root = monaco.Uri.file(this.info.root).toString();
      params.rootUri = root;
      params.workspaceFolders = [{ uri: root, name: this.info.root.slice(this.info.root.lastIndexOf('/') + 1) }];
    }
    this.restore(message);
    if (this.foreignDocument(message)) {
      this.answerEmpty(message);
      return;
    }
    try {
      await this.context.ui.request('lsp-write', { session: this.info.session, data: base64(frame(message)) });
    } catch (error) {
      // A write the node would not take is no proof the server exited; the service closes it and decides from its tries
      // whether to start another.
      this.stop((error as Error).message);
      return;
    }
    if (!this.stopped && this.state.value.state !== 'open') this.state.set({ state: 'open' });
  }

  // monaco asks this server about every file the window has open, and a window can hold two roots of one language,
  // each with its own server: a document of another language or of another root is none of this one's business.
  private foreignDocument(message: Message) {
    const { uri } = messageDocument(message);
    if (typeof uri !== 'string') return false;
    const language = monaco.editor.getModel(monaco.Uri.parse(uri))?.getLanguageId();
    if (language !== undefined && language !== this.options.language) return true;
    // A root of / owns every document, and monaco names a model it cannot spell as a file inmemory://model/N, which
    // belongs to no root: neither is judged by the prefix.
    const root = monaco.Uri.file(this.info.root).toString();
    return root !== 'file:///' && uri.startsWith('file://') && !uri.startsWith(`${root}/`);
  }

  // monaco's client lowercases every URI it syncs, and no path on a case-sensitive filesystem is spelled that
  // way, so each URI travels as the model spells it. A model outlives neither a tab close nor a sync, so a
  // spelling that was looked up once is kept.
  private restore(message: Message) {
    const { params, uri } = messageDocument(message);
    if (typeof uri !== 'string') return;
    const real = this.uris.get(uri) ?? monaco.editor.getModels().find((model) => model.uri.toString(true).toLowerCase() === uri.toLowerCase())?.uri.toString(true);
    if (!real || real === uri) return;
    this.uris.set(uri, real);
    if (params?.textDocument?.uri === uri) params.textDocument.uri = real;
    else if (params?.uri === uri) params.uri = real;
  }

  request(method: string, params: unknown) {
    const id = `wangcai-${++this.next}`;
    // A stopped server answers this send at once, so the answer must already have somewhere to go.
    const answer = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    void this.send({ jsonrpc: '2.0', id, method, params } as Message);
    return answer;
  }

  receive(data: string) {
    for (const message of this.frames.push(unbase64(data))) this.deliver(message);
  }

  // A server that stopped cannot serve its session again, so the next open replaces this proxy with a new one.
  get closed() { return this.stopped; }

  // A stop the window asked for is not a failure: only a server that stopped by itself is started again.
  get unexpected() { return this.stopped && !this.retired; }

  retire() { this.retired = true; }

  stop(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.state.set({ state: 'closed', error: new Error(reason) });
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
  }

  // A link needs the model of the file it points into, so a file the window has not opened is read in first.
  private async loadModel(uri: monaco.Uri) {
    if (monaco.editor.getModel(uri)) return;
    const text = await this.context.ui.request<string>('read', { machine: this.options.machine, path: uri.path }).catch(() => undefined);
    if (text === undefined) return;
    buffer(uri, languageFor(uri.path), text);
  }

  // monaco's client lowercases the URI it syncs, and a server names its locations the way it was told, so a location
  // of a file the window has open takes that model's spelling: the editor knows no model by the lowercased one.
  private spelled(uri: monaco.Uri) {
    const lower = uri.toString(true).toLowerCase();
    return monaco.editor.getModels().find((model) => model.uri.toString(true).toLowerCase() === lower)?.uri ?? uri;
  }

  private async locations(model: monaco.editor.ITextModel, position: monaco.Position, method: string, extra?: Record<string, unknown>): Promise<monaco.languages.Location[]> {
    // A server that cannot answer the method, or fails to, gives no location.
    const result = await this.request(method, {
      textDocument: { uri: model.uri.toString(true) },
      position: { line: position.lineNumber - 1, character: position.column - 1 },
      ...extra,
    }).catch(() => undefined);
    const locations = (Array.isArray(result) ? result : result ? [result] : []).map((item: { uri?: string; targetUri?: string; range?: Range; targetSelectionRange?: Range }) => {
      const range = item.targetSelectionRange ?? item.range ?? { start: { line: 0, character: 0 } };
      const line = range.start.line + 1;
      const column = range.start.character + 1;
      return { uri: this.spelled(monaco.Uri.parse(item.targetUri ?? item.uri ?? model.uri.toString(true))), range: new monaco.Range(line, column, line, column) };
    });
    // Opening the file is the opener's job, so reading it in for a location never moves the tab by itself.
    await Promise.all(locations.map((location) => this.loadModel(location.uri)));
    return locations;
  }

  definition(model: monaco.editor.ITextModel, position: monaco.Position) {
    return this.locations(model, position, ownProviders.definitionProvider);
  }

  implementation(model: monaco.editor.ITextModel, position: monaco.Position) {
    return this.locations(model, position, ownProviders.implementationProvider);
  }

  typeDefinition(model: monaco.editor.ITextModel, position: monaco.Position) {
    return this.locations(model, position, ownProviders.typeDefinitionProvider);
  }

  references(model: monaco.editor.ITextModel, position: monaco.Position) {
    return this.locations(model, position, ownProviders.referencesProvider, { context: { includeDeclaration: true } });
  }

  // The machine is the server's; only the path and the position come from the resource monaco asks about.
  openTarget(resource: monaco.Uri, position?: monaco.Position): FileClick {
    return { type: 'file', machine: this.options.machine, path: resource.path, line: position?.lineNumber ?? 1, column: position?.column ?? 1 };
  }

  private deliver(message: Message) {
    this.restore(message);
    if (this.foreignDocument(message)) return;
    const { id, method, result, error } = message as { id?: string | number; method?: string; result?: { capabilities?: Record<string, unknown> }; error?: { message?: string } };
    if (method !== undefined) {
      if ((method === 'client/registerCapability' || method === 'client/unregisterCapability') && this.registered(message)) return;
      this.listener?.(message);
      return;
    }
    if (typeof id === 'string') {
      const waiting = this.pending.get(id);
      if (!waiting) return;
      this.pending.delete(id);
      if (error) waiting.reject(new Error(error.message ?? '语言服务返回错误'));
      else waiting.resolve(result);
      return;
    }
    // The capabilities a server announces decide which features monaco's client turns on, so the ones this plugin
    // answers itself are kept for the menu and dropped before the client reads them.
    if (id === this.initializing) {
      const capabilities = result?.capabilities ?? {};
      for (const [provider, method] of Object.entries(ownProviders)) {
        if (capabilities[provider]) this.methods.add(method);
        delete capabilities[provider];
      }
      this.initializing = undefined;
    }
    this.listener?.(message);
  }

  // A server registering one of the methods this plugin answers would hand it to monaco's client instead.
  private registered(message: Message) {
    const params = (message as { params?: { registrations?: { method: string }[]; unregisterations?: { method: string }[] } }).params;
    if (!params) return false;
    const listed = params.registrations ?? params.unregisterations;
    if (!listed) return false;
    const mine = listed.filter((item) => ownMethods.has(item.method));
    // Only a registration offers a method: an unregistration must not add one back to the menu.
    if (params.registrations) for (const item of mine) this.methods.add(item.method);
    const kept = listed.filter((item) => !ownMethods.has(item.method));
    if (kept.length === listed.length) return false;
    if (kept.length) {
      if (params.registrations) params.registrations = kept;
      else params.unregisterations = kept;
      return false;
    }
    void this.send({ jsonrpc: '2.0', id: (message as { id: string | number }).id, result: null });
    return true;
  }
}

// A symbol as either form a server answers a document's symbols in: a file's own tree, whose nested entries are what
// they are declared in, or a flat list that carries each one's range in a location.
type ServerSymbol = { name: string; kind?: number; range?: Range; selectionRange?: Range; location?: { range: Range }; children?: ServerSymbol[] };
// What the picker lists for a file: a declaration, under the name of whatever declares it.
export type FileSymbol = { name: string; container?: string; line: number; column: number };

// The symbol kinds whose children are declarations of their own: a type of any language holds its members, and a file
// holds what it declares. Anything else — a function, a statement, a JSX child — holds statements and locals.
const containers = new Set([2, 3, 5, 10, 11, 19, 23]);
// What a file declares: a module, a namespace, a class, an enum, an interface, a function, a variable or constant, an
// object, a struct.
const declarations = new Set([2, 3, 5, 10, 11, 12, 13, 14, 19, 23]);
// What a type declares, which a file's declaration list shows as well: its methods, properties, fields, constructor and
// enum members.
const members = new Set([6, 7, 8, 9, 22]);
// A server describes what it cannot name with a placeholder — `<unknown>`, `<function>`, `[computed]`, `a.map() callback`
// — and nothing a reader can look up has such a name.
const unnamed = (name: string) => name.startsWith('<') || name.startsWith('[') || name.includes(' callback');

// A file's symbols, the way an editor's outline reads it: what the file declares, and the members of the types it
// declares, walking into an entry only where `containers` says its children are declarations too.
function outline(items: ServerSymbol[]): FileSymbol[] {
  const symbols: FileSymbol[] = [];
  const walk = (entries: ServerSymbol[], container?: string) => {
    for (const item of entries) {
      if (unnamed(item.name)) continue;
      const kind = item.kind ?? 0;
      if (!declarations.has(kind) && (container === undefined || !members.has(kind))) continue;
      const range = item.selectionRange ?? item.location?.range ?? item.range;
      symbols.push({ name: item.name, container, line: (range?.start.line ?? 0) + 1, column: (range?.start.character ?? 0) + 1 });
      if (item.children && containers.has(kind)) walk(item.children, [...(container ? [container] : []), item.name].join(' · '));
    }
  };
  walk(items);
  return symbols;
}

// How long a server that stopped by itself waits before each try at starting it again: a machine that reconnected needs
// its server back, while one that keeps dying must not be restarted forever.
const reviveWaits = [1000, 3000, 7000];
// How long a server has to stay up for the tries it has taken to count for nothing: one that comes up and dies again
// inside this window is still the server that keeps dying.
const healthyFor = 30_000;

// The language servers this window drives, one monaco LSP client per server. A client is never disposed —
// monaco's has no way to — so a server that is restarted leaves its client behind and starts another one.
export class LanguageServices {
  private bySession = new Map<string, LspProxy>();
  // One entry per file the window has: the session it speaks to, and what it takes to open it again.
  private byModel = new WeakMap<monaco.editor.ITextModel, { session: string; options: OpenOptions }>();
  private off: (() => void)[];
  private listeners = new Set<() => void>();
  // What a server last wrote to its error stream, which is all a user sees of why it stopped.
  private logs = new Map<string, string>();
  // What a file whose server never came up said, and what it takes to try it again.
  private missing = new WeakMap<monaco.editor.ITextModel, { error: string; options: OpenOptions }>();
  // What it takes to start a session again: the options to open it with, the tries that stand since a server last
  // stayed up, and when that server came up, which is what the tries are measured against.
  private revivals = new Map<string, { options: OpenOptions; tries: number; upSince?: number }>();
  // The sessions being revived now, so a server that stops again does not start a second revival of its own.
  private reviving = new Set<string>();

  constructor(private context: UiContext) {
    this.off = [
      context.ui.subscribe<LspData>('lsp-data', ({ session, data }) => this.bySession.get(session)?.receive(data)),
      context.ui.subscribe<LspExit>('lsp-exit', ({ session, code }) => {
        this.bySession.get(session)?.stop(code === undefined ? '语言服务已断开' : `语言服务已退出 (${code})`);
      }),
      context.ui.subscribe<LspLog>('lsp-log', ({ session, text }) => { if (text) this.logs.set(session, text.split('\n').pop()!); }),
    ];
  }

  // The status dot follows a server from the moment it opens until it stops, so each change in between reaches it.
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  // Starts or reuses the server for a file and connects the model to it, so the editor highlights and hovers from the
  // same server. `wanted` is false when a revival asks for a session a view may have left meanwhile.
  async open(options: OpenOptions, { wanted = true }: { wanted?: boolean } = {}) {
    const info = await this.context.ui.request<LspSession | null>('lsp-open', { machine: options.machine, path: options.path, language: options.language })
      .catch((error: Error) => {
        // Only a file whose server never came up is read from this: a revival that fails still has the closed proxy the
        // dot speaks for.
        if (wanted) this.missing.set(options.model, { error: error.message, options });
        return null;
      });
    if (!info) {
      // Nothing runs behind this file. A view's server that could not be started was just remembered, and this is what
      // lets the dot show it; a language with no server of its own keeps its dot away.
      this.changed();
      return;
    }
    if (!wanted && !this.revivals.has(info.session)) {
      // The views that asked for this server left while it was on its way, so the one just started is closed rather
      // than kept for nobody.
      await this.context.ui.request('lsp-close', { session: info.session }).catch(() => {});
      return;
    }
    this.missing.delete(options.model);
    // The record is put in place before the server starts, so even a server's first arrival is recorded.
    const known = this.revivals.get(info.session);
    const revival = known ?? { options, tries: 0 };
    if (known) revival.options = options;
    else this.revivals.set(info.session, revival);
    const existing = this.bySession.get(info.session);
    if (!existing || existing.closed) {
      // A new proxy starts without the session's old errors, so what the last server wrote goes with it.
      this.logs.delete(info.session);
      // Its clock starts from nothing too: until this server comes up, the session has not been healthy at all.
      revival.upSince = undefined;
      const started = new LspProxy(this.context, info, options);
      this.bySession.set(info.session, started);
      const subscription = started.state.onChange(() => {
        this.changed();
        if (started.state.value.state === 'open') revival.upSince = Date.now();
        else if (started.state.value.state === 'closed' && started.unexpected) void this.revive(info.session);
      });
      this.off.push(() => subscription.dispose());
      new MonacoLspClient(started);
    }
    this.byModel.set(options.model, { session: info.session, options });
    this.changed();
  }

  // The server a model belongs to, and the session it speaks on. A session that was replaced by a new server
  // answers with the new one, so a file that stayed open keeps jumping.
  private lookup(model: monaco.editor.ITextModel) {
    const view = this.byModel.get(model);
    const proxy = view && this.bySession.get(view.session);
    return view && proxy && { view, proxy };
  }

  for(model: monaco.editor.ITextModel) {
    return this.lookup(model)?.proxy;
  }

  // Another file of the same server is opened in the tab of the file that asked for it.
  openResource(source: monaco.editor.ITextModel | null, resource: monaco.Uri, position?: monaco.Position) {
    if (!source || resource.toString(true) === source.uri.toString(true)) return false;
    const found = this.lookup(source);
    if (!found) return false;
    found.view.options.navigate(found.proxy.openTarget(resource, position));
    return true;
  }

  // What the status dot shows for one file: the service behind it — the server its session runs, or the reason none does.
  status(model: monaco.editor.ITextModel) {
    const found = this.lookup(model);
    if (!found) {
      const missing = this.missing.get(model);
      // The binary's own name is not known here — it was never found — so the dot names the language instead.
      return missing && { server: missing.options.language, state: 'missing' as const, error: missing.error };
    }
    const state = found.proxy.state.value;
    return { server: found.proxy.info.server, root: found.proxy.info.root, state: state.state, error: state.state === 'closed' ? state.error?.message : undefined, log: this.logs.get(found.view.session) };
  }

  // The proxy a file speaks to, waiting for the view that opens it: the picker asks about a file whose server the
  // page is starting, and a request sent before that opening lands on a server nobody has told to start.
  private async proxyFor(model: monaco.editor.ITextModel) {
    const usable = () => {
      const proxy = this.for(model);
      return proxy && proxy.state.value.state !== 'connecting' ? proxy : undefined;
    };
    const ready = usable();
    if (ready) return ready;
    return new Promise<LspProxy | undefined>((resolve) => {
      // The subscription replaces this placeholder before the timeout can fire, and whichever answers first releases
      // both.
      let stop = () => {};
      const timer = setTimeout(() => { stop(); resolve(usable()); }, 5000);
      stop = this.subscribe(() => {
        const proxy = usable();
        if (!proxy) return;
        clearTimeout(timer);
        stop();
        resolve(proxy);
      });
    });
  }

  // The symbols a file's server lists for it, as `outline` reads them: `undefined` for a file no server serves.
  async symbols(model: monaco.editor.ITextModel): Promise<FileSymbol[] | undefined> {
    const proxy = await this.proxyFor(model);
    if (!proxy) return undefined;
    // A server that has not been told the document is open yet lists nothing at all, which is indistinguishable from a
    // file without symbols, so an empty answer is asked again for as long as that handshake takes.
    const ask = () => proxy.request('textDocument/documentSymbol', { textDocument: { uri: model.uri.toString(true) } }).catch(() => undefined);
    let answer = await ask();
    for (let attempt = 0; attempt < 4 && Array.isArray(answer) && !answer.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      answer = await ask();
    }
    return Array.isArray(answer) ? outline(answer as ServerSymbol[]) : [];
  }

  // Starts the server behind this file: a running session is dropped and the file is opened on a new server, while a
  // file with no server behind it is started for the first time.
  async restart(model: monaco.editor.ITextModel) {
    const found = this.lookup(model);
    if (!found) {
      const options = this.missing.get(model)?.options;
      if (options) await this.open(options);
      return;
    }
    await this.letGo(found.proxy, found.view.session, '语言服务已重启');
    if (!model.isDisposed()) await this.open(found.view.options);
  }

  // Starts the server behind a session again: the node is told to close the one this window dropped.
  private async revive(session: string) {
    const revival = this.revivals.get(session);
    if (!revival || this.reviving.has(session)) return;
    this.reviving.add(session);
    try {
      if (revival.upSince !== undefined && Date.now() - revival.upSince >= healthyFor) revival.tries = 0;
      await this.context.ui.request('lsp-close', { session }).catch(() => {});
      for (const wait of reviveWaits.slice(revival.tries)) {
        revival.tries++;
        await new Promise((resolve) => setTimeout(resolve, wait));
        // The view may have gone while this waited, and a server nobody needs is not started.
        if (!this.revivals.has(session)) return;
        await this.open(revival.options, { wanted: false });
        const revived = this.bySession.get(session);
        if (revived && !revived.closed) return;
      }
    } finally {
      this.reviving.delete(session);
    }
  }

  // The window lets a server go: it is retired, so its stop is not taken for a failure, and then closed on the node.
  private async letGo(proxy: LspProxy, session: string, reason: string) {
    proxy.retire();
    proxy.stop(reason);
    await this.context.ui.request('lsp-close', { session });
  }

  async closeUnused(openFiles: FileClick[]) {
    for (const [session, proxy] of [...this.bySession]) {
      const { machine, language } = proxy.options;
      const root = proxy.info.root;
      const key = machineKey(machine);
      const kept = openFiles.some((file) => machineKey(file.machine) === key && languageFor(file.path) === language
        && file.path.startsWith(root.endsWith('/') ? root : `${root}/`));
      if (kept) continue;
      this.bySession.delete(session);
      this.logs.delete(session);
      this.revivals.delete(session);
      await this.letGo(proxy, session, '语言服务已关闭');
    }
    this.changed();
  }

  dispose() {
    for (const dispose of this.off) dispose();
  }
}
