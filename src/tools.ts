import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BookInfo, ChapterFile, ChapterVolume, EntryCategory, EntryFile, SummaryState } from './model/book';
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
	sameChapter,
	VERSIONS_DIR,
	VOLUME_SUMMARIES_DIR,
	WORLD_DIR,
} from './services/library';
import { intervalSummaryFileName, type BookMetadata } from './services/markdown';

/** 工具返回文本结果。 */
const text = (value: string): vscode.LanguageModelToolResult =>
	new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);

/** 书中已知子目录：活动编辑器位于其中任意一层时即可定位所属书。 */
const BOOK_SUBDIRS = [
	CHAPTERS_DIR,
	VERSIONS_DIR,
	WORLD_DIR,
	CARDS_DIR,
	CHAPTER_SUMMARIES_DIR,
	INTERVAL_SUMMARIES_DIR,
	VOLUME_SUMMARIES_DIR,
	NOTES_DIR,
];

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

/** 取必填字符串参数（某些取值下才必填的参数由 action 决定，schema 无法表达），缺失时抛错。 */
function requireParam(value: string | undefined, name: string): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		throw new Error(vscode.l10n.t('Pass the {0} parameter.', name));
	}
	return trimmed;
}

/** 取必填整数参数（必填性同样由 action 决定），缺失或非整数时抛错。 */
function requireNumber(value: number | undefined, name: string): number {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		throw new Error(vscode.l10n.t('Pass the {0} parameter.', name));
	}
	return value;
}

/** 校验枚举参数（schema 中声明为 enum，运行时仍需兜底），返回合法值。 */
function requireEnum<T extends string>(value: string | undefined, allowed: readonly T[], param: string): T {
	if (value && (allowed as readonly string[]).includes(value)) {
		return value as T;
	}
	throw new Error(vscode.l10n.t('The {0} parameter must be one of: {1}.', param, allowed.join(' / ')));
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

/** 找不到章节时的报错：说明可用引用格式，以及「尚未创建的章节」用 序号-标题 写计划摘要。 */
function chapterNotFound(ref: string): Error {
	return new Error(
		vscode.l10n.t(
			'Chapter “{0}” not found. Use a relative path, file name, or title to reference a chapter; to plan a chapter that does not exist yet, pass “number-title” (e.g. 0201-抵达).',
			ref
		)
	);
}

/** 按引用取章节；找不到时抛错说明可用引用格式。 */
async function requireChapter(library: LibraryService, book: BookInfo, ref: string): Promise<ChapterFile> {
	const chapter = await findChapter(library, book, ref);
	if (!chapter) {
		throw chapterNotFound(ref);
	}
	return chapter;
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

/** 在已知分卷列表中按卷名/目录名取分卷；找不到时抛错列出现有分卷。 */
function pickVolume(volumes: ChapterVolume[], ref: string): ChapterVolume {
	const found = volumes.find((v) => v.name === ref || v.dirName === ref);
	if (!found) {
		throw new Error(vscode.l10n.t('Volume “{0}” not found. Existing: {1}', ref, listOrNone(volumes.map((v) => v.name))));
	}
	return found;
}

/** 按卷名/目录名取真实存在的分卷目录（rename / delete 用）：根目录章节组不是分卷，无法改名或删除。 */
async function requireVolumeDir(library: LibraryService, book: BookInfo, ref: string): Promise<string> {
	const volume = pickVolume(await library.listVolumes(book), ref);
	if (!volume.dirName) {
		throw new Error(
			vscode.l10n.t(
				'“{0}” is the chapter root directory, not a volume. Use the chapter operations instead.',
				volume.name
			)
		);
	}
	return volume.dirName;
}

/** 按引用取条目；找不到时抛错（notFoundTemplate 为该类条目的 l10n 文案）。 */
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

/** 在已知分类列表中按引用定位：完整路径优先，其次唯一的末级名（「配角」在多级下可能重名）。 */
function matchCategory(categories: EntryCategory[], ref: string): EntryCategory | undefined {
	const byPath = categories.find((c) => c.path === ref);
	if (byPath) {
		return byPath;
	}
	const byName = categories.filter((c) => c.name === ref);
	return byName.length === 1 ? byName[0] : undefined;
}

/** 按引用取分类（世界书/角色卡/笔记通用，可用分类路径或唯一的末级名）；找不到或有歧义时抛错。 */
async function requireCategory(
	library: LibraryService,
	book: BookInfo,
	subDir: string,
	ref: string
): Promise<EntryCategory> {
	const categories = await library.listCategories(book, subDir);
	const found = matchCategory(categories, ref);
	if (found) {
		return found;
	}
	const byName = categories.filter((c) => c.name === ref);
	if (byName.length > 1) {
		throw new Error(vscode.l10n.t('Category “{0}” is ambiguous. Use its full path, e.g. {1}.', ref, byName[0].path));
	}
	throw new Error(
		vscode.l10n.t('Category “{0}” not found. Existing: {1}', ref, listOrNone(categories.map((c) => c.path)))
	);
}

/** 目标分类：命中现有分类（完整路径或唯一末级名）时用其规范路径，否则按给定路径新建；空值表示根目录。 */
async function resolveTargetCategory(
	library: LibraryService,
	book: BookInfo,
	rootDir: string,
	ref?: string
): Promise<string | undefined> {
	if (!ref) {
		return undefined;
	}
	const categories = await library.listCategories(book, rootDir);
	return matchCategory(categories, ref)?.path ?? ref;
}

/** 笔记清单行尾的「关联章节」。 */
async function noteLinkSuffix(book: BookInfo, relPath: string): Promise<string> {
	const link = await noteChapterLink(path.join(book.dir, relPath));
	return link ? `｜关联章节：${link}` : '';
}

/** 条目按分类分组的清单行（分类标题 + 该分类下条目，最后是根目录条目）；lineOf 定制每行文本。 */
async function listEntriesGrouped(
	library: LibraryService,
	book: BookInfo,
	subDir: string,
	lineOf: (relPath: string, name: string) => Promise<string>
): Promise<string[]> {
	const lines: string[] = [];
	for (const category of await library.listCategories(book, subDir)) {
		lines.push(`【分类：${category.path}】`);
		const entries = await library.listEntries(book, subDir, category.path);
		lines.push(
			...(await Promise.all(entries.map((entry) => lineOf(`${subDir}/${category.path}/${entry.fileName}`, entry.name))))
		);
	}
	const rootEntries = await library.listEntries(book, subDir);
	lines.push(...(await Promise.all(rootEntries.map((entry) => lineOf(`${subDir}/${entry.fileName}`, entry.name)))));
	return lines;
}

/** 章节行尾的摘要状态标记：待维护 / ✓ / 不标（未创建）。 */
const summaryMark = (state: SummaryState | undefined): string =>
	state === 'stale' ? '｜摘要待维护' : state === 'ok' ? '｜摘要✓' : '';

/** 卷摘要行尾的标记：待维护 / ✓ / 计划 / 不标（未创建）。 */
const volumeSummaryMark = (state: SummaryState | undefined): string =>
	state === 'stale'
		? '｜卷摘要待维护'
		: state === 'ok'
			? '｜卷摘要✓'
			: state === 'planned'
				? '｜卷摘要计划'
				: '';

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

/** 计划摘要的提示：目标（章节/分卷）尚未创建，正文创建时该摘要会自动接管。 */
const PLAN_NOTICE = '✎ 这是计划摘要：对应的正文尚未创建，正文（分卷）创建后该摘要会自动接手，内容请按实际正文核对。\n\n';

interface BookInput {
	book?: string;
}

/** 条目类型（世界书/角色卡/笔记）：三处目录结构、分类与工具操作完全一致，仅措辞不同。 */
type EntryKind = 'world' | 'character' | 'note';

interface EntryKindSpec {
	kind: EntryKind;
	rootDir: string;
	/** 中文名词，用于条目结果文本（agent 工作域保持中文）。 */
	noun: string;
	/** 分类语境下的中文名词（如「世界书分类」）。 */
	categoryNoun: string;
	/** 找不到条目时的 l10n 模板。 */
	notFound: string;
	/** 聊天调用提示与删除确认的 l10n 文案（英文源）。 */
	message: {
		list: string;
		create: string;
		rename: string;
		delete: string;
		deleteConfirm: string;
		deleteTitle: string;
	};
}

const ENTRY_KINDS: Record<EntryKind, EntryKindSpec> = {
	world: {
		kind: 'world',
		rootDir: WORLD_DIR,
		noun: '世界书条目',
		categoryNoun: '世界书',
		notFound: 'World entry “{0}” not found. Existing: {1}',
		message: {
			list: 'List World Entries',
			create: 'Create world entry “{0}”',
			rename: 'Rename world entry “{0}” to “{1}”',
			delete: 'Delete world entry “{0}”',
			deleteConfirm: 'Delete world entry “{0}”?',
			deleteTitle: 'Delete World Entry',
		},
	},
	character: {
		kind: 'character',
		rootDir: CARDS_DIR,
		noun: '角色卡',
		categoryNoun: '角色卡',
		notFound: 'Character card “{0}” not found. Existing: {1}',
		message: {
			list: 'List Characters',
			create: 'Create character card “{0}”',
			rename: 'Rename character card “{0}” to “{1}”',
			delete: 'Delete character card “{0}”',
			deleteConfirm: 'Delete character card “{0}”?',
			deleteTitle: 'Delete Character Card',
		},
	},
	note: {
		kind: 'note',
		rootDir: NOTES_DIR,
		noun: '笔记',
		categoryNoun: '笔记',
		notFound: 'Note “{0}” not found. Existing: {1}',
		message: {
			list: 'List Notes',
			create: 'Create note “{0}”',
			rename: 'Rename note “{0}” to “{1}”',
			delete: 'Delete note “{0}”',
			deleteConfirm: 'Delete note “{0}”?',
			deleteTitle: 'Delete Note',
		},
	},
};

/** 按 kind 参数取条目类型配置；未传或非法时返回 undefined（prepareInvocation 用）。 */
const findKind = (value: string | undefined): EntryKindSpec | undefined =>
	value && value in ENTRY_KINDS ? ENTRY_KINDS[value as EntryKind] : undefined;

/** 校验 kind 参数，返回条目类型配置。 */
function requireKind(value: string | undefined): EntryKindSpec {
	const spec = findKind(value);
	if (!spec) {
		throw new Error(vscode.l10n.t('The kind parameter must be one of: {0}.', Object.keys(ENTRY_KINDS).join(' / ')));
	}
	return spec;
}

/** 按分类定位条目：返回条目文件、规范化的分类路径与所在目录（create 之外的条目操作共用）。 */
async function requireEntryIn(
	library: LibraryService,
	book: BookInfo,
	spec: EntryKindSpec,
	input: { name?: string; category?: string }
): Promise<{ file: EntryFile; categoryPath?: string; subDir: string }> {
	const ref = input.category?.trim() || undefined;
	const categoryPath = ref ? (await requireCategory(library, book, spec.rootDir, ref)).path : undefined;
	const subDir = categoryPath ? `${spec.rootDir}/${categoryPath}` : spec.rootDir;
	const file = await requireEntry(library, book, subDir, requireParam(input.name, 'name'), spec.notFound);
	return { file, categoryPath, subDir };
}

/** 读章节摘要：正文或摘要缺失都不报错——正文未创建时返回「计划摘要」槽位（写入即计划），摘要未创建时返回应写入的路径。 */
async function readChapterSummary(
	library: LibraryService,
	book: BookInfo,
	ref: string
): Promise<vscode.LanguageModelToolResult> {
	const chapter = await findChapter(library, book, ref);
	if (!chapter) {
		// 正文尚未创建：ref 形如 0201-标题（可带分卷目录）时按计划摘要处理，其它引用仍按找不到章节报错
		const slot = await library.chapterPlanSlot(book, ref);
		if (!slot) {
			throw chapterNotFound(ref);
		}
		if ('occupied' in slot) {
			const label = slot.occupied.kind === 'chapter' ? '正文' : '另一个计划摘要';
			return text(
				`序号已被${label}「${slot.occupied.relPath}」占用。要在该位置插入计划章节，请调用 xReader_manageChapter（action=insert，plan=true，before 或 after 指定该章）——它会顺延其后的章节序号再建计划摘要；或者换一个空闲序号。`
			);
		}
		try {
			return text(`${PLAN_NOTICE}${await fs.readFile(slot.filePath, 'utf8')}`);
		} catch {
			return text(
				`章节「${ref}」的正文尚未创建，可先写计划摘要（写入后即该章的计划，正文创建时自动接手）：${slot.filePath}`
			);
		}
	}
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
}

/** 解析区间引用（`NNNN-MMMM` / `11-20`），非法时返回 undefined。 */
function parseRangeRef(range: string): { startSeq: number; endSeq: number } | undefined {
	const nums = range
		.replace(/\.md$/i, '')
		.split('-')
		.map((part) => Number.parseInt(part.trim(), 10));
	if (nums.length !== 2 || !nums.every((n) => Number.isInteger(n) && n > 0) || nums[0] > nums[1]) {
		return undefined;
	}
	return { startSeq: nums[0], endSeq: nums[1] };
}

/**
 * 读区间摘要：range 省略时列出全部区间与状态；给定区间未创建时返回区间章节清单与应写入的路径。
 * 区间起止任意（可重叠），区间内还有尚未创建的章节时该摘要即计划。
 */
async function readIntervalSummary(
	library: LibraryService,
	book: BookInfo,
	range?: string
): Promise<vscode.LanguageModelToolResult> {
	const intervals = await library.listIntervalSummaries(book);
	if (!range) {
		if (intervals.length === 0) {
			return text(`《${book.name}》还没有章节，也没有区间摘要。`);
		}
		const lines = intervals.map((i) => `${i.fileName}｜第${i.startSeq}–${i.endSeq}章｜${stateLabel(i.state)}`);
		return text(`《${book.name}》区间摘要（缺失的默认区间为每 10 章一块，另可有任意起止的自定义区间）：\n${lines.join('\n')}`);
	}
	const parsed = parseRangeRef(range);
	if (!parsed) {
		throw new Error(
			vscode.l10n.t('Interval “{0}” is invalid. Use a start–end pair like 0011-0020 or 11-20.', range)
		);
	}
	const target = intervals.find(
		(i) => i.fileName === range || (i.startSeq === parsed.startSeq && i.endSeq === parsed.endSeq)
	);
	if (target && target.state !== 'missing') {
		const md = await fs.readFile(path.join(book.dir, INTERVAL_SUMMARIES_DIR, target.fileName), 'utf8');
		const notice = target.state === 'planned' ? PLAN_NOTICE : target.state === 'stale' ? STALE_NOTICE : '';
		return text(`${notice}${md}`);
	}
	// 未创建（或尚未列入默认区间的自定义区间）：给出应写入的路径与区间内已有章节
	const chapters = target?.chapters ?? (await library.chaptersInRange(book, parsed.startSeq, parsed.endSeq));
	// 区间内序号不齐全（越出现存章节，或中间还有没写的章节）时，写入的摘要即计划
	const planned = chapters.length < parsed.endSeq - parsed.startSeq + 1;
	const chapterList = chapters.map((c) => `${chapterRelPath(c)}（${c.title}）`).join('、') || '（尚无）';
	const filePath = path.join(
		book.dir,
		INTERVAL_SUMMARIES_DIR,
		intervalSummaryFileName(parsed.startSeq, parsed.endSeq)
	);
	return text(
		`第${parsed.startSeq}–${parsed.endSeq}章的区间摘要尚未创建${planned ? '（区间内还有尚未创建的章节：写入后即计划）' : ''}。区间内已有章节：${chapterList}。摘要写入：${filePath}`
	);
}

/** 摘要状态的中文标签（agent 侧输出用）。 */
const stateLabel = (state: SummaryState): string =>
	state === 'planned' ? '计划' : state === 'stale' ? '待维护' : state === 'ok' ? '已建' : '未建';

/** 读卷摘要：volume 省略时列出全部卷与状态；分卷尚未创建时给出可写入的路径。 */
async function readVolumeSummary(
	library: LibraryService,
	book: BookInfo,
	ref?: string
): Promise<vscode.LanguageModelToolResult> {
	const summaries = await library.listVolumeSummaries(book);
	if (!ref) {
		if (summaries.length === 0) {
			return text(`《${book.name}》还没有分卷，也没有卷摘要。`);
		}
		const lines = summaries.map(
			(s) => `${s.fileName}｜${s.name}｜${s.chapters.length} 章｜${stateLabel(s.state)}`
		);
		return text(`《${book.name}》卷摘要（一卷一档）：\n${lines.join('\n')}`);
	}
	const target = summaries.find(
		(s) => s.fileName === ref || s.fileName === `${ref}.md` || s.name === ref || s.dirName === ref
	);
	if (!target) {
		// 分卷尚未创建：可以先写这一卷的卷摘要，也可以先用章节计划规划
		const filePath = await library.volumePlanSummaryPath(book, ref);
		return text(
			`分卷「${ref}」尚未创建（现有：${listOrNone(summaries.map((s) => s.name))}）。卷摘要只写摘要，计划请用 xReader_manageChapter（action=insert 且 plan=true）或 xReader_manageInterval 写章节计划 / 区间计划；确要预建这一卷的卷摘要，写入：${filePath}。`
		);
	}
	const filePath = path.join(book.dir, VOLUME_SUMMARIES_DIR, target.fileName);
	if (target.state === 'missing') {
		const chapterList =
			target.chapters.map((c) => `${chapterRelPath(c)}（${c.title}）`).join('、') || '（本卷还没有章节）';
		return text(`分卷「${target.name}」的卷摘要尚未创建。卷内章节：${chapterList}。摘要写入：${filePath}`);
	}
	const md = await fs.readFile(filePath, 'utf8');
	return text(target.state === 'planned' ? `${PLAN_NOTICE}${md}` : target.state === 'stale' ? `${STALE_NOTICE}${md}` : md);
}

/** 列出全部计划摘要（正文/分卷/区间尚未写全）：供 agent 看「接下来要写什么」。 */
async function listSummaryPlans(library: LibraryService, book: BookInfo): Promise<vscode.LanguageModelToolResult> {
	const volumes = await library.listVolumes(book);
	const [states, volumeSummaries, intervals] = await Promise.all([
		library.listChapterSummaryStates(book, volumes),
		library.listVolumeSummaries(book, volumes),
		library.listIntervalSummaries(book),
	]);
	const lines = [...states]
		.filter(([, state]) => state === 'planned')
		.map(([rel]) => `${CHAPTER_SUMMARIES_DIR}/${rel}（章节计划）`);
	lines.push(
		...volumeSummaries
			.filter((summary) => summary.state === 'planned')
			.map((summary) => `${VOLUME_SUMMARIES_DIR}/${summary.fileName}（卷内还有计划章节）`)
	);
	lines.push(
		...intervals
			.filter((interval) => interval.state === 'planned')
			.map((interval) => `${INTERVAL_SUMMARIES_DIR}/${interval.fileName}（区间计划：第 ${interval.startSeq}–${interval.endSeq} 章）`)
	);
	if (lines.length === 0) {
		return text(
			`《${book.name}》还没有计划摘要（可用 readSummary 的 scope=chapter / volume / interval 指定尚未写全的目标来写计划）。`
		);
	}
	return text(
		`《${book.name}》计划摘要：\n${lines.join('\n')}\n写正文用 xReader_manageChapter（action=insert：after / before 指定相邻章，或 seq 直接给序号）——同序号会接手对应的计划摘要。`
	);
}

/** 注册小说库的 Language Model 工具（agent 通过约定读写文件，工具提供结构化领域操作）。 */
export function registerAgentTools(context: vscode.ExtensionContext, library: LibraryService): void {
	// 读类：定位、清单与摘要
	context.subscriptions.push(
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
							chapter = (await library.listChapters(book)).find((c) => sameChapter(c, target));
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
				const index = chapter ? chapters.findIndex((c) => sameChapter(c, chapter)) : -1;
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

		vscode.lm.registerTool<BookInput>('xReader_listBooks', {
			async invoke() {
				const books = await library.listBooks();
				if (books.length === 0) {
					return text('小说库还是空的，请导入或新建小说。');
				}
				// 只列目录取章节数：上千本书时逐本读取章节正文会明显拖慢调用
				const counts = await library.listChapterCounts(books);
				const lines = books.map((b) => `${b.name}｜${counts.get(b.dir) ?? 0} 章`);
				return text(`小说库（书文件夹名｜章节数）：\n${lines.join('\n')}`);
			},
			prepareInvocation: () => ({ invocationMessage: vscode.l10n.t('List Books') }),
		}),

		vscode.lm.registerTool<BookInput>('xReader_listVolumes', {
			async invoke(options) {
				const book = await resolveBook(library, options.input.book);
				const volumes = await library.listVolumes(book);
				// 卷摘要列表 = 现存分卷 + 只有卷摘要文件、分卷尚未创建的未来卷，按卷序排列
				const summaries = await library.listVolumeSummaries(book, volumes);
				if (summaries.length === 0) {
					return text(`《${book.name}》还没有分卷。`);
				}
				const existing = new Set(volumes.map((volume) => volume.dirName ?? volume.name));
				const lines = summaries.map((summary) => {
					const key = summary.dirName ?? summary.name;
					const dir = existing.has(key) ? `章节/${summary.dirName ?? '（根目录）'}` : '（分卷尚未创建）';
					return `${summary.name}｜目录：${dir}｜${summary.chapters.length} 章${volumeSummaryMark(summary.state)}`;
				});
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
				const [summaryStates, volumeSummaries] = await Promise.all([
					library.listChapterSummaryStates(book, volumes),
					library.listVolumeSummaries(book, volumes),
				]);
				const volumeStateOf = new Map(
					volumeSummaries.map((summary) => [summary.dirName ?? summary.name, summary.state])
				);
				const targets = volumeName ? [pickVolume(volumes, volumeName)] : volumes;
				const lines: string[] = [];
				for (const volume of targets) {
					lines.push(`【${volume.name}】${volumeSummaryMark(volumeStateOf.get(volume.dirName ?? volume.name))}`);
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

		vscode.lm.registerTool<BookInput & { scope: string; chapter?: string; range?: string; volume?: string }>(
			'xReader_readSummary',
			{
				async invoke(options) {
					const scope = requireEnum(
						options.input.scope,
						['chapter', 'interval', 'volume', 'plan'] as const,
						'scope'
					);
					const book = await resolveBook(library, options.input.book);
					if (scope === 'chapter') {
						return readChapterSummary(library, book, requireParam(options.input.chapter, 'chapter'));
					}
					if (scope === 'interval') {
						return readIntervalSummary(library, book, options.input.range?.trim());
					}
					if (scope === 'volume') {
						return readVolumeSummary(library, book, options.input.volume?.trim());
					}
					return listSummaryPlans(library, book);
				},
				prepareInvocation: (options) => ({
					invocationMessage:
						options.input.scope === 'interval'
							? vscode.l10n.t('Read Interval Summary')
							: options.input.scope === 'volume'
								? vscode.l10n.t('Read Volume Summary')
								: options.input.scope === 'plan'
									? vscode.l10n.t('List Summary Plans')
									: vscode.l10n.t('Read Chapter Summary'),
				}),
			}
		),

		vscode.lm.registerTool<BookInput & { kind: string }>('xReader_listEntries', {
			async invoke(options) {
				const spec = requireKind(options.input.kind);
				const book = await resolveBook(library, options.input.book);
				const lineOf = async (relPath: string, name: string): Promise<string> =>
					spec.kind === 'note'
						? `${relPath}｜${name}${await noteLinkSuffix(book, relPath)}`
						: `${relPath}｜${name}`;
				const lines = await listEntriesGrouped(library, book, spec.rootDir, lineOf);
				return text(
					lines.length === 0
						? `《${book.name}》还没有${spec.noun}。`
						: `《${book.name}》${spec.noun}（相对路径｜名称）：\n${lines.join('\n')}`
				);
			},
			prepareInvocation: (options) => {
				const spec = findKind(options.input.kind);
				return spec ? { invocationMessage: vscode.l10n.t(spec.message.list) } : {};
			},
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
		})
	);

	// 写类：书 / 分卷 / 章节 / 章节版本 各一个工具，用 action 参数区分操作
	context.subscriptions.push(
		vscode.lm.registerTool<ManageBookInput>('xReader_manageBook', {
			async invoke(options) {
				const input = options.input;
				const action = requireEnum(input.action, ['create', 'rename', 'delete'] as const, 'action');
				if (action === 'create') {
					const book = await library.createBook(requireParam(input.name, 'name'));
					return text(`已新建《${book.name}》（目录：${book.dir}）。`);
				}
				const book = await resolveBook(library, input.book);
				if (action === 'rename') {
					const renamed = await library.renameBook(book, requireParam(input.newName, 'newName'));
					return text(`已将《${book.name}》重命名为《${renamed.name}》。`);
				}
				await library.removeBook(book);
				return text(`已删除《${book.name}》及其全部章节。`);
			},
			prepareInvocation: (options) => {
				const { action, name, newName, book } = options.input;
				if (action === 'create') {
					return { invocationMessage: vscode.l10n.t('Create book “{0}”', name ?? '') };
				}
				if (action === 'rename') {
					return { invocationMessage: vscode.l10n.t('Rename book to “{0}”', newName ?? '') };
				}
				const target = book?.trim() || library.getCurrentBook()?.name || book || '';
				return {
					invocationMessage: vscode.l10n.t('Delete book “{0}”', target),
					confirmationMessages: {
						title: vscode.l10n.t('Delete Book'),
						message: new vscode.MarkdownString(vscode.l10n.t('Delete {0}?', target)),
					},
				};
			},
		}),

		vscode.lm.registerTool<ManageVolumeInput>('xReader_manageVolume', {
			async invoke(options) {
				const input = options.input;
				const action = requireEnum(input.action, ['create', 'rename', 'delete', 'deletePlan'] as const, 'action');
				const book = await resolveBook(library, input.book);
				if (action === 'create') {
					const dirName = await library.createVolume(book, requireParam(input.name, 'name'));
					return text(`已创建分卷「${dirName}」（${book.name}/${CHAPTERS_DIR}/${dirName}/）。`);
				}
				const ref = requireParam(input.volume, 'volume');
				if (action === 'deletePlan') {
					// 计划卷摘要针对的可能是尚未创建的分卷，故不要求分卷目录存在
					const fileName = await library.removeVolumePlan(book, ref);
					return text(`已删除卷计划摘要 ${VOLUME_SUMMARIES_DIR}/${fileName}（卷内还没有正文或还有计划章节）。`);
				}
				const volumeDir = await requireVolumeDir(library, book, ref);
				if (action === 'rename') {
					const target = await library.renameVolume(book, volumeDir, requireParam(input.newName, 'newName'));
					return text(`已将分卷「${ref}」重命名为「${target}」。`);
				}
				await library.deleteVolume(book, volumeDir, input.deleteChapters === true);
				return text(`已删除分卷「${ref}」。`);
			},
			prepareInvocation: (options) => {
				const { action, volume, name, newName, deleteChapters } = options.input;
				if (action === 'create') {
					return { invocationMessage: vscode.l10n.t('Create volume “{0}”', name ?? '') };
				}
				if (action === 'rename') {
					return { invocationMessage: vscode.l10n.t('Rename volume “{0}” to “{1}”', volume ?? '', newName ?? '') };
				}
				if (action === 'deletePlan') {
					return {
						invocationMessage: vscode.l10n.t('Delete volume plan “{0}”', volume ?? ''),
						confirmationMessages: {
							title: vscode.l10n.t('Delete Volume Plan'),
							message: new vscode.MarkdownString(vscode.l10n.t('Delete volume plan “{0}”?', volume ?? '')),
						},
					};
				}
				return {
					invocationMessage: vscode.l10n.t('Delete volume “{0}”', volume ?? ''),
					confirmationMessages: {
						title: vscode.l10n.t('Delete Volume'),
						message: new vscode.MarkdownString(
							vscode.l10n.t(
								'Delete volume “{0}”{1}?',
								volume ?? '',
								deleteChapters ? vscode.l10n.t(' and all its chapters') : ''
							)
						),
					},
				};
			},
		}),

		vscode.lm.registerTool<ManageChapterInput>('xReader_manageChapter', {
			async invoke(options) {
				const input = options.input;
				const action = requireEnum(
					input.action,
					['create', 'insert', 'rename', 'move', 'delete', 'deletePlan'] as const,
					'action'
				);
				const book = await resolveBook(library, input.book);
				if (input.plan === true && action !== 'insert') {
					throw new Error(
						vscode.l10n.t(
							'The plan parameter is only valid with action=insert (it writes a plan summary instead of the chapter text).'
						)
					);
				}
				switch (action) {
					case 'create': {
						const volume = input.volume?.trim();
						const volumeDir = volume ? pickVolume(await library.listVolumes(book), volume).dirName : undefined;
						const fileName = await library.createChapter(book, requireParam(input.title, 'title'), volumeDir);
						return text(`已新建章节：${chapterRelPath({ fileName, volumeDir })}。`);
					}
					case 'insert': {
						const title = requireParam(input.title, 'title');
						const after = input.after?.trim();
						const before = input.before?.trim();
						if ((after ? 1 : 0) + (before ? 1 : 0) > 1) {
							throw new Error(
								vscode.l10n.t('Pass exactly one of after / before to locate the insertion point.')
							);
						}
						const anchor = after || before ? await requireChapter(library, book, (after ?? before) as string) : undefined;
						const seq = input.seq === undefined ? undefined : requireNumber(input.seq, 'seq');
						const volumeRef = input.volume?.trim();
						const volumeDir = volumeRef
							? pickVolume(await library.listVolumes(book), volumeRef).dirName
							: undefined;
						if (input.plan === true) {
							// 计划章节：只建计划摘要（正文留待后写）。位置按锚点、序号，都没有则接在末尾
							const result = await library.createChapterPlan(
								book,
								title,
								anchor
									? after
										? { after: anchor }
										: { before: anchor }
									: seq === undefined
										? undefined
										: { seq, volumeDir }
							);
							const target = chapterRelPath({
								fileName: result.fileName,
								volumeDir: anchor ? anchor.volumeDir : volumeDir,
							});
							const shifting = result.shifted > 0 ? `其后的 ${result.shifted} 章序号已顺延 +1。` : '';
							return text(
								`已创建计划章节摘要：${CHAPTER_SUMMARIES_DIR}/${target}。${shifting}正文尚未创建，请用文件工具把计划写进该文件；按此位置写正文（action=insert）时该摘要会自动接手。`
							);
						}
						if (anchor) {
							const result = await library.insertChapter(book, title, after ? { after: anchor } : { before: anchor });
							const target = chapterRelPath({ fileName: result.fileName, volumeDir: anchor.volumeDir });
							const shifting = result.renumbered > 0 ? `其后的 ${result.renumbered} 章序号已顺延 +1。` : '';
							return text(
								`已在「${anchor.title || anchor.fileName}」${after ? '之后' : '之前'}插入新章节：${target}。${shifting}请用文件工具写入正文。`
							);
						}
						if (seq === undefined) {
							throw new Error(
								vscode.l10n.t(
									'Pass exactly one of after / before to locate the insertion point, or seq to pick the chapter number.'
								)
							);
						}
						const created = await library.createChapterAt(book, seq, title, volumeDir);
						const target = chapterRelPath({ fileName: created.fileName, volumeDir });
						const shifting = created.shifted > 0 ? `其后的 ${created.shifted} 章序号已顺延 +1。` : '';
						return text(
							`已在第 ${seq} 章的位置创建章节：${target}。${shifting}请用文件工具写入正文；同序号若有计划摘要，已自动接手。`
						);
					}
					case 'rename': {
						const chapter = await requireChapter(library, book, requireParam(input.chapter, 'chapter'));
						const newFileName = await library.renameChapter(book, chapter, requireParam(input.newTitle, 'newTitle'));
						return text(`已重命名章节：${chapterRelPath({ fileName: newFileName, volumeDir: chapter.volumeDir })}。`);
					}
					case 'move': {
						const chapter = await requireChapter(library, book, requireParam(input.chapter, 'chapter'));
						const target = pickVolume(await library.listVolumes(book), requireParam(input.volume, 'volume'));
						await library.moveChapter(book, chapter, target.dirName);
						return text(
							`已把第${chapter.seq}章「${chapter.title}」从 ${chapter.volumeDir ?? '（章节根目录）'} 移动到分卷「${target.name}」（${CHAPTERS_DIR}/${target.dirName ?? '（根目录）'}）。章节序号不变，导航、摘要镜像、笔记关联与阅读进度已同步。`
						);
					}
					case 'deletePlan': {
						const rel = await library.removeChapterPlan(book, requireParam(input.chapter, 'chapter'));
						return text(`已删除计划章节摘要：${CHAPTER_SUMMARIES_DIR}/${rel}。`);
					}
					default: {
						const chapter = await requireChapter(library, book, requireParam(input.chapter, 'chapter'));
						await library.removeChapter(book, chapter);
						return text(`已删除第${chapter.seq}章「${chapter.title}」。`);
					}
				}
			},
			prepareInvocation: (options) => {
				const { action, chapter, title, newTitle, volume } = options.input;
				if (action === 'create') {
					return { invocationMessage: vscode.l10n.t('Create chapter “{0}”', title ?? '') };
				}
				if (action === 'insert') {
					return { invocationMessage: vscode.l10n.t('Insert chapter “{0}”', title ?? '') };
				}
				if (action === 'rename') {
					return {
						invocationMessage: vscode.l10n.t('Rename chapter “{0}” to “{1}”', chapter ?? '', newTitle ?? ''),
					};
				}
				if (action === 'move') {
					return {
						invocationMessage: vscode.l10n.t('Move chapter “{0}” to volume “{1}”', chapter ?? '', volume ?? ''),
					};
				}
				if (action === 'deletePlan') {
					return {
						invocationMessage: vscode.l10n.t('Delete chapter plan “{0}”', chapter ?? ''),
						confirmationMessages: {
							title: vscode.l10n.t('Delete Chapter Plan'),
							message: new vscode.MarkdownString(vscode.l10n.t('Delete chapter plan “{0}”?', chapter ?? '')),
						},
					};
				}
				return {
					invocationMessage: vscode.l10n.t('Delete chapter “{0}”', chapter ?? ''),
					confirmationMessages: {
						title: vscode.l10n.t('Delete Chapter'),
						message: new vscode.MarkdownString(vscode.l10n.t('Delete chapter “{0}”?', chapter ?? '')),
					},
				};
			},
		}),

		vscode.lm.registerTool<ManageChapterVersionInput>('xReader_manageChapterVersion', {
			async invoke(options) {
				const input = options.input;
				const action = requireEnum(input.action, ['list', 'create', 'setPrimary', 'delete'] as const, 'action');
				const book = await resolveBook(library, input.book);
				const chapter = await requireChapter(library, book, requireParam(input.chapter, 'chapter'));
				if (action === 'list') {
					const versions = await library.listChapterVersions(book, chapter);
					return text(
						versions.length === 0
							? `第${chapter.seq}章「${chapter.title}」还没有备选版本。主版本：${chapterRelPath(chapter)}`
							: `第${chapter.seq}章「${chapter.title}」的备选版本（主版本：${chapterRelPath(chapter)}）：\n${versions.map((v) => v.name).join('、')}`
					);
				}
				if (action === 'create') {
					const filePath = await library.createChapterVersion(book, chapter, input.name?.trim() || undefined);
					return text(
						`已把第${chapter.seq}章「${chapter.title}」当前主版本内容存为备选版本：${filePath}。可用文件工具编辑该版本。`
					);
				}
				const version = requireParam(input.version, 'version');
				if (action === 'setPrimary') {
					await library.promoteChapterVersion(book, chapter, version, input.keepOldName);
					return text(
						`已把版本「${version}」设为第${chapter.seq}章「${chapter.title}」的主版本（${chapterRelPath(chapter)}），原主版本内容已存回版本库。章节摘要已转为待维护，需要重新保存摘要。`
					);
				}
				await library.deleteChapterVersion(book, chapter, version);
				return text(`已删除第${chapter.seq}章「${chapter.title}」的备选版本「${version}」。`);
			},
			prepareInvocation: (options) => {
				const { action, chapter, name, version } = options.input;
				if (action === 'list') {
					return { invocationMessage: vscode.l10n.t('List Chapter Versions') };
				}
				if (action === 'create') {
					return { invocationMessage: vscode.l10n.t('Create chapter version “{0}”', name ?? '') };
				}
				if (action === 'setPrimary') {
					return { invocationMessage: vscode.l10n.t('Set chapter version “{0}” as primary', version ?? '') };
				}
				return {
					invocationMessage: vscode.l10n.t('Delete chapter version “{0}”', version ?? ''),
					confirmationMessages: {
						title: vscode.l10n.t('Delete Version'),
						message: new vscode.MarkdownString(
							vscode.l10n.t('Delete version “{0}” of chapter “{1}”?', version ?? '', chapter ?? '')
						),
					},
				};
			},
		}),

		// 区间摘要：起止任意（可重叠），区间内还有没写的章节即计划
		vscode.lm.registerTool<ManageIntervalInput>('xReader_manageInterval', {
			async invoke(options) {
				const input = options.input;
				const action = requireEnum(input.action, ['create', 'editRange', 'delete'] as const, 'action');
				const book = await resolveBook(library, input.book);
				if (action === 'create') {
					const startSeq = requireNumber(input.start, 'start');
					const endSeq = requireNumber(input.end, 'end');
					const filePath = await library.ensureIntervalSummary(book, startSeq, endSeq);
					return text(`区间摘要已就绪：${filePath}。请用文件工具写入摘要内容（写入后仍缺章节时它会显示为计划）。`);
				}
				const parsed = parseRangeRef(requireParam(input.range, 'range'));
				if (!parsed) {
					throw new Error(
						vscode.l10n.t('Interval “{0}” is invalid. Use a start–end pair like 0011-0020 or 11-20.', input.range ?? '')
					);
				}
				const fileName = intervalSummaryFileName(parsed.startSeq, parsed.endSeq);
				if (action === 'delete') {
					await library.removeIntervalSummary(book, fileName);
					return text(`已删除区间计划摘要 ${fileName}。`);
				}
				const startSeq = requireNumber(input.start, 'start');
				const endSeq = requireNumber(input.end, 'end');
				const filePath = await library.editIntervalSummary(book, fileName, startSeq, endSeq);
				return text(`已把区间摘要 ${fileName} 改为 第 ${startSeq}–${endSeq} 章：${filePath}。摘要正文保留，标题与「章节范围」已重写。`);
			},
			prepareInvocation: (options) => {
				const { action, range, start, end } = options.input;
				if (action === 'create') {
					return { invocationMessage: vscode.l10n.t('Create interval summary {0}–{1}', start ?? 0, end ?? 0) };
				}
				if (action === 'editRange') {
					return {
						invocationMessage: vscode.l10n.t('Change interval “{0}” to {1}–{2}', range ?? '', start ?? 0, end ?? 0),
					};
				}
				return {
					invocationMessage: vscode.l10n.t('Delete interval “{0}”', range ?? ''),
					confirmationMessages: {
						title: vscode.l10n.t('Delete Interval Summary'),
						message: new vscode.MarkdownString(vscode.l10n.t('Delete interval summary “{0}”?', range ?? '')),
					},
				};
			},
		})
	);

	// 写类：条目（世界书/角色卡/笔记）与分类，kind 参数区分三处，操作同构
	context.subscriptions.push(
		vscode.lm.registerTool<ManageEntryInput>('xReader_manageEntry', {
			async invoke(options) {
				const input = options.input;
				const spec = requireKind(input.kind);
				const action = requireEnum(input.action, ['create', 'rename', 'move', 'delete'] as const, 'action');
				const book = await resolveBook(library, input.book);
				if (action === 'create') {
					const name = requireParam(input.name, 'name');
					const category = await resolveTargetCategory(library, book, spec.rootDir, input.category?.trim() || undefined);
					if (spec.kind === 'note') {
						const ref = input.chapter?.trim();
						const chapter = ref ? await requireChapter(library, book, ref) : undefined;
						const filePath = await library.createNote(book, name, category, chapter);
						return text(`笔记已就绪：${filePath}。`);
					}
					const filePath = await library.createEntry(book, spec.rootDir, name, category);
					return text(`${spec.noun}已就绪：${filePath}。`);
				}
				const { file, categoryPath, subDir } = await requireEntryIn(library, book, spec, input);
				if (action === 'rename') {
					const newFileName = await library.renameEntry(book, subDir, file.fileName, requireParam(input.newName, 'newName'));
					return text(`已重命名${spec.noun}：${subDir}/${newFileName}。`);
				}
				if (action === 'move') {
					const target = await resolveTargetCategory(library, book, spec.rootDir, input.targetCategory?.trim() || undefined);
					await library.moveEntry(book, spec.rootDir, categoryPath, file.fileName, target);
					return text(`已移动${spec.noun}「${file.name}」到${target ? `分类「${target}」` : '根目录'}。`);
				}
				await library.removeEntry(book, subDir, file.fileName);
				return text(`已删除${spec.noun}「${file.name}」${categoryPath ? `（分类：${categoryPath}）` : ''}。`);
			},
			prepareInvocation: (options) => {
				const spec = findKind(options.input.kind);
				if (!spec) {
					return {};
				}
				const { action, name, newName, targetCategory } = options.input;
				const message = spec.message;
				if (action === 'create') {
					return { invocationMessage: vscode.l10n.t(message.create, name ?? '') };
				}
				if (action === 'rename') {
					return { invocationMessage: vscode.l10n.t(message.rename, name ?? '', newName ?? '') };
				}
				if (action === 'move') {
					return {
						invocationMessage: vscode.l10n.t(
							'Move “{0}” to category “{1}”',
							name ?? '',
							targetCategory?.trim() || vscode.l10n.t('(root)')
						),
					};
				}
				return {
					invocationMessage: vscode.l10n.t(message.delete, name ?? ''),
					confirmationMessages: {
						title: vscode.l10n.t(message.deleteTitle),
						message: new vscode.MarkdownString(vscode.l10n.t(message.deleteConfirm, name ?? '')),
					},
				};
			},
		}),

		vscode.lm.registerTool<ManageCategoryInput>('xReader_manageCategory', {
			async invoke(options) {
				const input = options.input;
				const spec = requireKind(input.kind);
				const action = requireEnum(input.action, ['create', 'rename', 'delete'] as const, 'action');
				const book = await resolveBook(library, input.book);
				if (action === 'create') {
					const createdPath = await library.createCategory(book, spec.rootDir, requireParam(input.name, 'name'));
					return text(`已创建${spec.categoryNoun}分类「${createdPath}」（${spec.rootDir}/${createdPath}/）。`);
				}
				const category = await requireCategory(library, book, spec.rootDir, requireParam(input.category, 'category'));
				if (action === 'rename') {
					const target = await library.renameCategory(
						book,
						spec.rootDir,
						category.path,
						requireParam(input.newName, 'newName')
					);
					return text(`已将${spec.categoryNoun}分类「${category.path}」重命名为「${target}」。`);
				}
				await library.deleteCategory(book, spec.rootDir, category.path);
				return text(`已删除${spec.categoryNoun}分类「${category.path}」及其全部内容。`);
			},
			prepareInvocation: (options) => {
				const { action, name, category, newName } = options.input;
				if (action === 'create') {
					return { invocationMessage: vscode.l10n.t('Create category “{0}”', name ?? '') };
				}
				if (action === 'rename') {
					return {
						invocationMessage: vscode.l10n.t('Rename category “{0}” to “{1}”', category ?? '', newName ?? ''),
					};
				}
				return {
					invocationMessage: vscode.l10n.t('Delete category “{0}”', category ?? ''),
					confirmationMessages: {
						title: vscode.l10n.t('Delete Category'),
						message: new vscode.MarkdownString(
							vscode.l10n.t('Delete category “{0}” and all its entries?', category ?? '')
						),
					},
				};
			},
		})
	);
}

interface ManageBookInput extends BookInput {
	action: string;
	name?: string;
	newName?: string;
}

interface ManageVolumeInput extends BookInput {
	action: string;
	name?: string;
	volume?: string;
	newName?: string;
	deleteChapters?: boolean;
}

interface ManageChapterInput extends BookInput {
	action: string;
	chapter?: string;
	title?: string;
	volume?: string;
	after?: string;
	before?: string;
	newTitle?: string;
	/** action=insert 时直接指定章节序号（不指定 after/before 也可）：该序号被占用时其后的章节顺延 */
	seq?: number;
	/** action=insert 时只建计划摘要（不写正文），位置同插章 */
	plan?: boolean;
}

interface ManageIntervalInput extends BookInput {
	action: string;
	/** 目标区间（`0011-0020` / `11-20` / 文件名；action=editRange / delete） */
	range?: string;
	/** 区间起始章节序号（action=create / editRange） */
	start?: number;
	/** 区间结束章节序号（action=create / editRange） */
	end?: number;
}

interface ManageChapterVersionInput extends BookInput {
	action: string;
	chapter: string;
	name?: string;
	version?: string;
	keepOldName?: string;
}

interface ManageEntryInput extends BookInput {
	kind: string;
	action: string;
	name?: string;
	category?: string;
	newName?: string;
	targetCategory?: string;
	chapter?: string;
}

interface ManageCategoryInput extends BookInput {
	kind: string;
	action: string;
	name?: string;
	category?: string;
	newName?: string;
}
