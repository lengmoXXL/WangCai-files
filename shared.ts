import type { DirectoryEntry, FileClick, Profile } from '@lengmoxxl/sdk';
export type { FileClick } from '@lengmoxxl/sdk';

// The identity of a machine: the id, plus the host that tells two machines with one id apart.
export const machineKey = (machine: FileClick['machine']) => `${machine.id}|${machine.host ?? ''}`;
export const childOf = (base: string, name: string) => `${base === '/' ? '' : base}/${name}`;
export const relativeEntryPath = (directory: string, path: string) => path.slice(directory === '/' ? 1 : directory.length + 1);

export const entryText = ({ name, isDirectory }: DirectoryEntry) =>
  name.replace(/[\\\r\n]/g, (character) => character === '\n' ? '\\n' : character === '\r' ? '\\r' : '\\\\') + (isDirectory ? '/' : '');
export const validEntryPath = (path: string) => path.split('/').every((name) => name !== '' && name !== '.' && name !== '..' && !name.includes('\0'));

export type DirectoryChange = DirectoryEntry & { from?: string; copy?: true; remove?: true };
export type DirectoryEditResult = { applied: number[]; problem?: string };

// VS Code's decoration letters: git's M/A/D/R/C/T, with 'U' for untracked and '!' for a conflict.
export type GitLetter = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '!';
// The marks a repository's columns carry: the root they belong to, and one letter per changed path under it.
export type GitStatus = { root: string; states: Record<string, GitLetter> };

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string };
export type Settings = Profile & { font: Font };
