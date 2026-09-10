import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BookInfo, ChapterFile, ChapterVolume, EntryFile, SummaryState } from './model/book';
import {
	CARDS_DIR,
	CHAPTER_SUMMARIES_DIR,
	chapterRelPath,
	CHAPTERS_DIR,
	INTERVAL_SUMMARIES_DIR,
	LibraryService,
	META_FILE,
	NOTE_CHAPTER_FM_RE,
	NOTES_DIR,
	parseChapterFilePath,
	VERSIONS_DIR,
	WORLD_DIR,
} from './services/library';
import type { BookMetadata } from './services/markdown';

/** 工具返回文本结果。 */
const text = (value: string): vscode.LanguageModelToolResult =>
	new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);

/** 书中已知子目录：活动编辑器位于其中任意一层时即可定位所属书。 */
const BOOK_SUBDIRS = [CHAPTERS_DIR, VERSIONS_DIR, WORLD_DIR, CARDS_DIR, CHAPTER_SUMMARIES_DIR, INTERVAL_SUMMARIES_DIR, NOTES_DIR];

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
				vscode.l10n.t('Book “{0}” not found. Existing: {1}', name, listOrEmpty(books.map((b) => b.name)))
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

/** 顿号连接名称列表；空列表回退到 (empty)。 */
const listOrEmpty = (names: string[]): string => names.join('、') || vscode.l10n.t('(empty)');

/** 顿号连接名称列表；空列表回退到 (none)。 */
const listOrNone = (names: string[]): string => names.join('、') || vscode.l10n.t('(none)');

/** 按引用取章节；找不到时抛错说明可用引用格式。 */
async function requireChapter(library: LibraryService, book: BookInfo, ref: string): Promise<ChapterFile> {
	const chapter = await findChapter(library, book, ref);
	if (!chapter) {
		throw new Error(
			vscode.l10n.t(
				'Chapter “{0}” not found. Use a relative path, file name, or title to reference a chapter.',
				ref
			)
		);
	}
	return chapter;
}

/** 在已知分卷列表中按卷名/目录名取分卷；找不到时抛错列出现有分卷。 */
function pickVolume(volumes: ChapterVolume[], ref: string): ChapterVolume {
	const found = volumes.find((v) => v.name === ref || v.dirName === ref);
	if (!found) {
		throw new Error(
			vscode.l10n.t('Volume “{0}” not found. Existing: {1}', ref, listOrNone(volumes.map((v) => v.name)))
		);
	}
	return found;
}

/** 按引用取条目/角色卡；找不到时抛错（notFoundTemplate 为该类条目的 l10n 文案）。 */
async function requireEntry(
	library: LibraryService,
	book: BookInfo,
	subDir: string,
	ref: string,
	notFoundTemplate: string
): Promise<EntryFile> {
	const found = await findEntry(library, book, subDir, ref);
	if (found) {
		return found;
	}
	const existing = await library.listEntries(book, subDir);
	throw new Error(vscode.l10n.t(notFoundTemplate, ref, listOrEmpty(existing.map((e) => e.name))));
}

/** 笔记所在子目录（未指定分类时为 笔记/ 根）；分类不存在时抛错。 */
async function resolveNoteDir(library: LibraryService, book: BookInfo, category?: string): Promise<string> {
	if (!category) {
		return NOTES_DIR;
	}
	const categories = await library.listNoteCategories(book);
	const found = categories.find((c) => c.dirName === category || c.name === category);
	if (!found) {
		throw new Error(
			vscode.l10n.t('Note category “{0}” not found. Existing: {1}', category, listOrNone(categories.map((c) => c.name)))
		);
	}
	return `${NOTES_DIR}/${found.dirName}`;
}

/** 按引用取笔记；找不到时抛错（category 仅用于错误提示）。 */
async function requireNote(
	library: LibraryService,
	book: BookInfo,
	subDir: string,
	ref: string,
	category?: string
): Promise<EntryFile> {
	const note = await findEntry(library, book, subDir, ref);
	if (!note) {
		throw new Error(
			vscode.l10n.t('Note “{0}” not found{1}.', ref, category ? vscode.l10n.t(' (category: {0})', category) : '')
		);
	}
	return note;
}

/** 章节行尾的摘要状态标记：待维护 / ✓ / 不标（未创建）。 */
const summaryMark = (state: SummaryState | undefined): string =>
	state === 'stale' ? '｜摘要待维护' : state === 'ok' ? '｜摘要✓' : '';

/** 元数据文本行：frontmatter 字段 + 各二级小节（空小节注明），供工具直接带出，省得 agent 再读一遍文件。 */
function metadataLines(meta: BookMetadata | undefined, filePath: string): string[] {
	if (!meta || (meta.fields.length === 0 && meta.sections.length === 0)) {
		return [`元数据：${filePath} 缺失或为空，可用文件工具补写。`];
	}
	const fields = meta.fields
		.filter((field) => field.value.trim().length > 0)
		.map((field) => `${field.key}=${field.value.trim()}`);
	const lines = [`元数据（${filePath}）：${fields.join('｜') || '（无字段）'}`];
	for (const section of meta.sections) {
		lines.push(`## ${section.title}`);
		lines.push(section.body.trim() || '（空）');
	}
	return lines;
}

/** 摘要已过期时的提示，附在返回内容前。 */
const STALE_NOTICE = '⚠ 该摘要写入之后章节又有改动，内容可能已过期，请对照正文核对并按需重写。\n\n';

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
						const target = parseChapterFilePath(editorPath);
						if (target) {
							chapter = (await library.listChapters(book)).find(
								(c) => chapterRelPath(c) === chapterRelPath(target)
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
				// 分卷扫描一次，章节列表与摘要状态共用
				const volumes = await library.listVolumes(book);
				const chapters = volumes.flatMap((volume) => volume.chapters);
				const [summaryStates, meta] = await Promise.all([
					library.listChapterSummaryStates(book, volumes),
					library.readMetadata(book),
				]);
				const index = chapter ? chapters.findIndex((c) => chapterRelPath(c) === chapterRelPath(chapter)) : -1;
				const lines = [`书：${book.name}｜目录：${book.dir}`];
				lines.push(...metadataLines(meta, path.join(book.dir, META_FILE)));
				// 无活动编辑器时按当前书与阅读进度识别（关掉章节编辑器后仍能定位书）
				lines.push(`当前打开：${fileRel ?? '（无，按当前书与阅读进度识别）'}`);
				if (chapter) {
					const mark = summaryMark(summaryStates.get(chapterRelPath(chapter)));
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
				const chapter = await requireChapter(library, book, options.input.chapter);
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
				const volumes = await library.listVolumes(book);
				if (volumes.length === 0) {
					return text(`《${book.name}》还没有章节。`);
				}
				const summaryStates = await library.listChapterSummaryStates(book, volumes);
				const targets = volumeName ? [pickVolume(volumes, volumeName)] : volumes;
				const lines: string[] = [];
				for (const volume of targets) {
					lines.push(`【${volume.name}】`);
					const versionCounts = await library.listVolumeVersionCounts(book, volume.dirName);
					for (const c of volume.chapters) {
						const mark = summaryMark(summaryStates.get(chapterRelPath(c)));
						const versionCount = versionCounts.get(c.fileName.replace(/\.md$/, ''));
						const versionMark = versionCount ? `｜版本×${versionCount}` : '';
						lines.push(`${chapterRelPath(c)}｜第${c.seq}章｜${c.title}${mark}${versionMark}`);
					}
				}
				return text(`《${book.name}》章节（相对路径｜序号｜标题）：\n${lines.join('\n')}`);
			},
			prepareInvocation: () => ({ invocationMessage: vscode.l10n.t('List Chapters') }),
		}),

		vscode.lm.registerTool<BookInput & { chapter: string }>('xReader_readChapterSummary', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const chapter = await requireChapter(library, book, options.input.chapter);
				const filePath = path.join(book.dir, CHAPTER_SUMMARIES_DIR, chapter.volumeDir ?? '', chapter.fileName);
				const state = (await library.listChapterSummaryStates(book)).get(chapterRelPath(chapter));
				try {
					const md = await fs.readFile(filePath, 'utf8');
					return text(state === 'stale' ? `${STALE_NOTICE}${md}` : md);
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
				const stateLabel = (state: SummaryState): string => (state === 'stale' ? '待维护' : state === 'ok' ? '已建' : '未建');
				if (!range) {
					const lines = intervals.map(
						(i) => `${i.fileName}｜第${i.startSeq}–${i.endSeq}章｜${stateLabel(i.state)}`
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
				if (target.state !== 'missing') {
					const md = await fs.readFile(filePath, 'utf8');
					return text(target.state === 'stale' ? `${STALE_NOTICE}${md}` : md);
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

		vscode.lm.registerTool<BookInput & { chapter: string }>('xReader_listChapterVersions', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const chapter = await requireChapter(library, book, options.input.chapter);
				const versions = await library.listChapterVersions(book, chapter);
				if (versions.length === 0) {
					return text(`第${chapter.seq}章「${chapter.title}」还没有备选版本。主版本：${chapterRelPath(chapter)}`);
				}
				const lines = versions.map((v) => v.name).join('、');
				return text(
					`第${chapter.seq}章「${chapter.title}」的备选版本（主版本：${chapterRelPath(chapter)}）：\n${lines}`
				);
			},
			prepareInvocation: () => ({ invocationMessage: vscode.l10n.t('List Chapter Versions') }),
		}),

		vscode.lm.registerTool<BookInput & { chapter: string; name?: string }>('xReader_createChapterVersion', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const chapter = await requireChapter(library, book, options.input.chapter);
				const filePath = await library.createChapterVersion(book, chapter, options.input.name);
				return text(
					`已把第${chapter.seq}章「${chapter.title}」当前主版本内容存为备选版本：${filePath}。可用文件工具编辑该版本。`
				);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Create chapter version “{0}”', options.input.name ?? ''),
			}),
		}),

		vscode.lm.registerTool<BookInput & { chapter: string; version: string; keepOldName?: string }>(
			'xReader_setPrimaryChapterVersion',
			{
				async invoke(options) {
					const book = await resolveBook(library, options.input.book);
					const chapter = await requireChapter(library, book, options.input.chapter);
					await library.promoteChapterVersion(book, chapter, options.input.version, options.input.keepOldName);
					return text(
						`已把版本「${options.input.version}」设为第${chapter.seq}章「${chapter.title}」的主版本（${chapterRelPath(chapter)}），原主版本内容已存回版本库。章节摘要已转为待维护，需要重新保存摘要。`
					);
				},
				prepareInvocation: (options) => ({
					invocationMessage: vscode.l10n.t('Set chapter version “{0}” as primary', options.input.version),
				}),
			}
		),

		vscode.lm.registerTool<BookInput & { chapter: string; version: string }>('xReader_deleteChapterVersion', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const chapter = await requireChapter(library, book, options.input.chapter);
				await library.deleteChapterVersion(book, chapter, options.input.version);
				return text(`已删除第${chapter.seq}章「${chapter.title}」的备选版本「${options.input.version}」。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Delete chapter version “{0}”', options.input.version),
				confirmationMessages: {
					title: vscode.l10n.t('Delete Version'),
					message: new vscode.MarkdownString(
						vscode.l10n.t(
							'Delete version “{0}” of chapter “{1}”?',
							options.input.version,
							options.input.chapter
						)
					),
				},
			}),
		}),

		vscode.lm.registerTool<BookInput & { title: string; volume?: string }>('xReader_createChapter', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const volume = options.input.volume?.trim();
				const volumeDir = volume ? pickVolume(await library.listVolumes(book), volume).dirName : undefined;
				const fileName = await library.createChapter(book, options.input.title, volumeDir);
				return text(`已新建章节：${chapterRelPath({ fileName, volumeDir })}。`);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t('Create chapter “{0}”', options.input.title),
			}),
		}),

		vscode.lm.registerTool<BookInput & { title: string; after?: string; before?: string }>(
			'xReader_insertChapter',
			{
				async invoke(options) {
					const book = await resolveBook(library, options.input.book);
					const title = options.input.title?.trim();
					if (!title) {
						throw new Error(vscode.l10n.t('Pass the new chapter title via the title parameter.'));
					}
					const after = options.input.after?.trim();
					const before = options.input.before?.trim();
					if ((after ? 1 : 0) + (before ? 1 : 0) !== 1) {
						throw new Error(
							vscode.l10n.t('Pass exactly one of after / before to locate the insertion point.')
						);
					}
					const ref = (after ?? before) as string;
					const anchor = await requireChapter(library, book, ref);
					const result = await library.insertChapter(
						book,
						title,
						after ? { after: anchor } : { before: anchor }
					);
					const target = chapterRelPath({ fileName: result.fileName, volumeDir: anchor.volumeDir });
					const shifting =
						result.renumbered > 0 ? `其后的 ${result.renumbered} 章序号已顺延 +1。` : '';
					return text(
						`已在「${anchor.title || anchor.fileName}」${after ? '之后' : '之前'}插入新章节：${target}。${shifting}请用文件工具写入正文。`
					);
				},
				prepareInvocation: (options) => ({
					invocationMessage: vscode.l10n.t('Insert chapter “{0}”', options.input.title),
				}),
			}
		),

		vscode.lm.registerTool<BookInput & { chapter: string; volume: string }>('xReader_moveChapter', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const chapter = await requireChapter(library, book, options.input.chapter);
				const target = pickVolume(await library.listVolumes(book), options.input.volume);
				await library.moveChapter(book, chapter, target.dirName);
				return text(
					`已把第${chapter.seq}章「${chapter.title}」从 ${chapter.volumeDir ?? '（章节根目录）'} 移动到分卷「${target.name}」（${CHAPTERS_DIR}/${target.dirName ?? '（根目录）'}）。章节序号不变，导航、摘要镜像、笔记关联与阅读进度已同步。`
				);
			},
			prepareInvocation: (options) => ({
				invocationMessage: vscode.l10n.t(
					'Move chapter “{0}” to volume “{1}”',
					options.input.chapter,
					options.input.volume
				),
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
				const chapter = await requireChapter(library, book, options.input.chapter);
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
				const chapter = await requireChapter(library, book, options.input.chapter);
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
				const category = options.input.category?.trim();
				const subDir = await resolveNoteDir(library, book, category);
				const note = await requireNote(library, book, subDir, options.input.name, category);
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
				const category = options.input.category?.trim();
				const subDir = await resolveNoteDir(library, book, category);
				const note = await requireNote(library, book, subDir, options.input.name, category);
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
				const found = await requireEntry(
					library,
					book,
					CARDS_DIR,
					options.input.name,
					'Character card “{0}” not found. Existing: {1}'
				);
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
				const found = await requireEntry(
					library,
					book,
					CARDS_DIR,
					options.input.name,
					'Character card “{0}” not found. Existing: {1}'
				);
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
				const found = await requireEntry(
					library,
					book,
					WORLD_DIR,
					options.input.name,
					'World entry “{0}” not found. Existing: {1}'
				);
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
				const found = await requireEntry(
					library,
					book,
					WORLD_DIR,
					options.input.name,
					'World entry “{0}” not found. Existing: {1}'
				);
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
