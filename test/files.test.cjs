const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync, realpathSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { activeTerminal, backButton, cleanup, clickFile, closeTabs, codeView, collectErrors, columnOf, columns, createWorkspace, desktopMain, editorLines, emptyDirectory, entry, filePicker, filePreview, filesPanel, filesPanels, filesTab, forwardButton, goToPath, goToPathEntry, markdownDivider, markdownPage, markdownPane, markdownScroll, modeButton, newSidebarTab, openFilesPanel, openFilesTab, openWindow, openWorkspaces, pathBox, previewMenu, previewMode, previewModes, refreshButton, renderedPage, reopen, run, shownPanel, sidebarRight, sidebarToggle, storedHistory, terminalRow, terminalUp, testEnv, until, viewMenu, viewTabs, waitForPath, wangcaiApp, workspaceBar, workspaceTabs, writeInit } = require('./harness.cjs');

const app = wangcaiApp();

test('view picker browses current terminal directory; file links preview code, Markdown, HTML and images', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-files-')));
  const env = testEnv(home);
  let desktop, page;
  let devServer;
  try {
    writeInit(home);
    const code = join(home, 'sample.ts');
    const markdown = join(home, '说明 file.md');
    const binary = join(home, 'binary.bin');
    const html = join(home, 'page.html');
    const image = join(home, 'photo.png');
    const json = join(home, 'settings.json');
    const subdirectory = join(home, 'sub');
    const wide = 'const wide = "' + 'wide code block '.repeat(80) + '";';
    writeFileSync(json, '{"ready":true}');
    writeFileSync(code, 'const first = 1;\nconst second = "CODE_PREVIEW";\n');
    writeFileSync(markdown, '---\nname: sample-skill\ndescription: A frontmatter description that is long enough to wrap inside the metadata panel\nallowed-tools: Read, Grep\nhomepage: https://example.com/sample-skill\n---\n\n# Markdown preview\n\n**Rendered content**\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n```ts\n' + wide + '\n```\n\n' + 'A body line tall enough for the pane to scroll.\n\n'.repeat(40) + '<script>window.previewScriptRan = true</script>');
    writeFileSync(html, '<!doctype html>\n<!-- HTML_SOURCE -->\n<h1 id="heading">Rendered page</h1>\n<script>document.getElementById("heading").dataset.scripted = "yes"</script>\n');
    writeFileSync(binary, Buffer.from([0, 1, 255, 2]));
    writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
    ({ desktop, window: page } = await openWindow(home, env));
    const errors = [];
    collectErrors(page, errors);
    await page.evaluate(() => { window.linkClicks = []; window.wangcai.subscribe('onclick', (payload) => window.linkClicks.push(payload)); });
    await createWorkspace(page);
    const sessionId = (await openWorkspaces(page))[0].sessionId;
    // A wide or differently styled character gets a span of its own, so the text is looked for one
    // node at a time and the first character of the link is enough for the point.
    const firstChar = (row, label) => row.evaluate((element, label) => {
      const nodes = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node; node = walker.nextNode();) nodes.push(node);
      const pointAt = (node, index) => {
        const range = document.createRange();
        range.setStart(node, index); range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      };
      for (const node of nodes) {
        const index = node.textContent.indexOf(label);
        if (index >= 0) return pointAt(node, index);
      }
      for (const node of nodes) {
        const index = node.textContent.indexOf(label[0]);
        if (index >= 0) return pointAt(node, index);
      }
      throw new Error('Link text not found');
    }, label);
    const cursor = page.locator('.xterm-cursor-pointer');
    const clickPoint = async (point) => {
      // Away from every link first, so the cursor belongs to this hover and not to the last one.
      await page.mouse.move(500, 500);
      await until(async () => (await cursor.count()) === 0, { attempts: 60, interval: 250 });
      await page.evaluate(() => { window.linkClicks = []; });
      // Command is what shows a terminal link and what opens it, so it is held across the hover and the click.
      await page.keyboard.down('Meta');
      // The line is answered after the plugin looks its paths up, so the hover is repeated until the cursor shows.
      await until(() => cursor.isVisible(), {
        act: () => page.mouse.move(point.x, point.y), attempts: 60, interval: 250,
      });
      await page.mouse.click(point.x, point.y);
      await page.keyboard.up('Meta');
    };
    const terminal = activeTerminal(page);
    const printLine = (text, cwd = home) => run(terminal, `cd '${cwd}'; printf '\\033[2J\\033[H%b\\n' '${text}'`);
    const clickLink = async (link, { label = link, cwd = home, anchor = label } = {}) => {
      const output = label === link ? link : `\\033]8;;${link}\\007${label}\\033]8;;\\007`;
      await printLine(output, cwd);
      const row = terminalRow(terminal, label);
      // A command typed while the shell is busy is lost, so the line is printed again until it is the row on show.
      await until(async () => (await row.count()) > 0 && (await row.textContent()).trim() === label, {
        act: () => printLine(output, cwd), attempts: 60, interval: 250,
      });
      await clickPoint(await firstChar(row, anchor));
    };
    const clickCount = () => page.evaluate(() => window.linkClicks.length);
    const lastClick = async () => {
      // The click crosses the plugin channel, so wait for its answer instead of the last one.
      await page.waitForFunction(() => window.linkClicks.length > 0);
      const { type, path, line, column } = await page.evaluate(() => window.linkClicks.at(-1));
      return { type, path, line, column };
    };
    const right = sidebarRight(page);
    assert.equal(await right.isVisible(), false);
    await openFilesPanel(page);
    const address = pathBox(page);
    const panel = filesPanel(page);
    const back = backButton(page);
    const forward = forwardButton(page);
    const refresh = refreshButton(page);
    const directory = columnOf(page, home);
    const shownColumns = columns(page);
    const tabs = viewTabs(page);
    const sample = entry(directory, 'sample.ts');
    const refreshFile = entry(directory, 'refresh.md');
    const preview = codeView(panel, 'CODE_PREVIEW');
    const lines = editorLines(panel);
    const article = markdownPage(panel);
    const mode = modeButton(panel);
    const scroller = markdownScroll(panel);
    const pane = markdownPane(panel);
    const dividerLine = markdownDivider(panel);
    const markdownSource = codeView(panel, '# Markdown preview');
    const copy = page.locator('.markdown-code-copy');
    const codeSpans = page.locator('.markdown-code-body span');
    const renderedMarkdown = renderedPage(page, 'Markdown preview');
    const empty = emptyDirectory(page);
    const previewSection = filePreview(page);
    const toggle = sidebarToggle(page);
    const alert = page.getByRole('alert');
    await sample.waitFor();
    assert.equal(await shownColumns.count(), 1, 'the picker starts at the workspace directory');
    assert.deepEqual(await shownColumns.evaluate((column) => {
      const pane = column.parentElement.getBoundingClientRect();
      return [Math.round(column.getBoundingClientRect().left - pane.left), column.parentElement.scrollLeft];
    }), [0, 0], 'the leftmost column is aligned with the pane');
    assert.equal(await address.inputValue(), home);
    assert.equal(await back.isDisabled(), true);
    assert.equal(await forward.isDisabled(), true);
    writeFileSync(join(home, 'refresh.md'), '# Refreshed directory');
    await refresh.click();
    await refreshFile.waitFor();
    assert.equal(await back.isDisabled(), true);
    assert.equal(await forward.isDisabled(), true);
    await sample.click();
    await preview.waitFor();
    // The path above the file opens the picker, and the file it was opened from comes back marked.
    await address.click();
    await sample.waitFor();
    assert.equal(await sample.getAttribute('aria-current'), 'true');
    assert.equal(await page.locator('.monaco-editor').count(), 0);
    await sample.click();
    await preview.waitFor();
    assert.equal(await tabs.count(), 1);
    writeFileSync(code, 'const first = 1;\nconst second = "CODE_PREVIEW";\nconst refreshed = true;\n');
    await refresh.click();
    await codeView(panel, 'refreshed').waitFor();
    await back.click();
    await sample.waitFor();
    assert.equal(await back.isDisabled(), true);
    assert.equal(await forward.isDisabled(), false);
    await refresh.click();
    await refreshFile.waitFor();
    assert.equal(await back.isDisabled(), true);
    assert.equal(await forward.isDisabled(), false);
    await forward.click();
    await preview.waitFor();
    assert.equal(await address.inputValue(), code);
    await goToPath(page, 'missing.ts');
    await alert.filter({ hasText: '路径不存在' }).waitFor();
    await address.press('Escape');
    assert.equal(await address.inputValue(), code);
    assert.equal(await filePicker(page).locator('.file-message[role=alert]').count(), 0);
    await goToPath(page, './sample.ts');
    await waitForPath(page, code);
    await preview.waitFor();
    await toggle.click();
    await clickLink(`${code}:2:3`);
    await previewSection.waitFor();
    assert.equal(await address.inputValue(), code);
    assert.equal(await mode.count(), 0);
    assert.equal(await panel.locator('.preview-header').evaluate((element) => getComputedStyle(element).fontSize), '12px');
    assert.equal(await lines.evaluate((element) => getComputedStyle(element).fontSize), '12px');
    await page.screenshot({ path: 'tests/dist/screenshots/files-code.png' });
    assert.equal(await previewSection.locator('.monaco-editor').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(18, 19, 20)');
    await preview.waitFor();
    const workerReady = page.waitForEvent('worker');
    await page.evaluate(() => { window.MonacoEnvironment.getWorker('', 'editorWorkerService'); });
    const worker = await workerReady;
    assert.equal(await Promise.race([worker.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        if (typeof self.onmessage === 'function') return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    }), new Promise((_, reject) => setTimeout(() => reject(new Error('Preview worker failed to initialize')), 10000))]), true);
    const beforeEdit = await lines.innerText();
    await lines.click();
    await page.keyboard.type('SHOULD_NOT_EDIT');
    assert.equal(await lines.innerText(), beforeEdit);
    const terminalBounds = await desktopMain(page).boundingBox();
    const fileBounds = await right.boundingBox();
    assert.ok(fileBounds.x >= terminalBounds.x + terminalBounds.width);
    mkdirSync(subdirectory);
    await clickLink('../sample.ts:2:3', { cwd: subdirectory });
    assert.equal(await tabs.count(), 1);
    await preview.waitFor();
    await clickLink(pathToFileURL(markdown).href, { label: 'MARKDOWN_LINK' });
    await renderedMarkdown.waitFor();
    assert.equal(await article.locator('strong').innerText(), 'Rendered content');
    assert.equal(await article.locator('table').count(), 1);
    const meta = article.locator('.markdown-meta');
    const values = meta.locator('dd');
    assert.deepEqual(await meta.locator('dt').allInnerTexts(), ['name', 'description', 'allowed-tools', 'homepage']);
    assert.equal(await values.first().innerText(), 'sample-skill');
    assert.equal(await values.last().innerText(), 'https://example.com/sample-skill');
    assert.equal(await article.locator('hr, h2').count(), 0);
    assert.equal(await page.evaluate(() => window.previewScriptRan), undefined);
    assert.equal(await page.locator('.markdown-code-head span').innerText(), 'ts');
    // Monaco tokenizes the fence after the text is painted, so the colors arrive a tick later.
    await codeSpans.first().waitFor();
    // Monaco colors with the editor's theme, so a highlighted keyword takes the palette's keyword color.
    assert.equal(await codeSpans.evaluateAll((spans) => {
      const keyword = spans.find((span) => span.textContent === 'const');
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--wc-magenta');
      document.body.append(probe);
      const magenta = getComputedStyle(probe).color;
      probe.remove();
      return keyword ? getComputedStyle(keyword).color === magenta : false;
    }), true, 'a fenced block is highlighted');
    await copy.click();
    await copy.filter({ hasText: '已复制' }).waitFor();
    assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), wide);
    assert.equal(await address.inputValue(), markdown);
    assert.deepEqual(await previewModes(panel), ['文本', 'Markdown 预览']);
    await page.screenshot({ path: 'tests/dist/screenshots/files-modes.png' });
    await page.locator('.menu-backdrop').click();
    assert.equal(await previewMenu(panel).count(), 0);
    assert.equal(await mode.evaluate((element) => getComputedStyle(element).fontSize), '12px');
    assert.equal(await article.evaluate((element) => getComputedStyle(element).fontSize), '13px');
    await previewMode(panel, '文本');
    assert.equal(await lines.evaluate((element) => getComputedStyle(element).fontSize), '12px');
    await markdownSource.waitFor();
    await refresh.click();
    await markdownSource.waitFor();
    assert.equal(await mode.innerText(), '文本');
    await previewMode(panel, 'Markdown 预览');
    await renderedMarkdown.waitFor();
    // Hovering the sidebar reveals its scrollbar thumbs, so park the pointer before asserting idle panels hide theirs.
    await page.mouse.move(0, 0);
    for (const [element, size] of [[article, ['10px', '12px']], [scroller, ['6px', '6px']]]) {
      assert.deepEqual(await element.evaluate((element) => {
        const bar = getComputedStyle(element, '::-webkit-scrollbar');
        const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb');
        return [bar.width, bar.height, thumb.backgroundColor, thumb.borderRadius,
          getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor,
          getComputedStyle(element, '::-webkit-scrollbar-button').display];
      }), [...size, 'rgba(0, 0, 0, 0)', '0px', 'rgba(0, 0, 0, 0)', 'none']);
    }
    const thumb = await scroller.evaluate(async (element) => {
      element.scrollLeft = 40;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor;
    });
    assert.equal(thumb, 'rgba(121, 121, 121, 0.4)', 'a scrolling panel shows its scrollbar');
    await until(() => scroller.evaluate((element) => getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor === 'rgba(0, 0, 0, 0)'), { attempts: 60, interval: 250 });
    assert.equal(await scroller.evaluate(element => element.scrollWidth > element.clientWidth), true);

    // The pane scrolls rather than the page, so the scrollbar sits at the panel's right edge instead of at the divider.
    assert.deepEqual([
      ...await pane.evaluate((element) => [element.scrollHeight > element.clientHeight, element.clientWidth < element.offsetWidth]),
      await article.evaluate((element) => element.clientWidth === element.offsetWidth),
    ], [true, true, true]);
    assert.deepEqual(await page.evaluate(async () => {
      const strip = document.querySelector('.sidebar-tabs');
      strip.style.width = '20px';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const overflow = [strip.scrollWidth > strip.clientWidth, strip.clientHeight, strip.offsetHeight];
      strip.style.width = '';
      return overflow;
    }), [true, 32, 32]);

    // The seam is a single hairline over the pane's whole height, with no gaps to read as two dividers.
    assert.deepEqual(await dividerLine.evaluate((element) => {
      const hairline = getComputedStyle(element, '::before');
      return [hairline.width, hairline.marginTop, hairline.marginBottom, parseFloat(hairline.height) === element.getBoundingClientRect().height];
    }), ['1px', '0px', '0px', true]);

    // The markdown page is sized by its own divider, and the fraction it was dragged to is remembered.
    const dividerBox = await dividerLine.boundingBox();
    // The divider is grabbed at the page's right edge, so the page follows the pointer one to one.
    const from = dividerBox.x + 1;
    const step = 60;
    const before = (await article.boundingBox()).width;
    await page.mouse.move(from, dividerBox.y + dividerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(from + step, dividerBox.y + dividerBox.height / 2, { steps: 5 });
    await page.mouse.up();
    const after = (await article.boundingBox()).width;
    assert.ok(Math.abs(after - before - step) < 2, `dragging the divider resizes the page (${before} -> ${after})`);
    const [paneWidth, stored] = await pane.evaluate((element) => [element.clientWidth, Number(localStorage.getItem('markdown-width'))]);
    assert.ok(Math.abs(stored - after / paneWidth) < 0.01, 'the dragged fraction is remembered');
    await previewMode(panel, '文本');
    await previewMode(panel, 'Markdown 预览');
    await renderedMarkdown.waitFor();
    assert.ok(Math.abs((await article.boundingBox()).width - after) < 2, 'a page shown again comes back to the dragged width');

    // Dragging past the page's minimum width stops the page there.
    const seam = await dividerLine.boundingBox();
    await page.mouse.move(seam.x + 1, seam.y + seam.height / 2);
    await page.mouse.down();
    await page.mouse.move(seam.x - 400, seam.y + seam.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.ok(Math.abs((await article.boundingBox()).width - 240) < 2, 'the page keeps its minimum width');

    // The host's own divider can make the pane too narrow for that width, and then the divider takes its own and the
    // page keeps the rest.
    const separatorBox = await page.getByRole('separator', { name: '调整右侧栏宽度' }).boundingBox();
    await page.mouse.move(separatorBox.x + separatorBox.width / 2, separatorBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(separatorBox.x + 400, separatorBox.y + 100, { steps: 5 });
    await page.mouse.up();
    await until(async () => {
      const [paneWidth, shown, dividerWidth] = await Promise.all([
        pane.evaluate((element) => element.clientWidth),
        article.evaluate((element) => element.getBoundingClientRect().width),
        dividerLine.evaluate((element) => element.offsetWidth),
      ]);
      return Math.abs(shown - (paneWidth - dividerWidth)) < 2;
    }, { attempts: 60, interval: 250 });
    await back.click();
    await preview.waitFor();
    await forward.click();
    await renderedMarkdown.waitFor();
    const tabCount = await tabs.count();
    await clickLink(pathToFileURL(markdown).href, { label: 'MARKDOWN_LINK' });
    await renderedMarkdown.waitFor();
    assert.equal(await tabs.count(), tabCount);

    await page.screenshot({ path: 'tests/dist/screenshots/files-preview.png' });
    await clickLink(pathToFileURL(html).href, { label: 'HTML_LINK' });
    const htmlFrame = page.frameLocator('.html-frame');
    await htmlFrame.locator('#heading[data-scripted=yes]').waitFor();
    assert.equal(await htmlFrame.locator('#heading').innerText(), 'Rendered page');
    assert.equal(await page.locator('.html-frame').getAttribute('sandbox'), 'allow-scripts');
    const htmlBody = htmlFrame.locator('body');
    assert.equal(await htmlBody.evaluate((element) => getComputedStyle(element).fontSize), '13px');
    assert.match(await htmlBody.evaluate((element) => getComputedStyle(element).fontFamily), /DejaVuSansM Nerd Font Mono/);
    assert.equal(await address.inputValue(), html);
    assert.deepEqual(await previewMode(panel, '文本'), ['文本', 'HTML 预览']);
    await codeView(panel, 'HTML_SOURCE').waitFor();
    await previewMode(panel, 'HTML 预览');
    await renderedPage(htmlFrame, 'Rendered page').waitFor();
    await clickLink(pathToFileURL(json).href, { label: 'JSON_LINK' });
    await codeView(panel, 'ready').waitFor();
    await page.waitForFunction(() => new Set([...document.querySelectorAll('.monaco-editor .view-line span')].map(el => getComputedStyle(el).color)).size > 1);
    await clickLink(pathToFileURL(binary).href, { label: 'BINARY_LINK' });
    await alert.filter({ hasText: '暂不支持二进制' }).waitFor();
    const beforeMissing = await tabs.count();
    await clickLink(pathToFileURL(join(home, 'missing.ts')).href, { label: 'MISSING_LINK' });
    const published = await clickCount();
    await page.evaluate(({ sessionId, path }) => window.wangcai.request('terminal-agent', 'click', { sessionId, location: { path } }), { sessionId, path: 'missing.ts' });
    assert.equal(await clickCount(), published);
    assert.equal(await tabs.count(), beforeMissing);
    assert.equal(await alert.filter({ hasText: 'No such file' }).count(), 0);
    await goToPath(page, home);
    // The handle is taken before the click, since a column that is read again would replace its buttons.
    const sampleButton = await sample.elementHandle();
    await entry(directory, 'sub/').click();
    await waitForPath(page, subdirectory);
    await empty.waitFor();
    assert.equal(await page.evaluate((node) => document.contains(node), sampleButton), true, 'the column above keeps its entries');
    assert.equal(await shownColumns.count(), 2, 'a directory below the workspace gets a column of its own');
    await back.click();
    await entry(directory, '说明 file.md').click();
    await renderedMarkdown.waitFor();
    await back.click();
    await sample.waitFor();
    await entry(directory, 'photo.png').click();
    const shownImage = panel.locator('.image-preview img');
    await shownImage.waitFor();
    assert.match(await shownImage.getAttribute('src'), /^data:image\/png;base64,/);
    assert.deepEqual(await shownImage.evaluate(async (element) => { await element.decode(); return [element.naturalWidth, element.naturalHeight]; }), [1, 1]);
    assert.equal(await mode.count(), 0);
    assert.equal(await forward.isDisabled(), true);
    await toggle.click();
    assert.equal(await right.isVisible(), false);
    await openFilesPanel(page);
    await shownImage.waitFor();
    await goToPathEntry(page, home, 'sample.ts');
    await page.screenshot({ path: 'tests/dist/screenshots/files-picker.png' });
    await run(terminal, `cd '${subdirectory}'`);
    await page.waitForFunction(async ({ id, path }) => {
      const result = await window.wangcai.request('files', 'list', { machine: { id: 'local', name: '本机' }, sessionId: id });
      return result.path === path;
    }, { id: sessionId, path: subdirectory });
    const workspaces = workspaceTabs(page);
    await workspaces.filter({ hasText: 'sub' }).waitFor();
    await openFilesTab(page);
    await sample.waitFor();
    await goToPath(page, 'sub');
    await empty.waitFor();
    assert.equal(await address.inputValue(), subdirectory);
    await createWorkspace(page);
    await openFilesTab(page);
    await sample.waitFor();
    await workspaces.first().click();
    await empty.waitFor();
    await page.screenshot({ path: 'tests/dist/screenshots/files-picker-empty.png' });
    writeFileSync(join(home, 'sub', 'inside.md'), '# Directory link preview');
    await clickLink('./sub/');
    await filesTab(page).waitFor();
    const sub = columnOf(page, subdirectory);
    const inside = entry(sub, 'inside.md');
    await inside.click();
    await renderedPage(page, 'Directory link preview').waitFor();
    await clickLink(pathToFileURL(subdirectory).href, { label: 'DIRECTORY_LINK' });
    assert.equal(await tabs.count(), 1);
    await inside.waitFor();
    await goToPathEntry(page, home, 'sample.ts');
    assert.equal((await openWorkspaces(page))[0].sessionId, sessionId);
    await clickLink('sample.ts(2,3)');
    assert.deepEqual(await lastClick(), { type: 'file', path: code, line: 2, column: 3 });
    await clickLink('"说明 file.md", line 3', { anchor: '说明 file.md' });
    assert.deepEqual(await lastClick(), { type: 'file', path: markdown, line: 3, column: undefined });
    await printLine('missing.ts:12');
    const missingRow = terminalRow(terminal, 'missing.ts:12');
    await missingRow.waitFor();
    const clicksSoFar = await clickCount();
    const missingPoint = await firstChar(missingRow, 'missing.ts:12');
    await page.mouse.move(500, 500);
    // With Command held, a cursor here would mean the path that does not exist became a link.
    await page.keyboard.down('Meta');
    await page.mouse.move(missingPoint.x, missingPoint.y);
    await page.waitForTimeout(500);
    assert.equal(await cursor.count(), 0);
    await page.mouse.click(missingPoint.x, missingPoint.y);
    await page.waitForTimeout(500);
    assert.equal(await clickCount(), clicksSoFar);
    await page.keyboard.up('Meta');
    // Clicking through the mouse hangs on the picker; click the element itself.
    await newSidebarTab(page).first().evaluate((element) => element.click());
    await viewMenu(page).getByRole('button', { name: '终端', exact: true }).click();
    const sidebar = shownPanel(page).locator('.terminal-pane');
    await terminalUp(sidebar);
    await run(sidebar, `cd '${home}'; printf '\\033[2J\\033[Hsample.ts:2\\n'`);
    const sidebarRow = terminalRow(sidebar, 'sample.ts:2');
    await sidebarRow.waitFor();
    await clickPoint(await firstChar(sidebarRow, 'sample.ts:2'));
    assert.deepEqual(await lastClick(), { type: 'file', path: code, line: 2, column: undefined });
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollTop), 0);
    const { resolveConfig } = await import(pathToFileURL(require.resolve('electron-vite', { paths: [app] })).href);
    const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [app] })).href);
    const { config } = await resolveConfig({ root: join(app, 'desktop') }, 'serve');
    devServer = await createServer({ ...config.renderer, configFile: false, server: { port: 0, host: '127.0.0.1' } });
    await devServer.listen();
    env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${devServer.httpServer.address().port}`;
    ({ desktop, window: page } = await reopen(desktop, home, env));
    await workspaceBar(page).waitFor();
    // The window this reopen made is a page of its own, so its preview is taken from the page that is open now.
    const reopenedPreview = codeView(filesPanel(page), 'CODE_PREVIEW');
    await until(() => reopenedPreview.count(), {
      act: () => clickFile(page, { type: 'file', machine: { id: 'local', name: '本机' }, path: code }),
      attempts: 150, interval: 100,
    });
    // The click is the part the plugin may have missed while it mounted. Once the preview is there, another click is
    // what would take it away again, so waiting for it to show asks for nothing more than that it shows.
    await reopenedPreview.waitFor();
  } finally {
    await desktop?.close();
    await devServer?.close();
    cleanup(home);
  }
});

test('navigation history recovers its position and follows workspace tab ownership', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-files-recover-')));
  const env = testEnv(home);
  let desktop, page;
  try {
    writeInit(home, { workspaces: ['terminal-agent'], tabs: ['files'] });
    const code = join(home, 'first.ts');
    const middle = join(home, 'middle.md');
    const latest = join(home, 'latest.md');
    writeFileSync(code, 'const first = 1;\nconst recovered = true;\n');
    writeFileSync(middle, '# Middle preview');
    writeFileSync(latest, '# Latest preview');
    const machine = { id: 'local', name: '本机' };
    const first = { type: 'file', machine, path: code, line: 2, column: 3 };
    const second = { type: 'file', machine, path: middle };
    const third = { type: 'file', machine, path: latest };
    ({ desktop, window: page } = await openWindow(home, env));
    const errors = [];
    collectErrors(page, errors);
    const firstPreview = renderedPage(page, 'Middle preview');
    await viewMenu(page).getByRole('button', { name: '文件', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
    await clickFile(page, first);
    await codeView(page, 'recovered').waitFor();
    await clickFile(page, second);
    await firstPreview.waitFor();
    await clickFile(page, third);
    await renderedPage(page, 'Latest preview').waitFor();
    await backButton(page).click();
    await firstPreview.waitFor();
    assert.deepEqual((await storedHistory(page))[''], { entries: [first, second, third], index: 1 });
    ({ desktop, window: page } = await reopen(desktop, home, env));
    collectErrors(page, errors);
    const secondPreview = renderedPage(page, 'Middle preview');
    const secondBack = backButton(page);
    await secondPreview.waitFor();
    assert.equal(await secondBack.isDisabled(), false);
    assert.equal(await forwardButton(page).isDisabled(), false);
    await createWorkspace(page);
    const firstWorkspace = (await openWorkspaces(page))[0].id;
    await clickFile(page, second);
    await secondPreview.waitFor();
    await goToPathEntry(page, home, 'first.ts');
    await secondBack.click();
    await secondPreview.waitFor();
    await createWorkspace(page);
    const secondWorkspace = (await openWorkspaces(page))[1].id;
    await clickFile(page, third);
    await renderedPage(page, 'Latest preview').waitFor();
    const stored = await storedHistory(page);
    assert.equal('' in stored, false);
    assert.deepEqual(stored[firstWorkspace], { entries: [first, second, { type: 'directory', machine, path: home }], index: 1 });
    assert.deepEqual(stored[secondWorkspace], { entries: [third], index: 0 });
    ({ desktop, window: page } = await reopen(desktop, home, env));
    collectErrors(page, errors);
    const address = pathBox(page);
    const directory = columnOf(page, home);
    const firstFile = entry(directory, 'first.ts');
    await filesPanels(page).nth(1).waitFor({ state: 'attached' });
    assert.deepEqual(await storedHistory(page), stored);
    const workspaces = workspaceTabs(page);
    await workspaces.first().click();
    const fileTabs = filesTab(page);
    const thirdPreview = renderedPage(page, 'Middle preview');
    assert.equal(await fileTabs.count(), 1);
    await fileTabs.click();
    await thirdPreview.waitFor();
    const back = backButton(page);
    const forward = forwardButton(page);
    assert.equal(await address.inputValue(), middle);
    assert.equal(await back.isDisabled(), false);
    assert.equal(await forward.isDisabled(), false);
    const historyPath = join(home, '.local/share/wangcai/data/files/history.json');
    const modified = statSync(historyPath, { bigint: true }).mtimeNs;
    await refreshButton(page).click();
    await thirdPreview.waitFor();
    await fileTabs.click();
    await storedHistory(page);
    assert.equal(statSync(historyPath, { bigint: true }).mtimeNs, modified);
    await forward.click();
    await firstFile.waitFor();
    await back.click();
    await thirdPreview.waitFor();
    await back.click();
    await codeView(page, 'recovered').waitFor();
    assert.equal(await address.inputValue(), code);
    assert.equal(await back.isDisabled(), true);
    await goToPathEntry(page, home, 'first.ts');
    assert.equal(await forward.isDisabled(), true);
    assert.deepEqual((await storedHistory(page))[firstWorkspace], {
      entries: [first, { type: 'directory', machine, path: home }], index: 1,
    });
    await workspaces.last().click();
    await fileTabs.click();
    await renderedPage(page, 'Latest preview').waitFor();
    assert.equal(await back.isDisabled(), true);
    assert.equal(await forward.isDisabled(), true);
    await closeTabs(page).last().click();
    const remaining = await storedHistory(page);
    assert.equal(secondWorkspace in remaining, false);
    assert.equal(firstWorkspace in remaining, true);
    await openFilesTab(page);
    await firstFile.waitFor();
    assert.equal(await back.isDisabled(), true);
    assert.equal(await forward.isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await desktop?.close();
    cleanup(home);
  }
});
