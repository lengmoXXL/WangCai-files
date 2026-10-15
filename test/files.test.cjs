const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync, realpathSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { cleanup, createWorkspace, launchApp, run, testEnv, wangcaiApp, writeInit } = require('./harness.cjs');

const app = wangcaiApp();

test('view picker browses current terminal directory; file links preview code, Markdown, HTML and images', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-files-')));
  const env = testEnv(home);
  let desktop;
  let devServer;
  try {
    writeInit(home);
    const code = join(home, 'sample.ts');
    const markdown = join(home, '说明 file.md');
    const binary = join(home, 'binary.bin');
    const html = join(home, 'page.html');
    const image = join(home, 'photo.png');
    const json = join(home, 'settings.json');
    const wide = 'const wide = "' + 'wide code block '.repeat(80) + '";';
    writeFileSync(json, '{"ready":true}');
    writeFileSync(code, 'const first = 1;\nconst second = "CODE_PREVIEW";\n');
    writeFileSync(markdown, '---\nname: sample-skill\ndescription: A frontmatter description that is long enough to wrap inside the metadata panel\nallowed-tools: Read, Grep\nhomepage: https://example.com/sample-skill\n---\n\n# Markdown preview\n\n**Rendered content**\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n```ts\n' + wide + '\n```\n\n' + 'A body line tall enough for the pane to scroll.\n\n'.repeat(40) + '<script>window.previewScriptRan = true</script>');
    writeFileSync(html, '<!doctype html>\n<!-- HTML_SOURCE -->\n<h1 id="heading">Rendered page</h1>\n<script>document.getElementById("heading").dataset.scripted = "yes"</script>\n');
    writeFileSync(binary, Buffer.from([0, 1, 255, 2]));
    writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
    desktop = await launchApp(home, env);
    let page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.evaluate(() => { window.linkClicks = []; window.wangcai.subscribe('onclick', (payload) => window.linkClicks.push(payload)); });
    await createWorkspace(page);
    const sessionId = await page.evaluate(async () => (await window.wangcai.request('terminal-agent', 'config')).workspaces[0].sessionId);
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
    const clickPoint = async (point) => {
      // Away from every link first, so the cursor belongs to this hover and not to the last one.
      await page.mouse.move(500, 500);
      await page.waitForFunction(() => !document.querySelector('.xterm-cursor-pointer'));
      await page.evaluate(() => { window.linkClicks = []; });
      await page.mouse.move(point.x, point.y);
      await page.waitForFunction(() => !!document.querySelector('.xterm-cursor-pointer'));
      await page.mouse.click(point.x, point.y);
    };
    const printLine = (text, cwd = home) => run(page, `cd '${cwd}'; printf '\\033[2J\\033[H%b\\n' '${text}'`);
    const clickLink = async (link, { label = link, cwd = home, anchor = label } = {}) => {
      const output = label === link ? link : `\\033]8;;${link}\\007${label}\\033]8;;\\007`;
      await printLine(output, cwd);
      const row = page.locator('.terminal-pane.active .xterm-rows > div').filter({ hasText: label }).first();
      await page.waitForFunction((label) => document.querySelector('.terminal-pane.active .xterm-rows > div')?.textContent.trim() === label, label);
      await clickPoint(await firstChar(row, anchor));
    };
    const lastClick = async () => {
      // The click crosses the plugin channel, so wait for its answer instead of the last one.
      await page.waitForFunction(() => window.linkClicks.length > 0);
      const { type, path, line, column } = await page.evaluate(() => window.linkClicks.at(-1));
      return { type, path, line, column };
    };
    assert.equal(await page.locator('.sidebar-right').isVisible(), false);
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    const columnOf = (path) => page.getByRole('navigation', { name: path, exact: true });
    const address = page.getByRole('textbox', { name: '路径', exact: true });
    const back = page.getByRole('button', { name: '后退', exact: true });
    const forward = page.getByRole('button', { name: '前进', exact: true });
    const refresh = page.getByRole('button', { name: '刷新', exact: true });
    await columnOf(home).getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    assert.equal(await page.locator('.file-column').count(), 1, 'the picker starts at the workspace directory');
    assert.deepEqual(await page.locator('.file-column').evaluate((column) => {
      const pane = column.parentElement.getBoundingClientRect();
      return [Math.round(column.getBoundingClientRect().left - pane.left), column.parentElement.scrollLeft];
    }), [0, 0], 'the leftmost column is aligned with the pane');
    assert.equal(await address.inputValue(), home);
    assert.equal(await back.isDisabled(), true);
    assert.equal(await forward.isDisabled(), true);
    writeFileSync(join(home, 'refresh.md'), '# Refreshed directory');
    await refresh.click();
    await columnOf(home).getByRole('button', { name: 'refresh.md', exact: true }).waitFor();
    assert.equal(await back.isDisabled(), true);
    assert.equal(await forward.isDisabled(), true);
    await columnOf(home).getByRole('button', { name: 'sample.ts', exact: true }).click();
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    // The path above the file opens the picker, and the file it was opened from comes back marked.
    await address.click();
    const marked = columnOf(home).getByRole('button', { name: 'sample.ts', exact: true });
    await marked.waitFor();
    assert.equal(await marked.getAttribute('aria-current'), 'true');
    assert.equal(await page.locator('.monaco-editor').count(), 0);
    await marked.click();
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    assert.equal(await page.getByRole('tablist', { name: '侧栏标签页' }).getByRole('tab').count(), 1);
    writeFileSync(code, 'const first = 1;\nconst second = "CODE_PREVIEW";\nconst refreshed = true;\n');
    await refresh.click();
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'refreshed' }).waitFor();
    await back.click();
    await columnOf(home).getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    assert.equal(await back.isDisabled(), true);
    assert.equal(await forward.isDisabled(), false);
    await refresh.click();
    await columnOf(home).getByRole('button', { name: 'refresh.md', exact: true }).waitFor();
    assert.equal(await back.isDisabled(), true);
    assert.equal(await forward.isDisabled(), false);
    await forward.click();
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    assert.equal(await address.inputValue(), code);
    await address.fill('missing.ts');
    await address.press('Enter');
    await page.getByRole('alert').filter({ hasText: '路径不存在' }).waitFor();
    await address.press('Escape');
    assert.equal(await address.inputValue(), code);
    assert.equal(await page.locator('.file-preview .file-message[role=alert]').count(), 0);
    await address.fill('./sample.ts');
    await address.press('Enter');
    await page.waitForFunction((path) => document.querySelector('.preview-path').value === path, code);
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    await clickLink(`${code}:2:3`);
    await page.getByLabel('文件预览', { exact: true }).waitFor();
    const codePanel = page.getByRole('tabpanel', { name: '文件' });
    assert.equal(await codePanel.locator('.preview-path').inputValue(), code);
    assert.equal(await codePanel.locator('.preview-mode').count(), 0);
    assert.equal(await codePanel.locator('.preview-header').evaluate((element) => getComputedStyle(element).fontSize), '12px');
    assert.equal(await codePanel.locator('.monaco-editor .view-lines').evaluate((element) => getComputedStyle(element).fontSize), '12px');
    await page.screenshot({ path: 'tests/dist/screenshots/files-code.png' });
    assert.equal(await page.locator('.file-preview .monaco-editor').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(18, 19, 20)');
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
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
    const codeView = page.locator('.monaco-editor .view-lines');
    const beforeEdit = await codeView.innerText();
    await codeView.click();
    await page.keyboard.type('SHOULD_NOT_EDIT');
    assert.equal(await codeView.innerText(), beforeEdit);
    const terminalBounds = await page.locator('.desktop-main').boundingBox();
    const fileBounds = await page.locator('.sidebar-right').boundingBox();
    assert.ok(fileBounds.x >= terminalBounds.x + terminalBounds.width);
    mkdirSync(join(home, 'sub'));
    await clickLink('../sample.ts:2:3', { cwd: join(home, 'sub') });
    assert.equal(await page.getByRole('tablist', { name: '侧栏标签页' }).getByRole('tab').count(), 1);
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    await clickLink(pathToFileURL(markdown).href, { label: 'MARKDOWN_LINK' });
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    assert.equal(await page.locator('.markdown-preview strong').innerText(), 'Rendered content');
    assert.equal(await page.locator('.markdown-preview table').count(), 1);
    assert.deepEqual(await page.locator('.markdown-meta dt').allInnerTexts(), ['name', 'description', 'allowed-tools', 'homepage']);
    assert.equal(await page.locator('.markdown-meta dd').first().innerText(), 'sample-skill');
    assert.equal(await page.locator('.markdown-meta dd').last().innerText(), 'https://example.com/sample-skill');
    assert.equal(await page.locator('.markdown-preview hr, .markdown-preview h2').count(), 0);
    assert.equal(await page.evaluate(() => window.previewScriptRan), undefined);
    assert.equal(await page.locator('.markdown-code-head span').innerText(), 'ts');
    // Monaco tokenizes the fence after the text is painted, so the colors arrive a tick later.
    await page.locator('.markdown-code-body span').first().waitFor();
    // Monaco colors with the editor's theme, so a highlighted keyword takes the palette's keyword color.
    assert.equal(await page.evaluate(() => {
      const keyword = [...document.querySelectorAll('.markdown-code-body span')].find((span) => span.textContent === 'const');
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--wc-magenta');
      document.body.append(probe);
      const magenta = getComputedStyle(probe).color;
      probe.remove();
      return keyword ? getComputedStyle(keyword).color === magenta : false;
    }), true, 'a fenced block is highlighted');
    await page.locator('.markdown-code-copy').click();
    await page.getByRole('button', { name: '已复制', exact: true }).waitFor();
    assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), wide);
    const markdownPanel = page.getByRole('tabpanel', { name: '文件' });
    assert.equal(await markdownPanel.locator('.preview-path').inputValue(), markdown);
    await markdownPanel.getByRole('button', { name: 'Markdown 预览', exact: true }).click();
    assert.deepEqual(await markdownPanel.getByRole('menu', { name: '预览方式' }).getByRole('menuitem').allInnerTexts(), ['文本', 'Markdown 预览']);
    await page.screenshot({ path: 'tests/dist/screenshots/files-modes.png' });
    await page.locator('.menu-backdrop').click();
    assert.equal(await markdownPanel.getByRole('menu', { name: '预览方式' }).count(), 0);
    assert.equal(await markdownPanel.locator('.preview-mode').evaluate((element) => getComputedStyle(element).fontSize), '12px');
    assert.equal(await markdownPanel.locator('.markdown-preview').evaluate((element) => getComputedStyle(element).fontSize), '13px');
    await markdownPanel.getByRole('button', { name: 'Markdown 预览', exact: true }).click();
    await markdownPanel.getByRole('menuitem', { name: '文本', exact: true }).click();
    assert.equal(await markdownPanel.locator('.monaco-editor .view-lines').evaluate((element) => getComputedStyle(element).fontSize), '12px');
    await markdownPanel.locator('.monaco-editor .view-lines').filter({ hasText: '# Markdown preview' }).waitFor();
    await refresh.click();
    await markdownPanel.locator('.monaco-editor .view-lines').filter({ hasText: '# Markdown preview' }).waitFor();
    assert.equal(await markdownPanel.locator('.preview-mode').innerText(), '文本');
    await markdownPanel.getByRole('button', { name: '文本', exact: true }).click();
    await markdownPanel.getByRole('menuitem', { name: 'Markdown 预览', exact: true }).click();
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    // Hovering the sidebar reveals its scrollbar thumbs, so park the pointer before asserting idle panels hide theirs.
    await page.mouse.move(0, 0);
    for (const [selector, size] of [['.markdown-preview', ['10px', '12px']], ['.markdown-preview pre', ['6px', '6px']]]) {
      assert.deepEqual(await page.locator(selector).evaluate((element) => {
        const bar = getComputedStyle(element, '::-webkit-scrollbar');
        const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb');
        return [bar.width, bar.height, thumb.backgroundColor, thumb.borderRadius,
          getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor,
          getComputedStyle(element, '::-webkit-scrollbar-button').display];
      }), [...size, 'rgba(0, 0, 0, 0)', '0px', 'rgba(0, 0, 0, 0)', 'none'], selector);
    }
    const thumb = await page.locator('.markdown-preview pre').evaluate(async (element) => {
      element.scrollLeft = 40;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor;
    });
    assert.equal(thumb, 'rgba(121, 121, 121, 0.4)', 'a scrolling panel shows its scrollbar');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.markdown-preview pre'), '::-webkit-scrollbar-thumb').backgroundColor === 'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('.markdown-preview pre').evaluate(element => element.scrollWidth > element.clientWidth), true);

    // The pane scrolls rather than the page, so the scrollbar sits at the panel's right edge instead of at the divider.
    assert.deepEqual(await page.evaluate(() => {
      const pane = document.querySelector('.markdown-pane');
      const article = document.querySelector('.markdown-preview');
      return [pane.scrollHeight > pane.clientHeight, pane.clientWidth < pane.offsetWidth, article.clientWidth === article.offsetWidth];
    }), [true, true, true]);
    assert.deepEqual(await page.evaluate(async () => {
      const strip = document.querySelector('.sidebar-tabs');
      strip.style.width = '20px';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const overflow = [strip.scrollWidth > strip.clientWidth, strip.clientHeight, strip.offsetHeight];
      strip.style.width = '';
      return overflow;
    }), [true, 32, 32]);

    // The seam is a single hairline over the pane's whole height, with no gaps to read as two dividers.
    assert.deepEqual(await markdownPanel.locator('.markdown-divider').evaluate((element) => {
      const hairline = getComputedStyle(element, '::before');
      return [hairline.width, hairline.marginTop, hairline.marginBottom, parseFloat(hairline.height) === element.getBoundingClientRect().height];
    }), ['1px', '0px', '0px', true]);

    // The markdown page is sized by its own divider, and the fraction it was dragged to is remembered.
    const article = markdownPanel.locator('.markdown-preview');
    const dividerBox = await markdownPanel.locator('.markdown-divider').boundingBox();
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
    const [paneWidth, stored] = await markdownPanel.locator('.markdown-pane').evaluate((element) => [element.clientWidth, Number(localStorage.getItem('markdown-width'))]);
    assert.ok(Math.abs(stored - after / paneWidth) < 0.01, 'the dragged fraction is remembered');
    await markdownPanel.getByRole('button', { name: 'Markdown 预览', exact: true }).click();
    await markdownPanel.getByRole('menuitem', { name: '文本', exact: true }).click();
    await markdownPanel.getByRole('button', { name: '文本', exact: true }).click();
    await markdownPanel.getByRole('menuitem', { name: 'Markdown 预览', exact: true }).click();
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    assert.ok(Math.abs((await article.boundingBox()).width - after) < 2, 'a page shown again comes back to the dragged width');

    // Dragging past the page's minimum width stops the page there.
    const seam = await markdownPanel.locator('.markdown-divider').boundingBox();
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
    await page.waitForFunction(() => {
      const pane = document.querySelector('.markdown-pane');
      const article = document.querySelector('.markdown-preview');
      const divider = document.querySelector('.markdown-divider');
      return Math.abs(article.getBoundingClientRect().width - (pane.clientWidth - divider.offsetWidth)) < 2;
    });
    const fileTabs = page.getByRole('tablist', { name: '侧栏标签页' });
    await page.getByRole('button', { name: '后退', exact: true }).click();
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    await page.getByRole('button', { name: '前进', exact: true }).click();
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    const tabCount = await fileTabs.getByRole('tab').count();
    await clickLink(pathToFileURL(markdown).href, { label: 'MARKDOWN_LINK' });
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    assert.equal(await fileTabs.getByRole('tab').count(), tabCount);

    await page.screenshot({ path: 'tests/dist/screenshots/files-preview.png' });
    await clickLink(pathToFileURL(html).href, { label: 'HTML_LINK' });
    const htmlFrame = page.frameLocator('.html-frame');
    await htmlFrame.locator('#heading[data-scripted=yes]').waitFor();
    assert.equal(await htmlFrame.locator('#heading').innerText(), 'Rendered page');
    assert.equal(await page.locator('.html-frame').getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await htmlFrame.locator('body').evaluate((element) => getComputedStyle(element).fontSize), '13px');
    assert.match(await htmlFrame.locator('body').evaluate((element) => getComputedStyle(element).fontFamily), /DejaVuSansM Nerd Font Mono/);
    const htmlPanel = page.getByRole('tabpanel', { name: '文件' });
    assert.equal(await htmlPanel.locator('.preview-path').inputValue(), html);
    await htmlPanel.getByRole('button', { name: 'HTML 预览', exact: true }).click();
    assert.deepEqual(await htmlPanel.getByRole('menu', { name: '预览方式' }).getByRole('menuitem').allInnerTexts(), ['文本', 'HTML 预览']);
    await htmlPanel.getByRole('menuitem', { name: '文本', exact: true }).click();
    await htmlPanel.locator('.monaco-editor .view-lines').filter({ hasText: 'HTML_SOURCE' }).waitFor();
    await htmlPanel.getByRole('button', { name: '文本', exact: true }).click();
    await htmlPanel.getByRole('menuitem', { name: 'HTML 预览', exact: true }).click();
    await htmlFrame.getByRole('heading', { name: 'Rendered page' }).waitFor();
    await clickLink(pathToFileURL(json).href, { label: 'JSON_LINK' });
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'ready' }).waitFor();
    await page.waitForFunction(() => new Set([...document.querySelectorAll('.monaco-editor .view-line span')].map(el => getComputedStyle(el).color)).size > 1);
    await clickLink(pathToFileURL(binary).href, { label: 'BINARY_LINK' });
    await page.getByRole('alert').filter({ hasText: '暂不支持二进制' }).waitFor();
    const beforeMissing = await fileTabs.getByRole('tab').count();
    await clickLink(pathToFileURL(join(home, 'missing.ts')).href, { label: 'MISSING_LINK' });
    const published = await page.evaluate(() => window.linkClicks.length);
    await page.evaluate(({ sessionId, path }) => window.wangcai.request('terminal-agent', 'click', { sessionId, location: { path } }), { sessionId, path: 'missing.ts' });
    assert.equal(await page.evaluate(() => window.linkClicks.length), published);
    assert.equal(await fileTabs.getByRole('tab').count(), beforeMissing);
    assert.equal(await page.getByRole('alert').filter({ hasText: 'No such file' }).count(), 0);
    await address.fill(home);
    await address.press('Enter');
    await columnOf(home).getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    await columnOf(home).getByRole('button', { name: 'sub/', exact: true }).click();
    assert.equal(await address.inputValue(), join(home, 'sub'));
    await page.getByText('空目录', { exact: true }).waitFor();
    assert.equal(await page.locator('.file-column').count(), 2, 'a directory below the workspace gets a column of its own');
    await back.click();
    await columnOf(home).getByRole('button', { name: '说明 file.md', exact: true }).click();
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    await page.getByRole('button', { name: '后退', exact: true }).click();
    await columnOf(home).getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    await columnOf(home).getByRole('button', { name: 'photo.png', exact: true }).click();
    const imagePanel = page.getByRole('tabpanel', { name: '文件' });
    const shownImage = imagePanel.locator('.image-preview img');
    await shownImage.waitFor();
    assert.match(await shownImage.getAttribute('src'), /^data:image\/png;base64,/);
    assert.deepEqual(await shownImage.evaluate(async (element) => { await element.decode(); return [element.naturalWidth, element.naturalHeight]; }), [1, 1]);
    assert.equal(await imagePanel.locator('.preview-mode').count(), 0);
    assert.equal(await page.getByRole('button', { name: '前进', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    assert.equal(await page.locator('.sidebar-right').isVisible(), false);
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    await shownImage.waitFor();
    await address.fill(home);
    await address.press('Enter');
    await columnOf(home).getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    await page.screenshot({ path: 'tests/dist/screenshots/files-picker.png' });
    await run(page, `cd '${join(home, 'sub')}'`);
    await page.waitForFunction(async ({ id, path }) => {
      const result = await window.wangcai.request('files', 'list', { machine: { id: 'local', name: '本机' }, sessionId: id });
      return result.path === path;
    }, { id: sessionId, path: join(home, 'sub') });
    await page.getByRole('tablist', { name: '工作区' }).getByRole('tab').filter({ hasText: 'sub' }).waitFor();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    await columnOf(home).getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    await address.fill('sub');
    await address.press('Enter');
    await page.getByText('空目录', { exact: true }).waitFor();
    assert.equal(await address.inputValue(), join(home, 'sub'));
    await createWorkspace(page);
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    await columnOf(home).getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    await page.getByRole('tablist', { name: '工作区' }).getByRole('tab').first().click();
    await page.getByText('空目录', { exact: true }).waitFor();
    await page.screenshot({ path: 'tests/dist/screenshots/files-picker-empty.png' });
    writeFileSync(join(home, 'sub', 'inside.md'), '# Directory link preview');
    await clickLink('./sub/');
    await fileTabs.getByRole('tab', { name: '文件', exact: true }).waitFor();
    await columnOf(join(home, 'sub')).getByRole('button', { name: 'inside.md', exact: true }).click();
    await page.getByRole('heading', { name: 'Directory link preview' }).waitFor();
    await clickLink(pathToFileURL(join(home, 'sub')).href, { label: 'DIRECTORY_LINK' });
    assert.equal(await fileTabs.getByRole('tab').count(), 1);
    await columnOf(join(home, 'sub')).getByRole('button', { name: 'inside.md', exact: true }).waitFor();
    await address.fill(home);
    await address.press('Enter');
    await columnOf(home).getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.wangcai.request('terminal-agent', 'config'))).workspaces[0].sessionId, sessionId);
    await clickLink('sample.ts(2,3)');
    assert.deepEqual(await lastClick(), { type: 'file', path: code, line: 2, column: 3 });
    await clickLink('"说明 file.md", line 3', { anchor: '说明 file.md' });
    assert.deepEqual(await lastClick(), { type: 'file', path: markdown, line: 3, column: undefined });
    await printLine('missing.ts:12');
    await page.waitForFunction(() => [...document.querySelectorAll('.terminal-pane.active .xterm-rows > div')].some((row) => row.textContent.trim() === 'missing.ts:12'));
    const clicksSoFar = await page.evaluate(() => window.linkClicks.length);
    const missingPoint = await firstChar(page.locator('.terminal-pane.active .xterm-rows > div').filter({ hasText: 'missing.ts:12' }).first(), 'missing.ts:12');
    await page.mouse.move(500, 500);
    await page.mouse.move(missingPoint.x, missingPoint.y);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => !!document.querySelector('.xterm-cursor-pointer')), false);
    await page.mouse.click(missingPoint.x, missingPoint.y);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.linkClicks.length), clicksSoFar);
    // Clicking through the mouse hangs on the picker; click the element itself.
    await page.evaluate(() => document.querySelector('button[aria-label="新建侧栏标签页"]').click());
    await page.locator('#view-menu').getByRole('button', { name: '终端', exact: true }).click();
    const sidebar = page.locator('.sidebar-panel:visible .terminal-pane');
    await page.waitForFunction(() => (document.querySelector('.sidebar-panel:not([hidden]) .xterm-rows')?.textContent ?? '').trim().length > 0);
    await sidebar.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`cd '${home}'; printf '\\033[2J\\033[Hsample.ts:2\\n'`);
    await page.keyboard.press('Enter');
    const sidebarRow = sidebar.locator('.xterm-rows > div').filter({ hasText: 'sample.ts:2' }).first();
    await page.waitForFunction(() => [...document.querySelectorAll('.sidebar-panel .xterm-rows > div')].some((row) => row.textContent.trim() === 'sample.ts:2'));
    await clickPoint(await firstChar(sidebarRow, 'sample.ts:2'));
    assert.deepEqual(await lastClick(), { type: 'file', path: code, line: 2, column: undefined });
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollTop), 0);
    await desktop.close(); desktop = undefined;
    const { resolveConfig } = await import(pathToFileURL(require.resolve('electron-vite', { paths: [app] })).href);
    const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [app] })).href);
    const { config } = await resolveConfig({ root: join(app, 'desktop') }, 'serve');
    devServer = await createServer({ ...config.renderer, configFile: false, server: { port: 0, host: '127.0.0.1' } });
    await devServer.listen();
    env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${devServer.httpServer.address().port}`;
    desktop = await launchApp(home, env);
    page = await desktop.firstWindow();
    await page.locator('.workspaces').waitFor();
    // A plugin subscribes to clicks as it mounts, so the click is repeated until its preview answers.
    const preview = page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' });
    for (let attempt = 0; attempt < 100 && !await preview.count(); attempt++) {
      await page.evaluate(path => window.wangcai.publish('onclick', { type: 'file', machine: { id: 'local', name: '本机' }, path }), code);
      await page.waitForTimeout(100);
    }
    await preview.waitFor();
  } finally {
    await desktop?.close();
    await devServer?.close();
    cleanup(home);
  }
});

test('navigation history recovers its position and follows workspace tab ownership', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-files-recover-')));
  const env = testEnv(home);
  let desktop;
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
    desktop = await launchApp(home, env);
    let page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const columnOf = (path) => page.getByRole('navigation', { name: path, exact: true });
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
    await page.evaluate(file => window.wangcai.publish('onclick', file), first);
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'recovered' }).waitFor();
    await page.evaluate(file => window.wangcai.publish('onclick', file), second);
    await page.getByRole('heading', { name: 'Middle preview' }).waitFor();
    await page.evaluate(file => window.wangcai.publish('onclick', file), third);
    await page.getByRole('heading', { name: 'Latest preview' }).waitFor();
    await page.getByRole('button', { name: '后退', exact: true }).click();
    await page.getByRole('heading', { name: 'Middle preview' }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.wangcai.request('files', 'history')))[''], { entries: [first, second, third], index: 1 });
    await desktop.close(); desktop = undefined;
    desktop = await launchApp(home, env);
    page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.getByRole('heading', { name: 'Middle preview' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '后退', exact: true }).isDisabled(), false);
    assert.equal(await page.getByRole('button', { name: '前进', exact: true }).isDisabled(), false);
    await createWorkspace(page);
    const firstWorkspace = await page.evaluate(async () => (await window.wangcai.request('terminal-agent', 'config')).workspaces[0].id);
    await page.evaluate(file => window.wangcai.publish('onclick', file), second);
    await page.getByRole('heading', { name: 'Middle preview' }).waitFor();
    await page.getByRole('textbox', { name: '路径', exact: true }).fill(home);
    await page.getByRole('textbox', { name: '路径', exact: true }).press('Enter');
    await columnOf(home).getByRole('button', { name: 'first.ts', exact: true }).waitFor();
    await page.getByRole('button', { name: '后退', exact: true }).click();
    await page.getByRole('heading', { name: 'Middle preview' }).waitFor();
    await createWorkspace(page);
    const secondWorkspace = await page.evaluate(async () => (await window.wangcai.request('terminal-agent', 'config')).workspaces[1].id);
    await page.evaluate(file => window.wangcai.publish('onclick', file), third);
    await page.getByRole('heading', { name: 'Latest preview' }).waitFor();
    const stored = await page.evaluate(() => window.wangcai.request('files', 'history'));
    assert.equal('' in stored, false);
    assert.deepEqual(stored[firstWorkspace], { entries: [first, second, { type: 'directory', machine, path: home }], index: 1 });
    assert.deepEqual(stored[secondWorkspace], { entries: [third], index: 0 });
    await desktop.close(); desktop = undefined;
    desktop = await launchApp(home, env);
    page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-panel[data-plugin=files]').length === 2);
    assert.deepEqual(await page.evaluate(() => window.wangcai.request('files', 'history')), stored);
    const workspaces = page.getByRole('tablist', { name: '工作区' }).getByRole('tab');
    await workspaces.first().click();
    const fileTabs = page.getByRole('tablist', { name: '侧栏标签页' }).getByRole('tab', { name: '文件', exact: true });
    assert.equal(await fileTabs.count(), 1);
    await fileTabs.first().click();
    await page.getByRole('heading', { name: 'Middle preview' }).waitFor();
    const address = page.getByRole('textbox', { name: '路径', exact: true });
    const back = page.getByRole('button', { name: '后退', exact: true });
    const forward = page.getByRole('button', { name: '前进', exact: true });
    assert.equal(await address.inputValue(), middle);
    assert.equal(await back.isDisabled(), false);
    assert.equal(await forward.isDisabled(), false);
    const historyPath = join(home, '.local/share/wangcai/data/files/history.json');
    const modified = statSync(historyPath, { bigint: true }).mtimeNs;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('heading', { name: 'Middle preview' }).waitFor();
    await fileTabs.first().click();
    await page.evaluate(() => window.wangcai.request('files', 'history'));
    assert.equal(statSync(historyPath, { bigint: true }).mtimeNs, modified);
    await forward.click();
    await columnOf(home).getByRole('button', { name: 'first.ts', exact: true }).waitFor();
    await back.click();
    await page.getByRole('heading', { name: 'Middle preview' }).waitFor();
    await back.click();
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'recovered' }).waitFor();
    assert.equal(await address.inputValue(), code);
    assert.equal(await back.isDisabled(), true);
    await address.fill(home);
    await address.press('Enter');
    await columnOf(home).getByRole('button', { name: 'first.ts', exact: true }).waitFor();
    assert.equal(await forward.isDisabled(), true);
    assert.deepEqual((await page.evaluate(() => window.wangcai.request('files', 'history')))[firstWorkspace], {
      entries: [first, { type: 'directory', machine, path: home }], index: 1,
    });
    await workspaces.last().click();
    await fileTabs.last().click();
    await page.getByRole('heading', { name: 'Latest preview' }).waitFor();
    assert.equal(await back.isDisabled(), true);
    assert.equal(await forward.isDisabled(), true);
    await page.locator('.sidebar-tab:visible .close-tab').last().click();
    const remaining = await page.evaluate(() => window.wangcai.request('files', 'history'));
    assert.equal(secondWorkspace in remaining, false);
    assert.equal(firstWorkspace in remaining, true);
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    await columnOf(home).getByRole('button', { name: 'first.ts', exact: true }).waitFor();
    assert.equal(await back.isDisabled(), true);
    assert.equal(await forward.isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await desktop?.close();
    cleanup(home);
  }
});
