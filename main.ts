import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { MachineConnection } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { imageMime, type FileClick, type History } from './shared';

// Fields this plugin takes from init.ts.
export const config = {
  font: {
    family: { type: 'string', default: '"DejaVuSansM Nerd Font Mono", monospace' },
    size: { type: 'number', default: 12 },
    lineHeight: { type: 'number' },
  },
};

export function activate(context: MainContext) {
  const pending = new Set<AbortController>();
  const connections = new Set<MachineConnection>();
  const handlers = ['read', 'list', 'resolve'].map((method) => context.ui.handle(method, async ({ machine, path, sessionId, base }: { machine: FileClick['machine']; path?: string; sessionId?: string; base?: string }) => {
    const controller = new AbortController();
    pending.add(controller);
    let connection: MachineConnection | undefined;
    try {
      connection = await context.connect(machine, controller.signal);
      controller.signal.throwIfAborted();
      connections.add(connection);
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
    } finally {
      connection?.disconnect();
      if (connection) connections.delete(connection);
      pending.delete(controller);
    }
  }));
  const historyPath = join(context.host.dataDirectory, 'history.json');
  handlers.push(
    context.ui.handle('history', () => existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf8')) : {}),
    context.ui.handle('save-history', (history: Record<string, History>) => {
      writeFileSync(`${historyPath}.tmp`, JSON.stringify(history, null, 2));
      renameSync(`${historyPath}.tmp`, historyPath);
    }),
  );
  return () => {
    for (const remove of handlers) remove();
    for (const controller of pending) controller.abort();
    for (const connection of connections) connection.disconnect();
  };
}
