const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { activeTerminal, createWorkspace, openView, serveRenderer, until, viewTabs, withHome, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { backButton, clickFile, codeView, collectErrors, columnOf, columns, desktopMain, drawnCloseButtons, editorLines, emptyDirectory, entry, filePicker, filePreview, filesPanels, filesTab, filesTabPanel, forwardButton, goToPath, goToPathEntry, lists, machine, markdownDivider, markdownPage, markdownPane, markdownScroll, modeButton, newSidebarTab, openWorkspaces, pathBox, previewMenu, previewMode, previewModes, refreshButton, renderedPage, runIn, shownPanel, sidebarRight, sidebarToggle, storedHistory, terminalRow, viewMenu, waitForPath, workspaceBar, workspaceTabs } = require('./files-ui.cjs');

test('view picker browses current terminal directory; file links preview code, Markdown, HTML and images', { timeout: 180000 }, () => withHome('wangcai-files', lists, async ({ home, env, open }) => {
  let { desktop, page, close } = await open();
  const code = join(home, 'sample.ts');
  const markdown = join(home, '说明 file.md');
  const binary = join(home, 'binary.bin');
  const html = join(home, 'page.html');
  const json = join(home, 'settings.json');
  const subdirectory = join(home, 'sub');
  const wide = 'const wide = "' + 'wide code block '.repeat(80) + '";';
  writeFileSync(json, '{"ready":true}');
  writeFileSync(code, 'const first = 1;\nconst second = "CODE_PREVIEW";\n');
  writeFileSync(markdown, '---\nname: sample-skill\ndescription: A frontmatter description that is long enough to wrap inside the metadata panel\nallowed-tools: Read, Grep\nhomepage: https://example.com/sample-skill\n---\n\n# Markdown preview\n\n**Rendered content**\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n```ts\n' + wide + '\n```\n\n' + 'A body line tall enough for the pane to scroll.\n\n'.repeat(40) + '<script>window.previewScriptRan = true</script>');
  writeFileSync(html, '<!doctype html>\n<!-- HTML_SOURCE -->\n<h1 id="heading">Rendered page</h1>\n<script>document.getElementById("heading").dataset.scripted = "yes"</script>\n');
  writeFileSync(binary, Buffer.from([0, 1, 255, 2]));
  writeFileSync(join(home, 'photo.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
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
  // The point is asked for again on every round: a row redraws as output arrives, so where a link sits is only good for
  // the moment it was read.
  const clickPoint = async (pointOf) => {
    // Away from every link first, so the cursor belongs to this hover and not to the last one.
    await until(async () => (await cursor.count()) === 0, { act: () => page.mouse.move(500, 500) });
    await page.evaluate(() => { window.linkClicks = []; });
    // Command is what shows a terminal link and what opens it, so it is held across the hover and the click.
    await page.keyboard.down('Meta');
    // The line can only be answered once the plugin has looked its paths up, so the hover is given more than one try.
    let point;
    await until(() => cursor.isVisible(), {
      act: async () => {
        point = await pointOf();
        // Off the row and back: the app answers a line again once the pointer returns to it.
        await page.mouse.move(500, 500);
        await page.mouse.move(point.x, point.y);
      },
    });
    // A cursor that was already there ends the wait before the first move, so the point is read for the click itself.
    point ??= await pointOf();
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Meta');
  };
  const terminal = activeTerminal(page);
  // A line printed before the shell ran the one before it lands on top of it and leaves the quotes open, which the
  // shell answers with a continuation prompt and never runs, so whatever is pending is dropped first.
  const printLine = async (text, cwd = home) => {
    await terminal.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Control+C');
    await runIn(terminal, `cd '${cwd}'; printf '\\033[2J\\033[H%b\\n' '${text}'`);
  };
  const clickLink = async (link, { label = link, cwd = home, anchor = label } = {}) => {
    const output = label === link ? link : `\\033]8;;${link}\\007${label}\\033]8;;\\007`;
    await printLine(output, cwd);
    const row = terminalRow(terminal, label);
    // A command typed while the shell is busy is lost, so the line is printed again until it is the row on show.
    await until(async () => (await row.count()) > 0 && (await row.textContent()).trim() === label, {
      act: () => printLine(output, cwd),
    });
    await clickPoint(() => firstChar(row, anchor));
  };
  const clickCount = () => page.evaluate(() => window.linkClicks.length);
  const lastClick = async () => {
    // The click crosses the plugin channel, so wait for its answer instead of the last one.
    await until(() => page.evaluate(() => window.linkClicks.length > 0));
    const { type, path, line, column } = await page.evaluate(() => window.linkClicks.at(-1));
    return { type, path, line, column };
  };
  const right = sidebarRight(page);
  assert.ok(await right.isHidden());
  await openView(page, '文件');
  const address = pathBox(page);
  const panel = filesTabPanel(page);
  const back = backButton(page);
  const forward = forwardButton(page);
  const refresh = refreshButton(page);
  const directory = columnOf(page, home);
  const shownColumns = columns(page);
  const drawnTabs = viewTabs(page);
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
  const copy = article.locator('.markdown-code-copy');
  const codeSpans = article.locator('.markdown-code-body span');
  const renderedMarkdown = renderedPage(article, 'Markdown preview');
  const empty = emptyDirectory(page);
  const previewSection = filePreview(page);
  const toggle = sidebarToggle(page);
  const alert = page.getByRole('alert');
  await sample.waitFor();
  assert.equal(await shownColumns.count(), 1, 'the picker starts at the workspace directory');
  assert.deepEqual(await shownColumns.evaluate((column) => {
    const container = column.parentElement.getBoundingClientRect();
    return [Math.round(column.getBoundingClientRect().left - container.left), column.parentElement.scrollLeft];
  }), [0, 0], 'the leftmost column is aligned with the pane');
  assert.equal(await address.inputValue(), home);
  assert.ok(await back.isDisabled());
  assert.ok(await forward.isDisabled());
  writeFileSync(join(home, 'refresh.md'), '# Refreshed directory');
  await refresh.click();
  await refreshFile.waitFor();
  assert.ok(await back.isDisabled());
  assert.ok(await forward.isDisabled());
  await sample.click();
  await preview.waitFor();
  // The path above the file opens the picker, and the file it was opened from comes back marked.
  await address.click();
  await sample.waitFor();
  assert.equal(await sample.getAttribute('aria-current'), 'true');
  assert.equal(await lines.count(), 0);
  await sample.click();
  await preview.waitFor();
  assert.equal(await drawnTabs.count(), 1);
  writeFileSync(code, 'const first = 1;\nconst second = "CODE_PREVIEW";\nconst refreshed = true;\n');
  await refresh.click();
  await codeView(panel, 'refreshed').waitFor();
  await back.click();
  await sample.waitFor();
  assert.ok(await back.isDisabled());
  assert.ok(await forward.isEnabled());
  await refresh.click();
  await refreshFile.waitFor();
  assert.ok(await back.isDisabled());
  assert.ok(await forward.isEnabled());
  await forward.click();
  await preview.waitFor();
  assert.equal(await address.inputValue(), code);
  await goToPath(page, 'missing.ts');
  await alert.filter({ hasText: '路径不存在' }).waitFor();
  await address.press('Escape');
  assert.equal(await address.inputValue(), code);
  // The picker draws a message area of its own, so this is not the alert the rest of the case waits for.
  assert.equal(await filePicker(page).getByRole('alert').count(), 0);
  await goToPath(page, './sample.ts');
  await waitForPath(page, code);
  await preview.waitFor();
  await toggle.click();
  await clickLink(`${code}:2:3`);
  await previewSection.waitFor();
  assert.equal(await address.inputValue(), code);
  assert.equal(await mode.innerText(), '文本');
  assert.equal(await mode.getAttribute('aria-haspopup'), null);
  assert.equal(await panel.locator('.preview-header').evaluate((element) => getComputedStyle(element).fontSize), '12px');
  assert.equal(await lines.evaluate((element) => getComputedStyle(element).fontSize), '12px');
  await page.screenshot({ path: 'test/output/screenshots/files-code.png' });
  assert.equal(await previewSection.locator('.monaco-editor').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(18, 19, 20)');
  await preview.waitFor();
  const workerReady = page.waitForEvent('worker');
  await page.evaluate(() => { window.MonacoEnvironment.getWorker('', 'editorWorkerService'); });
  const worker = await workerReady;
  await until(() => worker.evaluate(() => typeof self.onmessage === 'function'));
  const textBeforeEdit = await lines.innerText();
  await lines.click();
  await page.keyboard.type('SHOULD_NOT_EDIT');
  assert.equal(await lines.innerText(), textBeforeEdit);
  const terminalBox = await desktopMain(page).boundingBox();
  const fileBox = await right.boundingBox();
  assert.ok(fileBox.x >= terminalBox.x + terminalBox.width);
  mkdirSync(subdirectory);
  await clickLink('../sample.ts:2:3', { cwd: subdirectory });
  assert.equal(await drawnTabs.count(), 1);
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
  // Monaco tokenizes the fence after the text is painted, so its label and its colors both arrive late: the label until
  // it names the language, and the colors under the editor's theme, which a highlighted keyword takes.
  const fenceLabel = article.locator('.markdown-code-head span');
  await until(async () => (await fenceLabel.count()) > 0 && (await fenceLabel.innerText()) === 'ts');
  await until(() => codeSpans.evaluateAll((spans) => {
    const keyword = spans.find((span) => span.textContent === 'const');
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--wc-magenta');
    document.body.append(probe);
    const magenta = getComputedStyle(probe).color;
    probe.remove();
    return keyword ? getComputedStyle(keyword).color === magenta : false;
  }));
  await copy.click();
  await copy.filter({ hasText: '已复制' }).waitFor();
  assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), wide);
  assert.equal(await address.inputValue(), markdown);
  assert.deepEqual(await previewModes(panel), ['文本', 'Markdown 预览']);
  await page.screenshot({ path: 'test/output/screenshots/files-modes.png' });
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
  for (const [view, size] of [[article, ['10px', '12px']], [scroller, ['6px', '6px']]]) {
    assert.deepEqual(await view.evaluate((element) => {
      const bar = getComputedStyle(element, '::-webkit-scrollbar');
      const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb');
      return [bar.width, bar.height, thumb.backgroundColor, thumb.borderRadius,
        getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor,
        getComputedStyle(element, '::-webkit-scrollbar-button').display];
    }), [...size, 'rgba(0, 0, 0, 0)', '0px', 'rgba(0, 0, 0, 0)', 'none']);
  }
  assert.equal(await scroller.evaluate(async (element) => {
    element.scrollLeft = 40;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor;
  }), 'rgba(121, 121, 121, 0.4)', 'a scrolling panel shows its scrollbar');
  await until(() => scroller.evaluate((element) => getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor === 'rgba(0, 0, 0, 0)'));
  assert.ok(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth));

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
  const articleWidthBefore = (await article.boundingBox()).width;
  await page.mouse.move(from, dividerBox.y + dividerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(from + step, dividerBox.y + dividerBox.height / 2, { steps: 5 });
  await page.mouse.up();
  const articleWidthAfter = (await article.boundingBox()).width;
  assert.ok(Math.abs(articleWidthAfter - articleWidthBefore - step) < 2, `dragging the divider resizes the page (${articleWidthBefore} -> ${articleWidthAfter})`);
  const [paneWidth, storedFraction] = await pane.evaluate((element) => [element.clientWidth, Number(localStorage.getItem('markdown-width'))]);
  assert.ok(Math.abs(storedFraction - articleWidthAfter / paneWidth) < 0.01, 'the dragged fraction is remembered');
  await previewMode(panel, '文本');
  await previewMode(panel, 'Markdown 预览');
  await renderedMarkdown.waitFor();
  assert.ok(Math.abs((await article.boundingBox()).width - articleWidthAfter) < 2, 'a page shown again comes back to the dragged width');

  // Dragging past the page's minimum width stops the page there.
  const seamBox = await dividerLine.boundingBox();
  await page.mouse.move(seamBox.x + 1, seamBox.y + seamBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(seamBox.x - 400, seamBox.y + seamBox.height / 2, { steps: 5 });
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
    const [nowWidth, shown, dividerWidth] = await Promise.all([
      pane.evaluate((element) => element.clientWidth),
      article.evaluate((element) => element.getBoundingClientRect().width),
      dividerLine.evaluate((element) => element.offsetWidth),
    ]);
    return Math.abs(shown - (nowWidth - dividerWidth)) < 2;
  });
  await back.click();
  await preview.waitFor();
  await forward.click();
  await renderedMarkdown.waitFor();
  const tabCount = await drawnTabs.count();
  await clickLink(pathToFileURL(markdown).href, { label: 'MARKDOWN_LINK' });
  await renderedMarkdown.waitFor();
  assert.equal(await drawnTabs.count(), tabCount);

  await page.screenshot({ path: 'test/output/screenshots/files-preview.png' });
  await clickLink(pathToFileURL(html).href, { label: 'HTML_LINK' });
  const htmlFrame = panel.locator('.html-frame');
  const renderedFrame = htmlFrame.contentFrame();
  await renderedFrame.locator('#heading[data-scripted=yes]').waitFor();
  assert.equal(await renderedFrame.locator('#heading').innerText(), 'Rendered page');
  assert.equal(await htmlFrame.getAttribute('sandbox'), 'allow-scripts');
  const htmlBody = renderedFrame.locator('body');
  assert.equal(await htmlBody.evaluate((element) => getComputedStyle(element).fontSize), '13px');
  assert.match(await htmlBody.evaluate((element) => getComputedStyle(element).fontFamily), /DejaVuSansM Nerd Font Mono/);
  assert.equal(await address.inputValue(), html);
  assert.deepEqual(await previewMode(panel, '文本'), ['文本', 'HTML 预览']);
  await codeView(panel, 'HTML_SOURCE').waitFor();
  await previewMode(panel, 'HTML 预览');
  await renderedPage(renderedFrame, 'Rendered page').waitFor();
  await clickLink(pathToFileURL(json).href, { label: 'JSON_LINK' });
  await codeView(panel, 'ready').waitFor();
  await until(() => lines.evaluate((element) => new Set([...element.querySelectorAll('.view-line span')].map((span) => getComputedStyle(span).color)).size > 1));
  await clickLink(pathToFileURL(binary).href, { label: 'BINARY_LINK' });
  await alert.filter({ hasText: '暂不支持二进制' }).waitFor();
  const tabCountBeforeMissing = await drawnTabs.count();
  await clickLink(pathToFileURL(join(home, 'missing.ts')).href, { label: 'MISSING_LINK' });
  const clickCountBeforeMissing = await clickCount();
  await page.evaluate(({ sessionId, path }) => window.wangcai.call('request', 'terminal-agent', 'click', { sessionId, location: { path } }), { sessionId, path: 'missing.ts' });
  assert.equal(await clickCount(), clickCountBeforeMissing);
  assert.equal(await drawnTabs.count(), tabCountBeforeMissing);
  assert.equal(await alert.filter({ hasText: 'No such file' }).count(), 0);
  await goToPath(page, home);
  // The handle is taken before the click, since a column that is read again would replace its buttons.
  const sampleButton = await sample.elementHandle();
  await entry(directory, 'sub/').click();
  await waitForPath(page, subdirectory);
  await empty.waitFor();
  assert.ok(await page.evaluate((node) => document.contains(node), sampleButton), 'the column above keeps its entries');
  assert.equal(await shownColumns.count(), 2, 'a directory below the workspace gets a column of its own');
  await back.click();
  await entry(directory, basename(markdown)).click();
  await renderedMarkdown.waitFor();
  await back.click();
  await sample.waitFor();
  await entry(directory, 'photo.png').click();
  const shownImage = panel.locator('.image-preview img');
  await shownImage.waitFor();
  assert.match(await shownImage.getAttribute('src'), /^data:image\/png;base64,/);
  assert.deepEqual(await shownImage.evaluate(async (element) => { await element.decode(); return [element.naturalWidth, element.naturalHeight]; }), [1, 1]);
  assert.equal(await mode.innerText(), '文本');
  assert.equal(await mode.getAttribute('aria-haspopup'), null);
  assert.ok(await forward.isDisabled());
  await toggle.click();
  assert.ok(await right.isHidden());
  await openView(page, '文件');
  await shownImage.waitFor();
  await goToPathEntry(page, home, 'sample.ts');
  await page.screenshot({ path: 'test/output/screenshots/files-picker.png' });
  await runIn(terminal, `cd '${subdirectory}'`);
  await until(() => page.evaluate(async ({ reader, id, path }) => {
    const result = await window.wangcai.call('request', 'files', 'list', { machine: reader, sessionId: id });
    return result.path === path;
  }, { reader: machine, id: sessionId, path: subdirectory }));
  const workspaces = workspaceTabs(page);
  await workspaces.filter({ hasText: 'sub' }).waitFor();
  await openView(page, '文件');
  await sample.waitFor();
  await goToPath(page, 'sub');
  await empty.waitFor();
  assert.equal(await address.inputValue(), subdirectory);
  await createWorkspace(page);
  await openView(page, '文件');
  await sample.waitFor();
  await workspaces.first().click();
  await empty.waitFor();
  await page.screenshot({ path: 'test/output/screenshots/files-picker-empty.png' });
  writeFileSync(join(home, 'sub', 'inside.md'), '# Directory link preview');
  await clickLink('./sub/');
  await filesTab(page).waitFor();
  const subColumn = columnOf(page, subdirectory);
  const insideFile = entry(subColumn, 'inside.md');
  await insideFile.click();
  await renderedPage(article, 'Directory link preview').waitFor();
  await clickLink(pathToFileURL(subdirectory).href, { label: 'DIRECTORY_LINK' });
  assert.equal(await drawnTabs.count(), 1);
  await insideFile.waitFor();
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
  // With Command held, a cursor here would mean the path that does not exist became a link, and only a hover away and
  // back counts as the app having answered the row.
  await page.keyboard.down('Meta');
  let missingPoint;
  for (let round = 0; round < 3; round += 1) {
    missingPoint = await firstChar(missingRow, 'missing.ts:12');
    await page.mouse.move(500, 500);
    await page.mouse.move(missingPoint.x, missingPoint.y);
    await page.waitForTimeout(300);
  }
  assert.equal(await cursor.count(), 0);
  await page.mouse.click(missingPoint.x, missingPoint.y);
  // A click that did open something is published on the channel the hover is answered through, so it is given the same
  // window the hover had before its silence counts.
  await page.waitForTimeout(900);
  assert.equal(await clickCount(), clicksSoFar);
  await page.keyboard.up('Meta');
  // A link click still reaches the plugin while its own panel is behind another one. The sidebar's terminal draws its
  // rows on a canvas, so the link is clicked in the workspace's terminal instead.
  await newSidebarTab(page).evaluate((element) => element.click());
  await viewMenu(page).getByRole('button', { name: '终端', exact: true }).click();
  await shownPanel(page).locator('.terminal-pane').waitFor();
  await clickLink('sample.ts:2');
  assert.deepEqual(await lastClick(), { type: 'file', path: code, line: 2, column: undefined });
  assert.equal(await page.evaluate(() => document.documentElement.scrollTop), 0);
  const stopRenderer = await serveRenderer(env);
  // This reopen is about the plugin mounting in a new window, not about the tabs the closed one saved.
  rmSync(join(home, '.local/share/wangcai/data/core/tabs.json'), { force: true });
  await close();
  ({ page, close } = await open());
  collectErrors(page, errors);
  await workspaceBar(page).waitFor();
  // The window this reopen made is a page of its own, so its preview is taken from the page that is open now.
  const reopenedPreview = codeView(filesTabPanel(page), 'CODE_PREVIEW');
  // The click is the part the plugin may have missed while it mounted. Once the preview is there, another click is
  // what would take it away again, so waiting for it to show asks for nothing more than that it shows.
  await until(() => reopenedPreview.isVisible(), {
    act: () => clickFile(page, { type: 'file', machine, path: code }),
  });
  assert.deepEqual(errors, []);
  await stopRenderer();
}));

test('navigation history recovers its position and follows workspace tab ownership', { timeout: 180000 }, () => withHome('wangcai-files-recover', { workspaces: ['terminal-agent'], tabs: ['files'] }, async ({ home, open }) => {
  let { page, close } = await open();
  const code = join(home, 'first.ts');
  const middle = join(home, 'middle.md');
  const latest = join(home, 'latest.md');
  writeFileSync(code, 'const first = 1;\nconst recovered = true;\n');
  writeFileSync(middle, '# Middle preview');
  writeFileSync(latest, '# Latest preview');
  const first = { type: 'file', machine, path: code, line: 2, column: 3 };
  const second = { type: 'file', machine, path: middle };
  const third = { type: 'file', machine, path: latest };
  const errors = [];
  collectErrors(page, errors);
  let middlePreview = renderedPage(page, 'Middle preview');
  // A plugin's menu entries are drawn when it registers its views, and the clicks below go to those views, so the entry
  // is waited for; the menu is closed at this point, which is why the entry is asked for as attached.
  await viewMenu(page).getByRole('button', { name: '文件', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
  await clickFile(page, first);
  await codeView(page, 'recovered').waitFor();
  await clickFile(page, second);
  await middlePreview.waitFor();
  await clickFile(page, third);
  await renderedPage(page, 'Latest preview').waitFor();
  await backButton(page).click();
  await middlePreview.waitFor();
  assert.deepEqual((await storedHistory(page))[''], { entries: [first, second, third], index: 1 });
  await close();
  ({ page, close } = await open());
  collectErrors(page, errors);
  middlePreview = renderedPage(page, 'Middle preview');
  await middlePreview.waitFor();
  assert.ok(await backButton(page).isEnabled());
  assert.ok(await forwardButton(page).isEnabled());
  await createWorkspace(page);
  const firstWorkspace = (await openWorkspaces(page))[0].id;
  await clickFile(page, second);
  await middlePreview.waitFor();
  await goToPathEntry(page, home, 'first.ts');
  await backButton(page).click();
  await middlePreview.waitFor();
  await createWorkspace(page);
  const secondWorkspace = (await openWorkspaces(page))[1].id;
  await clickFile(page, third);
  await renderedPage(page, 'Latest preview').waitFor();
  const history = await storedHistory(page);
  assert.ok(!('' in history));
  assert.deepEqual(history[firstWorkspace], { entries: [first, second, { type: 'directory', machine, path: home }], index: 1 });
  assert.deepEqual(history[secondWorkspace], { entries: [third], index: 0 });
  await close();
  ({ page, close } = await open());
  collectErrors(page, errors);
  const address = pathBox(page);
  const directory = columnOf(page, home);
  const firstFile = entry(directory, 'first.ts');
  await filesPanels(page).nth(1).waitFor({ state: 'attached' });
  assert.deepEqual(await storedHistory(page), history);
  const workspaces = workspaceTabs(page);
  await workspaces.first().click();
  const onlyTab = filesTab(page);
  middlePreview = renderedPage(page, 'Middle preview');
  assert.equal(await onlyTab.count(), 1);
  await onlyTab.click();
  await middlePreview.waitFor();
  const back = backButton(page);
  const forward = forwardButton(page);
  assert.equal(await address.inputValue(), middle);
  assert.ok(await back.isEnabled());
  assert.ok(await forward.isEnabled());
  const historyPath = join(home, '.local/share/wangcai/data/files/history.json');
  const mtimeBefore = statSync(historyPath, { bigint: true }).mtimeNs;
  await refreshButton(page).click();
  await middlePreview.waitFor();
  await onlyTab.click();
  // Asking for the history is a read: the file it comes from is not written again for it.
  await storedHistory(page);
  assert.equal(statSync(historyPath, { bigint: true }).mtimeNs, mtimeBefore);
  await forward.click();
  await firstFile.waitFor();
  await back.click();
  await middlePreview.waitFor();
  await back.click();
  await codeView(page, 'recovered').waitFor();
  assert.equal(await address.inputValue(), code);
  assert.ok(await back.isDisabled());
  await goToPathEntry(page, home, 'first.ts');
  assert.ok(await forward.isDisabled());
  assert.deepEqual((await storedHistory(page))[firstWorkspace], {
    entries: [first, { type: 'directory', machine, path: home }], index: 1,
  });
  await workspaces.last().click();
  await onlyTab.click();
  await renderedPage(page, 'Latest preview').waitFor();
  assert.ok(await back.isDisabled());
  assert.ok(await forward.isDisabled());
  await drawnCloseButtons(page).last().click();
  const remaining = await storedHistory(page);
  assert.ok(!(secondWorkspace in remaining));
  assert.ok(firstWorkspace in remaining);
  await openView(page, '文件');
  await firstFile.waitFor();
  assert.ok(await back.isDisabled());
  assert.ok(await forward.isDisabled());
  assert.deepEqual(errors, []);
}));

test('a file is shown again where it was left', { timeout: 180000 }, () => withWindow('wangcai-files-position', lists, async ({ home, page, errors }) => {
  const long = join(home, 'long.md');
  const other = join(home, 'other.md');
  writeFileSync(long, '# Long preview\n\n' + 'A body line tall enough for the pane to scroll.\n\n'.repeat(120));
  writeFileSync(other, '# Other preview');
  await createWorkspace(page);
  await clickFile(page, { type: 'file', machine, path: long });
  await renderedPage(page, 'Long preview').waitFor();
  const pane = markdownPane(filesTabPanel(page));
  // The pane draws its body again once the Markdown has arrived, which drops a scroll taken before that, so the
  // assignment is repeated until it is still there a frame later.
  await until(() => pane.evaluate(async (element) => {
    element.scrollTop = 600;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return element.scrollTop > 0;
  }));
  await clickFile(page, { type: 'file', machine, path: other });
  await renderedPage(page, 'Other preview').waitFor();
  // The offset the pane was left at is written down as the file changes, so the record is what is waited for.
  let keptTop;
  await until(async () => (keptTop = Object.values(await storedHistory(page)).flatMap((history) => history.entries).find((one) => one.path === long)?.top ?? 0) > 0);
  await backButton(page).click();
  await renderedPage(page, 'Long preview').waitFor();
  await until(async () => (await pane.evaluate((element) => element.scrollTop)) === keptTop);
  assert.deepEqual(errors, []);
}));
