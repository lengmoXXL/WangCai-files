import type { FileClick, Profile } from '@lengmoxxl/sdk';
export type { FileClick } from '@lengmoxxl/sdk';
// Where a visited file was left: its cursor and the offset it was scrolled to.
export type Position = { line: number; column: number; top: number };
export type HistoryEntry = FileClick & Partial<Position>;
export type History = { entries: HistoryEntry[]; index: number };

// The language service main.ts drives for a file: what opening one gives back, and what it publishes while
// a server runs. Bytes cross the channel as base64, since every payload here is JSON.
export type LspSession = { session: string; server: string; root: string };
export type LspData = { session: string; data: string };
export type LspLog = { session: string; text: string };
export type LspExit = { session: string; code?: number };

// A search's rows: a match in a file's text, at the line and column the row jumps to.
export type SearchHit = { path: string; line: number; column: number; text: string };

// VS Code's decoration letters: git's M/A/D/R/C/T, with 'U' for untracked and '!' for a conflict.
export type GitLetter = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '!';
export type GitStatus = { root: string; states: Record<string, GitLetter> };

// One hunk of a file's diff against the index: where it starts in the index and in the file on disk, and the lines the
// patch prints. A 'context' line is one the change left alone.
export type GitHunk = { oldStart: number; newStart: number; lines: { kind: 'context' | 'removed' | 'added'; text: string }[] };
// What a code preview reads for its gutter: the repository root the marks belong to, and the hunks they are drawn from.
export type GitLines = { root: string; hunks: GitHunk[] };

// The identity of a machine: the id, plus the host that tells two machines with one id apart.
export const machineKey = (machine: FileClick['machine']) => `${machine.id}|${machine.host ?? ''}`;

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight?: number };
type ServerOverride = { command?: string[]; markers?: string[] };
export type Settings = Profile & { font: Font; lsp?: Record<string, ServerOverride | false> };

// Chromium renders these straight from a data URL.
const imageTypes: Record<string, string> = {
  avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', ico: 'image/x-icon',
  jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp',
};
export const imageMime = (path: string) => imageTypes[path.split('.').pop()?.toLowerCase() ?? ''];
