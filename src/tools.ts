import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BookInfo, ChapterFile, EntryFile } from './model/book';
import {
	CARDS_DIR,
	CHAPTER_SUMMARIES_DIR,
	chapterRelPath,
	CHAPTERS_DIR,
	INTERVAL_SUMMARIES_DIR,
	LibraryService,
	NOTE_CHAPTER_FM_RE,
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

/** 读取笔记 frontmatter 的 chapter 字段（章节相对路径）。 */
async function noteChapterLink(filePath: string): Promise<string | undefined> {
	try {
		const content = await fs.readFile(filePath, 'utf8');
		return NOTE_CHAPTER_FM_RE.exec(content)?.[1];
	} catch {
		return undefined;
	}
}

/** 在指定目录中按名称（去扩展名）、文件名或带扩展名引用定位条目。 */
async function findEntry(
	library: LibraryService,
	book: BookInfo,
	subDir: string,
	ref: string
): Promise<EntryFile | undefined> {
	const entries = await library.listEntries(book, subDir);
	return entries.find((e) => e.name === ref || e.fileName === ref || e.fileName === `${ref}.md`);
}

interface BookInput {
	book?: string;
}

/** 注册小说库的 Language Model 工具（agent 通过约定读写文件，工具提供结构化领域操作）。 */
export function registerAgentTools(context: vscode.ExtensionContext, library: LibraryService): void {
	context.subscriptions.push(
		vscode.lm.registerTool<BookInput>('xReader_listBooks', {
			async invoke() {
				const books = await library.listBooks();
				if (books.length === 0) {
					return text('小说库还是空的，请先导入 txt 小说。');
				}
				const lines = await Promise.all(
					books.map(async (b) => `${b.name}｜${(await library.listChapters(b)).length} 章`)
				);
				return text(`小说库（书文件夹名｜章节数）：\n${lines.join('\n')}`);
			},
			prepareInvocation: () => ({ invocationMessage: '列出书籍' }),
		}),

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
					if (volumes.length === 0) {
						return text(`《${book.name}》还没有章节。`);
					}
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
				return text(`已创建分卷「${dirName}」（${book.name}/${CHAPTERS_DIR}/${dirName}/）。`);
			},
			prepareInvocation: (options) => ({ invocationMessage: `创建分卷「${options.input.name}」` }),
		}),

		vscode.lm.registerTool<BookInput & { oldName: string; newName: string }>('xReader_renameVolume', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const target = await library.renameVolume(book, options.input.oldName, options.input.newName);
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

		vscode.lm.registerTool<BookInput & { name: string }>('xReader_deleteBook', {
			async invoke(options) {
				const name = options.input.name.trim();
				if (!name) {
					throw new Error('请用 name 参数指定要删除的书文件夹名。');
				}
				const book = await resolveBook(library, name);
				await library.removeBook(book);
				return text(`已删除《${book.name}》及其全部章节（如有 git 历史可恢复）。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: `删除书籍「${options.input.name}」`,
				confirmationMessages: {
					title: '删除书籍',
					message: new vscode.MarkdownString(
						`确定删除《${options.input.name}》？书文件夹将被删除（如有 git 历史可恢复）。`
					),
				},
			}),
		}),

		vscode.lm.registerTool<BookInput & { newName: string }>('xReader_renameBook', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const renamed = await library.renameBook(book, options.input.newName);
				return text(`已将《${book.name}》重命名为《${renamed.name}》（书文件夹、元数据 title、当前选中书与阅读进度已同步）。`);
			},
			prepareInvocation: (options) => ({ invocationMessage: `重命名书籍→「${options.input.newName}」` }),
		}),

		vscode.lm.registerTool<BookInput>('xReader_listNotes', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const [categories, rootNotes] = await Promise.all([
					library.listNoteCategories(book),
					library.listNotes(book),
				]);
				const noteLine = async (relPath: string, name: string): Promise<string> => {
					const link = await noteChapterLink(path.join(book.dir, relPath));
					return `${relPath}｜${name}${link ? `｜关联章节：${link}` : ''}`;
				};
				const lines: string[] = [];
				for (const category of categories) {
					lines.push(`【分类：${category.name}】`);
					const notes = await library.listNotes(book, category.dirName);
					lines.push(
						...(await Promise.all(
							notes.map((note) => noteLine(`${NOTES_DIR}/${category.dirName}/${note.fileName}`, note.name))
						))
					);
				}
				lines.push(
					...(await Promise.all(rootNotes.map((note) => noteLine(`${NOTES_DIR}/${note.fileName}`, note.name))))
				);
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
				return text(`世界书条目已就绪：${filePath}（已存在同名条目时不覆盖）。`);
			},
			prepareInvocation: (options) => ({ invocationMessage: `新建世界书条目「${options.input.name}」` }),
		}),

		vscode.lm.registerTool<BookInput & { chapter: string }>('xReader_deleteChapter', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const chapter = await findChapter(library, book, options.input.chapter);
				if (!chapter) {
					throw new Error(`找不到章节「${options.input.chapter}」，可用相对路径、文件名或标题引用章节。`);
				}
				await library.removeChapter(book, chapter);
				return text(`已删除第${chapter.seq}章「${chapter.title}」（含章节摘要镜像；如有 git 历史可恢复）。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: `删除章节「${options.input.chapter}」`,
				confirmationMessages: {
					title: '删除章节',
					message: new vscode.MarkdownString(
						`确定删除章节「${options.input.chapter}」？文件将被删除（如有 git 历史可恢复）。`
					),
				},
			}),
		}),

		vscode.lm.registerTool<BookInput & { chapter: string; newTitle: string }>('xReader_renameChapter', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const chapter = await findChapter(library, book, options.input.chapter);
				if (!chapter) {
					throw new Error(`找不到章节「${options.input.chapter}」，可用相对路径、文件名或标题引用章节。`);
				}
				const newFileName = await library.renameChapter(book, chapter, options.input.newTitle);
				return text(
					`已重命名章节：${chapterRelPath({ fileName: newFileName, volumeDir: chapter.volumeDir })}（文件名、摘要镜像、相邻章导航链接与阅读进度已同步）。`
				);
			},
			prepareInvocation: (options) => ({
				invocationMessage: `重命名章节「${options.input.chapter}」→「${options.input.newTitle}」`,
			}),
		}),

		vscode.lm.registerTool<BookInput & { name: string; category?: string }>('xReader_deleteNote', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				let subDir = NOTES_DIR;
				const category = options.input.category?.trim();
				if (category) {
					const categories = await library.listNoteCategories(book);
					const found = categories.find((c) => c.dirName === category || c.name === category);
					if (!found) {
						throw new Error(
							`找不到笔记分类「${category}」。现有：${categories.map((c) => c.name).join('、') || '（无分类）'}`
						);
					}
					subDir = `${NOTES_DIR}/${found.dirName}`;
				}
				const note = await findEntry(library, book, subDir, options.input.name);
				if (!note) {
					throw new Error(
						`找不到笔记「${options.input.name}」${category ? `（分类：${category}）` : ''}。`
					);
				}
				await library.removeEntry(book, subDir, note.fileName);
				return text(`已删除笔记「${note.name}」${category ? `（分类：${category}）` : ''}。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: `删除笔记「${options.input.name}」`,
				confirmationMessages: {
					title: '删除笔记',
					message: new vscode.MarkdownString(
						`确定删除笔记「${options.input.name}」${options.input.category ? `（分类：${options.input.category}）` : ''
						}？文件将被删除（如有 git 历史可恢复）。`
					),
				},
			}),
		}),

		vscode.lm.registerTool<BookInput & { name: string }>('xReader_deleteCharacter', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const found = await findEntry(library, book, CARDS_DIR, options.input.name);
				if (!found) {
					const existing = await library.listEntries(book, CARDS_DIR);
					throw new Error(
						`找不到角色卡「${options.input.name}」。现有：${existing.map((e) => e.name).join('、') || '（空）'}`
					);
				}
				await library.removeEntry(book, CARDS_DIR, found.fileName);
				return text(`已删除角色卡「${found.name}」。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: `删除角色卡「${options.input.name}」`,
				confirmationMessages: {
					title: '删除角色卡',
					message: new vscode.MarkdownString(
						`确定删除角色卡「${options.input.name}」？文件将被删除（如有 git 历史可恢复）。`
					),
				},
			}),
		}),

		vscode.lm.registerTool<BookInput & { name: string }>('xReader_deleteWorldEntry', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const found = await findEntry(library, book, WORLD_DIR, options.input.name);
				if (!found) {
					const existing = await library.listEntries(book, WORLD_DIR);
					throw new Error(
						`找不到世界书条目「${options.input.name}」。现有：${existing.map((e) => e.name).join('、') || '（空）'}`
					);
				}
				await library.removeEntry(book, WORLD_DIR, found.fileName);
				return text(`已删除世界书条目「${found.name}」。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: `删除世界书条目「${options.input.name}」`,
				confirmationMessages: {
					title: '删除世界书条目',
					message: new vscode.MarkdownString(
						`确定删除世界书条目「${options.input.name}」？文件将被删除（如有 git 历史可恢复）。`
					),
				},
			}),
		})
	);
}
