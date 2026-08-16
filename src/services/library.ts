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
	uniqueBookName,
	WORLD_DIR,
} from './bookFactory';
import { commitAll } from './git';
import {
	buildChapterMarkdown,
	buildChapterSummaryMarkdown,
	buildEntryMarkdown,
	buildIntervalSummaryMarkdown,
	buildMetadataMarkdown,
	buildNoteMarkdown,
	chapterFileName,
	chineseNumberToInt,
	escapeMdLinkText,
	extractMarkdownTitle,
	intervalSummaryFileName,
	navRelPath,
	parseChapterFileName,
	sanitizeFileTitle,
	updateChapterNav,
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
	WORLD_DIR
};

/** 区间摘要的章节数：每 10 章一个区间。 */
export const INTERVAL_SUMMARY_SIZE = 10;

/** 新建空书时创建的目录骨架（不含 章节/；放 .gitkeep 以便 git 跟踪）。 */
const EMPTY_SUBDIRS = [WORLD_DIR, CARDS_DIR, CHAPTER_SUMMARIES_DIR, INTERVAL_SUMMARIES_DIR, NOTES_DIR];

/** 章节在 章节/ 下的相对路径（分卷含目录名），用作进度键。 */
export function chapterRelPath(chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>): string {
	return chapter.volumeDir ? `${chapter.volumeDir}/${chapter.fileName}` : chapter.fileName;
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
		const configured = vscode.workspace.getConfiguration('xReader').get<string>('libraryPath', '').trim();
		// 规范化为 fsPath（盘符大小写/分隔符统一），保证与 watcher、页签的 uri.fsPath 字符串比较一致
		return configured ? vscode.Uri.file(configured).fsPath : configured;
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
		const rootChapters: ChapterFile[] = await Promise.all(
			rootParsed.map(async ({ parsed, fileName }) => ({
				...parsed,
				title: (await this.readChapterContentTitle(path.join(book.dir, CHAPTERS_DIR, fileName))) ?? parsed.title,
				fileName,
			}))
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
		const readVolumes = await Promise.all(volumeDirs.map((dirName) => this.readVolume(book, dirName)));
		for (const volume of readVolumes) {
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
		const chapters = (
			await Promise.all(
				files.map(async (fileName): Promise<ChapterFile | undefined> => {
					const parsed = parseChapterFileName(fileName);
					if (!parsed) {
						return undefined;
					}
					const contentTitle = await this.readChapterContentTitle(
						path.join(book.dir, CHAPTERS_DIR, dirName, fileName)
					);
					return { ...parsed, title: contentTitle ?? parsed.title, fileName, volumeDir: dirName };
				})
			)
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
		await fs.writeFile(path.join(dir, META_FILE), buildMetadataMarkdown(dirName, ''), 'utf8');
		await commitAll(root, `新建《${dirName}》`);
		await this.setCurrentBook(dir);
		this._onDidChange.fire();
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
		if (!(await pathExists(filePath))) {
			await fs.writeFile(filePath, buildEntryMarkdown(name), 'utf8');
			const root = this.getLibraryPath();
			if (root) {
				await commitAll(root, `新建 ${subDir}/${path.basename(filePath)}`);
			}
		}
		return filePath;
	}

	/** 删除条目/笔记 md 文件并提交 git 快照。 */
	async removeEntry(book: BookInfo, subDir: string, fileName: string): Promise<void> {
		await fs.rm(path.join(book.dir, subDir, fileName), { force: true });
		await closeFileTabs(path.join(book.dir, subDir, fileName));
		const root = this.getLibraryPath();
		if (root) {
			await commitAll(root, `删除 ${subDir}/${fileName}`);
		}
		this._onDidChange.fire();
	}

	/** 删除章节 md 及其摘要镜像，同步重写相邻章导航，并提交 git 快照。 */
	async removeChapter(book: BookInfo, chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>): Promise<void> {
		const chapters = await this.listChapters(book);
		const index = chapters.findIndex((c) => chapterRelPath(c) === chapterRelPath(chapter));
		const prev = index > 0 ? chapters[index - 1] : undefined;
		const next = index >= 0 && index < chapters.length - 1 ? chapters[index + 1] : undefined;
		await Promise.all([
			prev
				? this.rewriteChapterNav(
					book,
					prev,
					undefined,
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
		await fs.rm(path.join(book.dir, CHAPTERS_DIR, chapter.volumeDir ?? '', chapter.fileName), { force: true });
		await fs.rm(path.join(book.dir, CHAPTER_SUMMARIES_DIR, chapter.volumeDir ?? '', chapter.fileName), {
			force: true,
		});
		await closeFileTabs(path.join(book.dir, CHAPTER_SUMMARIES_DIR, chapter.volumeDir ?? '', chapter.fileName));
		// 进度指向被删章时迁移到相邻章（prev 优先），无相邻章则清除
		const rel = chapterRelPath(chapter);
		if (this.getProgress(book.dir) === rel) {
			if (prev || next) {
				await this.setProgress(book.dir, chapterRelPath(prev ?? next!));
			} else {
				const store = this.context.globalState.get<Record<string, string>>(PROGRESS_KEY, {});
				delete store[book.dir];
				await this.context.globalState.update(PROGRESS_KEY, store);
			}
		}
		await closeFileTabs(path.join(book.dir, CHAPTERS_DIR, chapter.volumeDir ?? '', chapter.fileName));
		await this.updateNotesChapterRef(book, rel, undefined);
		const root = this.getLibraryPath();
		if (root) {
			await commitAll(root, `删除章节 ${chapterRelPath(chapter)}`);
		}
		this._onDidChange.fire();
	}

	/** 遍历全部笔记文件（根 + 各分类），回调返回新内容（undefined 不写回）。 */
	private async forEachNote(
		book: BookInfo,
		fn: (filePath: string, content: string, relDir: string) => string | undefined
	): Promise<void> {
		const categories = await this.listNoteCategories(book);
		const dirs = [NOTES_DIR, ...categories.map((c) => `${NOTES_DIR}/${c.dirName}`)];
		for (const relDir of dirs) {
			const category = relDir === NOTES_DIR ? undefined : relDir.slice(NOTES_DIR.length + 1);
			for (const note of await this.listNotes(book, category)) {
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
		await this.forEachNote(book, (_filePath, md, relDir) => {
			if (NOTE_CHAPTER_FM_RE.exec(md)?.[1] !== oldRel) {
				return undefined;
			}
			if (ref) {
				const prefix = relDir === NOTES_DIR ? '../' : '../../';
				return md
					.replace(NOTE_CHAPTER_LINE_RE, `chapter: ${JSON.stringify(ref.relPath)}`)
					.replace(
						/^> 关联章节：.*$/m,
						`> 关联章节：[${escapeMdLinkText(ref.title)}](<${prefix}${CHAPTERS_DIR}/${ref.relPath}>)`
					);
			}
			return md
				.replace(/^chapter:[^\n]*\n?/m, '')
				.replace(/^> 关联章节：[^\n]*\n?/m, '');
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
					.replace(NOTE_CHAPTER_LINE_RE, `chapter: ${JSON.stringify(`${newVolume}/${link.slice(prefix.length)}`)}`)
					.replace(new RegExp(`(\\(<[^>]*${CHAPTERS_DIR}/)${escaped}/`), `$1${newVolume}/`);
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
		const filePath = path.join(book.dir, CHAPTER_SUMMARIES_DIR, volumeDir ?? '', fileName);
		let md: string;
		try {
			md = await fs.readFile(filePath, 'utf8');
		} catch {
			return;
		}
		const prefix = volumeDir ? '../../' : '../';
		const href = `${prefix}${CHAPTERS_DIR}/${volumeDir ? volumeDir + '/' : ''}${fileName}`;
		let updated = md.replace(/^> 原文：.*$/m, `> 原文：[${fileName}](<${href}>)`);
		if (oldTitle) {
			const newTitle = parseChapterFileName(fileName)?.title;
			if (newTitle) {
				updated = updated.replace(`# ${oldTitle} · 摘要`, `# ${newTitle} · 摘要`);
			}
		}
		if (updated !== md) {
			await fs.writeFile(filePath, updated, 'utf8');
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
		// 统一用清洗后的标题，保证文件名、摘要标题与笔记链接文字一致
		const title = sanitizeFileTitle(newTitle);
		const newFileName = chapterFileName(seq, title);
		if (newFileName === chapter.fileName) {
			return chapter.fileName;
		}
		const volumeDir = chapter.volumeDir ?? '';
		const newPath = path.join(book.dir, CHAPTERS_DIR, volumeDir, newFileName);
		if (await pathExists(newPath)) {
			throw new Error(`章节「${newFileName}」已存在`);
		}
		// 用 workspace.fs 重命名，让打开的编辑器跟随新路径
		await vscode.workspace.fs.rename(
			vscode.Uri.file(path.join(book.dir, CHAPTERS_DIR, volumeDir, chapter.fileName)),
			vscode.Uri.file(newPath)
		);
		try {
			await vscode.workspace.fs.rename(
				vscode.Uri.file(path.join(book.dir, CHAPTER_SUMMARIES_DIR, volumeDir, chapter.fileName)),
				vscode.Uri.file(path.join(book.dir, CHAPTER_SUMMARIES_DIR, volumeDir, newFileName))
			);
		} catch {
			// 无摘要镜像时忽略
		}
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
		const root = this.getLibraryPath();
		if (root) {
			await commitAll(root, `重命名章节 ${oldRel} → ${newRel}`);
		}
		this._onDidChange.fire();
		return newFileName;
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
			const updated = meta.replace(/^title:\s*"[^"]*"\s*$/m, `title: ${JSON.stringify(target)}`);
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
		if (configuredRoot) {
			await commitAll(configuredRoot, `重命名书籍《${book.name}》→《${target}》`);
		}
		this._onDidChange.fire();
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
		await vscode.workspace.fs.rename(vscode.Uri.file(path.join(dir, fileName)), vscode.Uri.file(newPath));
		const root = this.getLibraryPath();
		if (root) {
			await commitAll(root, `重命名 ${subDir}/${fileName} → ${newFileName}`);
		}
		this._onDidChange.fire();
		return newFileName;
	}

	/** 新建章节 md（全局序号接最大值），重写全书导航；返回文件名。 */
	async createChapter(book: BookInfo, title: string, volumeDir?: string): Promise<string> {
		const chapters = await this.listChapters(book);
		const seq = chapters.reduce((max, c) => Math.max(max, c.seq), 0) + 1;
		const fileName = chapterFileName(seq, title);
		const dir = path.join(book.dir, CHAPTERS_DIR, volumeDir ?? '');
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, fileName), buildChapterMarkdown(title, ''), 'utf8');
		await this.rewriteBookChapterNavs(book);
		const root = this.getLibraryPath();
		if (root) {
			await commitAll(root, `新建章节 ${chapterRelPath({ fileName, volumeDir })}`);
		}
		this._onDidChange.fire();
		return fileName;
	}

	/** 重命名笔记分类目录（笔记/ 下子目录），返回新目录名。 */
	async renameNoteCategory(book: BookInfo, oldName: string, newName: string): Promise<string> {
		const target = sanitizeFileTitle(newName);
		if (target === oldName) {
			return target;
		}
		const oldDir = path.join(book.dir, NOTES_DIR, oldName);
		const newDir = path.join(book.dir, NOTES_DIR, target);
		if (!(await pathExists(oldDir))) {
			throw new Error(`分类「${oldName}」不存在`);
		}
		if (await pathExists(newDir)) {
			throw new Error(`分类「${target}」已存在`);
		}
		await vscode.workspace.fs.rename(vscode.Uri.file(oldDir), vscode.Uri.file(newDir));
		const root = this.getLibraryPath();
		if (root) {
			await commitAll(root, `重命名笔记分类「${oldName}」→「${target}」`);
		}
		this._onDidChange.fire();
		return target;
	}

	/** 删除笔记分类目录（含其中全部笔记）并提交 git 快照。 */
	async deleteNoteCategory(book: BookInfo, name: string): Promise<void> {
		await fs.rm(path.join(book.dir, NOTES_DIR, name), { recursive: true, force: true });
		const root = this.getLibraryPath();
		if (root) {
			await commitAll(root, `删除笔记分类「${name}」`);
		}
		this._onDidChange.fire();
	}

	/** 重写某章底部导航链接（prev/next 为相对路径，undefined 移除对应链接）；文件不存在时跳过。 */
	private async rewriteChapterNav(
		book: BookInfo,
		chapter: Pick<ChapterFile, 'fileName' | 'volumeDir'>,
		prev: string | undefined,
		next: string | undefined
	): Promise<void> {
		const filePath = path.join(book.dir, CHAPTERS_DIR, chapter.volumeDir ?? '', chapter.fileName);
		let md: string;
		try {
			md = await fs.readFile(filePath, 'utf8');
		} catch {
			return;
		}
		const updated = updateChapterNav(md, prev, next);
		if (updated !== md) {
			await fs.writeFile(filePath, updated, 'utf8');
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
		if (!(await pathExists(filePath))) {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			const prefix = chapter.volumeDir ? '../../' : '../';
			const href = `${prefix}${CHAPTERS_DIR}/${chapterRelPath(chapter)}`;
			const contentTitle = await this.readChapterContentTitle(
				path.join(book.dir, CHAPTERS_DIR, chapter.volumeDir ?? '', chapter.fileName)
			);
			await fs.writeFile(
				filePath,
				buildChapterSummaryMarkdown(contentTitle ?? chapter.title, chapter.fileName, href),
				'utf8'
			);
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
		if (!(await pathExists(filePath))) {
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
		if (!(await pathExists(filePath))) {
			const link = chapter
				? {
					relPath: chapterRelPath(chapter),
					title: chapter.title,
					href: `${safeCategory ? '../../' : '../'}${CHAPTERS_DIR}/${chapterRelPath(chapter)}`,
				}
				: undefined;
			await fs.writeFile(filePath, buildNoteMarkdown(name, link), 'utf8');
			const root = this.getLibraryPath();
			if (root) {
				await commitAll(root, `新建笔记 ${safeCategory ? `${safeCategory}/` : ''}${path.basename(filePath)}`);
			}
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
		const root = this.getLibraryPath();
		if (root) {
			await commitAll(root, `新建分卷「${dirName}」`);
		}
		this._onDidChange.fire();
		return dirName;
	}

	/** 校验分卷名不含路径分隔符或 ..（防越出章节目录）。 */
	private assertVolumeName(name: string): void {
		if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
			throw new Error(`非法的分卷名「${name}」`);
		}
	}

	/** 重命名分卷目录，并同步重命名 章节摘要/ 下的镜像目录、重写跨卷导航、迁移进度键。 */
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
		await vscode.workspace.fs.rename(vscode.Uri.file(oldDir), vscode.Uri.file(newDir));
		try {
			await vscode.workspace.fs.rename(
				vscode.Uri.file(path.join(book.dir, CHAPTER_SUMMARIES_DIR, oldName)),
				vscode.Uri.file(path.join(book.dir, CHAPTER_SUMMARIES_DIR, target))
			);
		} catch {
			// 无摘要镜像目录时忽略
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
		const root = this.getLibraryPath();
		if (root) {
			await commitAll(root, `重命名分卷「${oldName}」→「${target}」`);
		}
		this._onDidChange.fire();
		return target;
	}

	/** 删除分卷目录及其摘要镜像，重写跨卷导航并处理卷内进度；卷内还有章节且未确认时抛错。 */
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
		if (chapterCount > 0) {
			await this.rewriteBookChapterNavs(book);
			await this.updateNotesVolumeRef(book, name, undefined);
			const progress = this.getProgress(book.dir);
			if (progress && progress.startsWith(`${name}/`)) {
				const first = (await this.listChapters(book))[0];
				if (first) {
					await this.setProgress(book.dir, chapterRelPath(first));
				} else {
					const store = this.context.globalState.get<Record<string, string>>(PROGRESS_KEY, {});
					delete store[book.dir];
					await this.context.globalState.update(PROGRESS_KEY, store);
				}
			}
		}
		const root = this.getLibraryPath();
		if (root) {
			await commitAll(root, `删除分卷「${name}」`);
		}
		this._onDidChange.fire();
	}

	getCurrentBook(): BookInfo | undefined {
		const dir = this.context.globalState.get<string>(CURRENT_BOOK_KEY);
		return dir ? { name: path.basename(dir), dir } : undefined;
	}

	async setCurrentBook(dir: string | undefined): Promise<void> {
		// 翻章时重复调用同一本书，跳过写入与刷新
		if (this.context.globalState.get<string>(CURRENT_BOOK_KEY) === dir) {
			return;
		}
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
		const onEvent = (uri: vscode.Uri): void => {
			this.chapterTitleCache.delete(uri.fsPath);
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
