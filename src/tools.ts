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

/** 书中已知子目录：活动编辑器位于其中任意一层时即可定位所属书。 */
const BOOK_SUBDIRS = [CHAPTERS_DIR, WORLD_DIR, CARDS_DIR, CHAPTER_SUMMARIES_DIR, INTERVAL_SUMMARIES_DIR, NOTES_DIR];

/** 从活动编辑器路径解析所属书（书内任意文件）与相对路径；非库内文件返回 undefined。 */
function bookFromEditorPath(editorPath: string, books: BookInfo[]): { book: BookInfo; fileRel: string } | undefined {
	const segments = editorPath.split(path.sep);
	const knownIdx = BOOK_SUBDIRS.map((d) => segments.lastIndexOf(d)).filter((i) => i >= 0);
	const dirIdx = knownIdx.length > 0 ? Math.max(...knownIdx) : segments.length - 1;
	const book = books.find((b) => b.dir === segments.slice(0, dirIdx).join(path.sep));
	if (!book) {
		return undefined;
	}
	return { book, fileRel: path.relative(book.dir, editorPath).split(path.sep).join('/') };
}

/** 解析目标书：指定 book（书文件夹名）时用之，否则用当前书架选中的书。 */
async function resolveBook(library: LibraryService, name?: string): Promise<BookInfo> {
	if (name) {
		const books = await library.listBooks();
		const found = books.find((b) => b.name === name);
		if (!found) {
			throw new Error(
				vscode.l10n.t(
					'Book “{0}” not found. Existing: {1}',
					name,
					books.map((b) => b.name).join('、') || vscode.l10n.t('(empty)')
				)
			);
		}
		return found;
	}
	const current = library.getCurrentBook();
	if (!current) {
		throw new Error(
			vscode.l10n.t('No book selected. Select one in the bookshelf, or pass a book folder name via the book parameter.')
		);
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
					return text('小说库还是空的，请导入或新建小说。');
				}
				const lines = await Promise.all(
					books.map(async (b) => `${b.name}｜${(await library.listChapters(b)).length} 章`)
				);
				return text(`小说库（书文件夹名｜章节数）：\n${lines.join('\n')}`);
			},
			prepareInvocation: () => ({ invocationMessage: vscode.l10n.t('List Books') }),
		}),

		vscode.lm.registerTool<{ name: string }>('xReader_createBook', {
			async invoke(options) {
				const name = options.input.name.trim();
				if (!name) {
					throw new Error(vscode.l10n.t('Pass the new book name via the name parameter.'));
				}
				const book = await library.createBook(name);
				return text(`已新建《${book.name}》（目录：${book.dir}）。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Create book “{0}”', options.input.name),
			}),
		}),

		vscode.lm.registerTool<Record<string, never>>('xReader_getCurrentChapter', {
			async invoke() {
				const books = await library.listBooks();
				let book: BookInfo | undefined;
				let chapter: ChapterFile | undefined;
				let fileRel: string | undefined;
				// 活动编辑器是书内文件（章节/元数据/世界书/角色卡/摘要/笔记）时直接解析所属书
				const editorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
				if (editorPath && path.extname(editorPath) === '.md') {
					const parsed = bookFromEditorPath(editorPath, books);
					if (parsed) {
						book = parsed.book;
						fileRel = parsed.fileRel;
						// 打开的是章节文件时解析章节
						const segments = editorPath.split(path.sep);
						const chapterIdx = segments.lastIndexOf(CHAPTERS_DIR);
						if (chapterIdx === segments.length - 2 || chapterIdx === segments.length - 3) {
							const fileName = segments[segments.length - 1];
							const volumeDir = chapterIdx === segments.length - 3 ? segments[chapterIdx + 1] : undefined;
							chapter = (await library.listChapters(book)).find(
								(c) => chapterRelPath(c) === chapterRelPath({ fileName, volumeDir })
							);
						}
					}
				}
				if (!book) {
					book = library.getCurrentBook();
				}
				if (!book) {
					throw new Error(
						vscode.l10n.t('No book is currently open. Select one in the bookshelf, or open a file inside a book.')
					);
				}
				if (!chapter) {
					const progress = library.getProgress(book.dir);
					if (progress) {
						chapter = await library.findChapterByProgress(book, progress);
					}
				}
				const [chapters, summaryKeys] = await Promise.all([
					library.listChapters(book),
					library.listChapterSummaryKeys(book),
				]);
				const index = chapter ? chapters.findIndex((c) => chapterRelPath(c) === chapterRelPath(chapter)) : -1;
				const lines = [`书：${book.name}｜目录：${book.dir}`];
				// 无活动编辑器时按当前书与阅读进度识别（关掉章节编辑器后仍能定位书）
				lines.push(`当前打开：${fileRel ?? '（无，按当前书与阅读进度识别）'}`);
				if (chapter) {
					const mark = summaryKeys.has(chapterRelPath(chapter)) ? '｜摘要✓' : '';
					lines.push(`当前章节：${chapterRelPath(chapter)}｜第${chapter.seq}章｜${chapter.title}${mark}`);
				} else {
					lines.push('当前章节：（尚未开始阅读）');
				}
				lines.push(`进度：${index >= 0 ? `${index + 1}/${chapters.length}` : '0/' + chapters.length}`);
				return text(lines.join('\n'));
			},
			prepareInvocation: () => ({ invocationMessage: vscode.l10n.t('Get Current Book & Chapter') }),
		}),

		vscode.lm.registerTool<BookInput & { chapter: string }>('xReader_setProgress', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const chapter = await findChapter(library, book, options.input.chapter);
				if (!chapter) {
					throw new Error(
						vscode.l10n.t(
							'Chapter “{0}” not found. Use a relative path, file name, or title to reference a chapter.',
							options.input.chapter
						)
					);
				}
				await library.setProgress(book.dir, chapterRelPath(chapter));
				return text(`已将《${book.name}》的阅读进度设为：${chapterRelPath(chapter)}。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Set reading progress to “{0}”', options.input.chapter),
			}),
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
			prepareInvocation: () => ({ invocationMessage: vscode.l10n.t('List Volumes') }),
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
						vscode.l10n.t(
							'Volume “{0}” not found. Existing: {1}',
							volumeName!,
							volumes.map((v) => v.name).join('、') || vscode.l10n.t('(none)')
						)
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
			prepareInvocation: () => ({ invocationMessage: vscode.l10n.t('List Chapters') }),
		}),

		vscode.lm.registerTool<BookInput & { chapter: string }>('xReader_readChapterSummary', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const chapter = await findChapter(library, book, options.input.chapter);
				if (!chapter) {
					throw new Error(
						vscode.l10n.t(
							'Chapter “{0}” not found. Use a relative path, file name, or title to reference a chapter.',
							options.input.chapter
						)
					);
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
			prepareInvocation: () => ({ invocationMessage: vscode.l10n.t('Read Chapter Summary') }),
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
						vscode.l10n.t(
							'Interval “{0}” not found. Existing: {1}',
							range,
							intervals.map((i) => `${i.startSeq}-${i.endSeq}`).join('、')
						)
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
			prepareInvocation: () => ({ invocationMessage: vscode.l10n.t('Read Interval Summary') }),
		}),

		vscode.lm.registerTool<BookInput & { name: string }>('xReader_createVolume', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const dirName = await library.createVolume(book, options.input.name);
				return text(`已创建分卷「${dirName}」（${book.name}/${CHAPTERS_DIR}/${dirName}/）。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Create volume “{0}”', options.input.name),
			}),
		}),

		vscode.lm.registerTool<BookInput & { title: string; volume?: string }>('xReader_createChapter', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				let volumeDir: string | undefined;
				const volume = options.input.volume?.trim();
				if (volume) {
					const volumes = await library.listVolumes(book);
					const found = volumes.find((v) => v.name === volume || v.dirName === volume);
					if (!found) {
						throw new Error(
							vscode.l10n.t(
								'Volume “{0}” not found. Existing: {1}',
								volume,
								volumes.map((v) => v.name).join('、') || vscode.l10n.t('(none)')
							)
						);
					}
					volumeDir = found.dirName;
				}
				const fileName = await library.createChapter(book, options.input.title, volumeDir);
				return text(`已新建章节：${chapterRelPath({ fileName, volumeDir })}。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Create chapter “{0}”', options.input.title),
			}),
		}),

		vscode.lm.registerTool<BookInput & { oldName: string; newName: string }>('xReader_renameVolume', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const target = await library.renameVolume(book, options.input.oldName, options.input.newName);
				return text(`已将分卷「${options.input.oldName}」重命名为「${target}」。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Rename volume “{0}” to “{1}”', options.input.oldName, options.input.newName),
			}),
		}),

		vscode.lm.registerTool<BookInput & { name: string; deleteChapters?: boolean }>('xReader_deleteVolume', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				await library.deleteVolume(book, options.input.name, options.input.deleteChapters === true);
				return text(`已删除分卷「${options.input.name}」。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Delete volume “{0}”', options.input.name),
				confirmationMessages: {
					title: vscode.l10n.t('Delete Volume'),
					message: new vscode.MarkdownString(
						vscode.l10n.t(
							'Delete volume “{0}”{1}?',
							options.input.name,
							options.input.deleteChapters ? vscode.l10n.t(' and all its chapters') : ''
						)
					),
				},
			}),
		}),

		vscode.lm.registerTool<BookInput & { name: string }>('xReader_deleteBook', {
			async invoke(options) {
				const name = options.input.name.trim();
				if (!name) {
					throw new Error(vscode.l10n.t('Pass the book folder name via the name parameter.'));
				}
				const book = await resolveBook(library, name);
				await library.removeBook(book);
				return text(`已删除《${book.name}》及其全部章节。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Delete book “{0}”', options.input.name),
				confirmationMessages: {
					title: vscode.l10n.t('Delete Book'),
					message: new vscode.MarkdownString(vscode.l10n.t('Delete {0}?', options.input.name)),
				},
			}),
		}),

		vscode.lm.registerTool<BookInput & { newName: string }>('xReader_renameBook', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const renamed = await library.renameBook(book, options.input.newName);
				return text(`已将《${book.name}》重命名为《${renamed.name}》。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Rename book to “{0}”', options.input.newName),
			}),
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
			prepareInvocation: () => ({ invocationMessage: vscode.l10n.t('List Notes') }),
		}),

		vscode.lm.registerTool<BookInput & { oldName: string; newName: string }>('xReader_renameNoteCategory', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const target = await library.renameNoteCategory(book, options.input.oldName, options.input.newName);
				return text(`已将笔记分类「${options.input.oldName}」重命名为「${target}」。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t(
					'Rename note category “{0}” to “{1}”',
					options.input.oldName,
					options.input.newName
				),
			}),
		}),

		vscode.lm.registerTool<BookInput & { name: string }>('xReader_deleteNoteCategory', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				await library.deleteNoteCategory(book, options.input.name);
				return text(`已删除笔记分类「${options.input.name}」。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Delete note category “{0}”', options.input.name),
				confirmationMessages: {
					title: vscode.l10n.t('Delete Note Category'),
					message: new vscode.MarkdownString(
						vscode.l10n.t('Delete note category “{0}” and all its notes?', options.input.name)
					),
				},
			}),
		}),

		vscode.lm.registerTool<BookInput & { name: string; category?: string; chapter?: string }>('xReader_createNote', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				let chapter: ChapterFile | undefined;
				if (options.input.chapter?.trim()) {
					chapter = await findChapter(library, book, options.input.chapter.trim());
					if (!chapter) {
						throw new Error(
							vscode.l10n.t(
								'Chapter “{0}” not found. Use a relative path, file name, or title to reference a chapter.',
								options.input.chapter
							)
						);
					}
				}
				const filePath = await library.createNote(
					book,
					options.input.name,
					options.input.category?.trim() || undefined,
					chapter
				);
				return text(`笔记已就绪：${filePath}。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Create note “{0}”', options.input.name),
			}),
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
			prepareInvocation: () => ({ invocationMessage: vscode.l10n.t('List Characters') }),
		}),

		vscode.lm.registerTool<BookInput & { name: string }>('xReader_createCharacter', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const filePath = await library.createEntry(book, CARDS_DIR, options.input.name);
				return text(`角色卡已就绪：${filePath}。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Create character card “{0}”', options.input.name),
			}),
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
			prepareInvocation: () => ({ invocationMessage: vscode.l10n.t('List World Entries') }),
		}),

		vscode.lm.registerTool<BookInput & { name: string }>('xReader_createWorldEntry', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const filePath = await library.createEntry(book, WORLD_DIR, options.input.name);
				return text(`世界书条目已就绪：${filePath}。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Create world entry “{0}”', options.input.name),
			}),
		}),

		vscode.lm.registerTool<BookInput & { chapter: string }>('xReader_deleteChapter', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const chapter = await findChapter(library, book, options.input.chapter);
				if (!chapter) {
					throw new Error(
						vscode.l10n.t(
							'Chapter “{0}” not found. Use a relative path, file name, or title to reference a chapter.',
							options.input.chapter
						)
					);
				}
				await library.removeChapter(book, chapter);
				return text(`已删除第${chapter.seq}章「${chapter.title}」。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Delete chapter “{0}”', options.input.chapter),
				confirmationMessages: {
					title: vscode.l10n.t('Delete Chapter'),
					message: new vscode.MarkdownString(vscode.l10n.t('Delete chapter “{0}”?', options.input.chapter)),
				},
			}),
		}),

		vscode.lm.registerTool<BookInput & { chapter: string; newTitle: string }>('xReader_renameChapter', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const chapter = await findChapter(library, book, options.input.chapter);
				if (!chapter) {
					throw new Error(
						vscode.l10n.t(
							'Chapter “{0}” not found. Use a relative path, file name, or title to reference a chapter.',
							options.input.chapter
						)
					);
				}
				const newFileName = await library.renameChapter(book, chapter, options.input.newTitle);
				return text(
					`已重命名章节：${chapterRelPath({ fileName: newFileName, volumeDir: chapter.volumeDir })}。`
				);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t(
					'Rename chapter “{0}” to “{1}”',
					options.input.chapter,
					options.input.newTitle
				),
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
							vscode.l10n.t(
								'Note category “{0}” not found. Existing: {1}',
								category,
								categories.map((c) => c.name).join('、') || vscode.l10n.t('(none)')
							)
						);
					}
					subDir = `${NOTES_DIR}/${found.dirName}`;
				}
				const note = await findEntry(library, book, subDir, options.input.name);
				if (!note) {
					throw new Error(
						vscode.l10n.t(
							'Note “{0}” not found{1}.',
							options.input.name,
							category ? vscode.l10n.t(' (category: {0})', category) : ''
						)
					);
				}
				await library.removeEntry(book, subDir, note.fileName);
				return text(`已删除笔记「${note.name}」${category ? `（分类：${category}）` : ''}。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Delete note “{0}”', options.input.name),
				confirmationMessages: {
					title: vscode.l10n.t('Delete Note'),
					message: new vscode.MarkdownString(
						vscode.l10n.t(
							'Delete note “{0}”{1}?',
							options.input.name,
							options.input.category ? vscode.l10n.t(' (category: {0})', options.input.category) : ''
						)
					),
				},
			}),
		}),

		vscode.lm.registerTool<BookInput & { name: string; newName: string; category?: string }>('xReader_renameNote', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				let subDir = NOTES_DIR;
				const category = options.input.category?.trim();
				if (category) {
					const categories = await library.listNoteCategories(book);
					const found = categories.find((c) => c.dirName === category || c.name === category);
					if (!found) {
						throw new Error(
							vscode.l10n.t(
								'Note category “{0}” not found. Existing: {1}',
								category,
								categories.map((c) => c.name).join('、') || vscode.l10n.t('(none)')
							)
						);
					}
					subDir = `${NOTES_DIR}/${found.dirName}`;
				}
				const note = await findEntry(library, book, subDir, options.input.name);
				if (!note) {
					throw new Error(
						vscode.l10n.t(
							'Note “{0}” not found{1}.',
							options.input.name,
							category ? vscode.l10n.t(' (category: {0})', category) : ''
						)
					);
				}
				const newFileName = await library.renameEntry(book, subDir, note.fileName, options.input.newName);
				return text(`已重命名笔记：${subDir}/${newFileName}。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t(
					'Rename note “{0}” to “{1}”',
					options.input.name,
					options.input.newName
				),
			}),
		}),

		vscode.lm.registerTool<BookInput & { name: string }>('xReader_deleteCharacter', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const found = await findEntry(library, book, CARDS_DIR, options.input.name);
				if (!found) {
					const existing = await library.listEntries(book, CARDS_DIR);
					throw new Error(
						vscode.l10n.t(
							'Character card “{0}” not found. Existing: {1}',
							options.input.name,
							existing.map((e) => e.name).join('、') || vscode.l10n.t('(empty)')
						)
					);
				}
				await library.removeEntry(book, CARDS_DIR, found.fileName);
				return text(`已删除角色卡「${found.name}」。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Delete character card “{0}”', options.input.name),
				confirmationMessages: {
					title: vscode.l10n.t('Delete Character Card'),
					message: new vscode.MarkdownString(vscode.l10n.t('Delete character card “{0}”?', options.input.name)),
				},
			}),
		}),

		vscode.lm.registerTool<BookInput & { name: string; newName: string }>('xReader_renameCharacter', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const found = await findEntry(library, book, CARDS_DIR, options.input.name);
				if (!found) {
					const existing = await library.listEntries(book, CARDS_DIR);
					throw new Error(
						vscode.l10n.t(
							'Character card “{0}” not found. Existing: {1}',
							options.input.name,
							existing.map((e) => e.name).join('、') || vscode.l10n.t('(empty)')
						)
					);
				}
				const newFileName = await library.renameEntry(book, CARDS_DIR, found.fileName, options.input.newName);
				return text(`已重命名角色卡：${CARDS_DIR}/${newFileName}。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t(
					'Rename character card “{0}” to “{1}”',
					options.input.name,
					options.input.newName
				),
			}),
		}),

		vscode.lm.registerTool<BookInput & { name: string }>('xReader_deleteWorldEntry', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const found = await findEntry(library, book, WORLD_DIR, options.input.name);
				if (!found) {
					const existing = await library.listEntries(book, WORLD_DIR);
					throw new Error(
						vscode.l10n.t(
							'World entry “{0}” not found. Existing: {1}',
							options.input.name,
							existing.map((e) => e.name).join('、') || vscode.l10n.t('(empty)')
						)
					);
				}
				await library.removeEntry(book, WORLD_DIR, found.fileName);
				return text(`已删除世界书条目「${found.name}」。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Delete world entry “{0}”', options.input.name),
				confirmationMessages: {
					title: vscode.l10n.t('Delete World Entry'),
					message: new vscode.MarkdownString(vscode.l10n.t('Delete world entry “{0}”?', options.input.name)),
				},
			}),
		}),

		vscode.lm.registerTool<BookInput & { name: string; newName: string }>('xReader_renameWorldEntry', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const found = await findEntry(library, book, WORLD_DIR, options.input.name);
				if (!found) {
					const existing = await library.listEntries(book, WORLD_DIR);
					throw new Error(
						vscode.l10n.t(
							'World entry “{0}” not found. Existing: {1}',
							options.input.name,
							existing.map((e) => e.name).join('、') || vscode.l10n.t('(empty)')
						)
					);
				}
				const newFileName = await library.renameEntry(book, WORLD_DIR, found.fileName, options.input.newName);
				return text(`已重命名世界书条目：${WORLD_DIR}/${newFileName}。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t(
					'Rename world entry “{0}” to “{1}”',
					options.input.name,
					options.input.newName
				),
			}),
		})
	);
}
