import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { MachineConnection, Process } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { imageMime, machineKey, type FileClick, type GitHunk, type GitLetter, type GitLines, type GitStatus, type History, type LspData, type SearchHit, type Settings } from './shared';

export const keys = { '<leader>ff': { global: true, desc: '打开文件视图', event: 'core:show-view', data: { plugin: 'files' } } };

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
  // The keys the preview answers to.
  vim: { type: 'object' },
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

// `git status --porcelain=v2 -z`, read the way VS Code paints a change: one badge per path, and the working tree's
// side winning over the index's, so a file staged and edited again reads as modified rather than added.
function readStatus(stdout: string): Record<string, GitLetter> {
  const states: Record<string, GitLetter> = {};
  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.startsWith('? ')) states[field.slice(2)] = 'U';
    // An unmerged path is a conflict whatever its two sides say.
    else if (field.startsWith('u ')) states[field.split(' ').slice(10).join(' ')] = '!';
    else if (field[0] === '1' || field[0] === '2') {
      const parts = field.split(' ');
      const [index, worktree] = parts[1];
      const path = parts.slice(field[0] === '1' ? 8 : 9).join(' ');
      // A rename's record is followed by the path it came from, which is a field of its own in this format.
      if (field[0] === '2') i++;
      states[path] = (worktree === '.' ? index : worktree) as GitLetter;
    }
  }
  return states;
}

function readHunks(patch: string): GitHunk[] {
  const hunks: GitHunk[] = [];
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) { hunks.push({ oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] }); continue; }
    const hunk = hunks[hunks.length - 1];
    if (!hunk) continue;
    if (line.startsWith('+')) hunk.lines.push({ kind: 'added', text: line.slice(1) });
    else if (line.startsWith('-')) hunk.lines.push({ kind: 'removed', text: line.slice(1) });
    else if (line.startsWith(' ')) hunk.lines.push({ kind: 'context', text: line.slice(1) });
  }
  return hunks;
}

// A git run over a connection, with the index lock off so reading never takes the lock a writer wants.
const git = (connection: MachineConnection, cwd: string, args: string[]) =>
  connection.subprocess.exec('git', args, { cwd, env: { GIT_OPTIONAL_LOCKS: '0' } });

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

  // One line of `rg --json` output: what kind of event it is — a match among others — the path it was found in, the line
  // it sits on with that line's text, and where in the line its hits start.
  type RgEvent = { type: string; data: { path?: { text: string }; line_number?: number; lines?: { text: string }; submatches?: { start: number }[] } };

  // How many lines a grep answer carries: the page draws fewer than this, and whether more were found is all it hears.
  const grepCeiling = 500;
  // How many paths a listing carries: the page ranks the whole list before it draws any of it, so this only keeps one
  // answer from being a repository's worth of paths.
  const pathCeiling = 20000;

  // A rg run over a connection, looked up the way a language server is: the daemon's own PATH may not hold it.
  const rg = async (connection: MachineConnection, machine: FileClick['machine'], cwd: string, args: string[]) => {
    const located = await locate(connection, machine, [['rg']], cwd);
    if (!located) throw new Error('未找到 rg 命令，无法搜索');
    return connection.subprocess.exec(located.command, args, { cwd, env: { PATH: located.path } });
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

  // What git paints for the directory a picker shows: `status` answers with paths relative to the repository
  // root, so one reading covers the whole repository rather than just the directory asked about.
  handlers.push(context.ui.handle('git-status', ({ machine, path }: { machine: FileClick['machine']; path: string }) =>
    withConnection(machine, async (connection): Promise<GitStatus | null> => {
      try {
        const top = await git(connection, path, ['rev-parse', '--show-toplevel']);
        if (top.code !== 0) return null;
        const root = Buffer.from(top.stdout).toString('utf8').trim();
        const status = await git(connection, path, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
        if (status.code !== 0) return null;
        return { root, states: readStatus(Buffer.from(status.stdout).toString('utf8')) };
      } catch {
        // A machine without git, or a directory the command cannot run in, is just a picker with no marks.
        return null;
      }
    })));

  // The lines a file's uncommitted changes added or removed: VS Code's gutter compares the working tree with the
  // index, so a staged change takes its marks away.
  handlers.push(context.ui.handle('git-lines', ({ machine, path }: { machine: FileClick['machine']; path: string }) =>
    withConnection(machine, async (connection): Promise<GitLines | null> => {
      try {
        const top = await git(connection, posix.dirname(path), ['rev-parse', '--show-toplevel']);
        if (top.code !== 0) return null;
        const root = Buffer.from(top.stdout).toString('utf8').trim();
        if (!path.startsWith(`${root}/`)) return null;
        const relative = path.slice(root.length + 1);
        // A file git does not track has no index version for the lines to be compared with.
        if ((await git(connection, root, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', relative])).code !== 0) return null;
        const patch = await git(connection, root, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', '--', relative]);
        if (patch.code !== 0) return null;
        return { root, hunks: readHunks(Buffer.from(patch.stdout).toString('utf8')) };
      } catch {
        return null;
      }
    })));

  // The paths a file search offers: what rg lists under a workspace, which leaves out what git ignores.
  handlers.push(context.ui.handle('find-files', ({ machine, path }: { machine: FileClick['machine']; path: string }) =>
    withConnection(machine, async (connection) => {
      const listed = await rg(connection, machine, path, ['--files', '--color', 'never']);
      if (listed.code !== 0) throw new Error(Buffer.from(listed.stderr).toString('utf8').trim() || '文件列表读取失败');
      const files = Buffer.from(listed.stdout).toString('utf8').split('\n').filter(Boolean);
      return { files: files.slice(0, pathCeiling).map((file) => posix.resolve(path, file)), truncated: files.length > pathCeiling };
    })));

  // A pattern's matches under a workspace, one row per line that holds it. rg is asked for JSON because a match then
  // carries the byte offsets of its hits.
  handlers.push(context.ui.handle('grep', ({ machine, path, query }: { machine: FileClick['machine']; path: string; query: string }) =>
    withConnection(machine, async (connection) => {
      const found = await rg(connection, machine, path, ['--json', '--smart-case', '--max-count', '10', '--max-filesize', '2M', '-e', query]);
      // A pattern that matched nothing is exit code 1, which is an empty list rather than a failure.
      if (found.code > 1) throw new Error(Buffer.from(found.stderr).toString('utf8').trim() || '搜索失败');
      const hits: SearchHit[] = [];
      for (const line of Buffer.from(found.stdout).toString('utf8').split('\n')) {
        let event: RgEvent;
        try { event = JSON.parse(line) as RgEvent; } catch { continue; }
        if (event.type !== 'match' || !event.data.path) continue;
        const text = (event.data.lines?.text ?? '').replace(/\r?\n$/, '');
        // The offset counts bytes, so the column counts the characters those bytes spell.
        const start = event.data.submatches?.[0]?.start ?? 0;
        hits.push({
          path: posix.resolve(path, event.data.path.text), line: event.data.line_number ?? 1,
          column: Buffer.from(text).subarray(0, start).toString('utf8').length + 1, text: text.trim(),
        });
      }
      return { hits: hits.slice(0, grepCeiling), truncated: hits.length > grepCeiling };
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
        if (!located) throw new Error(`未找到 ${spec.commands.map(([command]) => command).join(' / ')}`);
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
