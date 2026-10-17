import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { MachineConnection, Process } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { imageMime, machineKey, type FileClick, type History, type LspData, type Settings } from './shared';

// Fields this plugin takes from init.ts.
export const config = {
  font: {
    family: { type: 'string', default: '"DejaVuSansM Nerd Font Mono", monospace' },
    size: { type: 'number', default: 12 },
    lineHeight: { type: 'number' },
  },
  // Per-language entries from init.ts, keyed by Monaco language: a command and markers replace the defaults
  // below, false turns the language off, and a language that is not named here keeps its default.
  lsp: { type: 'object' },
};

type LanguageServer = { commands: string[][]; markers: string[] };

// The language servers this plugin knows, per Monaco language: what to run, and the files that mark the root
// a server should index. A command carries its own arguments, since stdio is not every server's default.
const typescript = { commands: [['typescript-language-server', '--stdio']], markers: ['tsconfig.json', 'jsconfig.json', 'package.json'] };
const clangd = { commands: [['clangd']], markers: ['compile_commands.json', '.clangd', 'CMakeLists.txt'] };
const languageServers: Record<string, LanguageServer> = {
  typescript, javascript: typescript, typescriptreact: typescript, javascriptreact: typescript,
  go: { commands: [['gopls']], markers: ['go.mod', 'go.work'] },
  rust: { commands: [['rust-analyzer']], markers: ['Cargo.toml'] },
  c: clangd, cpp: clangd,
  python: { commands: [['pyright-langserver', '--stdio'], ['pylsp']], markers: ['pyproject.toml', 'setup.py', 'requirements.txt'] },
  shell: { commands: [['bash-language-server', 'start']], markers: [] },
};

export function activate(context: MainContext) {
  const pending = new Set<AbortController>();
  const connections = new Set<MachineConnection>();
  const sessions = new Map<string, { connection: MachineConnection; handle: Process }>();
  const probes = new Map<string, Promise<{ command: string; path: string } | undefined>>();
  const settings: Settings = context.host.config;

  // A daemon started by the app does not inherit a login shell's PATH, so a server is looked up and started with
  // the PATH a login shell would have: the absolute path finds the program, and the PATH is what the program
  // itself resolves its interpreter with.
  const locate = async (connection: MachineConnection, machine: FileClick['machine'], candidates: string[][], cwd: string) => {
    for (const [command, ...args] of candidates) {
      const key = `${machineKey(machine)}|${command}`;
      let probe = probes.get(key);
      if (!probe) {
        probe = connection.subprocess
          .exec('/bin/sh', ['-c', 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; printf "%s\\n" "$PATH"; command -v "$1"', 'sh', command], { cwd })
          .then(({ stdout, code }) => {
            const [path, found] = Buffer.from(stdout).toString('utf8').trim().split('\n');
            return code === 0 && found ? { command: found, path } : undefined;
          }, () => undefined);
        probes.set(key, probe);
      }
      const found = await probe;
      if (found) return { ...found, args };
    }
    return undefined;
  };

  // The nearest ancestor holding a marker of this language or the repository root, and the directory itself
  // when neither marks one.
  const findRoot = async (connection: MachineConnection, directory: string, markers: string[]) => {
    const names = ['.git', ...markers];
    for (let current = directory; ; ) {
      for (const name of names) if (await connection.fs.stat(posix.join(current, name))) return current;
      const parent = posix.dirname(current);
      if (parent === current) return directory;
      current = parent;
    }
  };

  // The server a language runs here: the built-in one, with whatever init.ts says about that language on top.
  const serverFor = (language: string): LanguageServer | undefined => {
    const override = settings.lsp?.[language];
    if (override === false) return undefined;
    const builtin = languageServers[language];
    const commands = override?.command ? [override.command] : builtin?.commands;
    return commands && { commands, markers: override?.markers ?? builtin?.markers ?? [] };
  };

  // One request runs on its own connection to a machine, closed again at the end unless the body keeps it: a
  // language server outlives the request that started it.
  const withConnection = async <T>(machine: FileClick['machine'], body: (connection: MachineConnection, keep: () => void) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    pending.add(controller);
    let connection: MachineConnection | undefined;
    let kept = false;
    try {
      connection = await context.connect(machine, controller.signal);
      controller.signal.throwIfAborted();
      connections.add(connection);
      return await body(connection, () => { kept = true; });
    } finally {
      if (!kept && connection) {
        connection.disconnect();
        connections.delete(connection);
      }
      pending.delete(controller);
    }
  };

  const handlers = ['read', 'list', 'resolve'].map((method) => context.ui.handle(method, ({ machine, path, sessionId, base }: { machine: FileClick['machine']; path?: string; sessionId?: string; base?: string }) =>
    withConnection(machine, async (connection) => {
      if (method === 'resolve') {
        const target = path === undefined ? await connection.pty.cwd(sessionId!) : posix.resolve(base!, path);
        const stat = await connection.fs.stat(target);
        if (!stat) throw new Error(`路径不存在: ${target}`);
        return { type: stat.isDirectory ? 'directory' : 'file', machine, path: target };
      }
      if (method === 'list') {
        const directory = path ?? await connection.pty.cwd(sessionId!);
        const entries = await connection.fs.readDirectory(directory);
        entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
        return { path: directory, entries };
      }
      const bytes = await connection.fs.readFile(path!);
      const image = imageMime(path!);
      if (image) return `data:${image};base64,${Buffer.from(bytes).toString('base64')}`;
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('暂不支持二进制或非 UTF-8 文件'); }
      if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw new Error('暂不支持二进制文件');
      return text;
    })));

  // One watch set per tab: the window keeps a tab per workspace, and a tab that stops showing something must not stop
  // another tab's watch.
  const watchers = new Map<string, { key: string; connection: MachineConnection; close: () => void }>();
  const asked = new Map<string, string>();
  handlers.push(context.ui.handle('watch', async ({ holder, machine, paths }: { holder: string; machine: FileClick['machine']; paths: string[] }) => {
    const key = `${machineKey(machine)}|${JSON.stringify(paths)}`;
    asked.set(holder, key);
    const previous = watchers.get(holder);
    if (previous?.key === key) return;
    // What this tab watched before is given up, since it is about to watch what it shows now.
    if (previous) {
      previous.close();
      // The connection was held only while this tab watched something.
      previous.connection.disconnect();
      connections.delete(previous.connection);
      watchers.delete(holder);
    }
    if (!paths.length) return;
    await withConnection(machine, async (connection, keep) => {
      // A path that cannot be watched is skipped, so one bad path does not cost the others their watch.
      const closes = (await Promise.all(paths.map((path) =>
        connection.fs.watch(path, {}, () => context.ui.publish('changed', path)).catch(() => undefined))))
        .filter((close): close is () => void => close !== undefined);
      // A later request from the same tab took the set over while this one was connecting.
      if (asked.get(holder) !== key || !closes.length || watchers.has(holder)) {
        for (const close of closes) close();
        return;
      }
      keep();
      watchers.set(holder, { key, connection, close: () => { for (const close of closes) close(); } });
    });
  }));

  const historyPath = join(context.host.dataDirectory, 'history.json');
  handlers.push(
    context.ui.handle('history', () => existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf8')) : {}),
    context.ui.handle('save-history', (history: Record<string, History>) => {
      writeFileSync(`${historyPath}.tmp`, JSON.stringify(history, null, 2));
      renameSync(`${historyPath}.tmp`, historyPath);
    }),
    // One server serves every file of its language and root that this window opens.
    context.ui.handle('lsp-open', ({ machine, path, language }: { machine: FileClick['machine']; path: string; language: string }) =>
      withConnection(machine, async (connection, keep) => {
        const spec = serverFor(language);
        if (!spec) return null;
        const directory = posix.dirname(path);
        const located = await locate(connection, machine, spec.commands, directory);
        if (!located) return null;
        const root = await findRoot(connection, directory, spec.markers);
        const name = posix.basename(located.command);
        const session = `${machineKey(machine)}|${language}|${root}`;
        const running = sessions.get(session);
        if (running) return { session, server: name, root };
        const info = await connection.subprocess.spawn(located.command, located.args, { cwd: root, env: { PATH: located.path } });
        const handle = await connection.subprocess.attach(info.id);
        keep();
        sessions.set(session, { connection, handle });
        handle.onData(({ stream, data }) => {
          if (stream === 'stdout') context.ui.publish('lsp-data', { session, data: Buffer.from(data).toString('base64') });
          else context.ui.publish('lsp-log', { session, text: Buffer.from(data).toString('utf8').trimEnd() });
        });
        handle.onExit((code) => {
          // A session that a restart has already replaced belongs to the new process, so its exit is not the
          // window's to hear about.
          if (sessions.get(session)?.handle.id === handle.id) {
            sessions.delete(session);
            context.ui.publish('lsp-exit', { session, code });
          }
          connection.disconnect();
          connections.delete(connection);
        });
        return { session, server: name, root };
      })),
    context.ui.handle('lsp-write', async ({ session, data }: LspData) => {
      const running = sessions.get(session);
      if (!running) throw new Error('语言服务已关闭');
      await running.handle.write(Buffer.from(data, 'base64'));
    }),
    // Closing is asked for by the status dot's restart, by a tab that leaves no file needing the server, and by
    // a write the node would not take. The process is closed here and no exit event goes out: the window that
    // asked has dropped its own session.
    context.ui.handle('lsp-close', async ({ session }: { session: string }) => {
      const running = sessions.get(session);
      if (!running) return;
      sessions.delete(session);
      connections.delete(running.connection);
      await running.connection.subprocess.close(running.handle.id).catch(() => {});
      running.connection.disconnect();
    }),
  );
  return async () => {
    for (const remove of handlers) remove();
    for (const controller of pending) controller.abort();
    // Closing the server first, so nothing is left running on the machine once the window is gone.
    await Promise.all([...sessions.values()].map((session) => session.connection.subprocess.close(session.handle.id).catch(() => {})));
    sessions.clear();
    for (const connection of connections) connection.disconnect();
  };
}
