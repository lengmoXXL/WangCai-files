const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { activeTerminal, agentState, backButton, cleanup, closeTab, closeTabs, closeWorkspace, collectErrors, columnOf, createWorkspace, desktopMain, entry, filesPanels, filesTab, newSidebarTab, openFilesPanel, openFilesTab, openView, openWindow, openWorkspaces, renderedPage, reopen, run, selectedViewTab, selectedWorkspace, shownPanel, sidebarLeft, sidebarRight, sidebarTabs, sidebarToggle, testEnv, until, viewMenu, viewTab, workspaceBar, workspaceTabs, writeInit } = require('./harness.cjs');

test('view menu switches plugins and handles empty and closed terminals', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-sidebar-')));
  const env = testEnv(home);
  let desktop, page;
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
    ({ desktop, window: page } = await openWindow(home, env));
    const errors = [];
    collectErrors(page, errors);
    await workspaceBar(page).waitFor();
    const toggle = sidebarToggle(page);
    await toggle.click();
    const picker = newSidebarTab(page);
    const menu = viewMenu(page);
    const shown = shownPanel(page);
    const tabs = sidebarTabs(page);
    const panels = filesPanels(page);
    const main = desktopMain(page);
    const back = backButton(page);
    const noTerminal = shown.getByText('请选择一个已连接的终端', { exact: true });
    const viewContent = page.getByLabel('视图内容');
    await picker.click();
    await menu.waitFor();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await openFilesTab(page);
    await noTerminal.waitFor();
    assert.equal(await shown.count(), 1);
    await openView(page, '测试视图');
    await viewContent.fill('preserved');
    const lastTab = await tabs.last().boundingBox();
    const plus = await picker.boundingBox();
    const toggleBounds = await toggle.boundingBox();
    assert.ok(plus.x >= lastTab.x + lastTab.width);
    assert.ok(plus.x - lastTab.x - lastTab.width < 10);
    assert.ok(toggleBounds.x > plus.x + plus.width);
    assert.equal(await panels.isVisible(), false);
    assert.equal(await main.locator('[data-plugin=terminal-agent]').isVisible(), true);
    assert.equal(await shown.count(), 1);
    await openFilesTab(page);
    await createWorkspace(page);
    await createWorkspace(page);
    const workspaces = workspaceTabs(page);
    const directory = columnOf(page, home);
    const hidden = entry(directory, '.hidden.md');
    const subdirectory = entry(directory, '子目录 with spaces/');
    const selectedRow = selectedWorkspace(page);
    const selectedTab = selectedViewTab(page);
    const left = sidebarLeft(page);
    const right = sidebarRight(page);
    await workspaces.first().click();
    await hidden.locator('svg[data-kind=file]').waitFor();
    await subdirectory.locator('svg[data-kind=folder]').waitFor();
    assert.equal(await selectedRow.evaluate((element) => getComputedStyle(element).backgroundColor),
      await selectedTab.evaluate((element) => getComputedStyle(element).backgroundColor));
    for (const [element, corners] of [[left, '8px 0px 0px 8px'], [selectedRow, '0px'], [selectedTab, '8px 8px 0px 0px']]) {
      assert.equal(await element.evaluate((element) => getComputedStyle(element).borderRadius), corners);
    }
    // The hairline sits on a pseudo-element, so selecting a row or a tab never moves its icon.
    for (const element of [selectedRow, selectedTab]) {
      assert.deepEqual(await element.evaluate((element) => { const style = getComputedStyle(element, '::after'); return [getComputedStyle(element).outlineWidth, style.borderTopWidth, style.borderTopColor]; }), ['0px', '1px', 'rgb(51, 53, 54)']);
    }
    // The list's own hairline is an overlay, so a row background can never replace that column.
    assert.deepEqual(await left.evaluate((element) => {
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
    // A redraw of the list replaces its rows and takes their focus with them, so every attempt focuses a row
    // again and reads the style at once rather than after an interval a redraw could use.
    await until(async () => (await workspaces.first().evaluate((element) => {
      const style = getComputedStyle(element);
      return [getComputedStyle(element, '::after').borderTopWidth, `${style.outlineWidth} ${style.outlineColor}`];
    })).join() === '1px,2px rgb(57, 148, 188)', {
      attempts: 60, interval: 0,
      // Programmatic focus does not match :focus-visible; keyboard input does.
      act: async () => { await workspaces.first().focus(); await page.keyboard.press('Shift'); },
    });
    // A row drag marks the line it would drop in front of.
    const rowLine = page.locator('.workspace-line').first();
    await workspaces.last().waitFor();
    const fromRow = await workspaces.last().boundingBox();
    await page.mouse.move(fromRow.x + fromRow.width / 2, fromRow.y + fromRow.height / 2);
    await page.mouse.down();
    await rowLine.waitFor();
    const toLine = await rowLine.boundingBox();
    // Native dragover needs a second move after dragstart.
    await page.mouse.move(toLine.x + toLine.width / 2, toLine.y + 0.5, { steps: 6 });
    await page.mouse.move(toLine.x + toLine.width / 2, toLine.y + 0.5);
    await until(() => rowLine.evaluate((element) => element.dataset.drop === 'line'
      && getComputedStyle(element, '::after').backgroundColor === 'rgb(57, 148, 188)'), { attempts: 60, interval: 250 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await until(() => rowLine.evaluate((element) => element.dataset.drop === undefined), { attempts: 60, interval: 250 });

    // A tab drag marks the edge of the tab it would drop beside.
    await tabs.last().waitFor();
    const fromTab = await tabs.last().boundingBox();
    await page.mouse.move(fromTab.x + fromTab.width / 2, fromTab.y + fromTab.height / 2);
    await page.mouse.down();
    await selectedTab.waitFor();
    const toTab = await selectedTab.boundingBox();
    // Native dragover needs a second move after dragstart.
    await page.mouse.move(toTab.x + toTab.width * 0.85, toTab.y + toTab.height * 0.5, { steps: 6 });
    await page.mouse.move(toTab.x + toTab.width * 0.85, toTab.y + toTab.height * 0.5);
    await until(() => selectedTab.evaluate((element) => {
      const hairline = getComputedStyle(element, '::after');
      return getComputedStyle(element).boxShadow.includes('inset')
        && hairline.borderTopWidth === '1px' && hairline.borderRightColor === 'rgba(0, 0, 0, 0)';
    }), { attempts: 60, interval: 250 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await until(() => selectedTab.evaluate((element) => getComputedStyle(element).boxShadow === 'none'), { attempts: 60, interval: 250 });
    await closeWorkspace(workspaces.last());
    await workspaces.nth(1).waitFor({ state: 'detached' });
    // An idle workspace's agent mark draws in the muted colour, not the accent.
    await until(async () => (await agentState(page, 'idle').count()) === 1, { attempts: 60, interval: 250 });
    assert.equal(await agentState(page, 'idle').first().evaluate((element) => getComputedStyle(element).color), 'rgb(139, 152, 166)');
    for (const [pane, label, delta, minimum, shrink] of [
      [left, '调整左侧栏宽度', 60, 120, -600],
      [right, '调整右侧栏宽度', -80, 260, 800],
    ]) {
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
      assert.ok((await main.boundingBox()).width >= 240);
    }
    const measure = async () => ({
      inner: await page.evaluate(() => innerWidth),
      left: (await sidebarLeft(page).boundingBox()).width,
      right: (await sidebarRight(page).boundingBox()).width,
    });
    const beforeResize = await measure();
    await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [width, height] = win.getSize();
      win.setSize(width + 300, height);
    });
    await until(async () => (await sidebarLeft(page).boundingBox()).width > beforeResize.left, { attempts: 60, interval: 250 });
    const afterResize = await measure();
    assert.ok(afterResize.inner > beforeResize.inner);
    assert.ok(Math.abs(afterResize.left / afterResize.inner - beforeResize.left / beforeResize.inner) < 0.01);
    assert.ok(Math.abs(afterResize.right / afterResize.inner - beforeResize.right / beforeResize.inner) < 0.01);
    await closeTab(page, '文件').click();
    assert.equal(await filesTab(page).count(), 0);
    await openFilesTab(page);
    await hidden.click();
    await renderedPage(page, 'Hidden preview').waitFor();
    await back.click();
    await subdirectory.click();
    await entry(columnOf(page, join(home, '子目录 with spaces')), '空 格.md').click();
    await renderedPage(page, 'Nested preview').waitFor();
    await back.click();
    // Stepping up again lands on the directory the tab opened on.
    await back.click();
    await hidden.waitFor();
    await viewTab(page, '测试视图').click();
    assert.equal(await viewContent.inputValue(), 'preserved');
    assert.equal(await directory.isVisible(), false);
    await closeWorkspace(workspaces.filter({ hasText: '~' }));
    await workspaces.waitFor({ state: 'detached' });
    assert.equal(await panels.count(), 0);
    const existing = (await openWorkspaces(page)).map((workspace) => workspace.id);
    const stored = await page.evaluate(() => window.wangcai.call('tabs'));
    assert.deepEqual(stored.filter((record) => record.workspaceId && !existing.includes(record.workspaceId)), []);
    await openFilesPanel(page);
    await noTerminal.waitFor();
    await createWorkspace(page);
    await hidden.waitFor();
    await run(activeTerminal(page), 'exit');
    const restart = page.getByRole('button', { name: '重新打开终端', exact: true });
    await restart.click();
    await restart.waitFor({ state: 'detached' });
    await toggle.click();
    await right.waitFor({ state: 'hidden' });
    await openFilesPanel(page);
    await hidden.waitFor();
    await page.screenshot({ path: 'tests/dist/screenshots/sidebar-layout.png' });
    const closeVisible = closeTabs(page);
    while (await closeVisible.count()) await closeVisible.last().click();
    await right.waitFor({ state: 'hidden' });
    assert.equal(await picker.isVisible(), false);
    assert.equal(await toggle.isVisible(), true);
    await toggle.click();
    await picker.waitFor();
    assert.deepEqual(errors, []);
    const beforeReload = await measure();
    ({ desktop, window: page } = await reopen(desktop, home, env));
    await openFilesPanel(page);
    await sidebarLeft(page).waitFor();
    await sidebarRight(page).waitFor();
    const afterReload = await measure();
    assert.ok(Math.abs(afterReload.inner - beforeReload.inner) < 2);
    assert.ok(Math.abs(afterReload.left - beforeReload.left * afterReload.inner / beforeReload.inner) < 2);
    assert.ok(Math.abs(afterReload.right - beforeReload.right * afterReload.inner / beforeReload.inner) < 2);
  } finally {
    await desktop?.close();
    cleanup(home);
  }
});
