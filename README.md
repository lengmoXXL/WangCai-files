# 旺财文件视图（files）

旺财右侧的文件视图：目录浏览、文本预览（Monaco + 语言服务），以及一个搜文件、搜内容、搜符号的面板。

它会读一切能被当成文本的东西（代码、Markdown、HTML、JSON……），只按文字显示；
图片、渲染后的 Markdown 与 HTML 页面都归 preview 插件。

## 配置

在 `~/.config/wangcai/init.ts` 的标签页条目里写 `config`，改完重启 App 生效：

```ts
tabs: [
  { id: 'files', config: { font: { size: 13 } } },
  // `<C-p>` 把文件交给 preview 插件，所以它也要在列表里。
  { id: 'preview' },
  { id: 'terminal' },
],
```

### `font`

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `family` | `"DejaVuSansM Nerd Font Mono", monospace` | 面板与代码的字体 |
| `size` | `12` | 代码的字号（面板文字固定 12px） |
| `lineHeight` | 编辑器默认 | 行高倍数，乘 `size` |

### `lsp`

按 Monaco 的语言名分键，每个键是文件所在的那台机器上要启动的语言服务。每一项的参数：

| 参数 | 说明 |
| --- | --- |
| `command` | 命令加上它的参数，按 stdio 通信 |
| `markers` | 从文件所在目录往上找，最近的含这些文件（或 `.git`）的目录作为服务索引的根 |

整个条目写 `false` 则不启动这种语言的服务。

内置的默认值：

| 语言 | 命令 | 根标记 |
| --- | --- | --- |
| `typescript` `javascript` `typescriptreact` `javascriptreact` | `typescript-language-server --stdio` | `tsconfig.json` `jsconfig.json` `package.json` |
| `go` | `gopls` | `go.mod` `go.work` |
| `rust` | `rust-analyzer` | `Cargo.toml` |
| `c` `cpp` | `clangd` | `compile_commands.json` `.clangd` `CMakeLists.txt` |
| `python` | `pyright-langserver --stdio`，没有就用 `pylsp` | `pyproject.toml` `setup.py` `requirements.txt` |
| `shell` | `bash-language-server start` | 无 |

默认表里的语言：不写就用表里的命令，只写了 `command` 或 `markers` 之一时，另一项仍用表里的默认值。
表外的语言务必写 `command`，只写 `markers` 不会启动服务。

```ts
config: {
  lsp: {
    lua: { command: ['lua-language-server'] },
    rust: false,
  },
},
```

圆点显示“未启动”，说明这条语言服务没能启动；悬停可以看到原因。

### `vim.keys`

文本预览按 vim 的常规模式读，只读，没有插入模式。键只在文本预览里、且代码文本拿着键盘时生效。
例外是 `<C-p>`：焦点不在任何输入框里时它仍然有效——比如焦点在页头的按钮或插件自己的标签页与列表上。

默认的键与动作：

| 键 | 动作 |
| --- | --- |
| `h` `j` `k` `l` | 左 下 上 右 |
| `w` `b` `e` | 下一个词首、上一个词首、下一个词尾 |
| `0` `^` `$` | 行首、行首第一个非空字符、行尾 |
| `gg` `G` | 文件首行、末行 |
| `<C-d>` `<C-u>` | 下半页、上半页 |
| `zz` `zt` `zb` | 当前行居中、置顶、置底 |
| `/` `n` `N` | 编辑器内查找，下一个、上一个匹配 |
| `<C-f>` | 文件、内容、符号的搜索面板 |
| `<C-p>` | 交给 preview 插件 |
| `gd` | 跳到光标下名字的定义 |
| `<C-o>` `<C-i>` | 在跳转过的位置之间后退、前进（跨文件，回到原来那一行） |
| `f` `F` `t` `T` | 行内找字符，`F` `T` 反向，`t` `T` 停在字符旁边而不落到它上面 |
| `;` `,` | 重复上一次找字符，`,` 反方向 |
| `v` `V` `y` | 按字符选择、按行选择、把选择复制到剪贴板 |

数字前缀表示次数：`3j` 下移三行，`2fX` 到第二个 `X`。

这些键都能改或删，结束选择用的 `Esc` 除外（它不在这张键表里，固定生效）。改键的值有三类：

| 值 | 含义 |
| --- | --- |
| `vim.*` 名字 | 本插件的动作，见下表 |
| Monaco 命令 id | 编辑器自己的命令，如 `cursorTop`、`actions.find` |
| `false` | 删掉这个键 |

本插件的动作：

| 动作 | 说明 |
| --- | --- |
| `vim.center` `vim.top` `vim.bottom` | 当前行居中、置顶、置底 |
| `vim.definition` | 跳到定义 |
| `vim.search` | 打开搜索面板 |
| `vim.preview` | 把当前显示的文件发给 preview 插件，并把它的标签页调到前面 |
| `vim.jumpBack` `vim.jumpForward` | 跳转位置的后退与前进 |
| `vim.seek` `vim.seekBack` `vim.seekTill` `vim.seekTillBack` | 行内找字符的四种 |
| `vim.seekAgain` `vim.seekAgainBack` | 重复上一次找字符，后者反方向 |
| `vim.visual` `vim.visualLine` | 按字符、按行开始或结束选择 |
| `vim.yank` | 复制选择 |

写法跟默认键表一样：多键序列是 `gg`、`zz`，带修饰的是 `<C-o>`、`<C-d>`。

表里没有的键会新增一个绑定。

```ts
config: {
  vim: {
    keys: {
      '<C-s>': 'vim.search',
      G: 'cursorTop',
      gg: false,
    },
  },
},
```
