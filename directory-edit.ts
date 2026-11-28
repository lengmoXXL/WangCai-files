import { posix } from 'node:path';
import type { MachineConnection } from '@lengmoxxl/sdk';
import { childOf, entryText, validEntryPath, type DirectoryChange, type DirectoryEditResult } from './shared';

// Foundation names the exact destination on macOS, including case-only renames.
const renameOnMac = `
ObjC.import('Foundation');
function run([from, to]) {
  if (!$.NSFileManager.defaultManager.moveItemAtPathToPathError(from, to, null))
    throw 'Unable to rename entry';
}
`;
const trashOnMac = `
ObjC.import('Foundation');
function run([path]) {
  if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(path), null, null))
    throw '无法将条目移到废纸篓';
}
`;

type Entry = { isDirectory: boolean; diskPath?: string; children?: Map<string, Entry> };
type Step = { change: DirectoryChange; index?: number };

function copyEntry(entry: Entry): Entry {
  const children = entry.children && new Map([...entry.children].map(([name, child]) => [name, copyEntry(child)]));
  return { ...entry, children };
}

async function prepareChanges(connection: MachineConnection, cwd: string, changes: DirectoryChange[]) {
  const sources = new Map<string, number>();
  const destinations = new Map<string, number>();
  for (const [index, { from, name, isDirectory, copy, remove }] of changes.entries()) {
    if (!validEntryPath(name) || (from !== undefined && (!validEntryPath(from) || from === name))) throw new Error('目录变更包含无效路径');
    if (remove) {
      if (from !== undefined || copy) throw new Error('目录变更包含无效的删除');
      if (sources.has(name)) throw new Error(`源路径重复：${entryText({ name, isDirectory })}`);
      sources.set(name, index);
      continue;
    }
    if (copy && from === undefined) throw new Error('复制需要源路径');
    if (destinations.has(name)) throw new Error(`目标名称重复：${entryText({ name, isDirectory })}`);
    destinations.set(name, index);
    if (from === undefined) continue;
    if (name.startsWith(`${from}/`)) throw new Error(`目标位于源路径下：${entryText({ name: from, isDirectory })}`);
    if (!copy) {
      if (sources.has(from)) throw new Error(`源路径重复：${entryText({ name: from, isDirectory })}`);
      sources.set(from, index);
    }
  }

  // Free occupied paths first. Changes inside an existing directory follow that directory when it moves.
  const dependencies = changes.map(() => new Set<number>());
  for (const [index, { from, name, copy, remove }] of changes.entries()) {
    if (!remove) {
      const taken = sources.get(name);
      if (taken !== undefined) dependencies[index].add(taken);
      for (let parent = posix.dirname(name); parent !== '.'; parent = posix.dirname(parent)) {
        const leaving = sources.get(parent);
        const arriving = destinations.get(parent);
        if (arriving !== undefined) dependencies[index].add(arriving);
        else if (leaving !== undefined) dependencies[leaving].add(index);
      }
    }
    const source = remove ? name : from;
    if (source === undefined) continue;
    const moving = sources.get(source);
    if (copy && moving !== undefined) dependencies[moving].add(index);
    for (let parent = posix.dirname(source); parent !== '.'; parent = posix.dirname(parent)) {
      const enclosingMove = sources.get(parent);
      if (enclosingMove !== undefined) dependencies[enclosingMove].add(index);
    }
  }
  const followers = changes.map(() => [] as number[]);
  const order: number[] = [];
  for (const [index, needed] of dependencies.entries()) {
    if (!needed.size) order.push(index);
    for (const before of needed) followers[before].push(index);
  }
  for (const index of order) {
    for (const next of followers[index]) {
      dependencies[next].delete(index);
      if (!dependencies[next].size) order.push(next);
    }
  }
  if (order.length !== changes.length) throw new Error('目录变更会形成循环，请先用一个临时路径腾出位置');

  // Follow the proposed tree without writing. A moved directory keeps its children and original disk path.
  const root: Entry = { isDirectory: true, diskPath: cwd };
  const steps: Step[] = [];
  const children = async (entry: Entry) => {
    if (!entry.children) {
      const path = entry.diskPath;
      entry.children = path === undefined ? new Map() : new Map((await connection.fs.readDirectory(path))
        .map(({ name, isDirectory }) => [name, { isDirectory, diskPath: childOf(path, name) }]));
    }
    return entry.children;
  };
  const containingDirectory = async (path: string, create: boolean) => {
    let entry = root;
    let relative = '';
    const parents = path.split('/').slice(0, -1);
    for (const name of parents) {
      relative = relative ? `${relative}/${name}` : name;
      const entries = await children(entry);
      let next = entries.get(name);
      if (!next && create) {
        next = { isDirectory: true };
        entries.set(name, next);
        steps.push({ change: { name: relative, isDirectory: true } });
      }
      if (!next?.isDirectory) {
        if (create) throw new Error(`上级路径被文件占用：${entryText({ name: relative, isDirectory: false })}`);
        return undefined;
      }
      entry = next;
    }
    return children(entry);
  };
  for (const index of order) {
    const change = changes[index];
    const { from, name, isDirectory, copy, remove } = change;
    const sourcePath = remove ? name : from;
    const source = sourcePath === undefined ? undefined : await containingDirectory(sourcePath, false);
    const sourceName = sourcePath === undefined ? '' : posix.basename(sourcePath);
    const entry = source?.get(sourceName);
    if (sourcePath !== undefined && entry?.isDirectory !== isDirectory) throw new Error(`源条目已变化：${entryText({ name: sourcePath, isDirectory })}`);
    if (remove) {
      source?.delete(sourceName);
      steps.push({ change, index });
      continue;
    }
    const destination = (await containingDirectory(name, true))!;
    const destinationName = posix.basename(name);
    if (destination.has(destinationName)) throw new Error(`目录中已有同名条目：${entryText(change)}`);
    if (!copy) source?.delete(sourceName);
    destination.set(destinationName, entry ? copy ? copyEntry(entry) : entry : { isDirectory });
    steps.push({ change, index });
  }
  return steps;
}

export async function editDirectory(connection: MachineConnection, cwd: string, changes: DirectoryChange[]): Promise<DirectoryEditResult> {
  const steps = await prepareChanges(connection, cwd, changes);
  const exec = async (program: string, args: string[]) => {
    const result = await connection.subprocess.exec(program, args, { cwd });
    if (result.code !== 0) throw new Error(Buffer.from(result.stderr).toString().trim() || '目标已存在或当前目录不可写');
    return Buffer.from(result.stdout).toString();
  };
  const platform = changes.some(({ from, remove }) => from !== undefined || remove) ? (await exec('uname', ['-s'])).trim() : '';
  if (platform !== 'Darwin' && changes.some(({ remove }) => remove)) {
    try { await exec('gio', ['help', 'trash']); }
    catch { throw new Error('当前机器没有可用的废纸篓'); }
  }
  const move = (from: string, to: string) => platform === 'Darwin'
    ? exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', renameOnMac, from, to])
    // GNU mv can skip a colliding target and still exit successfully.
    : exec('/bin/sh', ['-c', 'mv -nT -- "$1" "$2" && [ ! -e "$1" ] && [ ! -L "$1" ]', 'sh', from, to]);
  const applied: number[] = [];
  for (const { change, index } of steps) {
    const to = childOf(cwd, change.name);
    try {
      if (change.remove) {
        if (platform === 'Darwin') await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', trashOnMac, to]);
        else await exec('gio', ['trash', '--', to]);
      } else if (change.from !== undefined) {
        const from = childOf(cwd, change.from);
        if (change.copy) {
          // Stage beside the destination so publishing the copy can't merge with an existing directory.
          const prefix = childOf(posix.dirname(to), '.wangcai-copy.');
          const staging = (await exec('mktemp', ['-d', `${prefix}XXXXXXXX`])).replace(/\n$/, '');
          if (!staging.startsWith(prefix) || !/^[A-Za-z0-9]{8}$/.test(staging.slice(prefix.length))) throw new Error('无法确认复制的临时路径');
          const item = childOf(staging, 'item');
          try {
            await exec('cp', ['-pPR', '--', from, item]);
            await move(item, to);
          } finally {
            await exec('rm', ['-rf', '--', staging]).catch(() => undefined);
          }
        } else await move(from, to);
      } else if (change.isDirectory) {
        await exec('mkdir', index === undefined ? ['-p', '--', to] : ['--', to]);
      } else {
        await exec('/bin/sh', ['-c', 'set -C; [ ! -e "$1" ] && [ ! -L "$1" ] && : > "$1"', 'sh', to]);
      }
      if (index !== undefined) applied.push(index);
    } catch (error) {
      return { applied, problem: `${entryText(change)}：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { applied };
}
