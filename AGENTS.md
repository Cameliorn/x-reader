# X Reader — VS Code 扩展

在 VS Code 中导入本地 txt 小说，自动解析为 Markdown 章节书库，提供书架、章节目录、世界书/角色卡视图、阅读进度与 Git 快照。

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
  │   ├── library.ts      — 书库目录、进度与条目管理
  │   ├── bookFactory.ts  — 从 txt 创建书籍四件套与章节 Markdown
  │   ├── novelParser.ts  — txt 编码识别与卷/章解析
  │   ├── markdown.ts     — 章节 Markdown 与文件命名工具
  │   └── git.ts          — 书籍目录 Git 快照
  ├── views/          — 树视图层
  │   ├── bookshelfProvider.ts — 书架视图
  │   ├── chapterProvider.ts   — 章节目录视图
  │   └── entryProvider.ts     — 世界书/角色卡视图
  └── test/           — 测试（*.test.ts，Mocha TDD + @vscode/test-cli）
```

## 关键约定

- **严格 TypeScript**：`strict: true`。详见 [tsconfig.json](tsconfig.json)。
- **模块系统**：`module: "Node16"`。使用 `import`/`export` 语法编写，esbuild 输出为 CJS。
- **VS Code 目标版本**：`^1.85.0`。
- **用户界面文本**使用简体中文。
- 每本书是 `xReader.libraryPath` 下的一个文件夹，包含 `书籍信息.md`、`章节/`、`世界书/`、`角色卡/` 四件套。
- `.vscodeignore` 排除了 `src/`（含测试）与构建文件 — 运行时代码位于 `dist/`。

## 注意事项

- 测试使用 Mocha TDD（`suite`/`test`），由 `@vscode/test-cli` 在扩展宿主内执行。
- txt 编码识别与章节目录解析逻辑集中在 `services/novelParser.ts`，新增解析规则时同步补充 `src/test/` 中的单测。
