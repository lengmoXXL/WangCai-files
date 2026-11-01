# 旺财文件视图（files）

旺财右侧的目录视图：翻目录，点一个文件把它交给 editor 插件。

它没有自己的头部行——面板上直接就是列；图片、渲染后的 Markdown 与 HTML 归 preview 插件。

点目录在这一列后面开一列。文件走的是终端里点文件链接那条 `onclick`；反方向也成立——别处发来的目录链接
落在这里。

## 配置

在 `~/.config/wangcai/init.ts` 的标签页条目里写 `config`，改完重启 App 生效：

```ts
tabs: [
  { id: 'files', config: { font: { family: '"DejaVuSansM Nerd Font Mono", monospace' } } },
  // 点开的文件交给它，所以它也要在列表里。
  { id: 'editor' },
  { id: 'terminal' },
],
```

`font.family` 是面板的字体，默认 `"DejaVuSansM Nerd Font Mono", monospace`。

## 键

`<leader>ff`（默认 `<Space>ff`）把本视图调到前面。

## 标签页

一个窗口给每个工作区留一份本插件的标签页，各显示各的列。
还没有显示目录的标签页，打开时取的是当时终端的目录（之后终端换目录不会再跟）。
