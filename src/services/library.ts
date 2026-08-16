import type { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BookInfo, ChapterFile, ChapterVolume, EntryFile, IntervalSummary, NoteCategory, NoteFile } from '../model/book';
import {
	CARDS_DIR,
	CHAPTER_SUMMARIES_DIR,
	CHAPTERS_DIR,
	createBookFromText,
	INTERVAL_SUMMARIES_DIR,
	META_FILE,
	NOTES_DIR,
	WORLD_DIR,
} from './bookFactory';
import { commitAll } from './git';
import {
	buildChapterSummaryMarkdown,
	buildEntryMarkdown,
	buildIntervalSummaryMarkdown,
	buildNoteMarkdown,
	chineseNumberToInt,
	intervalSummaryFileName,
	parseChapterFileName,
	sanitizeFileTitle,
} from './markdown';
import { decodeBuffer } from './novelParser';

export {
	CARDS_DIR,
	CHAPTER_SUMMARIES_DIR,
	CHAPTERS_DIR, createBookFromText, INTERVAL_SUMMARIES_DIR,
	META_FILE,
	NOTES_DIR,
	WORLD_DIR
};

/** 区间摘要的章节数：每 10 章一个区间。 */
export const INTERVAL_SUMMARY_SIZE = 10;

/** 章节在 章节/ 下的相对路径（分卷含目录名），用作进度键。 */
export function chapterRelPath(chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>): string {
	return chapter.volumeDir ? `${chapter.volumeDir}/${chapter.fileName}` : chapter.fileName;
}

const VOLUME_NAME_RE = /^\s*第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*卷\s*$/;

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

/** 小说库服务：扫描库目录、读写书籍文件夹、跟踪当前书与阅读进度。文件即真相，外部变更经 watcher 汇入。 */
export class LibraryService {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private watcher: vscode.FileSystemWatcher | undefined;
	private watcherRoot = '';
	private debounce: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.ensureWatcher();
		context.subscriptions.push(
			{
				dispose: () => {
					this.watcher?.dispose();
					if (this.debounce) {
						clearTimeout(this.debounce);
					}
				},
			},
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('xReader.libraryPath')) {
					this.ensureWatcher();
					this._onDidChange.fire();
				}
			})
		);
	}

	getLibraryPath(): string {
		return vscode.workspace.getConfiguration('xReader').get<string>('libraryPath', '').trim();
	}

	/** 返回已配置的库目录；未配置（或 force 时）弹窗让用户选择并写入全局配置。 */
	async ensureLibraryPath(force = false): Promise<string | undefined> {
		const existing = this.getLibraryPath();
		if (existing && !force) {
			return existing;
		}
		const picked = await vscode.window.showOpenDialog({
			title: '选择小说库目录',
			openLabel: '选择',
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
		this._onDidChange.fire();
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
		const books: BookInfo[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const dir = path.join(root, entry.name);
			try {
				await fs.access(path.join(dir, META_FILE));
				books.push({ name: entry.name, dir });
			} catch {
				// 非书文件夹
			}
		}
		return books.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** 章节分卷列表（按卷序排序）：根目录章节归入默认卷 第一卷。 */
	async listVolumes(book: BookInfo): Promise<ChapterVolume[]> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(path.join(book.dir, CHAPTERS_DIR), { withFileTypes: true });
		} catch {
			return [];
		}
		const rootChapters: ChapterFile[] = [];
		const volumeDirs: string[] = [];
		for (const entry of entries) {
			if (entry.isDirectory()) {
				volumeDirs.push(entry.name);
			} else {
				const parsed = parseChapterFileName(entry.name);
				if (parsed) {
					rootChapters.push({ ...parsed, fileName: entry.name });
				}
			}
		}
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
		for (const dirName of volumeDirs) {
			const volume = await this.readVolume(book, dirName);
			if (volume.chapters.length > 0) {
				volumes.push(volume);
			}
		}
		return volumes;
	}

	private async readVolume(book: BookInfo, dirName: string): Promise<ChapterVolume> {
		let files: string[];
		try {
			files = await fs.readdir(path.join(book.dir, CHAPTERS_DIR, dirName));
		} catch {
			files = [];
		}
		const chapters: ChapterFile[] = [];
		for (const fileName of files) {
			const parsed = parseChapterFileName(fileName);
			if (parsed) {
				chapters.push({ ...parsed, fileName, volumeDir: dirName });
			}
		}
		chapters.sort(bySeq);
		return { name: dirName, dirName, chapters };
	}

	/** 全部章节（跨卷合并，按卷序 + 序号排序），用于翻章与章节计数。 */
	async listChapters(book: BookInfo): Promise<ChapterFile[]> {
		const volumes = await this.listVolumes(book);
		return volumes.flatMap((volume) => volume.chapters);
	}

	/** 按进度键（分卷相对路径；兼容旧格式文件名）定位章节。 */
	async findChapterByProgress(book: BookInfo, progressKey: string): Promise<ChapterFile | undefined> {
		const chapters = await this.listChapters(book);
		return (
			chapters.find((c) => chapterRelPath(c) === progressKey) ??
			chapters.find((c) => c.fileName === progressKey)
		);
	}

	/** 世界书/角色卡 目录下的条目 md 文件列表（忽略 .gitkeep 等非 md 文件）。 */
	async listEntries(book: BookInfo, subDir: string): Promise<EntryFile[]> {
		let entries: string[];
		try {
			entries = await fs.readdir(path.join(book.dir, subDir));
		} catch {
			return [];
		}
		return entries
			.filter((fileName) => fileName.endsWith('.md'))
			.map((fileName) => ({ name: fileName.replace(/\.md$/, ''), fileName }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** 导入 txt：解码 → 建书文件夹 → git commit。返回 undefined 表示用户未选库目录。 */
	async importBook(fileUri: vscode.Uri): Promise<{ book: BookInfo; chapterCount: number } | undefined> {
		const root = await this.ensureLibraryPath();
		if (!root) {
			return undefined;
		}
		const data = await fs.readFile(fileUri.fsPath);
		const text = decodeBuffer(data);
		const sourceFileName = path.basename(fileUri.fsPath);
		const rawName = sourceFileName.replace(/\.[^.]+$/, '');
		const result = await createBookFromText(root, rawName, sourceFileName, text);
		await commitAll(root, `导入《${result.book.name}》（${result.chapterCount}章）`);
		await this.setCurrentBook(result.book.dir);
		this._onDidChange.fire();
		return result;
	}

	async removeBook(book: BookInfo): Promise<void> {
		await fs.rm(book.dir, { recursive: true, force: true });
		const root = this.getLibraryPath();
		if (root) {
			await commitAll(root, `移除《${book.name}》`);
		}
		if (this.getCurrentBook()?.dir === book.dir) {
			await this.setCurrentBook(undefined);
		}
		const progress = this.context.globalState.get<Record<string, string>>(PROGRESS_KEY, {});
		delete progress[book.dir];
		await this.context.globalState.update(PROGRESS_KEY, progress);
		this._onDidChange.fire();
	}

	/** 在 世界书/ 或 角色卡/ 下新建条目 md（已存在则不覆盖），返回文件路径。 */
	async createEntry(book: BookInfo, subDir: string, name: string): Promise<string> {
		const dir = path.join(book.dir, subDir);
		await fs.mkdir(dir, { recursive: true });
		const filePath = path.join(dir, `${sanitizeFileTitle(name)}.md`);
		try {
			await fs.access(filePath);
		} catch {
			await fs.writeFile(filePath, buildEntryMarkdown(name), 'utf8');
		}
		return filePath;
	}

	/** 删除条目/笔记 md 文件并提交 git 快照。 */
	async removeEntry(book: BookInfo, subDir: string, fileName: string): Promise<void> {
		await fs.rm(path.join(book.dir, subDir, fileName), { force: true });
		const root = this.getLibraryPath();
		if (root) {
			await commitAll(root, `删除 ${subDir}/${fileName}`);
		}
		this._onDidChange.fire();
	}

	/** 已有章节摘要的相对路径集合（键格式同 chapterRelPath）；镜像 章节/ 的分卷结构。 */
	async listChapterSummaryKeys(book: BookInfo): Promise<Set<string>> {
		const keys = new Set<string>();
		let entries: Dirent[];
		try {
			entries = await fs.readdir(path.join(book.dir, CHAPTER_SUMMARIES_DIR), { withFileTypes: true });
		} catch {
			return keys;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				let files: string[];
				try {
					files = await fs.readdir(path.join(book.dir, CHAPTER_SUMMARIES_DIR, entry.name));
				} catch {
					continue;
				}
				for (const fileName of files) {
					if (parseChapterFileName(fileName)) {
						keys.add(`${entry.name}/${fileName}`);
					}
				}
			} else if (parseChapterFileName(entry.name)) {
				keys.add(entry.name);
			}
		}
		return keys;
	}

	/** 章节摘要文件路径（不存在则从模板创建），返回文件路径。 */
	async ensureChapterSummary(book: BookInfo, chapter: ChapterFile): Promise<string> {
		const filePath = path.join(book.dir, CHAPTER_SUMMARIES_DIR, chapter.volumeDir ?? '', chapter.fileName);
		try {
			await fs.access(filePath);
		} catch {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			const prefix = chapter.volumeDir ? '../../' : '../';
			const href = `${prefix}${CHAPTERS_DIR}/${chapterRelPath(chapter)}`;
			await fs.writeFile(filePath, buildChapterSummaryMarkdown(chapter.title, chapter.fileName, href), 'utf8');
		}
		return filePath;
	}

	/** 区间摘要列表：全部章节每 10 章一个区间，附带摘要文件是否已存在。 */
	async listIntervalSummaries(book: BookInfo): Promise<IntervalSummary[]> {
		const chapters = await this.listChapters(book);
		if (chapters.length === 0) {
			return [];
		}
		let files: string[] = [];
		try {
			files = await fs.readdir(path.join(book.dir, INTERVAL_SUMMARIES_DIR));
		} catch {
			// 目录不存在时视为全部未建
		}
		const existing = new Set(files);
		const intervals: IntervalSummary[] = [];
		for (let i = 0; i < chapters.length; i += INTERVAL_SUMMARY_SIZE) {
			const chunk = chapters.slice(i, i + INTERVAL_SUMMARY_SIZE);
			const startSeq = chunk[0].seq;
			const endSeq = chunk[chunk.length - 1].seq;
			const fileName = intervalSummaryFileName(startSeq, endSeq);
			intervals.push({ startSeq, endSeq, fileName, chapters: chunk, exists: existing.has(fileName) });
		}
		return intervals;
	}

	/** 区间摘要文件路径（不存在则从模板创建），返回文件路径。 */
	async ensureIntervalSummary(book: BookInfo, interval: IntervalSummary): Promise<string> {
		const filePath = path.join(book.dir, INTERVAL_SUMMARIES_DIR, interval.fileName);
		try {
			await fs.access(filePath);
		} catch {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			const md = buildIntervalSummaryMarkdown(interval.startSeq, interval.endSeq, interval.chapters);
			await fs.writeFile(filePath, md, 'utf8');
		}
		return filePath;
	}

	/** 笔记分类：笔记/ 下的子目录列表。 */
	async listNoteCategories(book: BookInfo): Promise<NoteCategory[]> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(path.join(book.dir, NOTES_DIR), { withFileTypes: true });
		} catch {
			return [];
		}
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => ({ name: entry.name, dirName: entry.name }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** 某个分类下（或笔记根目录）的笔记 md 文件列表。 */
	async listNotes(book: BookInfo, categoryDir?: string): Promise<NoteFile[]> {
		const subDir = categoryDir ? `${NOTES_DIR}/${categoryDir}` : NOTES_DIR;
		const entries = await this.listEntries(book, subDir);
		return entries.map((entry) => ({ ...entry, categoryDir }));
	}

	/** 新建笔记 md（已存在则不覆盖），可选分类目录与关联章节，返回文件路径。 */
	async createNote(book: BookInfo, name: string, categoryDir?: string, chapter?: ChapterFile): Promise<string> {
		const safeCategory = categoryDir ? sanitizeFileTitle(categoryDir) : undefined;
		const dir = safeCategory ? path.join(book.dir, NOTES_DIR, safeCategory) : path.join(book.dir, NOTES_DIR);
		await fs.mkdir(dir, { recursive: true });
		const filePath = path.join(dir, `${sanitizeFileTitle(name)}.md`);
		try {
			await fs.access(filePath);
		} catch {
			const link = chapter
				? {
					relPath: chapterRelPath(chapter),
					title: chapter.title,
					href: `${safeCategory ? '../../' : '../'}${CHAPTERS_DIR}/${chapterRelPath(chapter)}`,
				}
				: undefined;
			await fs.writeFile(filePath, buildNoteMarkdown(name, link), 'utf8');
		}
		return filePath;
	}

	/** 创建分卷（章节/ 下的子目录），返回实际卷目录名；已存在则抛错。 */
	async createVolume(book: BookInfo, name: string): Promise<string> {
		const dirName = sanitizeFileTitle(name);
		const dir = path.join(book.dir, CHAPTERS_DIR, dirName);
		try {
			await fs.access(dir);
			throw new Error(`分卷「${dirName}」已存在`);
		} catch (error) {
			if (error instanceof Error && error.message.includes('已存在')) {
				throw error;
			}
		}
		await fs.mkdir(dir, { recursive: true });
		this._onDidChange.fire();
		return dirName;
	}

	/** 重命名分卷目录，并同步重命名 章节摘要/ 下的镜像目录。 */
	async renameVolume(book: BookInfo, oldName: string, newName: string): Promise<string> {
		const target = sanitizeFileTitle(newName);
		const oldDir = path.join(book.dir, CHAPTERS_DIR, oldName);
		const newDir = path.join(book.dir, CHAPTERS_DIR, target);
		try {
			await fs.access(oldDir);
		} catch {
			throw new Error(`分卷「${oldName}」不存在`);
		}
		try {
			await fs.access(newDir);
			throw new Error(`分卷「${target}」已存在`);
		} catch (error) {
			if (error instanceof Error && error.message.includes('已存在')) {
				throw error;
			}
		}
		await fs.rename(oldDir, newDir);
		try {
			await fs.rename(
				path.join(book.dir, CHAPTER_SUMMARIES_DIR, oldName),
				path.join(book.dir, CHAPTER_SUMMARIES_DIR, target)
			);
		} catch {
			// 无摘要镜像目录时忽略
		}
		this._onDidChange.fire();
		return target;
	}

	/** 删除分卷目录及其摘要镜像；卷内还有章节且未确认时抛错。 */
	async deleteVolume(book: BookInfo, name: string, deleteChapters: boolean): Promise<void> {
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
		this._onDidChange.fire();
	}

	getCurrentBook(): BookInfo | undefined {
		const dir = this.context.globalState.get<string>(CURRENT_BOOK_KEY);
		return dir ? { name: path.basename(dir), dir } : undefined;
	}

	async setCurrentBook(dir: string | undefined): Promise<void> {
		await this.context.globalState.update(CURRENT_BOOK_KEY, dir);
		this._onDidChange.fire();
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
		this._onDidChange.fire();
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
		this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.md'));
		const onEvent = (): void => {
			if (this.debounce) {
				clearTimeout(this.debounce);
			}
			this.debounce = setTimeout(() => this._onDidChange.fire(), 300);
		};
		this.watcher.onDidCreate(onEvent);
		this.watcher.onDidChange(onEvent);
		this.watcher.onDidDelete(onEvent);
	}
}
