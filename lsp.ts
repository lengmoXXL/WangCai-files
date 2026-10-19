import { MonacoLspClient } from 'monaco-lsp-client';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import { machineKey, type FileClick, type LspData, type LspExit, type LspLog, type LspSession } from './shared';

type Transport = ConstructorParameters<typeof MonacoLspClient>[0];
type Message = Parameters<Transport['send']>[0];

// The method this plugin answers itself: a definition names a location in a file the window may not have
// open, and monaco's client translates locations against open models only, so it would fail on them.
const ownMethods = new Set(['textDocument/definition']);
const ownProviders = ['definitionProvider'];

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
type OpenOptions = { machine: FileClick['machine']; path: string; language: string; model: monaco.editor.ITextModel; navigate: (file: FileClick) => void; notify: (reason: string) => void };

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
  private uris = new Map<string, string>();

  constructor(private context: UiContext, readonly info: LspSession, readonly options: OpenOptions, private notify: (reason: string) => void) {}

  // A server outlives the file that opened it, so a notice about it goes to the file its viewer last opened.
  setNotify(notify: (reason: string) => void) { this.notify = notify; }

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
      // A write the node would not take is no proof the server exited: its process is closed here rather
      // than left behind for a window that has already dropped it.
      this.stop((error as Error).message);
      void this.context.ui.request('lsp-close', { session: this.info.session }).catch(() => {});
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

  stop(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.state.set({ state: 'closed', error: new Error(reason) });
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
    this.notify(reason);
  }

  // monaco resolves the location through its own model service, which knows only the models this window has, and a
  // link needs the model of the file it points into, so a file the window has not opened is read in first.
  private async loadModel(uri: monaco.Uri) {
    if (monaco.editor.getModel(uri)) return;
    const text = await this.context.ui.request<string>('read', { machine: this.options.machine, path: uri.path }).catch(() => undefined);
    if (text === undefined) return;
    buffer(uri, languageFor(uri.path), text);
  }

  // The location is answered even for a file this window has not opened: opening that file is the opener's job, so
  // computing a link never moves the tab by itself.
  async definition(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.Location[]> {
    const result = await this.request('textDocument/definition', {
      textDocument: { uri: model.uri.toString(true) },
      position: { line: position.lineNumber - 1, character: position.column - 1 },
    });
    const locations = (Array.isArray(result) ? result : result ? [result] : []).map((item: { uri?: string; targetUri?: string; range?: Range; targetSelectionRange?: Range }) => {
      const range = item.targetSelectionRange ?? item.range ?? { start: { line: 0, character: 0 } };
      const line = range.start.line + 1;
      const column = range.start.character + 1;
      return { uri: monaco.Uri.parse(item.targetUri ?? item.uri ?? model.uri.toString(true)), range: new monaco.Range(line, column, line, column) };
    });
    await Promise.all(locations.map((location) => this.loadModel(location.uri)));
    return locations;
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
    // The capabilities a server announces decide which features monaco's client turns on, so the ones this
    // plugin answers itself are dropped before the client reads them.
    if (id === this.initializing) {
      for (const provider of ownProviders) delete result?.capabilities?.[provider];
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
    const kept = listed.filter((item) => !ownMethods.has(item.method));
    if (kept.length === listed.length) return false;
    if (kept.length) {
      if (params.registrations === listed) params.registrations = kept;
      else params.unregisterations = kept;
      return false;
    }
    void this.send({ jsonrpc: '2.0', id: (message as { id: string | number }).id, result: null });
    return true;
  }
}

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

  // Starts or reuses the server for a file and connects the model to it, so the editor highlights and hovers
  // from the same server. The notify callback reports why there is no server, or why a running one stopped.
  async open(options: OpenOptions) {
    const info = await this.context.ui.request<LspSession | null>('lsp-open', { machine: options.machine, path: options.path, language: options.language })
      .catch((error: Error) => { options.notify(`语言服务未启动：${error.message}`); return null; });
    if (!info) return;
    let proxy = this.bySession.get(info.session);
    // The stopped proxy is replaced here, and its log goes with it: the next server starts without the old errors.
    if (proxy?.closed) {
      this.logs.delete(info.session);
      proxy = undefined;
    }
    const notify = (reason: string) => {
      const log = this.logs.get(info.session);
      options.notify(log ? `${reason}: ${log}` : reason);
    };
    if (!proxy) {
      proxy = new LspProxy(this.context, info, options, notify);
      this.bySession.set(info.session, proxy);
      const subscription = proxy.state.onChange(() => this.changed());
      this.off.push(() => subscription.dispose());
      new MonacoLspClient(proxy);
    } else proxy.setNotify(notify);
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

  // What the status dot shows for one file: the server its session runs, and how that session is doing.
  status(model: monaco.editor.ITextModel) {
    const found = this.lookup(model);
    if (!found) return undefined;
    const state = found.proxy.state.value;
    return { server: found.proxy.info.server, root: found.proxy.info.root, state: state.state, error: state.state === 'closed' ? state.error?.message : undefined, log: this.logs.get(found.view.session) };
  }

  // A restart replaces the server behind this file: its session is dropped here, and the file is opened again on
  // a new server with the client this window builds for it.
  async restart(model: monaco.editor.ITextModel) {
    const found = this.lookup(model);
    if (!found) return;
    // A restart is not a failure, so the session being replaced reports nothing on its way out.
    found.proxy.setNotify(() => {});
    found.proxy.stop('语言服务已重启');
    await this.context.ui.request('lsp-close', { session: found.view.session });
    if (!model.isDisposed()) await this.open(found.view.options);
  }

  // No view is left to report the close, so it goes without a notice.
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
      proxy.setNotify(() => {});
      proxy.stop('语言服务已关闭');
      await this.context.ui.request('lsp-close', { session });
    }
    this.changed();
  }

  dispose() {
    for (const dispose of this.off) dispose();
  }
}
