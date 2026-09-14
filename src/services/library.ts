import type { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BookInfo, ChapterFile, ChapterSummaryGroup, ChapterVolume, EntryCategory, EntryFile, IntervalSummary, Shelf, SummaryState, VolumeSummary } from '../model/book';
import {
	CARDS_DIR,
	CHAPTER_SUMMARIES_DIR,
	CHAPTERS_DIR,
	createBookFromText,
	INTERVAL_SUMMARIES_DIR,
	META_FILE,
	NOTES_DIR,
	uniqueBookName,
	VERSIONS_DIR,
	VOLUME_SUMMARIES_DIR,
	WORLD_DIR,
} from './bookFactory';
import { commitAll } from './git';
import {
	type BookMetadata,
	buildChapterMarkdown,
	buildChapterSummaryMarkdown,
	buildEntryMarkdown,
	buildIntervalSummaryMarkdown,
	buildMetadataMarkdown,
	buildNoteMarkdown,
	buildVolumeSummaryMarkdown,
	chapterFileName,
	chineseNumberToInt,
	escapeMdLinkText,
	extractMarkdownTitle,
	intervalSummaryFileName,
	mdToPlainText,
	navRelPath,
	parseBookMetadata,
	parseChapterFileName,
	parseIntervalSummaryFileName,
	planChapterInsertSeq,
	rewriteIntervalRange,
	sanitizeFileTitle,
	updateChapterNav,
	volumeSummaryFileName,
} from './markdown';
import { decodeBuffer } from './novelParser';

export {
	CARDS_DIR,
	CHAPTER_SUMMARIES_DIR,
	CHAPTERS_DIR,
	createBookFromText,
	INTERVAL_SUMMARIES_DIR,
	META_FILE,
	NOTES_DIR,
	VERSIONS_DIR,
	VOLUME_SUMMARIES_DIR,
	WORLD_DIR
};

/** 区间摘要的章节数：每 10 章一个区间。 */
export const INTERVAL_SUMMARY_SIZE = 10;

/** 子书架清单文件（库根下），记录自定义子书架与其收录的书链接。 */
export const SHELVES_FILE = '书架.json';

/** 默认子书架名：不出现在 书架.json 中，始终收录全部书。 */
export const DEFAULT_SHELF_NAME = '默认';

/** 切换主版本时原主版本在版本库中的默认存档名。 */
export const PRIMARY_KEEP_VERSION_NAME = '原版';

/** 计划章节摘要的位置：参照章（after / before，序号有空档优先）或直接指定序号（可落在存量中间）。 */
export type ChapterPlanPosition =
	| { after: Pick<ChapterFile, 'fileName' | 'volumeDir'> }
	| { before: Pick<ChapterFile, 'fileName' | 'volumeDir'> }
	| { seq: number; volumeDir?: string };

/** 新建空书时创建的目录骨架（不含 章节/；放 .gitkeep 以便 git 跟踪）。 */
const EMPTY_SUBDIRS = [
	WORLD_DIR,
	CARDS_DIR,
	CHAPTER_SUMMARIES_DIR,
	INTERVAL_SUMMARIES_DIR,
	VOLUME_SUMMARIES_DIR,
	NOTES_DIR,
	VERSIONS_DIR,
];

/** 章节在 章节/ 下的相对路径（分卷含目录名），用作进度键。 */
export function chapterRelPath(chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>): string {
	return chapter.volumeDir ? `${chapter.volumeDir}/${chapter.fileName}` : chapter.fileName;
}

/** 是否同一章（分卷目录 + 文件名）。 */
export function sameChapter(
	a: Pick<ChapterFile, 'fileName' | 'volumeDir'>,
	b: Pick<ChapterFile, 'fileName' | 'volumeDir'>
): boolean {
	return a.fileName === b.fileName && (a.volumeDir ?? '') === (b.volumeDir ?? '');
}

/** 进度键是否指向该章：新格式为分卷相对路径，兼容旧格式的纯文件名。 */
export function matchesProgress(
	chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>,
	progress: string | undefined
): boolean {
	return progress !== undefined && (progress === chapterRelPath(chapter) || progress === chapter.fileName);
}

/** 清洗条目分类 / 子书架相对路径：按 / 拆段逐段清洗，去掉空段（可多级嵌套）；无有效段时返回 undefined。 */
function sanitizeRelativePath(raw: string): string | undefined {
	const segments = raw
		.split(/[/\\]+/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0)
		.map((segment) => sanitizeFileTitle(segment));
	return segments.length > 0 ? segments.join('/') : undefined;
}

/** 可选分类路径的清洗：undefined / 空表示条目根目录；`..` 等越界片段会被化解为普通名字。 */
function safeCategoryPath(categoryPath?: string): string | undefined {
	return categoryPath ? sanitizeRelativePath(categoryPath) : undefined;
}

/** 子书架路径的父路径；根层返回 undefined。 */
export function shelfParentPath(path: string): string | undefined {
	const index = path.lastIndexOf('/');
	return index < 0 ? undefined : path.slice(0, index);
}

/** 子书架路径的末级名（树节点显示用）。 */
export function shelfLeafName(path: string): string {
	const index = path.lastIndexOf('/');
	return index < 0 ? path : path.slice(index + 1);
}

/** 把子书架路径（自身或后代）从 oldPath 前缀改写为 newPath。 */
function rewriteShelfPath(path: string, oldPath: string, newPath: string): string {
	if (path === oldPath) {
		return newPath;
	}
	return path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : path;
}

/** 补齐子书架清单里缺失的上级路径（手改 json、或新建多级路径时只存了最深一层），按路径排序。 */
function withAncestorShelves(shelves: Shelf[]): Shelf[] {
	const byPath = new Map<string, Shelf>();
	for (const shelf of shelves) {
		if (!byPath.has(shelf.name)) {
			byPath.set(shelf.name, shelf);
		}
	}
	for (const shelf of [...byPath.values()]) {
		const segments = shelf.name.split('/');
		for (let i = 1; i < segments.length; i++) {
			const ancestor = segments.slice(0, i).join('/');
			if (!byPath.has(ancestor)) {
				byPath.set(ancestor, { name: ancestor, books: [] });
			}
		}
	}
	return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 章节文件的路径构成（书目录 + 分卷 + 文件名）。 */
export interface ChapterFilePath {
	/** 书文件夹绝对路径 */
	bookDir: string;
	/** 所在卷的目录名；undefined 表示 章节/ 根 */
	volumeDir: string | undefined;
	/** 章节文件名 */
	fileName: string;
}

/** 从绝对路径解析章节文件（支持 章节/根 与 章节/分卷/ 两层；取最后一个「章节」段，库路径本身含同名目录时不误判）；非章节文件返回 undefined。 */
export function parseChapterFilePath(filePath: string): ChapterFilePath | undefined {
	const segments = filePath.split(path.sep);
	const idx = segments.lastIndexOf(CHAPTERS_DIR);
	if (idx < 0 || (idx !== segments.length - 2 && idx !== segments.length - 3)) {
		return undefined;
	}
	const fileName = segments[segments.length - 1];
	if (!parseChapterFileName(fileName)) {
		return undefined;
	}
	return {
		bookDir: segments.slice(0, idx).join(path.sep),
		volumeDir: idx === segments.length - 3 ? segments[idx + 1] : undefined,
		fileName,
	};
}

/** 路径是否存在。 */
async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * 目录扫描并发上限：大书库（上千本书 / 单本上千章）下无上限的 Promise.all 会同时打开过多句柄（EMFILE），
 * 也更容易拖慢磁盘；按批执行兼顾吞吐与稳定。
 */
const SCAN_CONCURRENCY = 16;

/** 变更通知合并窗口：批量操作（连续导入、顺延改名等）只触发一次全量刷新。 */
const REFRESH_COALESCE_MS = 80;

/** 按并发上限并行映射，结果顺序与输入一致。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (; ;) {
			const index = cursor++;
			if (index >= items.length) {
				return;
			}
			results[index] = await task(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

const VOLUME_NAME_RE = /^\s*第\s*([0-9零〇一二两三四五六七八九十百千万拾佰仟]+)\s*卷/;

/** 卷目录排序键：第X卷按数字，其余按名称兜底排最后。 */
function volumeSortKey(name: string): number {
	const match = VOLUME_NAME_RE.exec(name);
	if (!match) {
		return Number.MAX_SAFE_INTEGER;
	}
	return chineseNumberToInt(match[1]) ?? Number.MAX_SAFE_INTEGER;
}

const bySeq = (a: ChapterFile, b: ChapterFile): number => a.seq - b.seq || a.fileName.localeCompare(b.fileName);

const CURRENT_BOOK_KEY = 'x-reader.currentBookDir';
const PROGRESS_KEY = 'x-reader.progress.v1';

/** 笔记 frontmatter 的 chapter 字段（章节相对路径）。 */
export const NOTE_CHAPTER_FM_RE = /^chapter:\s*"?([^"\n]+?)"?\s*$/m;

/** 笔记 frontmatter 的 chapter 整行（替换/删除用；与 NOTE_CHAPTER_FM_RE 同锚，引号可选）。 */
const NOTE_CHAPTER_LINE_RE = /^chapter:[^\n]*$/m;

/** 笔记正文的「关联章节」链接行（捕获链接文字，替换/删除用）。 */
const NOTE_CHAPTER_LINK_RE = /^> 关联章节：\[([^\]]*)\]\([^\n]*\)$/m;

/** 笔记正文的「关联章节」整行（删除用，匹配任何形式）。 */
const NOTE_CHAPTER_LINK_LINE_RE = /^> 关联章节：[^\n]*$/m;

/** 关闭已打开该文件的编辑器页签（含渲染预览）；exceptActive 为 true 时跳过当前活动页签。 */
export async function closeFileTabs(filePath: string, exceptActive = false): Promise<void> {
	const active = exceptActive ? vscode.window.tabGroups.activeTabGroup.activeTab : undefined;
	const tasks: Thenable<boolean>[] = [];
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = tab.input;
			const uri =
				input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
			if (uri && uri.fsPath === filePath && tab !== active) {
				tasks.push(vscode.window.tabGroups.close(tab, true));
			}
		}
	}
	await Promise.all(tasks);
}

/** 小说库服务：扫描库目录、读写书籍文件夹、跟踪当前书与阅读进度。文件即真相，外部变更经 watcher 汇入。 */
export class LibraryService {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private watcher: vscode.FileSystemWatcher | undefined;
	private watcherRoot = '';
	private debounce: ReturnType<typeof setTimeout> | undefined;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	/** 防抖期内内容标题可能已变更、待同步文件名的章节文件路径。 */
	private pendingChapterSync = new Set<string>();

	constructor(private readonly context: vscode.ExtensionContext) {
		this.ensureWatcher();
		context.subscriptions.push(
			{
				dispose: () => {
					this.watcher?.dispose();
					if (this.debounce) {
						clearTimeout(this.debounce);
					}
					if (this.refreshTimer) {
						clearTimeout(this.refreshTimer);
					}
				},
			},
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('xReader.libraryPath')) {
					this.ensureWatcher();
					this.scheduleRefresh();
				}
			})
		);
	}

	/** 合并窗口内的变更只通知一次：批量导入上千本书时逐本刷新会退化成 O(n²) 次目录扫描。 */
	private scheduleRefresh(): void {
		if (this.refreshTimer) {
			return;
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			this._onDidChange.fire();
		}, REFRESH_COALESCE_MS);
	}

	getLibraryPath(): string {
		const configured = vscode.workspace.getConfiguration('xReader').get<string>('libraryPath', '').trim();
		// 规范化为 fsPath（盘符大小写/分隔符统一），保证与 watcher、页签的 uri.fsPath 字符串比较一致
		return configured ? vscode.Uri.file(configured).fsPath : configured;
	}

	/** 提交一次 git 快照（未配置库路径时跳过）。 */
	private async commit(message: string): Promise<void> {
		const root = this.getLibraryPath();
		if (root) {
			await commitAll(root, message);
		}
	}

	/** 提交快照并刷新视图。 */
	private async commitAndRefresh(message: string): Promise<void> {
		await this.commit(message);
		this.scheduleRefresh();
	}

	/** 章节文件绝对路径（volumeDir 省略时指 章节/ 根，即默认卷）。 */
	private chapterPath(book: BookInfo, fileName: string, volumeDir?: string): string {
		return path.join(book.dir, CHAPTERS_DIR, volumeDir ?? '', fileName);
	}

	/** 章节摘要镜像绝对路径（与 章节/ 目录同构）。 */
	private summaryPath(book: BookInfo, fileName: string, volumeDir?: string): string {
		return path.join(book.dir, CHAPTER_SUMMARIES_DIR, volumeDir ?? '', fileName);
	}

	/** 卷摘要文件绝对路径（一卷一档，默认卷用其卷名）。 */
	private volumeSummaryPath(book: BookInfo, fileName: string): string {
		return path.join(book.dir, VOLUME_SUMMARIES_DIR, fileName);
	}

	/** 移动/重命名章节文件及其摘要镜像（用 workspace.fs，让已打开的页签跟随新路径；无镜像时忽略）。 */
	private async relocateChapterFiles(
		book: BookInfo,
		from: Pick<ChapterFile, 'fileName' | 'volumeDir'>,
		to: Pick<ChapterFile, 'fileName' | 'volumeDir'>
	): Promise<void> {
		await vscode.workspace.fs.rename(
			vscode.Uri.file(this.chapterPath(book, from.fileName, from.volumeDir)),
			vscode.Uri.file(this.chapterPath(book, to.fileName, to.volumeDir))
		);
		try {
			await vscode.workspace.fs.rename(
				vscode.Uri.file(this.summaryPath(book, from.fileName, from.volumeDir)),
				vscode.Uri.file(this.summaryPath(book, to.fileName, to.volumeDir))
			);
		} catch {
			// 无摘要镜像时忽略
		}
		try {
			await vscode.workspace.fs.rename(
				vscode.Uri.file(this.versionsDirPath(book, from)),
				vscode.Uri.file(this.versionsDirPath(book, to))
			);
		} catch {
			// 无版本目录时忽略
		}
	}

	/** 返回已配置的库目录；未配置（或 force 时）弹窗让用户选择并写入全局配置。 */
	async ensureLibraryPath(force = false): Promise<string | undefined> {
		const existing = this.getLibraryPath();
		if (existing && !force) {
			return existing;
		}
		const picked = await vscode.window.showOpenDialog({
			title: vscode.l10n.t('Choose Library Folder'),
			openLabel: vscode.l10n.t('Choose'),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
		});
		if (!picked || picked.length === 0) {
			return undefined;
		}
		const root = picked[0].fsPath;
		await vscode.workspace
			.getConfiguration('xReader')
			.update('libraryPath', root, vscode.ConfigurationTarget.Global);
		this.ensureWatcher();
		this.scheduleRefresh();
		return root;
	}

	/** 库根下的书：含 元数据.md 的文件夹。 */
	async listBooks(): Promise<BookInfo[]> {
		const root = this.getLibraryPath();
		if (!root) {
			return [];
		}
		let entries;
		try {
			entries = await fs.readdir(root, { withFileTypes: true });
		} catch {
			return [];
		}
		const books = await mapLimit(
			entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
			SCAN_CONCURRENCY,
			async (name): Promise<BookInfo | undefined> => {
				const dir = path.join(root, name);
				return (await pathExists(path.join(dir, META_FILE))) ? { name, dir } : undefined;
			}
		);
		return books
			.filter((book): book is BookInfo => book !== undefined)
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** 书库中是否至少有一本书：空态判断只需命中一本即可返回，避免为一次刷新扫描全部书目。 */
	async hasBooks(): Promise<boolean> {
		const root = this.getLibraryPath();
		if (!root) {
			return false;
		}
		let entries: Dirent[];
		try {
			entries = await fs.readdir(root, { withFileTypes: true });
		} catch {
			return false;
		}
		const dirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		for (let i = 0; i < dirNames.length; i += SCAN_CONCURRENCY) {
			const batch = dirNames.slice(i, i + SCAN_CONCURRENCY);
			const found = await Promise.all(batch.map((name) => pathExists(path.join(root, name, META_FILE))));
			if (found.includes(true)) {
				return true;
			}
		}
		return false;
	}

	/** 读取 书架.json（缺失或损坏时按空处理）；缺失的上级路径自动补齐，返回按路径排序的清单。 */
	private async readShelves(): Promise<Shelf[]> {
		if (!this.getLibraryPath()) {
			return [];
		}
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(path.join(this.getLibraryPath(), SHELVES_FILE), 'utf8'));
			if (!Array.isArray(parsed)) {
				return [];
			}
			const byPath = new Map<string, Shelf>();
			for (const item of parsed) {
				if (
					item &&
					typeof item === 'object' &&
					typeof (item as Shelf).name === 'string' &&
					(item as Shelf).name.trim() &&
					Array.isArray((item as Shelf).books) &&
					(item as Shelf).books.every((b) => typeof b === 'string')
				) {
					const name = (item as Shelf).name.trim();
					if (!byPath.has(name)) {
						byPath.set(name, { name, books: [...(item as Shelf).books] });
					}
				}
			}
			// 手改 json 或历史数据只剩深层路径时补出上级，保证树能完整展开
			return withAncestorShelves([...byPath.values()]);
		} catch {
			return [];
		}
	}

	/** 写入 书架.json（不提交快照，由调用方统一 commit）。 */
	private async saveShelves(shelves: Shelf[]): Promise<void> {
		const root = this.getLibraryPath();
		if (!root) {
			return;
		}
		if (shelves.length === 0) {
			await fs.rm(path.join(root, SHELVES_FILE), { force: true });
			return;
		}
		const sorted = [...shelves].sort((a, b) => a.name.localeCompare(b.name));
		await fs.writeFile(path.join(root, SHELVES_FILE), JSON.stringify(sorted, null, '\t'), 'utf8');
	}

	/** 自定义子书架列表（不含默认子书架），按路径排序。 */
	async listShelves(): Promise<Shelf[]> {
		return this.readShelves();
	}

	/** 校验子书架路径（可多级，如 题材/同人）并返回清洗结果。 */
	private async validateShelfPath(raw: string, except?: string): Promise<string> {
		const target = sanitizeRelativePath(raw);
		if (!target) {
			throw new Error('子书架名不能为空');
		}
		if (target === DEFAULT_SHELF_NAME || target.startsWith(`${DEFAULT_SHELF_NAME}/`)) {
			throw new Error(`子书架「${target}」与默认子书架「${DEFAULT_SHELF_NAME}」冲突`);
		}
		if ((await this.readShelves()).some((s) => s.name === target && s.name !== except)) {
			throw new Error(`子书架「${target}」已存在`);
		}
		return target;
	}

	/** 新建子书架（path 可多级，如 题材/同人，缺的上级一并补出），返回清洗后的路径。 */
	async createShelf(path: string): Promise<string> {
		const target = await this.validateShelfPath(path);
		const shelves = withAncestorShelves([...(await this.readShelves()), { name: target, books: [] }]);
		await this.saveShelves(shelves);
		await this.commitAndRefresh(`新建子书架「${target}」`);
		return target;
	}

	/** 重命名子书架（newPath 为同级名称，也可写成相对路径以并层；下级子书架随路径整体迁移）。 */
	async renameShelf(oldPath: string, newPath: string): Promise<void> {
		const shelves = await this.readShelves();
		if (!shelves.some((s) => s.name === oldPath)) {
			throw new Error(`子书架「${oldPath}」不存在`);
		}
		const parent = shelfParentPath(oldPath);
		const target = await this.validateShelfPath(parent ? `${parent}/${newPath}` : newPath, oldPath);
		if (target === oldPath) {
			return;
		}
		const renamed = shelves.map((s) => ({ ...s, name: rewriteShelfPath(s.name, oldPath, target) }));
		if (new Set(renamed.map((s) => s.name)).size !== renamed.length) {
			throw new Error(`子书架「${target}」已存在`);
		}
		await this.saveShelves(renamed);
		await this.commitAndRefresh(`重命名子书架「${oldPath}」→「${target}」`);
	}

	/** 删除子书架及其全部下级子书架（只解除书籍链接，不删除书）。 */
	async deleteShelf(path: string): Promise<void> {
		const shelves = (await this.readShelves()).filter(
			(s) => s.name !== path && !s.name.startsWith(`${path}/`)
		);
		await this.saveShelves(shelves);
		await this.commitAndRefresh(`删除子书架「${path}」`);
	}

	async addBookToShelf(shelfPath: string, bookName: string): Promise<void> {
		const shelves = await this.readShelves();
		const shelf = shelves.find((s) => s.name === shelfPath);
		if (!shelf) {
			throw new Error(`子书架「${shelfPath}」不存在`);
		}
		if (!shelf.books.includes(bookName)) {
			shelf.books.push(bookName);
			await this.saveShelves(shelves);
			await this.commitAndRefresh(`添加《${bookName}》到子书架「${shelfPath}」`);
		}
	}

	async removeBookFromShelf(shelfPath: string, bookName: string): Promise<void> {
		const shelves = await this.readShelves();
		const shelf = shelves.find((s) => s.name === shelfPath);
		if (!shelf) {
			return;
		}
		const filtered = shelf.books.filter((b) => b !== bookName);
		if (filtered.length !== shelf.books.length) {
			shelf.books = filtered;
			await this.saveShelves(shelves);
			await this.commitAndRefresh(`从子书架「${shelfPath}」移除《${bookName}》`);
		}
	}

	/** 书改名/删除时同步所有子书架里的书链接（newName 为 undefined 表示删除）。 */
	private async updateShelfBookRefs(oldName: string, newName?: string): Promise<boolean> {
		const shelves = await this.readShelves();
		let changed = false;
		for (const shelf of shelves) {
			const index = shelf.books.indexOf(oldName);
			if (index < 0) {
				continue;
			}
			if (newName && !shelf.books.includes(newName)) {
				shelf.books[index] = newName;
			} else {
				shelf.books.splice(index, 1);
			}
			changed = true;
		}
		if (changed) {
			await this.saveShelves(shelves);
		}
		return changed;
	}

	/** 章节分卷列表（按卷序排序）：根目录章节归入默认卷 第一卷。 */
	async listVolumes(book: BookInfo): Promise<ChapterVolume[]> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(path.join(book.dir, CHAPTERS_DIR), { withFileTypes: true });
		} catch {
			return [];
		}
		const rootParsed: { parsed: { seq: number; title: string }; fileName: string }[] = [];
		const volumeDirs: string[] = [];
		for (const entry of entries) {
			if (entry.isDirectory()) {
				volumeDirs.push(entry.name);
			} else {
				const parsed = parseChapterFileName(entry.name);
				if (parsed) {
					rootParsed.push({ parsed, fileName: entry.name });
				}
			}
		}
		const rootChapters: ChapterFile[] = await mapLimit(
			rootParsed,
			SCAN_CONCURRENCY,
			async ({ parsed, fileName }) => ({
				...parsed,
				title: (await this.readChapterContentTitle(this.chapterPath(book, fileName))) ?? parsed.title,
				fileName,
			})
		);
		rootChapters.sort(bySeq);

		const volumes: ChapterVolume[] = [];
		if (rootChapters.length > 0) {
			// 根目录章节归入默认卷；若已有同名目录则并入
			const defaultIdx = volumeDirs.indexOf('第一卷');
			if (defaultIdx >= 0) {
				const volume = await this.readVolume(book, volumeDirs[defaultIdx]);
				volume.chapters.unshift(...rootChapters);
				volume.chapters.sort(bySeq);
				volumes.push(volume);
				volumeDirs.splice(defaultIdx, 1);
			} else {
				volumes.push({ name: '第一卷', dirName: undefined, chapters: rootChapters });
			}
		}
		volumeDirs.sort((a, b) => volumeSortKey(a) - volumeSortKey(b) || a.localeCompare(b));
		const readVolumes = await mapLimit(volumeDirs, SCAN_CONCURRENCY, (dirName) => this.readVolume(book, dirName));
		volumes.push(...readVolumes);
		return volumes;
	}

	private async readVolume(book: BookInfo, dirName: string): Promise<ChapterVolume> {
		let files: string[];
		try {
			files = await fs.readdir(path.join(book.dir, CHAPTERS_DIR, dirName));
		} catch {
			files = [];
		}
		const chapters = (
			await mapLimit(files, SCAN_CONCURRENCY, async (fileName): Promise<ChapterFile | undefined> => {
				const parsed = parseChapterFileName(fileName);
				if (!parsed) {
					return undefined;
				}
				const contentTitle = await this.readChapterContentTitle(this.chapterPath(book, fileName, dirName));
				return { ...parsed, title: contentTitle ?? parsed.title, fileName, volumeDir: dirName };
			})
		).filter((chapter): chapter is ChapterFile => chapter !== undefined);
		chapters.sort(bySeq);
		return { name: dirName, dirName, chapters };
	}

	/** 章节文件内容标题缓存：绝对路径 → 内容首行标题（无则 undefined）；文件变更时由 watcher 失效。 */
	private readonly chapterTitleCache = new Map<string, string | undefined>();

	/** 读取章节文件内容首行的一级标题（无标题/读失败返回 undefined），带缓存。 */
	private async readChapterContentTitle(filePath: string): Promise<string | undefined> {
		if (this.chapterTitleCache.has(filePath)) {
			return this.chapterTitleCache.get(filePath);
		}
		let title: string | undefined;
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(filePath, 'r');
			const buffer = Buffer.alloc(4096);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const firstLine = buffer
				.toString('utf8', 0, bytesRead)
				.replace(/^\uFEFF/, '')
				.split(/\r?\n/, 1)[0];
			title = extractMarkdownTitle(firstLine);
		} catch {
			title = undefined;
		} finally {
			await handle?.close();
		}
		this.chapterTitleCache.set(filePath, title);
		return title;
	}

	/** 全部章节（跨卷合并，按卷序 + 序号排序），用于翻章与章节计数。 */
	async listChapters(book: BookInfo): Promise<ChapterFile[]> {
		const volumes = await this.listVolumes(book);
		return volumes.flatMap((volume) => volume.chapters);
	}

	/** 章节数：只扫目录不读正文，供书架为大量书目显示计数（listChapters 会逐章读首行标题，代价高得多）。 */
	async countChapters(book: BookInfo): Promise<number> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(path.join(book.dir, CHAPTERS_DIR), { withFileTypes: true });
		} catch {
			return 0;
		}
		const isChapter = (name: string): boolean => parseChapterFileName(name) !== undefined;
		const rootCount = entries.filter((entry) => !entry.isDirectory() && isChapter(entry.name)).length;
		const volumeDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		return (
			rootCount +
			(await mapLimit(volumeDirs, SCAN_CONCURRENCY, async (dirName) => {
				try {
					const files = await fs.readdir(path.join(book.dir, CHAPTERS_DIR, dirName));
					return files.filter(isChapter).length;
				} catch {
					return 0;
				}
			})).reduce((sum, count) => sum + count, 0)
		);
	}

	/** 批量章节数（键为书目录），并发受限，供书架视图一次性补齐大量书的计数。 */
	async listChapterCounts(books: BookInfo[]): Promise<Map<string, number>> {
		const pairs = await mapLimit(
			books,
			SCAN_CONCURRENCY,
			async (book): Promise<[string, number]> => [book.dir, await this.countChapters(book)]
		);
		return new Map(pairs);
	}

	/** 按进度键（分卷相对路径；兼容旧格式文件名）定位章节；相对路径优先，避免同名章节跨卷误配。 */
	async findChapterByProgress(book: BookInfo, progressKey: string): Promise<ChapterFile | undefined> {
		const chapters = await this.listChapters(book);
		return (
			chapters.find((c) => chapterRelPath(c) === progressKey) ??
			chapters.find((c) => c.fileName === progressKey)
		);
	}

	/** 章节的版本目录（版本/<分卷>/<章节文件名去 .md>），目录按需创建。 */
	private versionsDirPath(book: BookInfo, chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>): string {
		return path.join(book.dir, VERSIONS_DIR, chapter.volumeDir ?? '', chapter.fileName.replace(/\.md$/, ''));
	}

	/** 章节某个版本文件的绝对路径（版本名统一清洗，防路径穿越）。 */
	chapterVersionPath(
		book: BookInfo,
		chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>,
		versionName: string
	): string {
		return path.join(this.versionsDirPath(book, chapter), `${sanitizeFileTitle(versionName)}.md`);
	}

	/** 目录内生成不冲突的文件基名（重名自动加 -2、-3…）。 */
	private async uniqueFileName(dir: string, base: string): Promise<string> {
		let name = base;
		for (let suffix = 2; ; suffix++) {
			if (!(await pathExists(path.join(dir, `${name}.md`)))) {
				return name;
			}
			name = `${base}-${suffix}`;
		}
	}

	/** 某分卷下有备选版本的章节（章节文件名基名 → 版本数），用于章节目录视图。 */
	async listVolumeVersionCounts(book: BookInfo, volumeDir?: string): Promise<Map<string, number>> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(path.join(book.dir, VERSIONS_DIR, volumeDir ?? ''), { withFileTypes: true });
		} catch {
			return new Map();
		}
		const counts = new Map<string, number>();
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			try {
				const files = await fs.readdir(path.join(book.dir, VERSIONS_DIR, volumeDir ?? '', entry.name));
				const count = files.filter((f) => f.endsWith('.md')).length;
				if (count > 0) {
					counts.set(entry.name, count);
				}
			} catch {
				// 目录读失败按无版本处理
			}
		}
		return counts;
	}

	/** 章节的备选版本列表（版本名 = 文件名去 .md），按名称排序。 */
	async listChapterVersions(book: BookInfo, chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>): Promise<EntryFile[]> {
		let files: string[];
		try {
			files = await fs.readdir(this.versionsDirPath(book, chapter));
		} catch {
			return [];
		}
		return files
			.filter((fileName) => fileName.endsWith('.md'))
			.map((fileName) => ({ name: fileName.replace(/\.md$/, ''), fileName }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** 以主版本当前内容创建备选版本（name 省略时自动命名，重名加序号），返回版本文件路径。 */
	async createChapterVersion(
		book: BookInfo,
		chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>,
		name?: string
	): Promise<string> {
		const dir = this.versionsDirPath(book, chapter);
		const count = (await this.listChapterVersions(book, chapter)).length;
		const base = await this.uniqueFileName(dir, sanitizeFileTitle(name?.trim() || `版本${count + 1}`));
		const content = await fs.readFile(this.chapterPath(book, chapter.fileName, chapter.volumeDir), 'utf8');
		await fs.mkdir(dir, { recursive: true });
		const filePath = path.join(dir, `${base}.md`);
		await fs.writeFile(filePath, content, 'utf8');
		await this.commitAndRefresh(`新建章节版本 ${chapterRelPath(chapter)} · ${base}`);
		return filePath;
	}

	/** 把备选版本设为主版本：原主版本存回版本库（默认名 原版），版本内容原地写入主文件（路径不变）。 */
	async promoteChapterVersion(
		book: BookInfo,
		chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>,
		versionName: string,
		keepOldName?: string
	): Promise<void> {
		const dir = this.versionsDirPath(book, chapter);
		// 版本名带 .md 后缀时容错去掉
		const base = sanitizeFileTitle(versionName.replace(/\.md$/, ''));
		const versionFile = path.join(dir, `${base}.md`);
		if (!(await pathExists(versionFile))) {
			throw new Error(`版本「${versionName}」不存在`);
		}
		const mainPath = this.chapterPath(book, chapter.fileName, chapter.volumeDir);
		const [mainMd, versionMd] = await Promise.all([
			fs.readFile(mainPath, 'utf8'),
			fs.readFile(versionFile, 'utf8'),
		]);
		const keepBase = await this.uniqueFileName(dir, sanitizeFileTitle(keepOldName?.trim() || PRIMARY_KEEP_VERSION_NAME));
		await fs.writeFile(path.join(dir, `${keepBase}.md`), mainMd, 'utf8');
		await fs.writeFile(mainPath, versionMd, 'utf8');
		await fs.rm(versionFile, { force: true });
		await closeFileTabs(versionFile);
		await this.commitAndRefresh(`「${chapter.fileName}」版本「${versionName}」设为主版本（原版存为「${keepBase}」）`);
	}

	/** 重命名章节的备选版本，返回新版本名。 */
	async renameChapterVersion(
		book: BookInfo,
		chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>,
		oldName: string,
		newName: string
	): Promise<string> {
		const target = sanitizeFileTitle(newName);
		if (target === oldName) {
			return oldName;
		}
		const oldPath = this.chapterVersionPath(book, chapter, oldName);
		const newPath = this.chapterVersionPath(book, chapter, target);
		if (!(await pathExists(oldPath))) {
			throw new Error(`版本「${oldName}」不存在`);
		}
		if (await pathExists(newPath)) {
			throw new Error(`版本「${target}」已存在`);
		}
		await vscode.workspace.fs.rename(vscode.Uri.file(oldPath), vscode.Uri.file(newPath));
		await this.commitAndRefresh(`重命名章节版本 ${chapterRelPath(chapter)} · ${oldName} → ${target}`);
		return target;
	}

	/** 删除章节的备选版本（不动主版本）。 */
	async deleteChapterVersion(
		book: BookInfo,
		chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>,
		versionName: string
	): Promise<void> {
		const filePath = this.chapterVersionPath(book, chapter, versionName);
		await fs.rm(filePath, { force: true });
		await closeFileTabs(filePath);
		await this.commitAndRefresh(`删除章节版本 ${chapterRelPath(chapter)} · ${versionName}`);
	}

	/** 条目目录（世界书/角色卡/笔记，可含分类路径）下的 md 文件列表（忽略 .gitkeep 等非 md 文件）。 */
	async listEntries(book: BookInfo, subDir: string, categoryPath?: string): Promise<EntryFile[]> {
		let entries: string[];
		try {
			entries = await fs.readdir(path.join(book.dir, subDir, safeCategoryPath(categoryPath) ?? ''));
		} catch {
			return [];
		}
		return entries
			.filter((fileName) => fileName.endsWith('.md'))
			.map((fileName) => ({ name: fileName.replace(/\.md$/, ''), fileName }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** 读取目录下的直接子目录名（不存在时为空）。 */
	private async readSubDirNames(dir: string): Promise<string[]> {
		try {
			return (await fs.readdir(dir, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort((a, b) => a.localeCompare(b));
		} catch {
			return [];
		}
	}

	/** 某个分类（或条目根目录）下的直接子分类。 */
	async listChildCategories(book: BookInfo, subDir: string, categoryPath?: string): Promise<EntryCategory[]> {
		const safe = safeCategoryPath(categoryPath);
		const names = await this.readSubDirNames(path.join(book.dir, subDir, safe ?? ''));
		return names.map((name) => ({ name, path: safe ? `${safe}/${name}` : name }));
	}

	/** 条目根目录下的全部分类（递归展开多级，按路径排序）。 */
	async listCategories(book: BookInfo, subDir: string, categoryPath?: string): Promise<EntryCategory[]> {
		const children = await this.listChildCategories(book, subDir, categoryPath);
		const nested = await Promise.all(children.map((child) => this.listCategories(book, subDir, child.path)));
		// 保持深度优先顺序：父分类紧跟其子分类，再排兄弟分类
		return children.flatMap((child, index) => [child, ...nested[index]]);
	}

	/** 新建分类目录（可多级）并提交 git 快照，返回清洗后的相对路径。 */
	async createCategory(book: BookInfo, subDir: string, categoryPath: string): Promise<string> {
		const safePath = sanitizeRelativePath(categoryPath);
		if (!safePath) {
			throw new Error('分类名不能为空');
		}
		const dir = path.join(book.dir, subDir, safePath);
		if (await pathExists(dir)) {
			throw new Error(`分类「${safePath}」已存在`);
		}
		await fs.mkdir(dir, { recursive: true });
		// 空目录不被 git 跟踪，放占位文件纳入快照
		await fs.writeFile(path.join(dir, '.gitkeep'), '', 'utf8');
		await this.commitAndRefresh(`新建分类 ${subDir}/${safePath}`);
		return safePath;
	}

	/** 重命名分类目录（只改末级名，内容随目录迁移），返回新的相对路径。 */
	async renameCategory(
		book: BookInfo,
		subDir: string,
		categoryPath: string,
		newName: string
	): Promise<string> {
		const source = safeCategoryPath(categoryPath) ?? '';
		const parent = source.includes('/') ? source.slice(0, source.lastIndexOf('/')) : '';
		const targetPath = parent ? `${parent}/${sanitizeFileTitle(newName)}` : sanitizeFileTitle(newName);
		if (targetPath === source) {
			return targetPath;
		}
		const oldDir = path.join(book.dir, subDir, source);
		const newDir = path.join(book.dir, subDir, targetPath);
		if (!(await pathExists(oldDir))) {
			throw new Error(`分类「${categoryPath}」不存在`);
		}
		if (await pathExists(newDir)) {
			throw new Error(`分类「${targetPath}」已存在`);
		}
		await vscode.workspace.fs.rename(vscode.Uri.file(oldDir), vscode.Uri.file(newDir));
		await this.commitAndRefresh(`重命名分类 ${subDir}/${source} → ${targetPath}`);
		return targetPath;
	}

	/** 删除分类目录（含其中全部条目与子分类）并提交 git 快照。 */
	async deleteCategory(book: BookInfo, subDir: string, categoryPath: string): Promise<void> {
		const safe = safeCategoryPath(categoryPath);
		if (!safe) {
			return;
		}
		await fs.rm(path.join(book.dir, subDir, safe), { recursive: true, force: true });
		await this.commitAndRefresh(`删除分类 ${subDir}/${safe}`);
	}

	/** 读取 元数据.md 并解析；文件缺失时返回 undefined。 */
	async readMetadata(book: BookInfo): Promise<BookMetadata | undefined> {
		try {
			return parseBookMetadata(await fs.readFile(path.join(book.dir, META_FILE), 'utf8'));
		} catch {
			return undefined;
		}
	}

	/** 确保 元数据.md 存在（缺失时按模板重建并提交），返回其路径；书文件夹不存在等失败时返回 undefined。 */
	async ensureMetadata(book: BookInfo): Promise<string | undefined> {
		const filePath = path.join(book.dir, META_FILE);
		if (await pathExists(filePath)) {
			return filePath;
		}
		try {
			await fs.writeFile(filePath, buildMetadataMarkdown(book.name), 'utf8');
		} catch {
			return undefined;
		}
		await this.commitAndRefresh(`重建${META_FILE}（${book.name}）`);
		return filePath;
	}

	/** 新建空书：库根下创建书目录骨架（章节/ 与各空目录 + 元数据.md）并 git commit。 */
	async createBook(name: string): Promise<BookInfo> {
		const root = await this.ensureLibraryPath();
		if (!root) {
			throw new Error('未选择小说库目录');
		}
		const dirName = await uniqueBookName(root, sanitizeFileTitle(name));
		const dir = path.join(root, dirName);
		await fs.mkdir(path.join(dir, CHAPTERS_DIR), { recursive: true });
		for (const sub of EMPTY_SUBDIRS) {
			await fs.mkdir(path.join(dir, sub), { recursive: true });
			await fs.writeFile(path.join(dir, sub, '.gitkeep'), '');
		}
		await fs.writeFile(path.join(dir, META_FILE), buildMetadataMarkdown(dirName), 'utf8');
		await commitAll(root, `新建《${dirName}》`);
		await this.setCurrentBook(dir);
		this.scheduleRefresh();
		return { name: dirName, dir };
	}

	/** 导入 txt：解码 → 建书文件夹 → git commit。返回 undefined 表示用户未选库目录。 */
	async importBook(fileUri: vscode.Uri): Promise<{ book: BookInfo; chapterCount: number } | undefined> {
		const root = await this.ensureLibraryPath();
		if (!root) {
			return undefined;
		}
		const data = await fs.readFile(fileUri.fsPath);
		const text = decodeBuffer(data);
		const rawName = path.basename(fileUri.fsPath).replace(/\.[^.]+$/, '');
		const result = await createBookFromText(root, rawName, text);
		await commitAll(root, `导入《${result.book.name}》（${result.chapterCount}章）`);
		await this.setCurrentBook(result.book.dir);
		this.scheduleRefresh();
		return result;
	}

	/** 导出整本书为单个纯文本：按阅读顺序拼接各章正文（Markdown 转纯文本），多卷时在卷首补卷名。 */
	async exportBookText(book: BookInfo): Promise<string> {
		const volumes = await this.listVolumes(book);
		const withVolumeName = volumes.length > 1;
		const blocks: string[] = [];
		for (const volume of volumes) {
			if (withVolumeName) {
				blocks.push(volume.name);
			}
			const texts = await mapLimit(volume.chapters, SCAN_CONCURRENCY, (chapter) =>
				fs.readFile(this.chapterPath(book, chapter.fileName, chapter.volumeDir), 'utf8')
			);
			blocks.push(...texts.map(mdToPlainText));
		}
		return `${blocks.filter((block) => block.length > 0).join('\n\n')}\n`;
	}

	async removeBook(book: BookInfo): Promise<void> {
		await fs.rm(book.dir, { recursive: true, force: true });
		await this.updateShelfBookRefs(book.name);
		await this.commit(`移除《${book.name}》`);
		if (this.getCurrentBook()?.dir === book.dir) {
			await this.setCurrentBook(undefined);
		}
		await this.clearProgress(book.dir);
		this.scheduleRefresh();
	}

	/** 在 世界书/角色卡/笔记 下新建条目 md（分类目录不存在则创建，已存在同名文件则不覆盖），返回文件路径。 */
	async createEntry(book: BookInfo, subDir: string, name: string, categoryPath?: string): Promise<string> {
		const safeCategory = categoryPath ? sanitizeRelativePath(categoryPath) : undefined;
		const dir = path.join(book.dir, subDir, safeCategory ?? '');
		await fs.mkdir(dir, { recursive: true });
		const filePath = path.join(dir, `${sanitizeFileTitle(name)}.md`);
		if (!(await pathExists(filePath))) {
			await fs.writeFile(filePath, buildEntryMarkdown(name), 'utf8');
			await this.commit(`新建 ${subDir}/${safeCategory ? `${safeCategory}/` : ''}${path.basename(filePath)}`);
		}
		return filePath;
	}

	/** 删除条目/笔记 md 文件并提交 git 快照。 */
	async removeEntry(book: BookInfo, subDir: string, fileName: string): Promise<void> {
		const filePath = path.join(book.dir, subDir, path.basename(fileName));
		await fs.rm(filePath, { force: true });
		await closeFileTabs(filePath);
		await this.commitAndRefresh(`删除 ${subDir}/${fileName}`);
	}

	/** 删除章节 md 及其摘要镜像，同步重写相邻章导航，并提交 git 快照。 */
	async removeChapter(book: BookInfo, chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>): Promise<void> {
		const chapters = await this.listChapters(book);
		const index = chapters.findIndex((c) => sameChapter(c, chapter));
		const prev = index > 0 ? chapters[index - 1] : undefined;
		const prevPrev = index > 1 ? chapters[index - 2] : undefined;
		const next = index >= 0 && index < chapters.length - 1 ? chapters[index + 1] : undefined;
		await Promise.all([
			prev
				? this.rewriteChapterNav(
					book,
					prev,
					prevPrev ? navRelPath(prev.volumeDir, prevPrev.volumeDir, prevPrev.fileName) : undefined,
					next ? navRelPath(prev.volumeDir, next.volumeDir, next.fileName) : undefined
				)
				: Promise.resolve(),
			next
				? this.rewriteChapterNav(
					book,
					next,
					prev ? navRelPath(next.volumeDir, prev.volumeDir, prev.fileName) : undefined,
					undefined
				)
				: Promise.resolve(),
		]);
		const chapterFile = this.chapterPath(book, chapter.fileName, chapter.volumeDir);
		const summaryFile = this.summaryPath(book, chapter.fileName, chapter.volumeDir);
		await fs.rm(chapterFile, { force: true });
		await fs.rm(summaryFile, { force: true });
		await fs.rm(this.versionsDirPath(book, chapter), { recursive: true, force: true });
		await closeFileTabs(summaryFile);
		await closeFileTabs(chapterFile);
		// 进度指向被删章时迁移到相邻章（prev 优先），无相邻章则清除
		const rel = chapterRelPath(chapter);
		if (this.getProgress(book.dir) === rel) {
			const neighbor = prev ?? next;
			if (neighbor) {
				await this.setProgress(book.dir, chapterRelPath(neighbor));
			} else {
				await this.clearProgress(book.dir);
			}
		}
		await this.updateNotesChapterRef(book, rel, undefined);
		await this.commitAndRefresh(`删除章节 ${chapterRelPath(chapter)}`);
	}

	/** 遍历全部笔记文件（根 + 各分类），回调返回新内容（undefined 不写回）。 */
	private async forEachNote(
		book: BookInfo,
		fn: (filePath: string, content: string, relDir: string) => string | undefined
	): Promise<void> {
		const categories = await this.listCategories(book, NOTES_DIR);
		const dirs = [NOTES_DIR, ...categories.map((c) => `${NOTES_DIR}/${c.path}`)];
		for (const relDir of dirs) {
			const category = relDir === NOTES_DIR ? undefined : relDir.slice(NOTES_DIR.length + 1);
			for (const note of await this.listEntries(book, NOTES_DIR, category)) {
				const filePath = path.join(book.dir, relDir, note.fileName);
				let md: string;
				try {
					md = await fs.readFile(filePath, 'utf8');
				} catch {
					continue;
				}
				const updated = await fn(filePath, md, relDir);
				if (updated !== undefined && updated !== md) {
					await fs.writeFile(filePath, updated, 'utf8');
				}
			}
		}
	}

	/** 更新全部笔记中对某章的关联（frontmatter chapter + 正文链接）；ref 为 undefined 时移除关联。 */
	private async updateNotesChapterRef(
		book: BookInfo,
		oldRel: string,
		ref: { relPath: string; title: string } | undefined
	): Promise<void> {
		await this.updateNotesChapterRefs(book, new Map([[oldRel, ref]]));
	}

	/** 批量更新笔记的章节关联（只遍历一遍全部笔记），键为旧章节相对路径；值为 undefined 时移除关联。 */
	private async updateNotesChapterRefs(
		book: BookInfo,
		refs: Map<string, { relPath: string; title: string } | undefined>
	): Promise<void> {
		await this.forEachNote(book, (_filePath, md, relDir) => {
			const oldRel = NOTE_CHAPTER_FM_RE.exec(md)?.[1];
			if (oldRel === undefined || !refs.has(oldRel)) {
				return undefined;
			}
			const ref = refs.get(oldRel);
			if (ref) {
				const prefix = '../'.repeat(relDir.split('/').length);
				// 均用函数形式替换：路径/标题里的 $& 等不被当作替换模式
				return md
					.replace(NOTE_CHAPTER_LINE_RE, () => `chapter: ${JSON.stringify(ref.relPath)}`)
					.replace(
						NOTE_CHAPTER_LINK_LINE_RE,
						() => `> 关联章节：[${escapeMdLinkText(ref.title)}](<${prefix}${CHAPTERS_DIR}/${ref.relPath}>)`
					);
			}
			return md.replace(/^chapter:[^\n]*\n?/m, '').replace(/^> 关联章节：[^\n]*\n?/m, '');
		});
	}

	/** 更新全部笔记中对某卷章节的关联（relPath 前缀匹配卷目录名）；newVolume 为 undefined 时移除关联。 */
	private async updateNotesVolumeRef(book: BookInfo, oldVolume: string, newVolume: string | undefined): Promise<void> {
		const prefix = `${oldVolume}/`;
		const escaped = oldVolume.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		await this.forEachNote(book, (_filePath, md) => {
			const link = NOTE_CHAPTER_FM_RE.exec(md)?.[1];
			if (!link || !link.startsWith(prefix)) {
				return undefined;
			}
			if (newVolume) {
				return md
					.replace(
						NOTE_CHAPTER_LINE_RE,
						() => `chapter: ${JSON.stringify(`${newVolume}/${link.slice(prefix.length)}`)}`
					)
					.replace(
						new RegExp(`(\\(<[^>]*${CHAPTERS_DIR}/)${escaped}/`),
						(_match, dirPrefix: string) => `${dirPrefix}${newVolume}/`
					);
			}
			return md
				.replace(/^chapter:[^\n]*\n?/m, '')
				.replace(/^> 关联章节：[^\n]*\n?/m, '');
		});
	}

	/** 重写章节摘要文件的标题行与原文链接行（镜像文件名与 href），使其与章节当前标题/位置一致。 */
	private async rewriteSummaryOriginal(
		book: BookInfo,
		volumeDir: string | undefined,
		fileName: string,
		oldTitle?: string
	): Promise<void> {
		const filePath = this.summaryPath(book, fileName, volumeDir);
		let md: string;
		try {
			md = await fs.readFile(filePath, 'utf8');
		} catch {
			return;
		}
		const prefix = volumeDir ? '../../' : '../';
		const href = `${prefix}${CHAPTERS_DIR}/${volumeDir ? volumeDir + '/' : ''}${fileName}`;
		let updated = md.replace(/^> 原文：.*$/m, () => `> 原文：[${escapeMdLinkText(fileName)}](<${href}>)`);
		if (oldTitle) {
			const newTitle = parseChapterFileName(fileName)?.title;
			if (newTitle) {
				// 原标题可能含被文件名清洗掉的字符，故按 H1 行锚替换，不比对 oldTitle 原文
				updated = updated.replace(/^#\s.*·\s摘要\s*$/m, () => `# ${newTitle} · 摘要`);
			}
		}
		if (updated !== md) {
			await fs.writeFile(filePath, updated, 'utf8');
		}
	}

	/**
	 * 接管同序号的计划摘要：新建/插入章节时把「有摘要无正文」的摘要移到新章节名下（序号全书唯一，故按序号定位），
	 * 并刷新标题与原文链接，使计划直接成为该章摘要。
	 */
	private async adoptPlanSummary(book: BookInfo, chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>): Promise<void> {
		const seq = parseChapterFileName(chapter.fileName)?.seq;
		const targetPath = this.summaryPath(book, chapter.fileName, chapter.volumeDir);
		let sourceTitle: string | undefined;
		if (seq !== undefined && !(await pathExists(targetPath))) {
			for (const [rel, filePath] of await this.scanChapterSummaryFiles(book)) {
				const parsed = parseChapterFileName(path.basename(rel));
				if (rel === chapterRelPath(chapter) || parsed?.seq !== seq) {
					continue;
				}
				await fs.mkdir(path.dirname(targetPath), { recursive: true });
				await vscode.workspace.fs.rename(vscode.Uri.file(filePath), vscode.Uri.file(targetPath));
				sourceTitle = parsed.title;
				break;
			}
		}
		const before = await fs.stat(targetPath).catch(() => undefined);
		await this.rewriteSummaryOriginal(book, chapter.volumeDir, chapter.fileName, sourceTitle);
		if (before) {
			// 计划先于正文：保留计划写入时的修改时间，摘要因此显示为待维护，提示按正文核对
			await fs.utimes(targetPath, before.atime, before.mtime).catch(() => undefined);
		}
	}

	/** 重命名章节文件（序号不变），同步重命名摘要镜像、重写全书导航、迁移进度；返回新文件名。 */
	async renameChapter(
		book: BookInfo,
		chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>,
		newTitle: string
	): Promise<string> {
		const seq = parseChapterFileName(chapter.fileName)?.seq;
		if (seq === undefined) {
			throw new Error(`「${chapter.fileName}」不是章节文件`);
		}
		// 文件名标题用清洗版；内容首行保留输入原文，与直接改首行的最终状态一致
		const title = sanitizeFileTitle(newTitle);
		const displayTitle = newTitle.trim() || title;
		const newFileName = chapterFileName(seq, title);
		const oldPath = this.chapterPath(book, chapter.fileName, chapter.volumeDir);
		if (newFileName === chapter.fileName) {
			// 文件名不变时也同步内容首行，保证显示标题与输入一致
			await this.updateChapterContentTitle(oldPath, displayTitle);
			await this.commitAndRefresh(`同步章节标题 ${chapterRelPath(chapter)} →「${displayTitle}」`);
			return chapter.fileName;
		}
		const newPath = this.chapterPath(book, newFileName, chapter.volumeDir);
		if (await pathExists(newPath)) {
			throw new Error(`章节「${newFileName}」已存在`);
		}
		await this.relocateChapterFiles(book, chapter, { fileName: newFileName, volumeDir: chapter.volumeDir });
		// 同步内容首行标题，保证显示标题与文件名一致
		await this.updateChapterContentTitle(newPath, displayTitle);
		await this.rewriteBookChapterNavs(book);
		await this.rewriteSummaryOriginal(
			book,
			chapter.volumeDir,
			newFileName,
			parseChapterFileName(chapter.fileName)?.title
		);
		const oldRel = chapterRelPath(chapter);
		const newRel = chapterRelPath({ fileName: newFileName, volumeDir: chapter.volumeDir });
		await this.updateNotesChapterRef(book, oldRel, {
			relPath: newRel,
			title,
		});
		if (this.getProgress(book.dir) === oldRel) {
			await this.setProgress(book.dir, newRel);
		}
		await this.commitAndRefresh(`重命名章节 ${oldRel} → ${newRel}`);
		return newFileName;
	}

	/** 更新章节文件内容首行的一级标题（无标题行时跳过）。 */
	private async updateChapterContentTitle(filePath: string, title: string): Promise<void> {
		try {
			const md = await fs.readFile(filePath, 'utf8');
			// 用函数形式替换，标题里的 $& 等不被当作替换模式
			const updated = md.replace(/^\uFEFF?#(?!#)\s*.*$/m, () => `# ${title}`);
			if (updated !== md) {
				await fs.writeFile(filePath, updated, 'utf8');
			}
		} catch {
			// 文件不可读（刚被移动/删除）时忽略
		}
	}

	/** 章节内容首行标题与文件名不一致时级联重命名（直接改首行与右键重命名效果一致）；返回是否发生重命名。 */
	async syncChapterTitle(
		book: BookInfo,
		chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>,
		contentTitle: string
	): Promise<boolean> {
		const parsed = parseChapterFileName(chapter.fileName);
		if (!parsed || sanitizeFileTitle(contentTitle) === parsed.title) {
			return false;
		}
		const newFileName = await this.renameChapter(book, chapter, contentTitle);
		return newFileName !== chapter.fileName;
	}

	/** 重命名书文件夹，迁移当前书与阅读进度；返回新书信息。 */
	async renameBook(book: BookInfo, newName: string): Promise<BookInfo> {
		const target = sanitizeFileTitle(newName);
		if (target === book.name) {
			return book;
		}
		// 库根优先取配置；未配置时回退书所在父目录，快照仍要求配置存在
		const configuredRoot = this.getLibraryPath();
		const root = configuredRoot || path.dirname(book.dir);
		const newDir = path.join(root, target);
		if (await pathExists(newDir)) {
			throw new Error(`书籍「${target}」已存在`);
		}
		await vscode.workspace.fs.rename(vscode.Uri.file(book.dir), vscode.Uri.file(newDir));
		// 同步更新 元数据.md 的 title 字段，保持书名一致
		const metaPath = path.join(newDir, META_FILE);
		try {
			const meta = await fs.readFile(metaPath, 'utf8');
			// 手写无引号的 title 一并覆盖，统一写成 JSON 字符串
			const updated = meta.replace(/^title:[^\n]*$/m, () => `title: ${JSON.stringify(target)}`);
			if (updated !== meta) {
				await fs.writeFile(metaPath, updated, 'utf8');
			}
		} catch {
			// 无元数据文件时忽略
		}
		if (this.getCurrentBook()?.dir === book.dir) {
			await this.setCurrentBook(newDir);
		}
		const progress = this.context.globalState.get<Record<string, string>>(PROGRESS_KEY, {});
		if (book.dir in progress) {
			progress[newDir] = progress[book.dir];
			delete progress[book.dir];
			await this.context.globalState.update(PROGRESS_KEY, progress);
		}
		await this.updateShelfBookRefs(book.name, target);
		await this.commitAndRefresh(`重命名书籍《${book.name}》→《${target}》`);
		return { name: target, dir: newDir };
	}

	/** 重命名子目录下的条目/笔记 md 文件（同目录内），返回新文件名。 */
	async renameEntry(book: BookInfo, subDir: string, fileName: string, newName: string): Promise<string> {
		const newFileName = `${sanitizeFileTitle(newName)}.md`;
		if (newFileName === fileName) {
			return fileName;
		}
		const dir = path.join(book.dir, subDir);
		const newPath = path.join(dir, newFileName);
		if (await pathExists(newPath)) {
			throw new Error(`「${newFileName}」已存在`);
		}
		await vscode.workspace.fs.rename(
			vscode.Uri.file(path.join(dir, path.basename(fileName))),
			vscode.Uri.file(newPath)
		);
		await this.commitAndRefresh(`重命名 ${subDir}/${fileName} → ${newFileName}`);
		return newFileName;
	}

	/** 移动条目/笔记到同一根目录下的另一个分类（categoryPath / targetCategoryPath 为 undefined 表示根目录，目标分类不存在则创建）。 */
	async moveEntry(
		book: BookInfo,
		rootDir: string,
		categoryPath: string | undefined,
		fileName: string,
		targetCategoryPath: string | undefined
	): Promise<void> {
		const fromRel = this.entryRelPath(rootDir, safeCategoryPath(categoryPath), fileName);
		const to = safeCategoryPath(targetCategoryPath);
		const targetRel = this.entryRelPath(rootDir, to, fileName);
		if (fromRel === targetRel) {
			throw new Error('条目已在目标分类中');
		}
		const fromPath = path.join(book.dir, fromRel);
		if (!(await pathExists(fromPath))) {
			throw new Error(`条目「${fileName}」不存在`);
		}
		const targetDir = path.join(book.dir, rootDir, to ?? '');
		if (await pathExists(path.join(targetDir, fileName))) {
			throw new Error(`目标分类中已存在「${fileName}」`);
		}
		await fs.mkdir(targetDir, { recursive: true });
		await vscode.workspace.fs.rename(vscode.Uri.file(fromPath), vscode.Uri.file(path.join(targetDir, fileName)));
		if (rootDir === NOTES_DIR) {
			await this.rewriteNoteChapterLink(path.join(targetDir, fileName), to);
		}
		await this.commitAndRefresh(`移动 ${fromRel} → ${targetRel}`);
	}

	/** 条目根目录与分类路径拼出的相对路径。 */
	private entryRelPath(rootDir: string, categoryPath: string | undefined, fileName: string): string {
		return categoryPath ? `${rootDir}/${categoryPath}/${fileName}` : `${rootDir}/${fileName}`;
	}

	/** 笔记换分类后重算「关联章节」链接的相对前缀（关联章节不变，只是从 笔记/ 到 章节/ 的层级变了）。 */
	private async rewriteNoteChapterLink(filePath: string, categoryPath: string | undefined): Promise<void> {
		let md: string;
		try {
			md = await fs.readFile(filePath, 'utf8');
		} catch {
			return;
		}
		const chapterRel = NOTE_CHAPTER_FM_RE.exec(md)?.[1];
		if (!chapterRel) {
			return;
		}
		const prefix = '../'.repeat((categoryPath ? categoryPath.split('/').length : 0) + 1);
		const linkText = NOTE_CHAPTER_LINK_RE.exec(md)?.[1] ?? path.basename(chapterRel, '.md');
		const updated = md.replace(
			NOTE_CHAPTER_LINK_LINE_RE,
			() => `> 关联章节：[${linkText}](<${prefix}${CHAPTERS_DIR}/${chapterRel}>)`
		);
		if (updated !== md) {
			await fs.writeFile(filePath, updated, 'utf8');
		}
	}

	/** 新建章节 md（全局序号接最大值），补上前后导航并重写全书导航；返回文件名。 */
	async createChapter(book: BookInfo, title: string, volumeDir?: string): Promise<string> {
		const seq = (await this.listChapters(book)).reduce((max, c) => Math.max(max, c.seq), 0) + 1;
		const created = await this.writeChapterAt(book, seq, title, volumeDir);
		await this.commitAndRefresh(`新建章节 ${chapterRelPath({ fileName: created.fileName, volumeDir })}`);
		return created.fileName;
	}

	/** 在参照章节前/后插入新章节（新章节随参照章节所在分卷）。序号有空档时直接插入，无空档时顺延其后章节；返回新文件名与顺延章数。 */
	async insertChapter(
		book: BookInfo,
		title: string,
		position:
			| { after: Pick<ChapterFile, 'fileName' | 'volumeDir'> }
			| { before: Pick<ChapterFile, 'fileName' | 'volumeDir'> }
	): Promise<{ fileName: string; renumbered: number }> {
		const chapters = await this.listChapters(book);
		const anchor = 'after' in position ? position.after : position.before;
		const at = chapters.findIndex((c) => sameChapter(c, anchor));
		if (at < 0) {
			throw new Error(`找不到章节「${anchor.fileName}」`);
		}
		const plan = planChapterInsertSeq(
			chapters.map((c) => c.seq),
			'after' in position ? at + 1 : at
		);
		const created = await this.writeChapterAt(book, plan.seq, title, anchor.volumeDir);
		await this.commitAndRefresh(`插入章节 ${chapterRelPath({ fileName: created.fileName, volumeDir: anchor.volumeDir })}`);
		return { fileName: created.fileName, renumbered: created.shifted };
	}

	/** 在指定序号创建章节正文（可落在存量中间、也可留出空洞）：该序号已被正文占用时其后的正文与计划顺延 +1；同序号计划摘要自动接手。 */
	async createChapterAt(
		book: BookInfo,
		seq: number,
		title: string,
		volumeDir?: string
	): Promise<{ fileName: string; shifted: number }> {
		const created = await this.writeChapterAt(book, seq, title, volumeDir);
		await this.commitAndRefresh(`新建章节 ${chapterRelPath({ fileName: created.fileName, volumeDir })}`);
		return created;
	}

	/** 落盘章节正文（序号被占用时顺延 → 写模板与导航 → 同序号计划摘要接手），提交由调用方负责。 */
	private async writeChapterAt(
		book: BookInfo,
		seq: number,
		title: string,
		volumeDir?: string
	): Promise<{ fileName: string; shifted: number }> {
		if (volumeDir) {
			this.assertVolumeName(volumeDir);
		}
		const shifted = (await this.listChapters(book)).some((c) => c.seq === seq)
			? await this.shiftSeqsFrom(book, seq)
			: 0;
		const fileName = chapterFileName(seq, title);
		await this.writeNewChapter(book, fileName, volumeDir, title);
		await this.adoptPlanSummary(book, { fileName, volumeDir });
		return { fileName, shifted };
	}

	/** 落盘新章节文件（建目录 → 写模板 → 接上前后导航），新建与插章共用（导航重写后由调用方提交）。 */
	private async writeNewChapter(
		book: BookInfo,
		fileName: string,
		volumeDir: string | undefined,
		title: string
	): Promise<void> {
		const filePath = this.chapterPath(book, fileName, volumeDir);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, buildChapterMarkdown(title, ''), 'utf8');
		await this.seedNewChapterNav(book, fileName, volumeDir, title);
		await this.rewriteBookChapterNavs(book);
	}

	/** 给刚创建的新章节写入带前后链接的内容（模板本身没有导航段，其它章节的导航交给 rewriteBookChapterNavs）。 */
	private async seedNewChapterNav(
		book: BookInfo,
		fileName: string,
		volumeDir: string | undefined,
		title: string
	): Promise<void> {
		const chapters = await this.listChapters(book);
		const at = chapters.findIndex(
			(c) => c.fileName === fileName && (c.volumeDir ?? '') === (volumeDir ?? '')
		);
		if (at < 0) {
			return;
		}
		const prev = at > 0 ? chapters[at - 1] : undefined;
		const next = at < chapters.length - 1 ? chapters[at + 1] : undefined;
		if (!prev && !next) {
			return;
		}
		const md = buildChapterMarkdown(
			title,
			'',
			prev ? navRelPath(volumeDir, prev.volumeDir, prev.fileName) : undefined,
			next ? navRelPath(volumeDir, next.volumeDir, next.fileName) : undefined
		);
		await fs.writeFile(this.chapterPath(book, fileName, volumeDir), md, 'utf8');
	}

	/** 把 fromSeq 及其后的章节序号 +1：按序号降序改名（避免同名冲突），正文尚未创建的计划摘要一并顺延；同步摘要镜像、笔记关联与阅读进度。返回顺延的正文章数；导航重写与提交由调用方负责。 */
	private async shiftSeqsFrom(book: BookInfo, fromSeq: number): Promise<number> {
		const chapters = (await this.listChapters(book)).filter((chapter) => chapter.seq >= fromSeq);
		const refs = new Map<string, { relPath: string; title: string }>();
		const shiftedRels = new Set(chapters.map((chapter) => chapterRelPath(chapter)));
		const moves = chapters.map((chapter) => ({
			seq: chapter.seq,
			run: async (): Promise<void> => {
				const parsed = parseChapterFileName(chapter.fileName);
				if (!parsed) {
					return;
				}
				const newFileName = chapterFileName(chapter.seq + 1, parsed.title);
				await this.relocateChapterFiles(book, chapter, { fileName: newFileName, volumeDir: chapter.volumeDir });
				await this.rewriteSummaryOriginal(book, chapter.volumeDir, newFileName);
				refs.set(chapterRelPath(chapter), {
					relPath: chapterRelPath({ fileName: newFileName, volumeDir: chapter.volumeDir }),
					title: parsed.title,
				});
			},
		}));
		for (const [rel, filePath] of await this.scanChapterSummaryFiles(book)) {
			const parsed = parseChapterFileName(path.basename(rel));
			if (!parsed || parsed.seq < fromSeq || shiftedRels.has(rel)) {
				continue;
			}
			const index = rel.lastIndexOf('/');
			const volumeDir = index < 0 ? undefined : rel.slice(0, index);
			moves.push({
				seq: parsed.seq,
				run: async (): Promise<void> => {
					await vscode.workspace.fs.rename(
						vscode.Uri.file(filePath),
						vscode.Uri.file(this.summaryPath(book, chapterFileName(parsed.seq + 1, parsed.title), volumeDir))
					);
				},
			});
		}
		// 降序搬移，保证每个目标序号都已先让出
		for (const move of moves.sort((a, b) => b.seq - a.seq)) {
			await move.run();
		}
		const progress = this.getProgress(book.dir);
		const migrated = progress ? refs.get(progress) : undefined;
		if (migrated) {
			await this.setProgress(book.dir, migrated.relPath);
		}
		await this.updateNotesChapterRefs(book, refs);
		return chapters.length;
	}

	/** 移动章节到目标分卷（根目录用 undefined），同步移动摘要镜像、重写全书导航、迁移进度与笔记关联。 */
	async moveChapter(
		book: BookInfo,
		chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>,
		targetVolumeDir: string | undefined
	): Promise<void> {
		if (targetVolumeDir) {
			this.assertVolumeName(targetVolumeDir);
		}
		const fromDir = chapter.volumeDir ?? '';
		const targetDir = targetVolumeDir ?? '';
		if (fromDir === targetDir) {
			throw new Error('目标分卷与当前分卷相同');
		}
		if (targetDir && !(await pathExists(path.join(book.dir, CHAPTERS_DIR, targetDir)))) {
			throw new Error(`分卷「${targetDir}」不存在`);
		}
		const newPath = this.chapterPath(book, chapter.fileName, targetVolumeDir);
		if (await pathExists(newPath)) {
			throw new Error(`目标分卷中已存在「${chapter.fileName}」`);
		}
		await this.relocateChapterFiles(book, chapter, { fileName: chapter.fileName, volumeDir: targetVolumeDir });
		await this.rewriteBookChapterNavs(book);
		await this.rewriteSummaryOriginal(book, targetVolumeDir, chapter.fileName);
		const oldRel = chapterRelPath(chapter);
		const newRel = chapterRelPath({ fileName: chapter.fileName, volumeDir: targetVolumeDir });
		await this.updateNotesChapterRef(book, oldRel, {
			relPath: newRel,
			title: parseChapterFileName(chapter.fileName)?.title ?? chapter.fileName,
		});
		if (this.getProgress(book.dir) === oldRel) {
			await this.setProgress(book.dir, newRel);
		}
		await this.commitAndRefresh(`移动章节 ${oldRel} → ${newRel}`);
	}

	/** 重写某章底部导航链接（prev/next 为相对路径，undefined 移除对应链接）；文件不存在时跳过。 */
	private async rewriteChapterNav(
		book: BookInfo,
		chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>,
		prev: string | undefined,
		next: string | undefined
	): Promise<void> {
		const filePath = this.chapterPath(book, chapter.fileName, chapter.volumeDir);
		let md: string;
		try {
			md = await fs.readFile(filePath, 'utf8');
		} catch {
			return;
		}
		const updated = updateChapterNav(md, prev, next);
		if (updated === md) {
			return;
		}
		const before = await fs.stat(filePath).catch(() => undefined);
		await fs.writeFile(filePath, updated, 'utf8');
		// 仅导航变化不算正文修订：恢复原修改时间，免得插章/删章时相邻章的摘要被判成待维护
		if (before) {
			await fs.utimes(filePath, before.atime, before.mtime).catch(() => undefined);
		}
	}

	/** 按全局章节顺序重算并重写全部章节的底部导航（有变化才写回）；用于分卷重命名/删除后修复跨卷链接。 */
	private async rewriteBookChapterNavs(book: BookInfo): Promise<void> {
		const chapters = await this.listChapters(book);
		await Promise.all(
			chapters.map((chapter, i) => {
				const prev = i > 0 ? chapters[i - 1] : undefined;
				const next = i < chapters.length - 1 ? chapters[i + 1] : undefined;
				return this.rewriteChapterNav(
					book,
					chapter,
					prev ? navRelPath(chapter.volumeDir, prev.volumeDir, prev.fileName) : undefined,
					next ? navRelPath(chapter.volumeDir, next.volumeDir, next.fileName) : undefined
				);
			})
		);
	}

	/** 文件最后修改时间（毫秒）；文件不存在或不可读时返回 undefined。 */
	private async mtime(filePath: string): Promise<number | undefined> {
		try {
			return (await fs.stat(filePath)).mtimeMs;
		} catch {
			return undefined;
		}
	}

	/** 一组文件中最新的修改时间（毫秒）；全部缺失时返回 0。 */
	private async newestMtime(filePaths: string[]): Promise<number> {
		const times = await Promise.all(filePaths.map((filePath) => this.mtime(filePath)));
		let newest = 0;
		for (const time of times) {
			newest = Math.max(newest, time ?? 0);
		}
		return newest;
	}

	/** 摘要状态：摘要缺失为 missing，任一目标文件比摘要新为 stale。 */
	private async summaryState(summaryFile: string, targets: string[]): Promise<SummaryState> {
		const summaryMtime = await this.mtime(summaryFile);
		if (summaryMtime === undefined) {
			return 'missing';
		}
		return (await this.newestMtime(targets)) > summaryMtime ? 'stale' : 'ok';
	}

	/** 扫描 章节摘要/ 下已有的摘要文件（含正文尚未创建的计划摘要），返回 章节相对路径 → 摘要文件绝对路径。 */
	private async scanChapterSummaryFiles(book: BookInfo): Promise<Map<string, string>> {
		const found = new Map<string, string>();
		const collect = async (dir: string, volumeDir: string | undefined): Promise<void> => {
			let entries: Dirent[];
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (entry.isDirectory()) {
					await collect(path.join(dir, entry.name), entry.name);
				} else if (parseChapterFileName(entry.name)) {
					found.set(volumeDir ? `${volumeDir}/${entry.name}` : entry.name, path.join(dir, entry.name));
				}
			}
		};
		await collect(path.join(book.dir, CHAPTER_SUMMARIES_DIR), undefined);
		return found;
	}

	/** 全书章节摘要状态（键同 chapterRelPath）：含只有计划摘要、正文尚未创建的章节（状态 planned）。已扫描过分卷时传入 volumes 避免重复扫描。 */
	async listChapterSummaryStates(book: BookInfo, volumes?: ChapterVolume[]): Promise<Map<string, SummaryState>> {
		const list = volumes ?? (await this.listVolumes(book));
		const states = new Map<string, SummaryState>();
		await mapLimit(
			list.flatMap((volume) => volume.chapters),
			SCAN_CONCURRENCY,
			async (chapter) => {
				states.set(
					chapterRelPath(chapter),
					await this.summaryState(this.summaryPath(book, chapter.fileName, chapter.volumeDir), [
						this.chapterPath(book, chapter.fileName, chapter.volumeDir),
					])
				);
			}
		);
		for (const rel of (await this.scanChapterSummaryFiles(book)).keys()) {
			if (!states.has(rel)) {
				states.set(rel, 'planned');
			}
		}
		return states;
	}

	/** 摘要视图用：分卷（含只有计划摘要的未来分卷）+ 各自章节摘要条目（含计划章节），按卷序与章节序号排序。 */
	async listChapterSummaries(book: BookInfo): Promise<ChapterSummaryGroup[]> {
		const volumes = await this.listVolumes(book);
		const states = await this.listChapterSummaryStates(book, volumes);
		const groups = new Map<string, ChapterSummaryGroup>();
		const groupOf = (name: string, dirName: string | undefined): ChapterSummaryGroup => {
			const key = dirName ?? name;
			let group = groups.get(key);
			if (!group) {
				group = { name, dirName, entries: [] };
				groups.set(key, group);
			}
			return group;
		};
		for (const volume of volumes) {
			groupOf(volume.name, volume.dirName).entries.push(
				...volume.chapters.map((chapter) => ({ ...chapter, state: states.get(chapterRelPath(chapter)) ?? 'missing' }))
			);
		}
		for (const [rel, state] of states) {
			const parsed = parseChapterFileName(path.basename(rel));
			if (state !== 'planned' || !parsed) {
				continue;
			}
			const index = rel.lastIndexOf('/');
			const dirName = index < 0 ? undefined : rel.slice(0, index);
			groupOf(dirName ?? '第一卷', dirName).entries.push({
				...parsed,
				fileName: path.basename(rel),
				volumeDir: dirName,
				state,
			});
		}
		for (const group of groups.values()) {
			group.entries.sort(bySeq);
		}
		return [...groups.values()].sort(
			(a, b) =>
				volumeSortKey(a.dirName ?? a.name) - volumeSortKey(b.dirName ?? b.name) || a.name.localeCompare(b.name)
		);
	}

	/** 卷摘要列表：现存分卷（含尚无章节的）+ 只有卷摘要文件、分卷尚未创建者，按卷序排序。 */
	async listVolumeSummaries(book: BookInfo, volumes?: ChapterVolume[]): Promise<VolumeSummary[]> {
		const list = volumes ?? (await this.listVolumes(book));
		const withPlans = await this.volumesWithPlans(book, list);
		const summaries = await mapLimit(
			list,
			SCAN_CONCURRENCY,
			async (volume): Promise<VolumeSummary> => {
				const fileName = volumeSummaryFileName(volume.dirName ?? volume.name);
				const summaryFile = this.volumeSummaryPath(book, fileName);
				const base = await this.summaryState(
					summaryFile,
					volume.chapters.map((c) => this.chapterPath(book, c.fileName, c.volumeDir))
				);
				// 卷内还有「有摘要无正文」的计划章节时该卷摘要即计划；摘要没建时仍是 missing
				const state: SummaryState =
					base !== 'missing' && withPlans.has(volume.dirName ?? '') ? 'planned' : base;
				return { name: volume.name, dirName: volume.dirName, fileName, chapters: volume.chapters, state };
			}
		);
		const known = new Set(summaries.map((summary) => summary.fileName));
		let files: string[];
		try {
			files = await fs.readdir(path.join(book.dir, VOLUME_SUMMARIES_DIR));
		} catch {
			files = [];
		}
		for (const file of files) {
			if (known.has(file) || !file.endsWith('.md')) {
				continue;
			}
			const name = path.basename(file, '.md');
			// 分卷尚未创建：卷内有计划章节即为计划，否则按「文件已存在」当作最新
			const state: SummaryState = withPlans.has(name) ? 'planned' : 'ok';
			summaries.push({ name, dirName: name, fileName: file, chapters: [], state });
		}
		return summaries.sort(
			(a, b) =>
				volumeSortKey(a.dirName ?? a.name) - volumeSortKey(b.dirName ?? b.name) || a.name.localeCompare(b.name)
		);
	}

	/** 卷内还有「有摘要无正文」的计划章节的分卷（键为分卷目录名，章节根目录的虚拟卷为 ''）。 */
	private async volumesWithPlans(book: BookInfo, volumes: ChapterVolume[]): Promise<Set<string>> {
		const written = new Set(volumes.flatMap((volume) => volume.chapters.map((chapter) => chapterRelPath(chapter))));
		const withPlans = new Set<string>();
		for (const rel of (await this.scanChapterSummaryFiles(book)).keys()) {
			if (written.has(rel)) {
				continue;
			}
			const index = rel.lastIndexOf('/');
			withPlans.add(index < 0 ? '' : rel.slice(0, index));
		}
		return withPlans;
	}

	/** 某序号上是否已有「有摘要无正文」的计划摘要：返回其相对路径（fileName 为待创建者的文件名，自身会被排除）。 */
	private async planAtSeq(
		book: BookInfo,
		seq: number,
		fileName: string,
		volumeDir: string | undefined
	): Promise<string | undefined> {
		const self = volumeDir ? `${volumeDir}/${fileName}` : fileName;
		for (const rel of (await this.scanChapterSummaryFiles(book)).keys()) {
			if (rel !== self && parseChapterFileName(path.basename(rel))?.seq === seq) {
				return rel;
			}
		}
		return undefined;
	}

	/**
	 * 计划章节摘要的槽位（正文尚未创建时按「序号-标题」定位）：序号空闲时返回应写入的路径（顺带建好目录）；
	 * 已被正文或另一个计划占用时返回占用者；ref 不是「序号-标题」（可带分卷目录）时返回 undefined。
	 */
	async chapterPlanSlot(
		book: BookInfo,
		ref: string
	): Promise<{ filePath: string } | { occupied: { relPath: string; kind: 'chapter' | 'plan' } } | undefined> {
		const segments = ref
			.replace(/^[/\\]+/, '')
			.replace(new RegExp(`^${CHAPTER_SUMMARIES_DIR}[/\\\\]+`), '')
			.replace(/\.md$/i, '')
			.split(/[/\\]+/)
			.filter((segment) => segment.length > 0);
		if (segments.some((segment) => segment === '.' || segment === '..')) {
			return undefined;
		}
		const last = segments.pop();
		const parsed = last ? parseChapterFileName(`${last}.md`) : undefined;
		if (!parsed) {
			return undefined;
		}
		const volumeDir = segments.length > 0 ? sanitizeRelativePath(segments.join('/')) : undefined;
		if (segments.length > 0 && volumeDir === undefined) {
			return undefined;
		}
		const planFileName = chapterFileName(parsed.seq, parsed.title);
		const filePath = this.summaryPath(book, planFileName, volumeDir);
		if (await pathExists(filePath)) {
			return { filePath };
		}
		const chapter = (await this.listChapters(book)).find((c) => c.seq === parsed.seq);
		if (chapter) {
			return { occupied: { relPath: chapterRelPath(chapter), kind: 'chapter' } };
		}
		const plan = await this.planAtSeq(book, parsed.seq, planFileName, volumeDir);
		if (plan) {
			return { occupied: { relPath: plan, kind: 'plan' } };
		}
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		return { filePath };
	}

	/** 为尚未创建的分卷预建卷摘要的目标路径（顺带建好 卷摘要/ 目录，不创建文件）。 */
	async volumePlanSummaryPath(book: BookInfo, name: string): Promise<string> {
		const filePath = this.volumeSummaryPath(book, volumeSummaryFileName(name));
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		return filePath;
	}

	/**
	 * 建计划章节摘要（正文尚未创建）：位置可按参照章（after/before，序号有空档优先）或直接给序号（可落在存量中间）；
	 * 目标序号被占用（正文或计划）时，先把该序号及其后的正文与计划一并顺延 +1（与该处插章同一套逻辑）。
	 */
	async createChapterPlan(
		book: BookInfo,
		title: string,
		position?: ChapterPlanPosition
	): Promise<{ filePath: string; fileName: string; shifted: number }> {
		const chapters = await this.listChapters(book);
		const seqs = chapters.map((c) => c.seq);
		let seq: number;
		let volumeDir: string | undefined;
		let shiftFrom: number | undefined;
		if (position && 'after' in position) {
			const at = chapters.findIndex((c) => sameChapter(c, position.after));
			if (at < 0) {
				throw new Error(`找不到章节「${position.after.fileName}」`);
			}
			({ seq, shiftFrom } = planChapterInsertSeq(seqs, at + 1));
			volumeDir = position.after.volumeDir;
		} else if (position && 'before' in position) {
			const at = chapters.findIndex((c) => sameChapter(c, position.before));
			if (at < 0) {
				throw new Error(`找不到章节「${position.before.fileName}」`);
			}
			({ seq, shiftFrom } = planChapterInsertSeq(seqs, at));
			volumeDir = position.before.volumeDir;
		} else {
			seq = position?.seq ?? seqs.reduce((max, value) => Math.max(max, value), 0) + 1;
			volumeDir = position?.volumeDir;
			if (volumeDir) {
				this.assertVolumeName(volumeDir);
			}
		}
		const fileName = chapterFileName(seq, title);
		const filePath = this.summaryPath(book, fileName, volumeDir);
		// 该序号已被正文或另一个计划占用时顺延（自身已存在的计划摘要不算占用，重复调用保持幂等）
		if (shiftFrom === undefined && !(await pathExists(filePath))) {
			if (seqs.includes(seq) || (await this.planAtSeq(book, seq, fileName, volumeDir))) {
				shiftFrom = seq;
			}
		}
		const shifted = shiftFrom === undefined ? 0 : await this.shiftSeqsFrom(book, shiftFrom);
		if (shifted > 0) {
			// 序号变了：相邻章导航要跟着重写
			await this.rewriteBookChapterNavs(book);
		}
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		if (!(await pathExists(filePath))) {
			await fs.writeFile(filePath, buildChapterSummaryMarkdown(title, fileName), 'utf8');
		}
		await this.commitAndRefresh(`新建计划章节 ${chapterRelPath({ fileName, volumeDir })}`);
		return { filePath, fileName, shifted };
	}

	/** 计划摘要引用的相对路径（`NNNN-标题`，可带分卷目录、`章节摘要/` 前缀与 `.md`）；格式不合法返回 undefined。 */
	private chapterPlanRel(ref: string): string | undefined {
		const segments = ref
			.replace(/^[/\\]+/, '')
			.replace(new RegExp(`^${CHAPTER_SUMMARIES_DIR}[/\\\\]+`), '')
			.replace(/\.md$/i, '')
			.split(/[/\\]+/)
			.filter((segment) => segment.length > 0);
		if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
			return undefined;
		}
		const last = segments.pop() as string;
		const parsed = parseChapterFileName(`${last}.md`);
		if (!parsed) {
			return undefined;
		}
		const fileName = chapterFileName(parsed.seq, parsed.title);
		if (segments.length === 0) {
			return fileName;
		}
		const volumeDir = sanitizeRelativePath(segments.join('/'));
		return volumeDir === undefined ? undefined : `${volumeDir}/${fileName}`;
	}

	/** 删除计划章节摘要（有正文对应的摘要不单独删，随章节一起清理）；ref 见 `chapterPlanRel`，返回被删的摘要相对路径。 */
	async removeChapterPlan(book: BookInfo, ref: string): Promise<string> {
		const rel = this.chapterPlanRel(ref);
		const filePath = rel ? (await this.scanChapterSummaryFiles(book)).get(rel) : undefined;
		if (!rel || !filePath) {
			throw new Error(`找不到计划摘要「${ref}」`);
		}
		if ((await this.listChapters(book)).some((chapter) => chapterRelPath(chapter) === rel)) {
			throw new Error(`「${rel}」已有正文，摘要不能单独删除（删章节时才连同清理）`);
		}
		await fs.rm(filePath, { force: true });
		await closeFileTabs(filePath);
		// 计划删空后顺手收掉空的分卷镜像目录，免得它挡住分卷重命名的冲突检查
		await fs.rmdir(path.dirname(filePath)).catch(() => undefined);
		await this.commitAndRefresh(`删除计划章节 ${rel}`);
		return rel;
	}

	/** 章节摘要文件路径（不存在则从模板创建），返回文件路径。 */
	async ensureChapterSummary(book: BookInfo, chapter: ChapterFile): Promise<string> {
		const filePath = this.summaryPath(book, chapter.fileName, chapter.volumeDir);
		if (!(await pathExists(filePath))) {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			const prefix = chapter.volumeDir ? '../../' : '../';
			const href = `${prefix}${CHAPTERS_DIR}/${chapterRelPath(chapter)}`;
			const contentTitle = await this.readChapterContentTitle(
				this.chapterPath(book, chapter.fileName, chapter.volumeDir)
			);
			await fs.writeFile(
				filePath,
				buildChapterSummaryMarkdown(contentTitle ?? chapter.title, chapter.fileName, href),
				'utf8'
			);
			await this.commitAndRefresh(`新建章节摘要 ${chapterRelPath(chapter)}`);
		}
		return filePath;
	}

	/** 卷摘要文件路径（不存在则从模板创建），返回文件路径。 */
	async ensureVolumeSummary(
		book: BookInfo,
		volume: Pick<VolumeSummary, 'name' | 'dirName'>
	): Promise<string> {
		const fileName = volumeSummaryFileName(volume.dirName ?? volume.name);
		const filePath = this.volumeSummaryPath(book, fileName);
		if (!(await pathExists(filePath))) {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			const key = volume.dirName ?? volume.name;
			const group = (await this.listChapterSummaries(book)).find(
				(candidate) => (candidate.dirName ?? candidate.name) === key
			);
			const chapters = (group?.entries ?? []).map((entry) => ({
				seq: entry.seq,
				title: entry.title,
				planned: entry.state === 'planned',
			}));
			await fs.writeFile(filePath, buildVolumeSummaryMarkdown(volume.name, chapters), 'utf8');
			await this.commitAndRefresh(`新建卷摘要 ${fileName}`);
		}
		return filePath;
	}

	/** 删除卷计划摘要（卷内还没有正文，或卷内还有计划章节）；已有正文的卷摘要随分卷一起清理。 */
	async removeVolumePlan(book: BookInfo, ref: string): Promise<string> {
		const summaries = await this.listVolumeSummaries(book);
		const target = summaries.find(
			(summary) =>
				summary.name === ref ||
				summary.dirName === ref ||
				summary.fileName === ref ||
				summary.fileName === `${ref}.md`
		);
		if (!target) {
			throw new Error(`找不到卷摘要「${ref}」（现有：${summaries.map((s) => s.fileName).join('、') || '无'}）`);
		}
		if (!(await pathExists(this.volumeSummaryPath(book, target.fileName)))) {
			throw new Error(`卷摘要「${target.fileName}」尚未创建`);
		}
		if (target.state !== 'planned' && target.chapters.length > 0) {
			throw new Error(`分卷「${target.name}」已有正文，卷摘要不能单独删除（删分卷时才连同清理）`);
		}
		await this.removeEntry(book, VOLUME_SUMMARIES_DIR, target.fileName);
		return target.fileName;
	}

	/** 区间摘要目录下已有的区间文件：文件名 → 起止序号。 */
	private async listIntervalFiles(book: BookInfo): Promise<Map<string, { startSeq: number; endSeq: number }>> {
		const files = new Map<string, { startSeq: number; endSeq: number }>();
		let entries: string[];
		try {
			entries = await fs.readdir(path.join(book.dir, INTERVAL_SUMMARIES_DIR));
		} catch {
			return files;
		}
		for (const entry of entries) {
			const range = parseIntervalSummaryFileName(entry);
			if (range) {
				files.set(entry, range);
			}
		}
		return files;
	}

	/** 区间起止校验：正整数、起始不大于结束。 */
	private assertIntervalRange(startSeq: number, endSeq: number): void {
		if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq) || startSeq < 1 || endSeq < startSeq) {
			throw new Error(`非法的区间「${startSeq}-${endSeq}」：起止须为正整数且起始不大于结束`);
		}
	}

	/** 区间内的现存章节（按序号）。 */
	async chaptersInRange(book: BookInfo, startSeq: number, endSeq: number): Promise<ChapterFile[]> {
		const chapters = await this.listChapters(book);
		return chapters.filter((chapter) => chapter.seq >= startSeq && chapter.seq <= endSeq);
	}

	/**
	 * 区间摘要列表：默认按 INTERVAL_SUMMARY_SIZE 章一块提示未建区间（已被某个区间文件覆盖的块不再提示），
	 * 外加任意起止的自定义区间（可重叠）。区间越出正文范围（含区间内章节尚未写）即计划。
	 */
	async listIntervalSummaries(book: BookInfo, chapters?: ChapterFile[]): Promise<IntervalSummary[]> {
		const list = chapters ?? (await this.listChapters(book));
		const files = await this.listIntervalFiles(book);
		const ranges: { startSeq: number; endSeq: number; fileName: string }[] = [];
		for (let i = 0; i < list.length; i += INTERVAL_SUMMARY_SIZE) {
			const chunk = list.slice(i, i + INTERVAL_SUMMARY_SIZE);
			const range = { startSeq: chunk[0].seq, endSeq: chunk[chunk.length - 1].seq };
			const fileName = intervalSummaryFileName(range.startSeq, range.endSeq);
			const overlapped = [...files].some(
				([, other]) => other.startSeq <= range.endSeq && range.startSeq <= other.endSeq
			);
			if (!files.has(fileName) && overlapped) {
				continue;
			}
			ranges.push({ ...range, fileName });
		}
		for (const [fileName, range] of files) {
			if (!ranges.some((candidate) => candidate.fileName === fileName)) {
				ranges.push({ ...range, fileName });
			}
		}
		const summaries = await mapLimit(ranges, SCAN_CONCURRENCY, async (range): Promise<IntervalSummary> => {
			const inRange = list.filter((chapter) => chapter.seq >= range.startSeq && chapter.seq <= range.endSeq);
			const summaryFile = path.join(book.dir, INTERVAL_SUMMARIES_DIR, range.fileName);
			const summaryMtime = await this.mtime(summaryFile);
			let state: SummaryState;
			if (summaryMtime === undefined) {
				state = 'missing';
			} else if (inRange.length < range.endSeq - range.startSeq + 1) {
				// 区间内还有尚未创建的章节（含序号空洞）：该摘要仍是计划
				state = 'planned';
			} else {
				state = (await this.newestMtime(inRange.map((c) => this.chapterPath(book, c.fileName, c.volumeDir)))) >
					summaryMtime
					? 'stale'
					: 'ok';
			}
			return { ...range, chapters: inRange, state };
		});
		return summaries.sort((a, b) => a.startSeq - b.startSeq || a.endSeq - b.endSeq);
	}

	/** 区间摘要文件路径（不存在则从模板创建），返回文件路径。 */
	async ensureIntervalSummary(book: BookInfo, startSeq: number, endSeq: number): Promise<string> {
		this.assertIntervalRange(startSeq, endSeq);
		const fileName = intervalSummaryFileName(startSeq, endSeq);
		const filePath = path.join(book.dir, INTERVAL_SUMMARIES_DIR, fileName);
		if (!(await pathExists(filePath))) {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			const chapters = await this.chaptersInRange(book, startSeq, endSeq);
			await fs.writeFile(filePath, buildIntervalSummaryMarkdown(startSeq, endSeq, chapters), 'utf8');
			await this.commitAndRefresh(`新建区间摘要 ${fileName}`);
		}
		return filePath;
	}

	/** 改区间（起止任意、可与其它区间重叠）：文件改名为新区间，重写标题与「章节范围」小节，摘要正文保留，原修改时间保留。 */
	async editIntervalSummary(book: BookInfo, fileName: string, startSeq: number, endSeq: number): Promise<string> {
		this.assertIntervalRange(startSeq, endSeq);
		const name = path.basename(fileName);
		const range = parseIntervalSummaryFileName(name);
		if (!range) {
			throw new Error(`「${name}」不是区间摘要文件名`);
		}
		const oldPath = path.join(book.dir, INTERVAL_SUMMARIES_DIR, name);
		const targetName = intervalSummaryFileName(startSeq, endSeq);
		const targetPath = path.join(book.dir, INTERVAL_SUMMARIES_DIR, targetName);
		const before = await fs.stat(oldPath).catch(() => undefined);
		if (before && targetName !== name) {
			if (await pathExists(targetPath)) {
				throw new Error(`区间摘要「${targetName}」已存在`);
			}
			await vscode.workspace.fs.rename(vscode.Uri.file(oldPath), vscode.Uri.file(targetPath));
		}
		const chapters = await this.chaptersInRange(book, startSeq, endSeq);
		const md =
			(await fs.readFile(targetPath, 'utf8').catch(() => undefined)) ??
			buildIntervalSummaryMarkdown(range.startSeq, range.endSeq, await this.chaptersInRange(book, range.startSeq, range.endSeq));
		await fs.writeFile(targetPath, rewriteIntervalRange(md, startSeq, endSeq, chapters), 'utf8');
		if (before) {
			// 只改了区间范围：保留原修改时间，免得把「待维护」的摘要刷成最新
			await fs.utimes(targetPath, before.atime, before.mtime).catch(() => undefined);
		}
		await this.commitAndRefresh(`修改区间摘要 ${name} →「第 ${startSeq}–${endSeq} 章」`);
		return targetPath;
	}

	/** 删除区间计划摘要（只有越出现存章节范围的计划能删；已覆盖正文的区间改用「修改区间」调整起止）。 */
	async removeIntervalSummary(book: BookInfo, fileName: string): Promise<void> {
		const name = path.basename(fileName);
		const target = (await this.listIntervalSummaries(book)).find((interval) => interval.fileName === name);
		if (!target || target.state === 'missing') {
			throw new Error(`找不到区间摘要「${name}」`);
		}
		if (target.state !== 'planned') {
			throw new Error(`区间「${name}」已覆盖正文，不能单独删除（可用「修改区间」调整起止）`);
		}
		await this.removeEntry(book, INTERVAL_SUMMARIES_DIR, name);
	}

	/** 新建笔记 md（已存在则不覆盖），可选分类路径（可多级）与关联章节，返回文件路径。 */
	async createNote(book: BookInfo, name: string, categoryPath?: string, chapter?: ChapterFile): Promise<string> {
		const safeCategory = categoryPath ? sanitizeRelativePath(categoryPath) : undefined;
		const dir = path.join(book.dir, NOTES_DIR, safeCategory ?? '');
		await fs.mkdir(dir, { recursive: true });
		const filePath = path.join(dir, `${sanitizeFileTitle(name)}.md`);
		if (!(await pathExists(filePath))) {
			// 笔记到 章节/ 的相对前缀随分类层级加深
			const up = '../'.repeat(safeCategory ? safeCategory.split('/').length + 1 : 1);
			const link = chapter
				? {
					relPath: chapterRelPath(chapter),
					title: chapter.title,
					href: `${up}${CHAPTERS_DIR}/${chapterRelPath(chapter)}`,
				}
				: undefined;
			await fs.writeFile(filePath, buildNoteMarkdown(name, link), 'utf8');
			await this.commit(`新建笔记 ${safeCategory ? `${safeCategory}/` : ''}${path.basename(filePath)}`);
		}
		return filePath;
	}

	/** 创建分卷（章节/ 下的子目录），返回实际卷目录名；已存在则抛错。 */
	async createVolume(book: BookInfo, name: string): Promise<string> {
		const dirName = sanitizeFileTitle(name);
		const dir = path.join(book.dir, CHAPTERS_DIR, dirName);
		if (await pathExists(dir)) {
			throw new Error(`分卷「${dirName}」已存在`);
		}
		await fs.mkdir(dir, { recursive: true });
		await this.commitAndRefresh(`新建分卷「${dirName}」`);
		return dirName;
	}

	/** 校验分卷名不含路径分隔符或 ..（防越出章节目录）。 */
	private assertVolumeName(name: string): void {
		if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
			throw new Error(`非法的分卷名「${name}」`);
		}
	}

	/** 重命名分卷目录，并同步重命名摘要镜像目录 / 卷摘要 / 版本目录，重写跨卷导航，迁移进度键。 */
	async renameVolume(book: BookInfo, oldName: string, newName: string): Promise<string> {
		this.assertVolumeName(oldName);
		const target = sanitizeFileTitle(newName);
		this.assertVolumeName(target);
		const oldDir = path.join(book.dir, CHAPTERS_DIR, oldName);
		const newDir = path.join(book.dir, CHAPTERS_DIR, target);
		if (!(await pathExists(oldDir))) {
			throw new Error(`分卷「${oldName}」不存在`);
		}
		if (await pathExists(newDir)) {
			throw new Error(`分卷「${target}」已存在`);
		}
		// 目标卷名下已有卷摘要 / 摘要镜像 / 版本目录（多半是「未来卷」的计划与草稿）时先让用户决定，
		// 否则静默吞掉失败会留下错位的摘要与版本
		const volumeSummaryFrom = this.volumeSummaryPath(book, volumeSummaryFileName(oldName));
		const volumeSummaryTo = this.volumeSummaryPath(book, volumeSummaryFileName(target));
		if ((await pathExists(volumeSummaryFrom)) && (await pathExists(volumeSummaryTo))) {
			throw new Error(
				`分卷「${target}」已有卷摘要（${path.basename(volumeSummaryTo)}），请先删除或改名后再重命名分卷`
			);
		}
		const summaryDirFrom = path.join(book.dir, CHAPTER_SUMMARIES_DIR, oldName);
		const summaryDirTo = path.join(book.dir, CHAPTER_SUMMARIES_DIR, target);
		if ((await pathExists(summaryDirFrom)) && (await pathExists(summaryDirTo))) {
			throw new Error(
				`分卷「${target}」已有章节摘要目录（${CHAPTER_SUMMARIES_DIR}/${target}），请先删除或改名后再重命名分卷`
			);
		}
		const versionsDirFrom = path.join(book.dir, VERSIONS_DIR, oldName);
		const versionsDirTo = path.join(book.dir, VERSIONS_DIR, target);
		if ((await pathExists(versionsDirFrom)) && (await pathExists(versionsDirTo))) {
			throw new Error(
				`分卷「${target}」已有章节版本目录（${VERSIONS_DIR}/${target}），请先删除或改名后再重命名分卷`
			);
		}
		await vscode.workspace.fs.rename(vscode.Uri.file(oldDir), vscode.Uri.file(newDir));
		try {
			await vscode.workspace.fs.rename(vscode.Uri.file(summaryDirFrom), vscode.Uri.file(summaryDirTo));
		} catch {
			// 无摘要镜像目录时忽略
		}
		try {
			await vscode.workspace.fs.rename(vscode.Uri.file(volumeSummaryFrom), vscode.Uri.file(volumeSummaryTo));
		} catch {
			// 无卷摘要时忽略
		}
		try {
			await vscode.workspace.fs.rename(vscode.Uri.file(versionsDirFrom), vscode.Uri.file(versionsDirTo));
		} catch {
			// 无版本目录时忽略
		}
		await this.rewriteBookChapterNavs(book);
		// 该卷各章摘要的原文链接 href 更新为镜像新位置，笔记关联中的卷名前缀同步
		const chapters = await this.listChapters(book);
		await Promise.all(
			chapters.filter((c) => c.volumeDir === target).map((c) => this.rewriteSummaryOriginal(book, target, c.fileName))
		);
		await this.updateNotesVolumeRef(book, oldName, target);
		const progress = this.getProgress(book.dir);
		if (progress && progress.startsWith(`${oldName}/`)) {
			await this.setProgress(book.dir, `${target}/${progress.slice(oldName.length + 1)}`);
		}
		await this.commitAndRefresh(`重命名分卷「${oldName}」→「${target}」`);
		return target;
	}

	/** 删除分卷目录及其摘要镜像、卷摘要与版本目录，重写跨卷导航并处理卷内进度；卷内还有章节且未确认时抛错。 */
	async deleteVolume(book: BookInfo, name: string, deleteChapters: boolean): Promise<void> {
		this.assertVolumeName(name);
		const dir = path.join(book.dir, CHAPTERS_DIR, name);
		let files: string[];
		try {
			files = await fs.readdir(dir);
		} catch {
			throw new Error(`分卷「${name}」不存在`);
		}
		const chapterCount = files.filter((f) => parseChapterFileName(f)).length;
		if (chapterCount > 0 && !deleteChapters) {
			throw new Error(`分卷「${name}」内还有 ${chapterCount} 章；确认一并删除章节时请设置 deleteChapters: true`);
		}
		await fs.rm(dir, { recursive: true, force: true });
		await fs.rm(path.join(book.dir, CHAPTER_SUMMARIES_DIR, name), { recursive: true, force: true });
		await fs.rm(path.join(book.dir, VERSIONS_DIR, name), { recursive: true, force: true });
		await fs.rm(this.volumeSummaryPath(book, volumeSummaryFileName(name)), { force: true });
		if (chapterCount > 0) {
			await this.rewriteBookChapterNavs(book);
			await this.updateNotesVolumeRef(book, name, undefined);
			const progress = this.getProgress(book.dir);
			if (progress && progress.startsWith(`${name}/`)) {
				const first = (await this.listChapters(book))[0];
				if (first) {
					await this.setProgress(book.dir, chapterRelPath(first));
				} else {
					await this.clearProgress(book.dir);
				}
			}
		}
		await this.commitAndRefresh(`删除分卷「${name}」`);
	}

	getCurrentBook(): BookInfo | undefined {
		const dir = this.context.globalState.get<string>(CURRENT_BOOK_KEY);
		if (!dir) {
			return undefined;
		}
		// 书都是库根的直接子目录：库路径变更后旧库的书不再算「当前书」（未配置库路径时不过滤，
		// 与 renameBook / removeBook 等按书目录直接操作的行为保持一致）
		const root = this.getLibraryPath();
		if (root && path.dirname(path.normalize(dir)) !== path.normalize(root)) {
			return undefined;
		}
		return { name: path.basename(dir), dir };
	}

	async setCurrentBook(dir: string | undefined): Promise<void> {
		// 翻章时重复调用同一本书，跳过写入与刷新
		if (this.context.globalState.get<string>(CURRENT_BOOK_KEY) === dir) {
			return;
		}
		await this.context.globalState.update(CURRENT_BOOK_KEY, dir);
		this.scheduleRefresh();
	}

	/** 阅读进度：globalState 中以书路径为 key 记录章节文件名。 */
	getProgress(bookDir: string): string | undefined {
		return this.context.globalState.get<Record<string, string>>(PROGRESS_KEY, {})[bookDir];
	}

	async setProgress(bookDir: string, fileName: string): Promise<void> {
		const progress = this.context.globalState.get<Record<string, string>>(PROGRESS_KEY, {});
		if (progress[bookDir] === fileName) {
			return;
		}
		progress[bookDir] = fileName;
		await this.context.globalState.update(PROGRESS_KEY, progress);
		this.scheduleRefresh();
	}

	/** 清除某书的阅读进度。 */
	private async clearProgress(bookDir: string): Promise<void> {
		const store = this.context.globalState.get<Record<string, string>>(PROGRESS_KEY, {});
		delete store[bookDir];
		await this.context.globalState.update(PROGRESS_KEY, store);
	}

	private ensureWatcher(): void {
		const root = this.getLibraryPath();
		if (root === this.watcherRoot) {
			return;
		}
		this.watcher?.dispose();
		this.watcherRoot = root;
		if (!root) {
			this.watcher = undefined;
			return;
		}
		// 书架.json 在库根，外部改动也要触发刷新，一并纳入监听
		this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.{md,json}'));
		const onEvent = (uri: vscode.Uri): void => {
			this.chapterTitleCache.delete(uri.fsPath);
			if (this.isChapterFile(uri.fsPath)) {
				this.pendingChapterSync.add(uri.fsPath);
			}
			if (this.debounce) {
				clearTimeout(this.debounce);
			}
			this.debounce = setTimeout(() => {
				void this.flushPendingChapterSync();
				this.scheduleRefresh();
			}, 300);
		};
		this.watcher.onDidCreate(onEvent);
		this.watcher.onDidChange(onEvent);
		this.watcher.onDidDelete(onEvent);
	}

	/** 处理防抖期内内容标题可能变更的章节：首行标题与文件名不一致时级联重命名。 */
	private async flushPendingChapterSync(): Promise<void> {
		const pending = [...this.pendingChapterSync];
		this.pendingChapterSync.clear();
		for (const filePath of pending) {
			const parsed = parseChapterFilePath(filePath);
			if (!parsed) {
				continue;
			}
			const contentTitle = await this.readChapterContentTitle(filePath);
			if (!contentTitle) {
				continue;
			}
			try {
				await this.syncChapterTitle(
					{ name: path.basename(parsed.bookDir), dir: parsed.bookDir },
					{ fileName: parsed.fileName, volumeDir: parsed.volumeDir },
					contentTitle
				);
			} catch {
				// 重命名失败（如目标名已存在）时保持现状，交由用户处理
			}
		}
	}

	private isChapterFile(filePath: string): boolean {
		return parseChapterFilePath(filePath) !== undefined;
	}
}
