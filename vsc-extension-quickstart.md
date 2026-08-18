# 开发指南

X Reader 扩展的开发、调试与测试说明。

## 环境要求

- Node.js 20+ 与 npm
- VS Code 1.95+（扩展运行目标版本）

## 编译与开发

```bash
npm install        # 安装依赖
npm run compile    # 类型检查 + ESLint + esbuild，输出 dist/extension.js
```

按 `F5` 启动「扩展开发宿主」加载扩展；修改源码后重新加载窗口（`Ctrl+R`）即可生效。开发时可保持 `npm run watch` 运行，源码变更自动重编译。

## 常用脚本

| 脚本 | 说明 |
| --- | --- |
| `npm run compile` | `tsc --noEmit` + ESLint + esbuild，输出 `dist/extension.js` |
| `npm run watch` | 监听源码变更自动重编译 |
| `npm run compile-tests` | 编译测试代码到 `out/` |
| `npm test` | 在扩展宿主内运行全部测试（`pretest` 自动先编译） |
| `npm run lint` | ESLint 检查 `src/` |
| `npm run package` | 生产构建（esbuild `--production`） |

## 测试

测试使用 Mocha（TDD）+ `@vscode/test-cli`，在扩展宿主内运行，配置见 `.vscode-test.mjs`：

1. `npm test` 一键运行全部测试；或先运行 watch 任务（`npm run watch` 与 `npm run watch-tests`），再在「测试」视图中运行 `out/test/**/*.test.js`。
2. 测试代码位于 `src/test/`，新增用例时同步补充。

## 打包发布

`npm run package` 构建生产 bundle；`vsce package` 打包 VSIX，发布前会自动执行 `vscode:prepublish`。
