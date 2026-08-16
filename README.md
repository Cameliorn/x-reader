# X Reader 小说阅读器 README

在 VS Code 中阅读与创作小说：导入本地 txt 自动解析章节，或新建小说从零写作，自动记录阅读进度。

## Features

- 导入本地 txt 小说文件，自动识别 UTF-8 / GB18030 编码。
- 新建空小说，从零开始写作。
- 自动解析卷 / 章两级目录，支持中文数字、阿拉伯数字及「序章 / 楔子 / 番外」等特殊章节。
- 活动栏书架视图：导入、新建、打开、移除书籍。
- 章节目录视图：跟随当前阅读章节。
- 阅读器自动保存进度，再次打开时恢复到上次位置。

## Requirements

无特殊要求，本地使用，不需要联网。

## Extension Settings

- `xReader.libraryPath`：小说库目录路径（每本书一个文件夹）。留空后下次导入或新建小说时会弹窗重新选择目录。

## Known Issues

- 目录格式特殊的 txt 文件可能解析不完整，可在导入后检查章节目录是否准确。

## Release Notes

### 0.1.0

初始版本：书架、章节目录、正文阅读与进度记录。

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

- [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## For more information

- [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
- [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
