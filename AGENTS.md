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
  │   ├── entryProvider.ts            — 世界书/角色卡视图
  │   └── noteProvider.ts             — 笔记视图（分类目录 + 未分类笔记）
  └── test/           — 测试（*.test.ts，Mocha TDD + @vscode/test-cli）
```

## 关键约定

- **严格 TypeScript**：`strict: true`。详见 [tsconfig.json](tsconfig.json)。
- **模块系统**：`module: "Node16"`。使用 `import`/`export` 语法编写，esbuild 输出为 CJS。
- **VS Code 目标版本**：`^1.95.0`（Language Model Tools API 的最低稳定版本）。
- **用户界面文本**使用简体中文；本地化见「关键约定 · 本地化」。
- **本地化**：静态字符串（displayName/description/命令标题/视图名/配置说明/工具 displayName）在 `package.json` 中写 `%key%` 引用，翻译在 `package.nls.json`（英文默认）+ `package.nls.zh-cn.json`（中文）；代码内 UI 字符串用 `vscode.l10n.t('英文消息', 参数)`，翻译在 `l10n/bundle.l10n.zh-cn.json`（英文源 `bundle.l10n.json` 为清单）。**不本地化**：`modelDescription`（给 agent 的中文提示）与 xReader 工具返回的结果文本（agent 工作域保持中文）。新增 UI 字符串时须同步更新 bundle 文件。
- 每本书是 `xReader.libraryPath` 下的一个文件夹，包含 `元数据.md` 与 `章节/`、`世界书/`、`角色卡/`、`章节摘要/`、`区间摘要/`、`笔记/`、`版本/` 目录。
- **子书架**：书架视图分两级（子书架 → 书）。内置「默认」子书架收录全部书，不出现在 书架.json 中；自定义子书架存于库根 `书架.json`，只存书文件夹名链接（不复制书）。书改名/删除时经 `LibraryService.updateShelfBookRefs` 级联同步链接；书树节点在自定义子书架下 `contextValue` 为 `shelfBook`（书籍管理操作仍在默认子书架做）。
- **图标全部自绘**：所有图形都在 `resources/icons/*.svg`（16×16、`fill="#6e6e6e"` 实心基底 + `mask id="cut"` 镂空细节，规范见仓库记忆），命令 `icon`、视图 `name` 图标、Language Model 工具 `icon` 一律写 `resources/icons/xxx.svg` 路径，**不使用内置 codicon `$(...)`**（工具 icon 的字符串非 `$( )` 形式时 VS Code 会按扩展目录解析为图标路径）。唯一例外是状态栏文本与 QuickPick 标签——它们只接受 codicon，故这两处不带图标；树节点状态标记 `●`（读到）/`✓`（摘要最新）/`⚠`（摘要待维护）是文本字形，不属于图标体系。
- `章节摘要/` 镜像 `章节/` 的分卷结构（同名 `NNNN-标题.md`）；`区间摘要/` 每 10 章一个文件（`NNNN-MMMM.md`，序号取区间首尾章节）；两者点击视图项时按需从模板创建。
- **章节版本**：`版本/<卷>/<章节文件名去 .md>/<版本名>.md` 存放章节备选版本；主版本始终是 `章节/` 下那个文件，阅读顺序、导航、摘要、进度、笔记关联只认主版本。操作经 `LibraryService.createChapterVersion` / `promoteChapterVersion` / `renameChapterVersion` / `deleteChapterVersion`（`listVolumeVersionCounts` 供章节目录视图显示版本数与展开箭头）；`relocateChapterFiles` 级联搬运版本目录（章节改名/跨卷移动/插章顺延），`removeChapter` 连带删除版本目录。切换主版本是**内容原地替换**（原主版本自动存为版本「原版」），摘要靠 mtime 自动转待维护。章节目录视图中章节节点 `contextValue` 仍为 `chapter`，版本子节点为 `chapterVersion`。
- **摘要状态靠文件修改时间判定**（`SummaryState`: missing / ok / stale）：章节文件比其摘要镜像新即为「待维护」，区间摘要在区间内任一章节更新后同样转为待维护；重新保存摘要即自动恢复最新，无需额外状态文件。因此**重写章节文件时必须只做必要写入**：`rewriteChapterNav` 这类仅导航变化的改动会用 `fs.utimes` 还原原修改时间，避免插章/删章把相邻章摘要误判成待维护。视图标 `⚠`/`✓`，agent 侧见 `xReader_listChapters` 的「｜摘要待维护」与读摘要工具返回的过期提示。
- `元数据.md` 的 frontmatter 字段与 `## 简介` / `## 写作要求` 等小节完全由用户或 agent 维护（**不从导入的 txt 解析**），解析见 `parseBookMetadata`，由「元数据」视图展示（字段与小节均可点击跳到对应行编辑；文件缺失时 `LibraryService.ensureMetadata` 按模板重建）。
- `笔记/` 支持分类子目录（即分类）；笔记可用 frontmatter `chapter` 字段（章节相对路径）关联章节，也可完全独立。
- **Agent 工具**（`vscode.lm.registerTool`，声明于 `contributes.languageModelTools`，按 书→卷→章→笔记→角色卡→世界书 分组）：
  - 书：`xReader_getCurrentChapter` / `xReader_listBooks` / `xReader_createBook` / `xReader_renameBook` / `xReader_deleteBook`
  - 分卷：`xReader_listVolumes` / `xReader_createVolume` / `xReader_renameVolume` / `xReader_deleteVolume`
  - 章节：`xReader_listChapters` / `xReader_listChapterVersions` / `xReader_createChapterVersion` / `xReader_setPrimaryChapterVersion` / `xReader_deleteChapterVersion` / `xReader_createChapter` / `xReader_insertChapter` / `xReader_moveChapter` / `xReader_renameChapter` / `xReader_deleteChapter` / `xReader_setProgress` / `xReader_readChapterSummary` / `xReader_readIntervalSummary`
  - 笔记：`xReader_listNotes` / `xReader_createNote` / `xReader_renameNote` / `xReader_deleteNote` / `xReader_renameNoteCategory` / `xReader_deleteNoteCategory`
  - 角色卡：`xReader_listCharacters` / `xReader_createCharacter` / `xReader_renameCharacter` / `xReader_deleteCharacter`
  - 世界书：`xReader_listWorldEntries` / `xReader_createWorldEntry` / `xReader_renameWorldEntry` / `xReader_deleteWorldEntry`
  **分工**：结构化操作（列书/卷/章、读摘要、设置进度、新建/移动/重命名/删除卷章书与条目）用 xReader 工具；章节正文与文件内容的读写搜索直接用内置文件工具。写操作在 LibraryService 层统一做 git 快照提交。
  **LibraryService 内部约定**：写操作结尾用 `commitAndRefresh(消息)` 一步完成快照 + 视图刷新（`commit` 只提交不刷新）；章节与摘要镜像路径一律经 `chapterPath` / `summaryPath` 拼接，章节改名、跨卷移动、插入顺延都复用 `relocateChapterFiles`（同时搬运摘要镜像）；阅读进度只经 `getProgress` / `setProgress` / `clearProgress` 读写；笔记章节关联用 `updateNotesChapterRef`（批量版 `updateNotesChapterRefs`，一次遍历）。tools.ts 侧复用 `requireChapter` / `pickVolume` / `requireEntry` / `resolveNoteDir` / `requireNote` 做引用解析与报错列现有项。
- **章节改名两个等价入口，效果一致**：`xReader_renameChapter`（或章节目录右键「重命名章节」）与直接编辑章节内容首行 `# 标题` 后保存——都会级联更新：文件名（序号不变，标题取清洗版）、内容首行标题、相邻章导航链接、章节摘要镜像、关联笔记引用与阅读进度（watcher 检测首行标题变化自动触发，见 `LibraryService.syncChapterTitle`）。**不要用文件工具直接重命名/移动 章节/ 下的 md**，否则相邻章导航留下死链、进度与笔记关联丢失。
- **插章用 `xReader_insertChapter`**（`after`/`before` 指定参照章节，二者只给一个；新章节归入参照章节所在分卷）：序号有空档时直接插入，无空档时该位置及其后章节序号顺延 +1（`planChapterInsertSeq` 决策，`LibraryService.shiftChapterSeqs` 按序号降序改名并同步摘要镜像、笔记关联与进度），最后统一重写导航并提交一次快照。手工新建/改名 章节/ 下的 md 来插章同样会留下死链与失联数据。
- **跨卷移动用 `xReader_moveChapter`**（`LibraryService.moveChapter`，序号与文件名不变，搬运摘要镜像、重写全书导航、迁移进度与笔记关联）；用文件工具直接挪 章节/ 下的 md 会留下死链与失联数据。
- `xReader_getCurrentChapter` 无参数：从活动编辑器解析当前书与章节（打开书内任意文件即可定位），回退当前书架选中的书与阅读进度，并一并返回本书 `元数据.md` 的字段与各小节（简介、写作要求等，agent 无需再读一遍文件）。先调用它取得当前上下文，可省略其他工具的 `book` 参数；操作其他书时先 `xReader_listBooks` 或显式传 `book`（书文件夹名）。
- `.vscodeignore` 排除了 `src/`（含测试）与构建文件 — 运行时代码位于 `dist/`。

## 注意事项

- 测试使用 Mocha TDD（`suite`/`test`），由 `@vscode/test-cli` 在扩展宿主内执行。
- txt 编码识别与章节目录解析逻辑集中在 `services/novelParser.ts`，新增解析规则时同步补充 `src/test/` 中的单测。
