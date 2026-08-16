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
  │   ├── chapterProvider.ts          — 章节目录视图
  │   ├── chapterSummaryProvider.ts   — 章节摘要视图（卷→章，✓ 标记已建）
  │   ├── intervalSummaryProvider.ts  — 区间摘要视图（每 10 章一个区间）
  │   ├── entryProvider.ts            — 世界书/角色卡视图
  │   └── noteProvider.ts             — 笔记视图（分类目录 + 未分类笔记）
  └── test/           — 测试（*.test.ts，Mocha TDD + @vscode/test-cli）
```

## 关键约定

- **严格 TypeScript**：`strict: true`。详见 [tsconfig.json](tsconfig.json)。
- **模块系统**：`module: "Node16"`。使用 `import`/`export` 语法编写，esbuild 输出为 CJS。
- **VS Code 目标版本**：`^1.95.0`（Language Model Tools API 的最低稳定版本）。
- **用户界面文本**使用简体中文。
- 每本书是 `xReader.libraryPath` 下的一个文件夹，包含 `元数据.md` 与 `章节/`、`世界书/`、`角色卡/`、`章节摘要/`、`区间摘要/`、`笔记/` 目录。
- `章节摘要/` 镜像 `章节/` 的分卷结构（同名 `NNNN-标题.md`）；`区间摘要/` 每 10 章一个文件（`NNNN-MMMM.md`，序号取区间首尾章节）；两者点击视图项时按需从模板创建。
- `笔记/` 支持分类子目录（即分类）；笔记可用 frontmatter `chapter` 字段（章节相对路径）关联章节，也可完全独立。
- **Agent 工具**（`vscode.lm.registerTool`，声明于 `contributes.languageModelTools`）：`xReader_listVolumes` / `xReader_listChapters` / `xReader_readChapterSummary` / `xReader_readIntervalSummary` / `xReader_createVolume` / `xReader_renameVolume` / `xReader_deleteVolume` / `xReader_listNotes` / `xReader_createNote` / `xReader_listCharacters` / `xReader_createCharacter` / `xReader_listWorldEntries` / `xReader_createWorldEntry`。章节正文与文件内容的读写搜索直接用内置文件工具；agent 经工具的写操作会做一次 git checkpoint 提交。
- `.vscodeignore` 排除了 `src/`（含测试）与构建文件 — 运行时代码位于 `dist/`。

## 注意事项

- 测试使用 Mocha TDD（`suite`/`test`），由 `@vscode/test-cli` 在扩展宿主内执行。
- txt 编码识别与章节目录解析逻辑集中在 `services/novelParser.ts`，新增解析规则时同步补充 `src/test/` 中的单测。
