import type { FileClick, Profile } from '@lengmoxxl/sdk';
export type { FileClick } from '@lengmoxxl/sdk';
export type History = { entries: FileClick[]; index: number };

// The language service main.ts drives for a file: what opening one gives back, and what it publishes while
// a server runs. Bytes cross the channel as base64, since every payload here is JSON.
export type LspSession = { session: string; server: string; root: string };
export type LspData = { session: string; data: string };
export type LspLog = { session: string; text: string };
export type LspExit = { session: string; code?: number };

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
