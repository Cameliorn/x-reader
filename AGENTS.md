# X Reader — VS Code 扩展

在 VS Code 中导入本地 txt 小说，自动解析为 Markdown 章节书库，提供书架、章节目录、章节/区间摘要、世界书/角色卡、笔记视图、阅读进度与 Git 快照，并向 Copilot agent 暴露 Language Model 工具。

## 构建与测试

- **编译**：`npm run compile` — `tsc --noEmit` 类型检查 + ESLint + esbuild 打包，输出 `dist/extension.js`（入口 `./dist/extension.js`）
- **测试编译**：`npm run compile-tests` — TypeScript 编译测试代码到 `out/`
- **代码检查**：`npm run lint` — ESLint 9 flat config 检查 `src/`
- **测试**：`npm test` — `vscode-test`（@vscode/test-cli）在 VS Code Extension Host 中以 Mocha（TDD）运行 `out/test/**/*.test.js`，配置见 `.vscode-test.mjs`
- **打包**：`npm run package` — 构建生产 bundle（esbuild `--production`）；`vsce package` 发布前会自动执行 `vscode:prepublish`

## 架构

```
extension.ts          — 入口（activate），注册命令、树视图与阅读流程
  ├── model/          — 领域模型
  │   └── book.ts     — 书籍、章节、条目等类型定义
  ├── services/       — 业务服务层
  │   ├── library.ts      — 书库目录、进度、条目与摘要/笔记管理
  │   ├── bookFactory.ts  — 从 txt 创建书籍目录骨架与章节 Markdown
  │   ├── novelParser.ts  — txt 编码识别与卷/章解析
  │   ├── markdown.ts     — 章节/摘要/笔记 Markdown 与文件命名工具
  │   └── git.ts          — 书籍目录 Git 快照
  ├── tools.ts        — Language Model 工具注册（agent 集成）
  ├── views/          — 树视图层
  │   ├── bookshelfProvider.ts        — 书架视图
  │   ├── metadataProvider.ts         — 元数据视图（当前书 元数据.md 的字段与二级小节，点击跳到对应行）
  │   ├── chapterProvider.ts          — 章节目录视图
  │   ├── summaryProvider.ts          — 摘要视图（顶层分 章节摘要（卷→章）/ 区间摘要（每 10 章一个区间），✓ 标记已建）
  │   └── entryProvider.ts            — 条目视图（世界书/角色卡/笔记 三处共用：多级分类目录 + 各层条目）
  └── test/           — 测试（*.test.ts，Mocha TDD + @vscode/test-cli）
```

## 关键约定

- **严格 TypeScript**：`strict: true`。详见 [tsconfig.json](tsconfig.json)。
- **模块系统**：`module: "Node16"`。使用 `import`/`export` 语法编写，esbuild 输出为 CJS。
- **VS Code 目标版本**：`^1.95.0`（Language Model Tools API 的最低稳定版本）。
- **用户界面文本**使用简体中文；本地化见「关键约定 · 本地化」。
- **本地化**：静态字符串（displayName/description/命令标题/视图名/配置说明/工具 displayName）在 `package.json` 中写 `%key%` 引用，翻译在 `package.nls.json`（英文默认）+ `package.nls.zh-cn.json`（中文）；代码内 UI 字符串用 `vscode.l10n.t('英文消息', 参数)`，翻译在 `l10n/bundle.l10n.zh-cn.json`（英文源 `bundle.l10n.json` 为清单）。**不本地化**：`modelDescription`（给 agent 的中文提示）与 xReader 工具返回的结果文本（agent 工作域保持中文）。新增 UI 字符串时须同步更新 bundle 文件。
- **大书库性能约定**（目标：上千本书 / 100MB 级仓库）：
  - 目录扫描一律经 `library.ts` 的 `mapLimit`（`SCAN_CONCURRENCY = 16`）分批执行，不要写无上限的 `Promise.all` 映射——上千本书或上千章时会同时打开过多句柄（EMFILE）。`listBooks`、分卷/章节扫描、章节摘要状态判定都已走这条路。
  - 只需要「章节数」时用 `countChapters(book)` / `listChapterCounts(books)`（只列目录），**不要**用 `listChapters(book).length`——后者会逐章打开文件读首行标题，为计数付出读正文的代价。
  - 书库变更通知统一走 `LibraryService.scheduleRefresh()`（80ms 合并窗口），不要直接 `_onDidChange.fire()`：批量操作（连续导入、批量改名）逐次触发会让每个视图各来一次全量重扫。
  - 书架视图书数超过 `INLINE_CHAPTER_COUNT_LIMIT`（50）时改为后台补章节计数、完成后二次刷新，保证大书库展开即刻出节点；书架视图内不要改回同步 `listChapters` 计数。
- 每本书是 `xReader.libraryPath` 下的一个文件夹，包含 `元数据.md` 与 `章节/`、`世界书/`、`角色卡/`、`章节摘要/`、`区间摘要/`、`笔记/`、`版本/` 目录。
- **子书架**：书架视图为多级树（子书架 → 子书架 → … → 书）。内置「默认」子书架收录全部书，不出现在 书架.json 中；自定义子书架存于库根 `书架.json`，`name` 是多级路径（用 `/` 连接，如 `题材/同人/XXX`），只存书文件夹名链接（不复制书）。新建时可直接输入多级路径，也可在子书架节点右键「新建子书架」往下一层挂（缺的上级路径在读取时自动补出）。重命名只改末级名、删除会连同其下全部子书架（书本身不删）；书改名/删除时经 `LibraryService.updateShelfBookRefs` 级联同步链接；书树节点在自定义子书架下 `contextValue` 为 `shelfBook`（书籍管理操作仍在默认子书架做）。路径工具 `shelfParentPath` / `shelfLeafName` 供视图与命令复用。
- **图标全部自绘**：所有图形都在 `resources/icons/*.svg`（16×16、`fill="#6e6e6e"` 实心基底 + `mask id="cut"` 镂空细节，规范见仓库记忆），命令 `icon`、视图 `name` 图标、Language Model 工具 `icon` 一律写 `resources/icons/xxx.svg` 路径，**不使用内置 codicon `$(...)`**（工具 icon 的字符串非 `$( )` 形式时 VS Code 会按扩展目录解析为图标路径）。唯一例外是状态栏文本与 QuickPick 标签——它们只接受 codicon，故这两处不带图标；树节点状态标记 `●`（读到）/`✓`（摘要最新）/`⚠`（摘要待维护）是文本字形，不属于图标体系。
- `章节摘要/` 镜像 `章节/` 的分卷结构（同名 `NNNN-标题.md`）；`区间摘要/` 每 10 章一个文件（`NNNN-MMMM.md`，序号取区间首尾章节）；两者点击视图项时按需从模板创建。
- **章节版本**：`版本/<卷>/<章节文件名去 .md>/<版本名>.md` 存放章节备选版本；主版本始终是 `章节/` 下那个文件，阅读顺序、导航、摘要、进度、笔记关联只认主版本。操作经 `LibraryService.createChapterVersion` / `promoteChapterVersion` / `renameChapterVersion` / `deleteChapterVersion`（`listVolumeVersionCounts` 供章节目录视图显示版本数与展开箭头）；`relocateChapterFiles` 级联搬运版本目录（章节改名/跨卷移动/插章顺延），`removeChapter` 连带删除版本目录。切换主版本是**内容原地替换**（原主版本自动存为版本「原版」），摘要靠 mtime 自动转待维护。章节目录视图中章节节点 `contextValue` 仍为 `chapter`，版本子节点为 `chapterVersion`。
- **摘要状态靠文件修改时间判定**（`SummaryState`: missing / ok / stale）：章节文件比其摘要镜像新即为「待维护」，区间摘要在区间内任一章节更新后同样转为待维护；重新保存摘要即自动恢复最新，无需额外状态文件。因此**重写章节文件时必须只做必要写入**：`rewriteChapterNav` 这类仅导航变化的改动会用 `fs.utimes` 还原原修改时间，避免插章/删章把相邻章摘要误判成待维护。视图标 `⚠`/`✓`，agent 侧见 `xReader_listChapters` 的「｜摘要待维护」与读摘要工具返回的过期提示。
- `元数据.md` 的 frontmatter 字段与 `## 简介` / `## 说明` 等小节完全由用户或 agent 维护（**不从导入的 txt 解析**），解析见 `parseBookMetadata`，由「元数据」视图展示（字段与小节均可点击跳到对应行编辑；文件缺失时 `LibraryService.ensureMetadata` 按模板重建）。
- **条目分类**（世界书/角色卡/笔记 三处一致）：`世界书/`、`角色卡/`、`笔记/` 下的**子目录即分类，可多级嵌套**（用 `/` 连接，如 `世界书/地理/城邦/`）；三个视图共用 `views/entryProvider.ts`（`EntryTreeNode` = `category` 折叠节点 + `entry` 条目节点，分类 `contextValue` 为 `entryCategory`，条目按视图为 `entry`/`note`），排序为「子分类在前、条目在后」，根目录条目即不分类。分类 API 全部以条目根目录为参数：`listChildCategories(book, subDir, path?)`（某层直接子分类）、`listCategories(book, subDir)`（递归展平，供选择列表与工具分组）、`createCategory`（新建空分类并放 `.gitkeep`，空目录才会进 git 快照）、`renameCategory`（只改末级名，父路径与内容随目录迁移）、`deleteCategory`（递归删除）；`listEntries(book, subDir, path?)`、`createEntry(book, subDir, name, path?)`、`createNote(..., path?, ...)`、`moveEntry(book, rootDir, categoryPath, fileName, targetCategoryPath)`（跨分类移动，目标分类不存在则创建）。**分类路径一律经 `safeCategoryPath`（内部走 `sanitizeRelativePath`）逐段清洗**（防路径穿越，`listEntries` / `listChildCategories` / `renameCategory` / `deleteCategory` / `moveEntry` 统一走它）；条目文件名、章节版本名与分卷目录名同样分别经 `path.basename` / `sanitizeFileTitle` / `assertVolumeName` 校验。笔记的章节关联链接按分类层级计算相对前缀 `'../'.repeat(层级 + 1)`（见 `createNote`、`updateNotesChapterRefs` 与 `rewriteNoteChapterLink`）——**凡是改变笔记所在层级或分类路径的操作都必须重算前缀**，勿写死 `../../`。
- **条目视图与章节目录的操作对齐**：三个条目视图（世界书/角色卡/笔记）的标题栏各有「新建 …分类」按钮（`xReader.newWorldCategory` / `newCharacterCategory` / `newNoteCategory`，图标 `add-category.svg`，建在条目根目录下，支持多级路径），分类节点右键为「新建子分类 / 重命名 / 删除」（`xReader.newCategory` 等三个命令由 `extension.ts` 的 `createCategory` 统一实现）；条目右键「移动到分类」（`xReader.moveEntry`，`LibraryService.moveEntry`）与章节目录的「移动到分卷」同一分组（`1_modify`），目标为同根下的任意分类或根目录，笔记的章节链接随之重算。
- `笔记/` 的笔记可用 frontmatter `chapter` 字段（章节相对路径）关联章节，也可完全独立。
- **Agent 工具**（`vscode.lm.registerTool`，声明于 `contributes.languageModelTools`，共 13 个）：写操作按实体合并进一个工具、用 `action` 参数区分（create / rename / delete / move / insert / list / setPrimary），条目与分类再用 `kind` 参数区分三处（world=世界书 / character=角色卡 / note=笔记）——同族操作不再逐个注册。
  - 书：`xReader_getCurrentChapter`（无参数取上下文）/ `xReader_listBooks` / `xReader_manageBook`（create / rename / delete）
  - 分卷：`xReader_listVolumes` / `xReader_manageVolume`（create / rename / delete）
  - 章节：`xReader_listChapters` / `xReader_manageChapter`（create / insert / rename / move / delete）/ `xReader_manageChapterVersion`（list / create / setPrimary / delete）
  - 摘要与进度：`xReader_readSummary`（scope=chapter|interval）/ `xReader_setProgress`
  - 条目与分类：`xReader_listEntries`（kind）/ `xReader_manageEntry`（kind + create / rename / move / delete）/ `xReader_manageCategory`（kind + create / rename / delete）
  各工具的 `modelDescription` 与 `inputSchema`（enum + 逐参数说明）写在 package.json；不同 action 的必填项不同，运行时校验在 tools.ts（`requireEnum` / `requireKind` / `requireParam`）。
  `contributes.languageModelTools` 的数组顺序 = 聊天工具选择器中的显示顺序，与 tools.ts 的注册顺序一致（读类在前、写类在后）。
  **条目类型的单一配置**：tools.ts 的 `ENTRY_KINDS`（根目录 / 中文名词 / 找不到条目的模板 / 调用提示与删除确认文案）是三种条目差异的唯一来源，新增条目类型或改文案只改这里。
  **分工**：结构化操作（列书/卷/章、读摘要、设置进度、新建/移动/重命名/删除卷章书与条目）用 xReader 工具；章节正文与文件内容的读写搜索直接用内置文件工具。写操作在 LibraryService 层统一做 git 快照提交。条目 list 按分类分组输出（`listEntriesGrouped`）；`manageEntry` / `manageCategory` 的 `category`、`manageEntry` 的 `targetCategory` 支持多级路径，也可写唯一的末级名——`matchCategory` / `resolveTargetCategory` 命中已有分类时取其规范路径，未命中则按路径新建。
  **LibraryService 内部约定**：写操作结尾用 `commitAndRefresh(消息)` 一步完成快照 + 视图刷新（`commit` 只提交不刷新）；章节与摘要镜像路径一律经 `chapterPath` / `summaryPath` 拼接，章节改名、跨卷移动、插入顺延都复用 `relocateChapterFiles`（同时搬运摘要镜像）；阅读进度只经 `getProgress` / `setProgress` / `clearProgress` 读写；笔记章节关联用 `updateNotesChapterRef`（批量版 `updateNotesChapterRefs`，一次遍历）。tools.ts 侧复用 `requireChapter` / `pickVolume` / `requireEntry` / `requireCategory` / `requireEntryIn` / `matchCategory` / `resolveTargetCategory` 做引用解析与报错列现有项。
- **章节改名两个等价入口，效果一致**：`xReader_manageChapter`（action=rename，或章节目录右键「重命名章节」）与直接编辑章节内容首行 `# 标题` 后保存——都会级联更新：文件名（序号不变，标题取清洗版）、内容首行标题、相邻章导航链接、章节摘要镜像、关联笔记引用与阅读进度（watcher 检测首行标题变化自动触发，见 `LibraryService.syncChapterTitle`）。**不要用文件工具直接重命名/移动 章节/ 下的 md**，否则相邻章导航留下死链、进度与笔记关联丢失。
- **插章用 `xReader_manageChapter`（action=insert）**（`after`/`before` 指定参照章节，二者只给一个；新章节归入参照章节所在分卷）：序号有空档时直接插入，无空档时该位置及其后章节序号顺延 +1（`planChapterInsertSeq` 决策，`LibraryService.shiftChapterSeqs` 按序号降序改名并同步摘要镜像、笔记关联与进度），最后统一重写导航并提交一次快照。手工新建/改名 章节/ 下的 md 来插章同样会留下死链与失联数据。
- **跨卷移动用 `xReader_manageChapter`（action=move）**（`LibraryService.moveChapter`，序号与文件名不变，搬运摘要镜像、重写全书导航、迁移进度与笔记关联）；用文件工具直接挪 章节/ 下的 md 会留下死链与失联数据。
- `xReader_getCurrentChapter` 无参数：从活动编辑器解析当前书与章节（打开书内任意文件即可定位），回退当前书架选中的书与阅读进度，并一并返回本书 `元数据.md` 的字段与各小节（简介、说明等，agent 无需再读一遍文件）。先调用它取得当前上下文，可省略其他工具的 `book` 参数；操作其他书时先 `xReader_listBooks` 或显式传 `book`（书文件夹名）。
- `.vscodeignore` 排除了 `src/`（含测试）与构建文件 — 运行时代码位于 `dist/`。

## 注意事项

- 测试使用 Mocha TDD（`suite`/`test`），由 `@vscode/test-cli` 在扩展宿主内执行。
- txt 编码识别与章节目录解析逻辑集中在 `services/novelParser.ts`，新增解析规则时同步补充 `src/test/` 中的单测。
