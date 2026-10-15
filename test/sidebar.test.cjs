const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { cleanup, createWorkspace, launchApp, run, testEnv, writeInit } = require('./harness.cjs');

test('view menu switches plugins and handles empty and closed terminals', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-sidebar-')));
  const env = testEnv(home);
  let desktop;
  try {
    const other = join(home, '.local/share/wangcai/plugins/other');
    writeInit(home, { workspaces: ['terminal-agent'], tabs: ['files', { id: 'other', directory: other }] });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'main.cjs'), 'exports.activate = () => {};');
    writeFileSync(join(other, 'ui.js'), `
      export const title = '测试视图';
      export function mount() {}
      export function open(context) { context.host.tabs({ id: 'other', title: '测试视图', mount(container) {
        const input = document.createElement('input');
        input.setAttribute('aria-label', '视图内容');
        container.append(input);
        return { dispose: () => input.remove() };
      } }); }
    `);
    mkdirSync(join(home, '子目录 with spaces'));
    writeFileSync(join(home, '子目录 with spaces', '空 格.md'), '# Nested preview');
    writeFileSync(join(home, '.hidden.md'), '# Hidden preview');
    desktop = await launchApp(home, env);
    let page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.locator('.workspaces').waitFor();
    const toggle = page.getByRole('button', { name: '切换右侧栏' });
    await toggle.click();
    const picker = page.getByRole('button', { name: '新建侧栏标签页' });
    const menu = page.locator('#view-menu');
    const noTerminal = page.locator('.sidebar-panel:visible').getByText('请选择一个已连接的终端', { exact: true });
    await picker.click();
    await menu.waitFor();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await noTerminal.waitFor();
    assert.equal(await page.locator('.sidebar-panel:visible').count(), 1);
    await picker.click();
    await menu.getByRole('button', { name: '测试视图', exact: true }).click();
    await page.getByLabel('视图内容').fill('preserved');
    const lastTab = await page.locator('.sidebar-tab').last().boundingBox();
    const plus = await picker.boundingBox();
    const toggleBounds = await toggle.boundingBox();
    assert.ok(plus.x >= lastTab.x + lastTab.width);
    assert.ok(plus.x - lastTab.x - lastTab.width < 10);
    assert.ok(toggleBounds.x > plus.x + plus.width);
    assert.equal(await page.locator('.sidebar-panel[data-plugin=files]').isVisible(), false);
    assert.equal(await page.locator('.desktop-main [data-plugin=terminal-agent]').isVisible(), true);
    assert.equal(await page.locator('.sidebar-panel:visible').count(), 1);
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await createWorkspace(page);
    await createWorkspace(page);
    const workspaces = page.getByRole('tablist', { name: '工作区' }).getByRole('tab');
    await workspaces.first().click();
    const columnOf = (path) => page.getByRole('navigation', { name: path, exact: true });
    await columnOf(home).getByRole('button', { name: '.hidden.md', exact: true }).locator('svg[data-kind=file]').waitFor();
    await columnOf(home).getByRole('button', { name: '子目录 with spaces/', exact: true }).locator('svg[data-kind=folder]').waitFor();
    assert.equal(await page.locator('.workspace.selected').evaluate((element) => getComputedStyle(element).backgroundColor),
      await page.locator('.sidebar-tab:has([aria-selected=true])').first().evaluate((element) => getComputedStyle(element).backgroundColor));
    for (const [selector, corners] of [['.sidebar-left', '8px 0px 0px 8px'], ['.workspace.selected', '0px'], ['.sidebar-tab:has([aria-selected=true])', '8px 8px 0px 0px']]) {
      assert.equal(await page.locator(selector).first().evaluate((element) => getComputedStyle(element).borderRadius), corners);
    }
    // The hairline sits on a pseudo-element, so selecting a row or a tab never moves its icon.
    for (const selector of ['.workspace.selected', '.sidebar-tab:has([aria-selected=true])']) {
      assert.deepEqual(await page.locator(selector).first().evaluate((element) => { const style = getComputedStyle(element, '::after'); return [getComputedStyle(element).outlineWidth, style.borderTopWidth, style.borderTopColor]; }), ['0px', '1px', 'rgb(51, 53, 54)']);
    }
    // The list's own hairline is an overlay, so a row background can never replace that column.
    assert.deepEqual(await page.locator('.sidebar-left').evaluate((element) => {
      const hairline = getComputedStyle(element, '::after');
      return [getComputedStyle(element).boxShadow, hairline.position, hairline.right, hairline.width, hairline.backgroundColor, hairline.pointerEvents];
    }), ['none', 'absolute', '0px', '1px', 'rgb(51, 53, 54)', 'none']);
    assert.deepEqual(await page.evaluate(async () => {
      const nav = document.querySelector('.sidebar-left .workspaces');
      const pane = document.querySelector('.sidebar-left');
      nav.style.flex = 'none';
      nav.style.height = '8px';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const overflowing = nav.scrollHeight > nav.clientHeight;
      const flush = Math.round(nav.querySelector('.workspace').getBoundingClientRect().right) === Math.round(pane.getBoundingClientRect().right);
      const full = nav.clientWidth === nav.offsetWidth;
      nav.style.cssText = '';
      return [overflowing, full, flush];
    }), [true, true, true]);
    // Keyboard input is needed for :focus-visible after programmatic focus.
    await workspaces.first().focus();
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await workspaces.first().evaluate((element) => {
      const style = getComputedStyle(element);
      return [getComputedStyle(element, '::after').borderTopWidth, `${style.outlineWidth} ${style.outlineColor}`];
    }), ['1px', '2px rgb(57, 148, 188)']);
    for (const [source, selector, x, y, edge] of [
      [workspaces.last(), '.workspace.selected', 0.5, 0.85, 'borderBottomColor'],
      [page.locator('.sidebar-tab').last(), '.sidebar-tab:has([aria-selected=true])', 0.85, 0.5, 'borderRightColor'],
    ]) {
      await source.waitFor();
      const from = await source.boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      const target = page.locator(selector).first();
      await target.waitFor();
      const to = await target.boundingBox();
      await page.mouse.move(to.x + to.width * x, to.y + to.height * y, { steps: 6 });
      // Native dragover needs a second move after dragstart.
      await page.mouse.move(to.x + to.width * x, to.y + to.height * y);
      await page.waitForFunction((selector) => getComputedStyle(document.querySelector(selector)).boxShadow.includes('inset'), selector);
      assert.deepEqual(await target.evaluate((element, edge) => {
        const hairline = getComputedStyle(element, '::after');
        return [hairline.borderTopWidth, getComputedStyle(element).boxShadow.includes('inset'), hairline[edge]];
      }, edge), ['1px', true, 'rgba(0, 0, 0, 0)']);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.waitForFunction((selector) => getComputedStyle(document.querySelector(selector)).boxShadow === 'none', selector);
    }
    await workspaces.last().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '关闭工作区', exact: true }).click();
    await workspaces.nth(1).waitFor({ state: 'detached' });
    // A running workspace's glyph shows state by lightness: it draws in the foreground colour, not the accent.
    assert.equal(await page.locator('.workspace.running .glyph').first().evaluate((element) => getComputedStyle(element).stroke), 'rgb(220, 227, 235)');
    for (const [side, label, delta, minimum, shrink] of [
      ['left', '调整左侧栏宽度', 60, 120, -600],
      ['right', '调整右侧栏宽度', -80, 260, 800],
    ]) {
      const pane = page.locator(`.sidebar-${side}`);
      const handle = page.getByRole('separator', { name: label });
      await pane.waitFor();
      const before = (await pane.boundingBox()).width;
      await handle.waitFor();
      let box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + delta, box.y + 100, { steps: 5 });
      await page.mouse.up();
      assert.ok(Math.abs((await pane.boundingBox()).width - before - Math.abs(delta)) < 2);
      box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + shrink, box.y + 100, { steps: 5 });
      await page.mouse.up();
      assert.equal(Math.round((await pane.boundingBox()).width), minimum);
      assert.ok((await page.locator('.desktop-main').boundingBox()).width >= 240);
    }
    const measure = () => page.evaluate(() => ({ inner: innerWidth, left: document.querySelector('.sidebar-left').getBoundingClientRect().width, right: document.querySelector('.sidebar-right').getBoundingClientRect().width }));
    const beforeResize = await measure();
    await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [width, height] = win.getSize();
      win.setSize(width + 300, height);
    });
    await page.waitForFunction((left) => document.querySelector('.sidebar-left').getBoundingClientRect().width > left, beforeResize.left);
    const afterResize = await measure();
    assert.ok(afterResize.inner > beforeResize.inner);
    assert.ok(Math.abs(afterResize.left / afterResize.inner - beforeResize.left / beforeResize.inner) < 0.01);
    assert.ok(Math.abs(afterResize.right / afterResize.inner - beforeResize.right / beforeResize.inner) < 0.01);
    await page.getByRole('button', { name: '关闭 文件', exact: true }).click();
    assert.equal(await page.getByRole('tab', { name: '文件', exact: true }).count(), 0);
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await columnOf(home).getByRole('button', { name: '.hidden.md', exact: true }).click();
    await page.getByRole('heading', { name: 'Hidden preview' }).waitFor();
    await page.getByRole('button', { name: '后退', exact: true }).click();
    await columnOf(home).getByRole('button', { name: '子目录 with spaces/', exact: true }).click();
    await columnOf(join(home, '子目录 with spaces')).getByRole('button', { name: '空 格.md', exact: true }).click();
    await page.getByRole('heading', { name: 'Nested preview' }).waitFor();
    await page.getByRole('button', { name: '后退', exact: true }).click();
    // Stepping up again lands on the directory the tab opened on.
    await page.getByRole('button', { name: '后退', exact: true }).click();
    await columnOf(home).getByRole('button', { name: '.hidden.md', exact: true }).waitFor();
    await page.getByRole('tab', { name: '测试视图', exact: true }).click();
    assert.equal(await page.getByLabel('视图内容').inputValue(), 'preserved');
    assert.equal(await columnOf(home).isVisible(), false);
    await page.getByRole('tab', { name: '~' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '关闭工作区', exact: true }).click();
    await page.getByRole('tablist', { name: '工作区' }).getByRole('tab').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.sidebar-panel[data-plugin=files]').count(), 0);
    const existing = await page.evaluate(async () => (await window.wangcai.request('terminal-agent', 'config')).workspaces.map((workspace) => workspace.id));
    const stored = await page.evaluate(() => window.wangcai.loadTabs());
    assert.deepEqual(stored.filter((record) => record.workspaceId && !existing.includes(record.workspaceId)), []);
    if (!(await page.locator('.sidebar-right').isVisible())) await toggle.click();
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await noTerminal.waitFor();
    await createWorkspace(page);
    await columnOf(home).getByRole('button', { name: '.hidden.md', exact: true }).waitFor();
    await run(page, 'exit');
    const restart = page.getByRole('button', { name: '重新打开终端', exact: true });
    await restart.waitFor();
    await restart.click();
    await restart.waitFor({ state: 'detached' });
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('.sidebar-right').hidden);
    await toggle.click();
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await columnOf(home).getByRole('button', { name: '.hidden.md', exact: true }).waitFor();
    await page.screenshot({ path: 'tests/dist/screenshots/sidebar-layout.png' });
    const closeVisible = page.locator('.sidebar-tab:visible .close-tab');
    while (await closeVisible.count()) await closeVisible.last().click();
    await page.locator('.sidebar-right').waitFor({ state: 'hidden' });
    assert.equal(await picker.isVisible(), false);
    assert.equal(await toggle.isVisible(), true);
    await toggle.click();
    await picker.waitFor();
    assert.deepEqual(errors, []);
    const beforeReload = await measure();
    await desktop.close(); desktop = undefined;
    desktop = await launchApp(home, env);
    page = await desktop.firstWindow();
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    const left = page.locator('.sidebar-left');
    const right = page.locator('.sidebar-right');
    await left.waitFor();
    await right.waitFor();
    const inner = await page.evaluate(() => innerWidth);
    assert.ok(Math.abs(inner - beforeReload.inner) < 2);
    assert.ok(Math.abs((await left.boundingBox()).width - beforeReload.left * inner / beforeReload.inner) < 2);
    assert.ok(Math.abs((await right.boundingBox()).width - beforeReload.right * inner / beforeReload.inner) < 2);
  } finally {
    await desktop?.close();
    cleanup(home);
  }
});
