const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { activeTerminal, createWorkspace, openView, until, withHome } = require('@lengmoxxl/wangcai-testkit');
const { backButton, boxOf, closeTab, closeWorkspace, collectErrors, columnOf, desktopMain, drawnCloseButtons, entry, filesPanels, filesTab, newSidebarTab, openWorkspaces, renderedInMarkdown, runIn, selectedViewTab, shownPanel, sidebarLeft, sidebarRight, sidebarTabs, sidebarToggle, viewMenu, viewTab, workspaceBar, workspaceTabs } = require('./files-ui.cjs');

test('view menu switches plugins and handles empty and closed terminals', { timeout: 180000 }, () => {
  // A plugin of the case's own, which draws a view the sidebar can be switched to.
  const other = mkdtempSync(join(tmpdir(), 'wangcai-sidebar-other-'));
  return withHome('wangcai-sidebar', { workspaces: ['terminal-agent'], tabs: ['files', { id: 'other', directory: other }] }, async ({ home, open }) => {
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
    let { desktop, page, close } = await open();
    const errors = [];
    collectErrors(page, errors);
    await workspaceBar(page).waitFor();
    const toggle = sidebarToggle(page);
    await toggle.click();
    const picker = newSidebarTab(page);
    const menu = viewMenu(page);
    const shown = shownPanel(page);
    const panels = filesPanels(page);
    const main = desktopMain(page);
    const back = backButton(page);
    const noTerminal = shown.getByText('请选择一个已连接的终端', { exact: true });
    const viewContent = page.getByLabel('视图内容');
    await picker.click();
    await menu.waitFor();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await openView(page, '文件');
    await noTerminal.waitFor();
    assert.equal(await shown.count(), 1);
    await openView(page, '测试视图');
    await viewContent.fill('preserved');
    const lastTabBox = await sidebarTabs(page).last().boundingBox();
    const plusBox = await picker.boundingBox();
    const toggleBox = await toggle.boundingBox();
    assert.ok(plusBox.x >= lastTabBox.x + lastTabBox.width);
    assert.ok(plusBox.x - lastTabBox.x - lastTabBox.width < 10);
    assert.ok(toggleBox.x > plusBox.x + plusBox.width);
    assert.ok(await panels.isHidden());
    assert.ok(await main.locator('[data-plugin=terminal-agent]').isVisible());
    assert.equal(await shown.count(), 1);
    await openView(page, '文件');
    await createWorkspace(page);
    await createWorkspace(page);
    const workspaces = workspaceTabs(page);
    const directory = columnOf(page, home);
    const hiddenFile = entry(directory, '.hidden.md');
    const subdirectoryEntry = entry(directory, '子目录 with spaces/');
    // Native dragover needs a second move after dragstart, so a drag onto a point moves there twice.
    const moveTwice = async (x, y) => {
      await page.mouse.move(x, y, { steps: 6 });
      await page.mouse.move(x, y);
    };
    const selectedTab = selectedViewTab(page);
    const left = sidebarLeft(page);
    const right = sidebarRight(page);
    await workspaces.first().click();
    await hiddenFile.locator('svg[data-kind=file]').waitFor();
    await subdirectoryEntry.locator('svg[data-kind=folder]').waitFor();
    // A redraw replaces rows as it runs, and a replaced row has no style left to read, so every style this part is
    // about is read in one go, again until the window draws the cards: the row the list shows selected, its tab, and
    // the bar the two sit in.
    const cards = () => page.evaluate(() => {
      const row = document.querySelector('.workspace.selected');
      const tab = document.querySelector('.sidebar-tab:has([aria-selected=true])');
      const leftBar = document.querySelector('.sidebar-left');
      if (!row || !tab || !leftBar) return null;
      const hairline = getComputedStyle(tab, '::after');
      return {
        row: [getComputedStyle(row).backgroundColor, getComputedStyle(row).borderRadius, getComputedStyle(row).boxShadow],
        tab: [getComputedStyle(tab).backgroundColor, getComputedStyle(tab).borderRadius, getComputedStyle(tab).outlineWidth, hairline.borderTopWidth, hairline.borderTopColor],
        leftRadius: getComputedStyle(leftBar).borderRadius,
      };
    });
    let drawn;
    // The hairline sits on a shadow or a pseudo-element, so selecting a row or a tab never moves its icon.
    await until(async () => (drawn = await cards()) !== null && drawn.row[2] === 'rgb(51, 53, 54) 0px 0px 0px 1px inset');
    assert.equal(drawn.row[0], drawn.tab[0]);
    assert.deepEqual([drawn.leftRadius, drawn.row[1], drawn.tab[1]], ['8px 0px 0px 8px', '0px', '8px 8px 0px 0px']);
    assert.deepEqual(drawn.tab.slice(2), ['0px', '1px', 'rgb(51, 53, 54)']);
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
      // A row stops one pixel short of the pane, which leaves that column to the hairline.
      const inset = Math.round(pane.getBoundingClientRect().right - nav.querySelector('.workspace').getBoundingClientRect().right) === 1;
      const full = nav.clientWidth === nav.offsetWidth;
      nav.style.cssText = '';
      return [overflowing, full, inset];
    }), [true, true, true]);
    // A redraw of the list replaces its rows and takes their focus with them, so each round focuses a row
    // again and reads the style at once rather than after an interval a redraw could use.
    await until(async () => (await workspaces.first().evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.outlineWidth} ${style.outlineColor}`;
    })) === '2px rgb(57, 148, 188)', {
      interval: 0,
      // Programmatic focus does not match :focus-visible; keyboard input does.
      act: async () => { await workspaces.first().focus(); await page.keyboard.press('Shift'); },
    });
    // A row drag marks the line it would drop in front of.
    const rowLine = page.locator('.workspace-line').first();
    await workspaces.last().waitFor();
    const fromRowBox = await boxOf(workspaces.last());
    await page.mouse.move(fromRowBox.x + fromRowBox.width / 2, fromRowBox.y + fromRowBox.height / 2);
    await page.mouse.down();
    await rowLine.waitFor();
    const toLineBox = await boxOf(rowLine);
    const onLine = { x: toLineBox.x + toLineBox.width / 2, y: toLineBox.y + 0.5 };
    await moveTwice(onLine.x, onLine.y);
    await until(() => rowLine.evaluate((element) => element.dataset.drop === 'line'
      && getComputedStyle(element, '::after').backgroundColor === 'rgb(57, 148, 188)'), {
      // A pointer that arrived while the list was still drawing leaves the line unmarked, so it is moved again.
      act: () => page.mouse.move(onLine.x, onLine.y),
    });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await until(() => rowLine.evaluate((element) => element.dataset.drop === undefined));

    // A tab drag marks the edge of the tab it would drop beside.
    const fromTabBox = await boxOf(sidebarTabs(page).last());
    await page.mouse.move(fromTabBox.x + fromTabBox.width / 2, fromTabBox.y + fromTabBox.height / 2);
    await page.mouse.down();
    await selectedTab.waitFor();
    const toTabBox = await boxOf(selectedTab);
    await moveTwice(toTabBox.x + toTabBox.width * 0.85, toTabBox.y + toTabBox.height * 0.5);
    await until(() => selectedTab.evaluate((element) => {
      const hairline = getComputedStyle(element, '::after');
      return getComputedStyle(element).boxShadow.includes('inset')
        && hairline.borderTopWidth === '1px' && hairline.borderRightColor === 'rgba(0, 0, 0, 0)';
    }));
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await until(() => selectedTab.evaluate((element) => getComputedStyle(element).boxShadow === 'none'));
    await closeWorkspace(workspaces.last());
    await workspaces.nth(1).waitFor({ state: 'detached' });
    // The row that is left draws an idle state, which is a glyph without the sweep or the finish the others carry.
    const idle = workspaces.and(page.locator('[data-state=idle]'));
    await until(async () => (await idle.count()) === 1);
    assert.match(await idle.getAttribute('aria-label'), /空闲$/);
    for (const [pane, label, delta, minimum, shrink] of [
      [left, '调整左侧栏宽度', 60, 120, -600],
      [right, '调整右侧栏宽度', -80, 260, 800],
    ]) {
      const handle = page.getByRole('separator', { name: label });
      await pane.waitFor();
      const paneWidthBefore = (await pane.boundingBox()).width;
      await handle.waitFor();
      let handleBox = await handle.boundingBox();
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 100);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 + delta, handleBox.y + 100, { steps: 5 });
      await page.mouse.up();
      assert.ok(Math.abs((await pane.boundingBox()).width - paneWidthBefore - Math.abs(delta)) < 2);
      handleBox = await handle.boundingBox();
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 100);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 + shrink, handleBox.y + 100, { steps: 5 });
      await page.mouse.up();
      assert.equal(Math.round((await pane.boundingBox()).width), minimum);
      assert.ok((await main.boundingBox()).width >= 240);
    }
    // Read off the window that is open now: a case that reopens the window measures the new one.
    const measure = async () => ({
      innerWidth: await page.evaluate(() => innerWidth),
      leftWidth: (await sidebarLeft(page).boundingBox()).width,
      rightWidth: (await sidebarRight(page).boundingBox()).width,
    });
    const beforeResize = await measure();
    await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [width, height] = win.getSize();
      win.setSize(width + 300, height);
    });
    await until(async () => (await sidebarLeft(page).boundingBox()).width > beforeResize.leftWidth);
    const afterResize = await measure();
    assert.ok(afterResize.innerWidth > beforeResize.innerWidth);
    assert.ok(Math.abs(afterResize.leftWidth / afterResize.innerWidth - beforeResize.leftWidth / beforeResize.innerWidth) < 0.01);
    assert.ok(Math.abs(afterResize.rightWidth / afterResize.innerWidth - beforeResize.rightWidth / beforeResize.innerWidth) < 0.01);
    await closeTab(page, '文件').click();
    assert.equal(await filesTab(page).count(), 0);
    await openView(page, '文件');
    await hiddenFile.click();
    await renderedInMarkdown(shownPanel(page), 'Hidden preview');
    await back.click();
    await subdirectoryEntry.click();
    await entry(columnOf(page, join(home, '子目录 with spaces')), '空 格.md').click();
    await renderedInMarkdown(shownPanel(page), 'Nested preview');
    await back.click();
    // Stepping up again lands on the directory the tab opened on.
    await back.click();
    await hiddenFile.waitFor();
    await viewTab(page, '测试视图').click();
    assert.equal(await viewContent.inputValue(), 'preserved');
    assert.ok(await directory.isHidden());
    await closeWorkspace(workspaces.filter({ hasText: '~' }));
    await workspaces.waitFor({ state: 'detached' });
    assert.equal(await panels.count(), 0);
    const existing = (await openWorkspaces(page)).map((workspace) => workspace.id);
    const storedTabs = await page.evaluate(() => window.wangcai.call('tabs'));
    assert.deepEqual(storedTabs.filter((record) => record.workspaceId && !existing.includes(record.workspaceId)), []);
    await openView(page, '文件');
    await noTerminal.waitFor();
    await createWorkspace(page);
    await hiddenFile.waitFor();
    await runIn(activeTerminal(page), 'exit');
    const restart = page.getByRole('button', { name: '重新打开终端', exact: true });
    await restart.click();
    await restart.waitFor({ state: 'detached' });
    await toggle.click();
    await right.waitFor({ state: 'hidden' });
    await openView(page, '文件');
    await hiddenFile.waitFor();
    await page.screenshot({ path: 'test/output/screenshots/sidebar-layout.png' });
    while (await drawnCloseButtons(page).count()) await drawnCloseButtons(page).last().click();
    await right.waitFor({ state: 'hidden' });
    assert.ok(await picker.isHidden());
    assert.ok(await toggle.isVisible());
    await toggle.click();
    await picker.waitFor();
    assert.deepEqual(errors, []);
    const beforeReload = await measure();
    await close();
    ({ page, close } = await open());
    collectErrors(page, errors);
    await openView(page, '文件');
    await sidebarLeft(page).waitFor();
    await sidebarRight(page).waitFor();
    const afterReload = await measure();
    assert.ok(Math.abs(afterReload.innerWidth - beforeReload.innerWidth) < 2);
    assert.ok(Math.abs(afterReload.leftWidth - beforeReload.leftWidth * afterReload.innerWidth / beforeReload.innerWidth) < 2);
    assert.ok(Math.abs(afterReload.rightWidth - beforeReload.rightWidth * afterReload.innerWidth / beforeReload.innerWidth) < 2);
    assert.deepEqual(errors, []);
  }).finally(() => rmSync(other, { recursive: true, force: true }));
});
