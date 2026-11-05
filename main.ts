import { posix } from 'node:path';
import type { MachineConnection } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { machineKey, type FileClick, type GitLetter, type GitStatus } from './shared';

export const keys = { '<leader>f': { global: true, desc: '打开文件视图', event: 'core:show-view', data: { plugin: 'files' } } };

// Fields this plugin takes from init.ts.
export const config = {
  font: {
    family: { type: 'string', default: '"DejaVuSansM Nerd Font Mono", monospace' },
  },
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

// A git run over a connection, with the index lock off so reading never takes the lock a writer wants.
const git = (connection: MachineConnection, cwd: string, args: string[]) =>
  connection.subprocess.exec('git', args, { cwd, env: { GIT_OPTIONAL_LOCKS: '0' } });

export function activate(context: MainContext) {
  const pending = new Set<AbortController>();
  const connections = new Set<MachineConnection>();

  // One request runs on its own connection to a machine, closed again at the end unless the body keeps it: the
  // connection a tab watches paths on outlives the request that set the watch.
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

  const handlers = ['list', 'resolve'].map((method) => context.ui.handle(method, ({ machine, path, sessionId, base }: { machine: FileClick['machine']; path?: string; sessionId?: string; base?: string }) =>
    withConnection(machine, async (connection) => {
      if (method === 'resolve') {
        const target = path === undefined ? await connection.pty.cwd(sessionId!) : posix.resolve(base!, path);
        const stat = await connection.fs.stat(target);
        if (!stat) throw new Error(`路径不存在: ${target}`);
        return { type: stat.isDirectory ? 'directory' : 'file', machine, path: target };
      }
      const directory = path ?? await connection.pty.cwd(sessionId!);
      const entries = await connection.fs.readDirectory(directory);
      entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
      return { path: directory, entries };
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

  return async () => {
    for (const remove of handlers) remove();
    for (const controller of pending) controller.abort();
    for (const connection of connections) connection.disconnect();
  };
}
