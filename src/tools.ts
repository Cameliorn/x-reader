import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BookInfo, ChapterFile } from './model/book';
import { commitAll } from './services/git';
import {
    CARDS_DIR,
    CHAPTER_SUMMARIES_DIR,
    chapterRelPath,
    CHAPTERS_DIR,
    INTERVAL_SUMMARIES_DIR,
    LibraryService,
    NOTES_DIR,
    WORLD_DIR,
} from './services/library';

/** 工具返回文本结果。 */
const text = (value: string): vscode.LanguageModelToolResult =>
    new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);

/** 解析目标书：指定 book（书文件夹名）时用之，否则用当前书架选中的书。 */
async function resolveBook(library: LibraryService, name?: string): Promise<BookInfo> {
    if (name) {
        const books = await library.listBooks();
        const found = books.find((b) => b.name === name);
        if (!found) {
            throw new Error(`找不到书「${name}」。现有：${books.map((b) => b.name).join('、') || '（空）'}`);
        }
        return found;
    }
    const current = library.getCurrentBook();
    if (!current) {
        throw new Error('当前没有选中的书；请先在书架中选择一本书，或用 book 参数指定书文件夹名。');
    }
    return current;
}

/** 按引用定位章节：依次为 相对路径（分卷/文件名）→ 文件名 → 标题。 */
async function findChapter(library: LibraryService, book: BookInfo, ref: string): Promise<ChapterFile | undefined> {
    const chapters = await library.listChapters(book);
    return (
        chapters.find((c) => chapterRelPath(c) === ref) ??
        chapters.find((c) => c.fileName === ref) ??
        chapters.find((c) => c.title === ref)
    );
}

/** agent 写操作后的 git checkpoint 提交。 */
async function checkpoint(library: LibraryService, message: string): Promise<void> {
    const root = library.getLibraryPath();
    if (root) {
        await commitAll(root, message);
    }
}

const CHAPTER_FM_RE = /^chapter:\s*"?([^"\n]+?)"?\s*$/m;

/** 读取笔记 frontmatter 的 chapter 字段（章节相对路径）。 */
async function noteChapterLink(filePath: string): Promise<string | undefined> {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        return CHAPTER_FM_RE.exec(content)?.[1];
    } catch {
        return undefined;
    }
}

interface BookInput {
    book?: string;
}

/** 注册小说库的 Language Model 工具（agent 通过约定读写文件，工具提供结构化领域操作）。 */
export function registerAgentTools(context: vscode.ExtensionContext, library: LibraryService): void {
    context.subscriptions.push(
        vscode.lm.registerTool<BookInput>('xReader_listVolumes', {
            async invoke(options) {
                const book = await resolveBook(library, options.input.book);
                const volumes = await library.listVolumes(book);
                if (volumes.length === 0) {
                    return text(`《${book.name}》还没有章节。`);
                }
                const lines = volumes.map(
                    (v) => `${v.name}｜目录：${CHAPTERS_DIR}/${v.dirName ?? '（根目录）'}｜${v.chapters.length} 章`
                );
                return text(`《${book.name}》分卷：\n${lines.join('\n')}`);
            },
            prepareInvocation: () => ({ invocationMessage: '列出分卷' }),
        }),

        vscode.lm.registerTool<BookInput & { volume?: string }>('xReader_listChapters', {
            async invoke(options) {
                const book = await resolveBook(library, options.input.book);
                const volumeName = options.input.volume?.trim();
                const [volumes, summaryKeys] = await Promise.all([
                    library.listVolumes(book),
                    library.listChapterSummaryKeys(book),
                ]);
                const targets = volumeName ? volumes.filter((v) => v.name === volumeName || v.dirName === volumeName) : volumes;
                if (targets.length === 0) {
                    throw new Error(
                        `找不到分卷「${volumeName}」。现有：${volumes.map((v) => v.name).join('、') || '（空）'}`
                    );
                }
                const lines: string[] = [];
                for (const volume of targets) {
                    lines.push(`【${volume.name}】`);
                    for (const c of volume.chapters) {
                        const mark = summaryKeys.has(chapterRelPath(c)) ? '｜摘要✓' : '';
                        lines.push(`${chapterRelPath(c)}｜第${c.seq}章｜${c.title}${mark}`);
                    }
                }
                return text(`《${book.name}》章节（相对路径｜序号｜标题）：\n${lines.join('\n')}`);
            },
            prepareInvocation: () => ({ invocationMessage: '列出章节' }),
        }),

        vscode.lm.registerTool<BookInput & { chapter: string }>('xReader_readChapterSummary', {
            async invoke(options) {
                const book = await resolveBook(library, options.input.book);
                const chapter = await findChapter(library, book, options.input.chapter);
                if (!chapter) {
                    throw new Error(`找不到章节「${options.input.chapter}」，可用相对路径、文件名或标题引用章节。`);
                }
                const filePath = path.join(book.dir, CHAPTER_SUMMARIES_DIR, chapter.volumeDir ?? '', chapter.fileName);
                try {
                    return text(await fs.readFile(filePath, 'utf8'));
                } catch {
                    return text(
                        `第${chapter.seq}章「${chapter.title}」的章节摘要尚未创建。可先用文件工具读取 ${CHAPTERS_DIR}/${chapterRelPath(chapter)}，再将摘要写入：${filePath}`
                    );
                }
            },
            prepareInvocation: () => ({ invocationMessage: '读取章节摘要' }),
        }),

        vscode.lm.registerTool<BookInput & { range?: string }>('xReader_readIntervalSummary', {
            async invoke(options) {
                const book = await resolveBook(library, options.input.book);
                const intervals = await library.listIntervalSummaries(book);
                if (intervals.length === 0) {
                    return text(`《${book.name}》还没有章节。`);
                }
                const range = options.input.range?.trim();
                if (!range) {
                    const lines = intervals.map(
                        (i) => `${i.fileName}｜第${i.startSeq}–${i.endSeq}章｜${i.exists ? '已建' : '未建'}`
                    );
                    return text(`《${book.name}》区间摘要（每 10 章一个）：\n${lines.join('\n')}`);
                }
                const nums = range.replace(/\.md$/, '').split('-').map((s) => Number.parseInt(s.trim(), 10));
                const target = intervals.find(
                    (i) => i.fileName === range || (i.startSeq === nums[0] && i.endSeq === nums[1])
                );
                if (!target) {
                    throw new Error(
                        `找不到区间「${range}」。现有：${intervals.map((i) => `${i.startSeq}-${i.endSeq}`).join('、')}`
                    );
                }
                const filePath = path.join(book.dir, INTERVAL_SUMMARIES_DIR, target.fileName);
                if (target.exists) {
                    return text(await fs.readFile(filePath, 'utf8'));
                }
                const chapterList = target.chapters.map((c) => `${chapterRelPath(c)}（${c.title}）`).join('、');
                return text(
                    `第${target.startSeq}–${target.endSeq}章的区间摘要尚未创建。区间章节：${chapterList}。摘要写入：${filePath}`
                );
            },
            prepareInvocation: () => ({ invocationMessage: '读取区间摘要' }),
        }),

        vscode.lm.registerTool<BookInput & { name: string }>('xReader_createVolume', {
            async invoke(options) {
                const book = await resolveBook(library, options.input.book);
                const dirName = await library.createVolume(book, options.input.name);
                await checkpoint(library, `创建分卷「${dirName}」`);
                return text(`已创建分卷「${dirName}」（${book.name}/${CHAPTERS_DIR}/${dirName}/）。`);
            },
            prepareInvocation: (options) => ({ invocationMessage: `创建分卷「${options.input.name}」` }),
        }),

        vscode.lm.registerTool<BookInput & { oldName: string; newName: string }>('xReader_renameVolume', {
            async invoke(options) {
                const book = await resolveBook(library, options.input.book);
                const target = await library.renameVolume(book, options.input.oldName, options.input.newName);
                await checkpoint(library, `重命名分卷「${options.input.oldName}」→「${target}」`);
                return text(`已将分卷「${options.input.oldName}」重命名为「${target}」（章节摘要镜像目录同步更名）。`);
            },
            prepareInvocation: (options) => ({
                invocationMessage: `重命名分卷「${options.input.oldName}」→「${options.input.newName}」`,
            }),
        }),

        vscode.lm.registerTool<BookInput & { name: string; deleteChapters?: boolean }>('xReader_deleteVolume', {
            async invoke(options) {
                const book = await resolveBook(library, options.input.book);
                await library.deleteVolume(book, options.input.name, options.input.deleteChapters === true);
                await checkpoint(library, `删除分卷「${options.input.name}」`);
                return text(`已删除分卷「${options.input.name}」。`);
            },
            prepareInvocation: (options) => ({
                invocationMessage: `删除分卷「${options.input.name}」`,
                confirmationMessages: {
                    title: '删除分卷',
                    message: new vscode.MarkdownString(
                        `确定删除分卷「${options.input.name}」${options.input.deleteChapters ? '及其中全部章节' : ''
                        }？文件将被删除（如有 git 历史可恢复）。`
                    ),
                },
            }),
        }),

        vscode.lm.registerTool<BookInput>('xReader_listNotes', {
            async invoke(options) {
                const book = await resolveBook(library, options.input.book);
                const [categories, rootNotes] = await Promise.all([
                    library.listNoteCategories(book),
                    library.listNotes(book),
                ]);
                const lines: string[] = [];
                const pushNote = async (relPath: string, name: string): Promise<void> => {
                    const link = await noteChapterLink(path.join(book.dir, relPath));
                    lines.push(`${relPath}｜${name}${link ? `｜关联章节：${link}` : ''}`);
                };
                for (const note of rootNotes) {
                    await pushNote(`${NOTES_DIR}/${note.fileName}`, note.name);
                }
                for (const category of categories) {
                    lines.push(`【分类：${category.name}】`);
                    for (const note of await library.listNotes(book, category.dirName)) {
                        await pushNote(`${NOTES_DIR}/${category.dirName}/${note.fileName}`, note.name);
                    }
                }
                return text(
                    lines.length === 0
                        ? `《${book.name}》还没有笔记。`
                        : `《${book.name}》笔记（相对路径｜名称）：\n${lines.join('\n')}`
                );
            },
            prepareInvocation: () => ({ invocationMessage: '列出笔记' }),
        }),

        vscode.lm.registerTool<BookInput & { name: string; category?: string; chapter?: string }>('xReader_createNote', {
            async invoke(options) {
                const book = await resolveBook(library, options.input.book);
                let chapter: ChapterFile | undefined;
                if (options.input.chapter?.trim()) {
                    chapter = await findChapter(library, book, options.input.chapter.trim());
                    if (!chapter) {
                        throw new Error(`找不到章节「${options.input.chapter}」，可用相对路径、文件名或标题引用章节。`);
                    }
                }
                const filePath = await library.createNote(
                    book,
                    options.input.name,
                    options.input.category?.trim() || undefined,
                    chapter
                );
                await checkpoint(library, `新建笔记「${options.input.name}」`);
                return text(`笔记已就绪：${filePath}（已存在同名笔记时不覆盖）。`);
            },
            prepareInvocation: (options) => ({ invocationMessage: `新建笔记「${options.input.name}」` }),
        }),

        vscode.lm.registerTool<BookInput>('xReader_listCharacters', {
            async invoke(options) {
                const book = await resolveBook(library, options.input.book);
                const entries = await library.listEntries(book, CARDS_DIR);
                return text(
                    entries.length === 0
                        ? `《${book.name}》还没有角色卡。`
                        : `《${book.name}》角色卡：\n${entries.map((e) => `${CARDS_DIR}/${e.fileName}`).join('\n')}`
                );
            },
            prepareInvocation: () => ({ invocationMessage: '列出角色卡' }),
        }),

        vscode.lm.registerTool<BookInput & { name: string }>('xReader_createCharacter', {
            async invoke(options) {
                const book = await resolveBook(library, options.input.book);
                const filePath = await library.createEntry(book, CARDS_DIR, options.input.name);
                await checkpoint(library, `新建角色卡「${options.input.name}」`);
                return text(`角色卡已就绪：${filePath}（已存在同名角色卡时不覆盖）。`);
            },
            prepareInvocation: (options) => ({ invocationMessage: `新建角色卡「${options.input.name}」` }),
        }),

        vscode.lm.registerTool<BookInput>('xReader_listWorldEntries', {
            async invoke(options) {
                const book = await resolveBook(library, options.input.book);
                const entries = await library.listEntries(book, WORLD_DIR);
                return text(
                    entries.length === 0
                        ? `《${book.name}》还没有世界书条目。`
                        : `《${book.name}》世界书条目：\n${entries.map((e) => `${WORLD_DIR}/${e.fileName}`).join('\n')}`
                );
            },
            prepareInvocation: () => ({ invocationMessage: '列出世界书条目' }),
        }),

        vscode.lm.registerTool<BookInput & { name: string }>('xReader_createWorldEntry', {
            async invoke(options) {
                const book = await resolveBook(library, options.input.book);
                const filePath = await library.createEntry(book, WORLD_DIR, options.input.name);
                await checkpoint(library, `新建世界书条目「${options.input.name}」`);
                return text(`世界书条目已就绪：${filePath}（已存在同名条目时不覆盖）。`);
            },
            prepareInvocation: (options) => ({ invocationMessage: `新建世界书条目「${options.input.name}」` }),
        })
    );
}
