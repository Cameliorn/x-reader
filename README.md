# 📚 X Reader 小说阅读器

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/cameliorn.x-reader?color=4ec1ff&label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=cameliorn.x-reader)
[![Installs](https://img.shields.io/visual-studio-marketplace/d/cameliorn.x-reader?color=00b894&label=Downloads)](https://marketplace.visualstudio.com/items?itemName=cameliorn.x-reader)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/cameliorn.x-reader?color=fdcb6e&label=Rating)](https://marketplace.visualstudio.com/items?itemName=cameliorn.x-reader)
[![License](https://img.shields.io/github/license/Cameliorn/x-reader?color=6c5ce7)](https://github.com/Cameliorn/x-reader/blob/main/LICENSE)

> 在 VS Code 中阅读与创作小说，并与 Copilot 共创写作。

导入本地 txt，自动解析为 Markdown 章节书库；内置书架、章节目录、章节/区间摘要、世界书、角色卡与笔记视图；全程 Git 快照可回溯，并向 Copilot 暴露完整的语言模型工具，实现「边读边写」的共创体验。

## 功能特性

- **导入与新建**：导入本地 txt（自动识别 UTF-8 / UTF-16 / GB18030 编码），或新建空小说从零写作。
- **卷/章自动解析**：识别「第 X 卷 / 第 X 章」两级目录，支持中文数字、阿拉伯数字及「序章 / 楔子 / 番外」等特殊章节。
- **书架与章节目录**：活动栏六视图——书架、章节目录、摘要、世界书、角色卡、笔记，随当前书联动。
- **阅读进度**：自动记录阅读位置，打开即恢复；状态栏显示当前书与进度，点击一键回到上次章节。
- **章节 / 区间摘要**：每章一份摘要，每 10 章一份区间摘要，点击即建，边读边回顾。
- **世界书与角色卡**：维护世界观设定与角色档案，写作时随手可查。
- **笔记系统**：支持分类目录与章节关联，阅读批注与创作大纲尽收其中。
- **章节改名级联同步**：右键重命名或直接修改章节标题，文件名、前后章导航、摘要、关联笔记与阅读进度全部自动同步，不留死链。
- **Git 快照**：每次导入、新建、重命名、删除均自动提交快照，可随时回溯。
- **朗读联动 x-audio**：与 [x-audio 朗读助手](https://marketplace.visualstudio.com/items?itemName=cameliorn.x-audio) 联动，一键朗读当前章节（普通 / 分角色），无需离开阅读界面。
- **与 Copilot 共创**：注册 30 个语言模型工具，Copilot 可直接读写书库。
- **中英文本地化**：界面自动跟随 VS Code 显示语言（中文 / English）。

## 快速开始

1. 在 VS Code 扩展商店安装 **X Reader**（或命令行 `code --install-extension`）。
2. 点击活动栏「小说阅读」进入书架。
3. 点击「导入小说」选择本地 txt，或「新建小说」从零开始。
4. 点击书名打开第一章开始阅读；编辑器标题栏的「上一章 / 下一章」随手翻章。

### 界面导览

| 视图 | 用途 |
| --- | --- |
| 书架 | 导入、新建、打开、删除书籍 |
| 章节目录 | 卷 → 章两级目录，自动跟随阅读进度 |
| 摘要 | 章节摘要与区间摘要，点击即建 |
| 世界书 | 世界观设定条目 |
| 角色卡 | 角色档案 |
| 笔记 | 分类笔记，可关联章节 |

### 朗读联动（x-audio）

安装 [x-audio 朗读助手](https://marketplace.visualstudio.com/items?itemName=cameliorn.x-audio) 并配置好 TTS 密钥后，可在阅读界面直接朗读：

| 入口 | 说明 |
| --- | --- |
| 章节页签标题栏 🔊「朗读本章」 | 普通朗读当前章节正文（自动去掉 Markdown 标记与底部导航） |
| 章节页签标题栏 👥「分角色朗读本章」 | 由 x-audio 自动识别角色与对白，逐角色分配音色朗读 |
| 章节目录右键「朗读本章 / 分角色朗读本章」 | 对指定章节朗读，无需先打开 |
| 章节编辑器右键「朗读选中文本」 | 只朗读选中的片段 |

- 长章节超过单次合成上限时，x-audio 会自动分块合成并顺序播放。
- 分角色朗读会从本书的**角色卡**读取角色音色：在角色卡里写一行 `- 音色：female-yujie`（或 `音色: xxx`、frontmatter `voice: xxx` / `voiceId: xxx`），即为该角色固定音色；可选 `- 类型：男/女/少女/少年/幼童/老人/旁白` 把音色同时映射到角色类型；名为「旁白」的卡片自动作为旁白音色。没有卡片带音色时回退到章节目录向上查找 `.ttsvoices.json`。
- 未安装 x-audio 时点击朗读入口会弹出安装引导。

## 与 Copilot 共创

在 Copilot Chat 中直接操作你的书库，例如：

> - 「我上次读到哪了？」——自动定位当前书与进度
> - 「根据前五章帮我写下一章」——自动新建章节、重排全书导航
> - 「整理第 1–10 章的摘要」——读取章节并撰写区间摘要
> - 「新建角色卡：林晚，外冷内热的医者」——建卡并打开供完善

扩展注册了 30 个结构化工具（列书 / 列卷 / 列章、读摘要、设置进度、新建 / 重命名 / 删除卷章书与条目），章节正文的读写搜索直接用内置文件工具即可。所有写操作自动落在 Git 快照中，放心交给 Copilot。

## 设置

| 设置项 | 说明 |
| --- | --- |
| `xReader.libraryPath` | 小说库目录路径（每本书一个文件夹）。留空时，下次导入或新建小说会弹窗选择目录。 |

## 常见问题

**导入后章节目录不准确？**

编码或排版格式特殊的 txt 可能解析不完整。可在章节目录中手动重命名章节，或改正文首行 `# 标题` 保存，两处会自动级联同步。

**支持哪些编码？**

UTF-8（含 BOM）、UTF-16 LE/BE、GB18030。

**章节改名后前后章的跳转链接没变？**

直接用章节目录右键「重命名章节」，或改章节正文首行标题后保存，两者效果一致，会同步更新文件名、导航链接、摘要镜像、关联笔记与阅读进度。不要用文件管理器直接改文件名，否则导航会留下死链。

## 发布说明

详细变更记录见 [CHANGELOG.md](https://github.com/Cameliorn/x-reader/blob/main/CHANGELOG.md)。

## 许可证

[MIT](https://github.com/Cameliorn/x-reader/blob/main/LICENSE)
