const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withWindow } = require('@lengmoxxl/wangcai-testkit');
const { codeView, goToPath, lists, openFilesWorkspace, search, searchDetail, searchPanel, searchRow, searchTitle } = require('./files-ui.cjs');

test('the symbol list is the outline of the file: its declarations and their members, never a local', { timeout: 120000 }, () => withWindow('wangcai-files-outline', lists, async ({ home, page }) => {
  const file = join(home, 'shapes.ts');
  writeFileSync(join(home, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
  writeFileSync(file, [
    'export interface Shape {',
    '  area(): number;',
    '  name: string;',
    '}',
    '',
    'export class Square implements Shape {',
    '  name = "square";',
    '  size = 2;',
    '  area() {',
    '    const insideMethod = this.size * this.size;',
    '    return insideMethod;',
    '  }',
    '}',
    '',
    'export const triangle = 3;',
    '',
    'export function helper() {',
    '  const insideFunction = 1;',
    '  function nested() { return insideFunction; }',
    '  return nested();',
    '}',
    '',
  ].join('\n'));
  await openFilesWorkspace(page);
  await goToPath(page, file);
  await codeView(page, 'helper').waitFor();
  await search(page, '@');
  const names = await searchTitle(searchPanel(page)).allInnerTexts();
  // What the file declares, and the members of the types it declares.
  for (const name of ['Shape', 'Square', 'area', 'name', 'size', 'triangle', 'helper']) assert.ok(names.includes(name), `${name} is missing from ${JSON.stringify(names)}`);
  // What a body declares is a local, which an outline does not list.
  for (const local of ['insideMethod', 'insideFunction', 'nested']) assert.ok(!names.includes(local), `${local} is a local, not a declaration`);
  // A member is listed under the type it belongs to.
  assert.equal(await searchDetail(searchRow(page, 'size')).textContent(), 'Square');
}));
