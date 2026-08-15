import * as fs from 'fs/promises';
import * as path from 'path';
import type { Dirent } from 'fs';
import * as vscode from 'vscode';
import type { BookInfo, ChapterFile, ChapterVolume, EntryFile } from '../model/book';
import { CARDS_DIR, CHAPTERS_DIR, META_FILE, WORLD_DIR, createBookFromText } from './bookFactory';
import { commitAll } from './git';
import { buildEntryMarkdown, chineseNumberToInt, parseChapterFileName, sanitizeFileTitle } from './markdown';
import { decodeBuffer } from './novelParser';

export { CARDS_DIR, CHAPTERS_DIR, META_FILE, WORLD_DIR, createBookFromText };

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
	private debounce: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.ensureWatcher();
		context.subscriptions.push({
			dispose: () => {
				this.watcher?.dispose();
				if (this.debounce) {
					clearTimeout(this.debounce);
				}
			},
		});
	}

	getLibraryPath(): string {
		return vscode.workspace.getConfiguration('xReader').get<string>('libraryPath', '').trim();
	}

	/** 返回已配置的库目录；未配置时弹窗让用户选择并写入全局配置。 */
	async ensureLibraryPath(): Promise<string | undefined> {
		const existing = this.getLibraryPath();
		if (existing) {
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
		if (!root || this.watcher) {
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
