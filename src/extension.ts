import * as path from 'path';
import * as vscode from 'vscode';
import type { BookInfo, ChapterFile, ChapterVolume, IntervalSummary } from './model/book';
import {
	promptInstallAudio,
	readChapterText,
	readCharacterVoiceConfig,
	resolveChapter,
	speakViaAudio,
} from './services/audio';
import { commitAll, resetHistory } from './services/git';
import {
	CARDS_DIR,
	CHAPTER_SUMMARIES_DIR,
	chapterRelPath,
	CHAPTERS_DIR,
	closeFileTabs,
	INTERVAL_SUMMARIES_DIR,
	LibraryService,
	matchesProgress,
	NOTES_DIR,
	parseChapterFilePath,
	PRIMARY_KEEP_VERSION_NAME,
	sameChapter,
	shelfLeafName,
	shelfParentPath,
	WORLD_DIR,
} from './services/library';
import { mdToPlainText, parseChapterFileName } from './services/markdown';
import { registerAgentTools } from './tools';
import { BookshelfProvider, type BookshelfItem } from './views/bookshelfProvider';
import { ChapterProvider, type ChapterVersionNode } from './views/chapterProvider';
import { EntryProvider, type EntryCategoryNode, type EntryNode, type EntryProviderOptions } from './views/entryProvider';
import { MetadataProvider } from './views/metadataProvider';
import { SummaryProvider } from './views/summaryProvider';

/** 本地时间戳 `YYYY-MM-DD HH:mm:ss`，用于 git 提交信息（此前用 toISOString 记的是 UTC 时间）。 */
function localTimestamp(): string {
	const now = new Date();
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function activate(context: vscode.ExtensionContext): void {
	const library = new LibraryService(context);
	// 视图图标同时用作各视图的树节点图标（默认活动栏分区布局不显示视图图标）
	const viewIcon = (name: string): vscode.Uri =>
		vscode.Uri.joinPath(context.extensionUri, 'resources', 'icons', name);
	const bookshelfProvider = new BookshelfProvider(library, viewIcon('book.svg'), viewIcon('bookshelf.svg'));
	const metadataProvider = new MetadataProvider(library, viewIcon('metadata.svg'));
	const chapterProvider = new ChapterProvider(
		library,
		viewIcon('volume.svg'),
		viewIcon('chapter.svg'),
		viewIcon('version.svg')
	);
	// 三个条目视图（世界书/角色卡/笔记）共用 EntryProvider，仅根目录、图标与条目菜单不同
	const categoryIcon = viewIcon('category.svg');
	const entryProviderOptions = (
		rootDir: string,
		entryIcon: vscode.Uri,
		entryContextValue = 'entry',
		openTitle = vscode.l10n.t('Open')
	): EntryProviderOptions => ({ rootDir, entryIcon, categoryIcon, entryContextValue, openTitle });
	const worldProvider = new EntryProvider(library, entryProviderOptions(WORLD_DIR, viewIcon('worldbook.svg')));
	const cardsProvider = new EntryProvider(library, entryProviderOptions(CARDS_DIR, viewIcon('characters.svg')));
	const summaryProvider = new SummaryProvider(
		library,
		viewIcon('summaries.svg'),
		viewIcon('volume.svg'),
		viewIcon('summary-chapter.svg'),
		viewIcon('summary-interval.svg')
	);
	const notesProvider = new EntryProvider(
		library,
		entryProviderOptions(NOTES_DIR, viewIcon('notes.svg'), 'note', vscode.l10n.t('Open Note'))
	);

	const bookshelfView = vscode.window.createTreeView('xReader.bookshelf', {
		treeDataProvider: bookshelfProvider,
	});
	// 书架选中即当前书：agent 工具（省略 book 参数）跟随书架选中；子书架节点不参与选中
	bookshelfView.onDidChangeSelection(
		(e) => {
			const book = e.selection[0];
			if (book && book.kind === 'book') {
				void library.setCurrentBook(book.dir);
			}
		},
		undefined,
		context.subscriptions
	);
	const chaptersView = vscode.window.createTreeView('xReader.chapters', {
		treeDataProvider: chapterProvider,
	});
	const metadataView = vscode.window.createTreeView('xReader.metadata', {
		treeDataProvider: metadataProvider,
	});
	const worldView = vscode.window.createTreeView('xReader.worldbook', {
		treeDataProvider: worldProvider,
	});
	const cardsView = vscode.window.createTreeView('xReader.characters', {
		treeDataProvider: cardsProvider,
	});
	const summariesView = vscode.window.createTreeView('xReader.summaries', {
		treeDataProvider: summaryProvider,
	});
	const notesView = vscode.window.createTreeView('xReader.notes', {
		treeDataProvider: notesProvider,
	});

	registerAgentTools(context, library);

	/** 状态栏：显示当前书与阅读进度，点击回到进度章节。 */
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	statusBar.command = 'xReader.openBook';
	statusBar.tooltip = vscode.l10n.t('Back to reading progress');

	const setContext = (key: string, value: boolean): void => {
		void vscode.commands.executeCommand('setContext', `xReader.${key}`, value);
	};

	/** 刷新视图空态 context（驱动 viewsWelcome）、视图标题（带当前书名）与状态栏进度。 */
	const updateViewStates = async (): Promise<void> => {
		const libraryPath = library.getLibraryPath();
		const book = library.getCurrentBook();
		setContext('noLibrary', !libraryPath);
		setContext('noBooks', Boolean(libraryPath) && !(await library.hasBooks()));
		setContext('noBook', !book);

		const titledViews: { view: { title?: string }; name: string }[] = [
			{ view: metadataView, name: vscode.l10n.t('Metadata') },
			{ view: chaptersView, name: vscode.l10n.t('Chapters') },
			{ view: summariesView, name: vscode.l10n.t('Summaries') },
			{ view: worldView, name: vscode.l10n.t('Worldbook') },
			{ view: cardsView, name: vscode.l10n.t('Characters') },
			{ view: notesView, name: vscode.l10n.t('Notes') },
		];
		for (const { view, name } of titledViews) {
			view.title = book ? `${name} · ${book.name}` : name;
		}

		if (!book) {
			setContext('emptyChapters', false);
			setContext('emptyMetadata', false);
			setContext('emptyWorld', false);
			setContext('emptyCards', false);
			setContext('emptyNotes', false);
			statusBar.hide();
			return;
		}
		/** 条目视图空态：既无条目也无分类（分类下可能还没有条目）。 */
		const isEmptySection = async (subDir: string): Promise<boolean> => {
			const [categories, entries] = await Promise.all([
				library.listChildCategories(book, subDir),
				library.listEntries(book, subDir),
			]);
			return categories.length === 0 && entries.length === 0;
		};
		const [chapters, meta, emptyWorld, emptyCards, emptyNotes] = await Promise.all([
			library.listChapters(book),
			library.readMetadata(book),
			isEmptySection(WORLD_DIR),
			isEmptySection(CARDS_DIR),
			isEmptySection(NOTES_DIR),
		]);
		setContext('emptyChapters', chapters.length === 0);
		setContext('emptyMetadata', !meta || (meta.fields.length === 0 && meta.sections.length === 0));
		setContext('emptyWorld', emptyWorld);
		setContext('emptyCards', emptyCards);
		setContext('emptyNotes', emptyNotes);

		const progress = library.getProgress(book.dir);
		const index = progress ? chapters.findIndex((c) => matchesProgress(c, progress)) : -1;
		statusBar.text =
			index >= 0 ? `${book.name} · ${index + 1}/${chapters.length}` : book.name;
		statusBar.show();
	};
	library.onDidChange(() => void updateViewStates());
	void updateViewStates();

	// 旧版本（globalStorage 只读副本）数据不迁移，提示一次后清除
	const legacy = context.globalState.get<unknown[]>('x-reader.books.v1');
	if (legacy && legacy.length > 0) {
		void vscode.window.showInformationMessage(
			vscode.l10n.t(
				'X Reader has been upgraded to a folder-based library. Old bookshelf data is incompatible; please re-import your novels.'
			)
		);
		void context.globalState.update('x-reader.books.v1', undefined);
	}

	/** 上次打开章节的文件路径，用于回收旧页签。 */
	let lastChapterPath: string | undefined;

	/** 当前章节页签的查看模式：渲染（预览编辑器）或并排动态预览，其余按源码处理。 */
	const chapterViewMode = (): 'rendered' | 'dynamic' | 'source' => {
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		if (input instanceof vscode.TabInputCustom) {
			return input.viewType === 'vscode.markdown.preview.editor' ? 'rendered' : 'source';
		}
		if (input instanceof vscode.TabInputWebview && input.viewType === 'markdown.preview') {
			return 'dynamic';
		}
		return 'source';
	};

	/** 关闭旧章节页签（除活动页签外），避免翻章累积新页签。 */
	const closeOldChapterTab = (oldPath: string | undefined): Promise<void> =>
		oldPath ? closeFileTabs(oldPath, true) : Promise.resolve();

	/** 按当前查看模式打开章节：复用当前页签（不新开），渲染/源码模式保持不变，并滚动到开头。 */
	const openChapter = async (
		bookDir: string,
		volumeDir: string | undefined,
		fileName: string,
		chapterHint?: ChapterFile
	): Promise<void> => {
		const dir = volumeDir
			? path.join(bookDir, CHAPTERS_DIR, volumeDir)
			: path.join(bookDir, CHAPTERS_DIR);
		const uri = vscode.Uri.file(path.join(dir, fileName));
		const mode = chapterViewMode();
		const oldPath = lastChapterPath;
		await vscode.window.showTextDocument(uri, {
			viewColumn: vscode.ViewColumn.Active,
			preview: true,
			selection: new vscode.Range(0, 0, 0, 0),
		});
		if (mode === 'rendered') {
			// 原地切换为渲染预览，保持渲染模式
			try {
				await vscode.commands.executeCommand('markdown.reopenAsPreview');
			} catch {
				// 旧版无预览编辑器时保持源码模式
			}
		} else if (mode === 'dynamic') {
			// 复用旁边的动态预览页签
			await vscode.commands.executeCommand('markdown.showPreviewToSide');
		}
		await closeOldChapterTab(oldPath);
		lastChapterPath = uri.fsPath;
		await library.setProgress(bookDir, chapterRelPath({ fileName, volumeDir }));
		await library.setCurrentBook(bookDir);
		const parsed = parseChapterFileName(fileName);
		// 侧边栏标题以内容首行 `# 标题` 为准，与目录展示一致；调用方已知章节时跳过重复扫描
		const target =
			chapterHint ??
			(await library.listChapters(bookAt(bookDir))).find((c) => sameChapter(c, { fileName, volumeDir }));
		void chaptersView
			.reveal(
				{ seq: parsed?.seq ?? 0, title: target?.title ?? parsed?.title ?? fileName, fileName, volumeDir },
				{ select: true, focus: false, expand: true }
			)
			.then(undefined, () => undefined);
	};

	/** 从当前章节（活动编辑器所在章节，或当前书进度）翻到相邻章，跨卷连续。 */
	const openNeighbor = async (offset: 1 | -1): Promise<void> => {
		const editorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
		const parsed = editorPath ? parseChapterFilePath(editorPath) : undefined;
		let bookDir = parsed?.bookDir;
		let currentFile = parsed?.fileName;
		let currentVolume = parsed?.volumeDir;
		if (!currentFile) {
			const book = library.getCurrentBook();
			const progress = book ? library.getProgress(book.dir) : undefined;
			if (!book || !progress) {
				return;
			}
			bookDir = book.dir;
			const found = await library.findChapterByProgress(book, progress);
			currentFile = found?.fileName;
			currentVolume = found?.volumeDir;
		}
		if (!bookDir || !currentFile) {
			return;
		}
		const book = bookAt(bookDir);
		const chapters = await library.listChapters(book);
		const index = chapters.findIndex(
			(c) => c.fileName === currentFile && (c.volumeDir ?? '') === (currentVolume ?? '')
		);
		const neighbor = chapters[index + offset];
		if (!neighbor) {
			void vscode.window.showInformationMessage(
				offset === 1 ? vscode.l10n.t('This is the last chapter') : vscode.l10n.t('This is the first chapter')
			);
			return;
		}
		await openChapter(bookDir, neighbor.volumeDir, neighbor.fileName, neighbor);
	};

	/** 选择分类（世界书/角色卡/笔记通用）：返回 '' 表示根目录，undefined 表示取消；可选已有分类或输入新分类路径。 */
	const pickCategory = async (book: BookInfo, subDir: string, title: string): Promise<string | undefined> => {
		const categories = await library.listCategories(book, subDir);
		const items: { label: string; value?: string }[] = [
			{ label: vscode.l10n.t('(root)'), value: '' },
			...categories.map((c) => ({ label: c.path, value: c.path })),
			{ label: vscode.l10n.t('New category…'), value: undefined },
		];
		const picked = await vscode.window.showQuickPick(items, {
			title,
			placeHolder: vscode.l10n.t('Category'),
		});
		if (!picked) {
			return undefined;
		}
		if (picked.value !== undefined) {
			return picked.value;
		}
		const input = await vscode.window.showInputBox({
			title,
			prompt: vscode.l10n.t('Category path (use / for sub-levels, e.g. Geography/City-States)'),
		});
		return input === undefined ? undefined : input.trim();
	};

	/** 在 世界书/角色卡 下新建条目并打开；categoryPath 给定（右键分类）时不再询问分类。 */
	const createEntry = async (
		book: BookInfo | undefined,
		subDir: string,
		kindLabel: string,
		categoryPath?: string
	): Promise<void> => {
		const target = book ?? library.getCurrentBook();
		if (!target) {
			return;
		}
		const title = vscode.l10n.t('New {0}', kindLabel);
		const name = await promptName(title, vscode.l10n.t('Entry name'));
		if (!name) {
			return;
		}
		// '' 表示条目根目录（不分类），undefined 表示用户取消
		const category = categoryPath ?? (await pickCategory(target, subDir, title));
		if (category === undefined) {
			return;
		}
		const filePath = await library.createEntry(target, subDir, name, category);
		await vscode.window.showTextDocument(vscode.Uri.file(filePath));
	};

	/** 新建笔记：名称 → 分类（可选）→ 关联章节（可选），然后创建并打开。 */
	const createNote = async (book: BookInfo | undefined, categoryPath?: string): Promise<void> => {
		const target = book ?? library.getCurrentBook();
		if (!target) {
			return;
		}
		const name = await promptName(vscode.l10n.t('New Note (1/3)'), vscode.l10n.t('Note name'));
		if (!name) {
			return;
		}
		// '' 表示条目根目录（不分类），undefined 表示用户取消
		const categoryDir = categoryPath ?? (await pickCategory(target, NOTES_DIR, vscode.l10n.t('New Note (2/3)')));
		if (categoryDir === undefined) {
			return;
		}
		const chapters = await library.listChapters(target);
		const items: ({ label: string; description?: string; chapter?: ChapterFile })[] = [
			{ label: vscode.l10n.t('(no linked chapter)') },
			...chapters.map((c) => ({ label: c.title, description: chapterRelPath(c), chapter: c })),
		];
		const picked = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t('New Note (3/3)'),
			placeHolder: vscode.l10n.t('Linked chapter'),
		});
		if (!picked) {
			return;
		}
		const filePath = await library.createNote(target, name, categoryDir, picked.chapter);
		await vscode.window.showTextDocument(vscode.Uri.file(filePath));
	};

	/** 由书文件夹路径构造 BookInfo（树项命令通常只带路径）。 */
	const bookAt = (dir: string): BookInfo => ({ name: path.basename(dir), dir });

	/** 条目命令参数：书架书名节点是 BookInfo；条目视图的分类节点则指向当前书 + 该分类路径。 */
	const entryTarget = (
		arg?: BookInfo | EntryCategoryNode
	): { book: BookInfo | undefined; categoryPath: string | undefined } =>
		arg && 'rootDir' in arg ? { book: undefined, categoryPath: arg.path } : { book: arg, categoryPath: undefined };

	/** 弹出书目选择框（QuickPick 自带关键词过滤，输入即搜索定位）；无书时提示并返回 undefined。 */
	const pickBook = async (title: string, placeHolder: string): Promise<BookInfo | undefined> => {
		const books = await library.listBooks();
		if (books.length === 0) {
			void vscode.window.showInformationMessage(vscode.l10n.t('The library is empty. Import or create a novel.'));
			return undefined;
		}
		const picked = await vscode.window.showQuickPick(
			books.map((book) => ({ label: book.name, book })),
			{ title, placeHolder }
		);
		return picked?.book;
	};

	/** 弹出名称输入框（value 为初始值）；取消或留空时返回 undefined。 */
	const promptName = async (title: string, prompt: string, value?: string): Promise<string | undefined> => {
		const name = await vscode.window.showInputBox({ title, prompt, value });
		return name?.trim() || undefined;
	};

	/** 弹出重命名输入框并执行；取消或留空时不动作。 */
	const renameWithInput = async (
		title: string,
		current: string,
		action: (name: string) => Promise<unknown>,
		prompt = vscode.l10n.t('New name')
	): Promise<void> => {
		const name = await promptName(title, prompt, current);
		if (name) {
			await action(name);
		}
	};

	/** 弹出 modal 删除确认；返回是否确认。 */
	const confirmDelete = async (message: string): Promise<boolean> => {
		const deleteLabel = vscode.l10n.t('Delete');
		const answer = await vscode.window.showWarningMessage(message, { modal: true }, deleteLabel);
		return answer === deleteLabel;
	};

	/** 执行写操作，返回是否成功；失败（重名、目标不存在等）时按 template 提示具体原因。 */
	const notifyFailure = async (template: string, action: () => Promise<unknown>): Promise<boolean> => {
		try {
			await action();
			return true;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			// 函数形式替换：错误信息里的 $& 等不被当作替换模式
			void vscode.window.showErrorMessage(template.replace('{0}', () => detail));
			return false;
		}
	};

	/** 执行新建类操作；失败（重名、目标不存在等）时提示具体原因。 */
	const createOrNotify = (action: () => Promise<unknown>): Promise<boolean> =>
		notifyFailure(vscode.l10n.t('Failed to create: {0}'), action);

	/** 条目/笔记的重命名处理器：树项传入同样的节点信息，仅弹窗标题不同。 */
	const renameEntryHandler =
		(title: string) =>
			async (arg?: EntryNode): Promise<void> => {
				if (!arg) {
					return;
				}
				await renameWithInput(title, arg.name, (name) =>
					library.renameEntry(bookAt(arg.bookDir), arg.subDir, arg.fileName, name)
				);
			};

	/** 条目/笔记换分类：目标为同一根目录下的其它分类，根目录即取消分类。 */
	const moveEntryHandler = async (arg?: EntryNode): Promise<void> => {
		const book = library.getCurrentBook();
		if (!book || !arg) {
			return;
		}
		const current = arg.subDir === arg.rootDir ? undefined : arg.subDir.slice(arg.rootDir.length + 1);
		const categories = await library.listCategories(book, arg.rootDir);
		const targets = [
			{ label: vscode.l10n.t('(root)'), target: undefined as string | undefined },
			...categories.map((category) => ({ label: category.path, target: category.path as string | undefined })),
		].filter((choice) => choice.target !== current);
		const pick = await vscode.window.showQuickPick(targets, {
			title: vscode.l10n.t('Move to Category'),
			placeHolder: vscode.l10n.t('Select target category'),
		});
		if (!pick) {
			return;
		}
		await notifyFailure(vscode.l10n.t('Move failed: {0}'), () =>
			library.moveEntry(book, arg.rootDir, current, arg.fileName, pick.target)
		);
	};

	/** 新建分类：三处条目视图的标题栏按钮（建在根目录）与分类节点右键（建为子分类）共用，名称支持多级路径。 */
	const createCategory = async (rootDir: string, parentPath?: string): Promise<void> => {
		const book = library.getCurrentBook();
		if (!book) {
			return;
		}
		const name = await promptName(
			parentPath ? vscode.l10n.t('New Sub-category') : vscode.l10n.t('New Category'),
			vscode.l10n.t('Category path (use / for sub-levels, e.g. Geography/City-States)')
		);
		if (!name) {
			return;
		}
		await createOrNotify(() => library.createCategory(book, rootDir, parentPath ? `${parentPath}/${name}` : name));
	};

	/** 朗读章节正文（无参数时回退到当前章节）；x-audio 缺失时引导安装。 */
	const speakChapter = async (
		mode: 'plain' | 'roles',
		chapterArg?: ChapterFile | string,
		volumeDir?: string,
		fileName?: string
	): Promise<void> => {
		const target = await resolveChapter(library, chapterArg, volumeDir, fileName);
		if (!target) {
			void vscode.window.showInformationMessage(
				vscode.l10n.t('Select a chapter in the chapters view or open a chapter file first')
			);
			return;
		}
		const content = await readChapterText(target.bookDir, target.chapter);
		if (!content) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Failed to read the chapter file'));
			return;
		}
		const text = mdToPlainText(content.text);
		if (text.length === 0) {
			void vscode.window.showWarningMessage(vscode.l10n.t('This chapter has no text to read'));
			return;
		}
		// 分角色朗读：从本书角色卡读取音色配置（无卡片带音色时回退到 x-audio 的目录查找）
		const voiceConfig = mode === 'roles' ? await readCharacterVoiceConfig(library, target.bookDir) : undefined;
		const ok = await speakViaAudio(text, mode, content.uri, voiceConfig);
		if (!ok) {
			await promptInstallAudio();
		}
	};

	context.subscriptions.push(
		bookshelfView,
		chaptersView,
		worldView,
		cardsView,
		summariesView,
		notesView,
		statusBar,
		vscode.commands.registerCommand('xReader.chooseLibraryPath', async () => {
			await library.ensureLibraryPath(true);
		}),
		vscode.commands.registerCommand('xReader.importBook', async () => {
			const picked = await vscode.window.showOpenDialog({
				title: vscode.l10n.t('Select novel txt files'),
				filters: { [vscode.l10n.t('Text files')]: ['txt'] },
				canSelectMany: true,
				canSelectFolders: false,
			});
			if (!picked || picked.length === 0) {
				return;
			}
			const imported: { book: BookInfo; chapterCount: number }[] = [];
			const failed: string[] = [];
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Importing novels…') },
				async (progress) => {
					for (let i = 0; i < picked.length; i++) {
						progress.report({
							message: `${i + 1}/${picked.length} ${path.basename(picked[i].fsPath)}`,
							increment: 100 / picked.length,
						});
						try {
							const result = await library.importBook(picked[i]);
							if (result) {
								imported.push(result);
							}
						} catch (error) {
							failed.push(
								`${path.basename(picked[i].fsPath)}：${error instanceof Error ? error.message : String(error)}`
							);
						}
					}
				}
			);
			if (failed.length > 0) {
				void vscode.window.showWarningMessage(
					vscode.l10n.t('Failed to import {0} books: {1}', failed.length, failed.join('；'))
				);
			}
			if (imported.length > 0) {
				await vscode.commands.executeCommand('xReader.openBook', imported[0].book.dir);
			}
		}),
		vscode.commands.registerCommand('xReader.newBook', async () => {
			const name = await promptName(vscode.l10n.t('New Novel'), vscode.l10n.t('Book name'));
			if (!name) {
				return;
			}
			await createOrNotify(async () => {
				const book = await library.createBook(name);
				await vscode.commands.executeCommand('xReader.openBook', book.dir);
			});
		}),
		vscode.commands.registerCommand('xReader.searchBook', async () => {
			const book = await pickBook(vscode.l10n.t('Search Books'), vscode.l10n.t('Type a book name to search'));
			if (book) {
				await vscode.commands.executeCommand('xReader.openBook', book);
			}
		}),
		vscode.commands.registerCommand('xReader.openBook', async (bookDir?: string | BookInfo) => {
			let dir = typeof bookDir === 'string' ? bookDir : (bookDir?.dir ?? library.getCurrentBook()?.dir);
			if (!dir) {
				dir = (await pickBook(vscode.l10n.t('Open Book'), vscode.l10n.t('Choose a book to open')))?.dir;
				if (!dir) {
					return;
				}
			}
			const book = bookAt(dir);
			const chapters = await library.listChapters(book);
			if (chapters.length === 0) {
				await library.setCurrentBook(dir);
				void vscode.window.showInformationMessage(
					vscode.l10n.t('This book has no chapters yet. Create one first.')
				);
				return;
			}
			const progress = library.getProgress(dir);
			const target = progress
				? (await library.findChapterByProgress(book, progress)) ?? chapters[0]
				: chapters[0];
			await openChapter(dir, target.volumeDir, target.fileName, target);
		}),
		vscode.commands.registerCommand('xReader.openChapter', async (bookDir?: string, volumeDir?: string, fileName?: string) => {
			if (!bookDir || !fileName) {
				return;
			}
			await openChapter(bookDir, volumeDir, fileName);
		}),
		vscode.commands.registerCommand('xReader.openEntry', async (bookDir?: string, subDir?: string, fileName?: string) => {
			if (!bookDir || !subDir || !fileName) {
				return;
			}
			await vscode.window.showTextDocument(vscode.Uri.file(path.join(bookDir, subDir, fileName)));
		}),
		vscode.commands.registerCommand('xReader.openMetadata', async (line?: number) => {
			const book = library.getCurrentBook();
			if (!book) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Select a book in the bookshelf first'));
				return;
			}
			const filePath = await library.ensureMetadata(book);
			if (!filePath) {
				void vscode.window.showWarningMessage(
					vscode.l10n.t('Metadata file is unavailable (the book folder may be gone)')
				);
				return;
			}
			const editor = await vscode.window.showTextDocument(vscode.Uri.file(filePath));
			if (line === undefined) {
				return;
			}
			const position = new vscode.Position(Math.min(line, Math.max(editor.document.lineCount - 1, 0)), 0);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
		}),
		vscode.commands.registerCommand('xReader.prevChapter', () => openNeighbor(-1)),
		vscode.commands.registerCommand('xReader.nextChapter', () => openNeighbor(1)),
		vscode.commands.registerCommand('xReader.exportBook', async () => {
			const book = await pickBook(vscode.l10n.t('Export Novel'), vscode.l10n.t('Choose a book to export'));
			if (!book) {
				return;
			}
			const target = await vscode.window.showSaveDialog({
				title: vscode.l10n.t('Export Novel'),
				defaultUri: vscode.Uri.file(path.join(path.dirname(book.dir), `${book.name}.txt`)),
				filters: { [vscode.l10n.t('Text files')]: ['txt'] },
			});
			if (!target) {
				return;
			}
			try {
				const text = await library.exportBookText(book);
				await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to export: {0}', detail));
				return;
			}
			void vscode.window.showInformationMessage(
				vscode.l10n.t('Exported “{0}” to {1}', book.name, target.fsPath)
			);
		}),
		vscode.commands.registerCommand('xReader.removeBook', async (book?: BookInfo) => {
			if (!book) {
				return;
			}
			if (await confirmDelete(vscode.l10n.t('Delete book “{0}”?', book.name))) {
				await library.removeBook(book);
			}
		}),
		vscode.commands.registerCommand('xReader.newShelf', async (node?: BookshelfItem) => {
			// 从子书架节点的右键菜单调用时，新子书架挂在该节点下（可多层嵌套）
			const parent = node && node.kind === 'shelf' && !node.isDefault ? node.name : undefined;
			const name = await promptName(
				vscode.l10n.t('New Sub-shelf'),
				vscode.l10n.t('Sub-shelf name (use “/” for multiple levels)')
			);
			if (!name) {
				return;
			}
			await createOrNotify(() => library.createShelf(parent ? `${parent}/${name}` : name));
		}),
		vscode.commands.registerCommand('xReader.renameShelf', async (node?: BookshelfItem) => {
			if (!node || node.kind !== 'shelf' || node.isDefault) {
				return;
			}
			await renameWithInput(
				vscode.l10n.t('Rename Sub-shelf'),
				shelfLeafName(node.name),
				(name) => library.renameShelf(node.name, name),
				vscode.l10n.t('Sub-shelf name')
			);
		}),
		vscode.commands.registerCommand('xReader.deleteShelf', async (node?: BookshelfItem) => {
			if (!node || node.kind !== 'shelf' || node.isDefault) {
				return;
			}
			const nested = (await library.listShelves()).filter((s) => s.name.startsWith(`${node.name}/`)).length;
			const message =
				nested > 0
					? vscode.l10n.t(
						'Delete sub-shelf “{0}” and its {1} nested sub-shelves? (Books will not be deleted)',
						node.name,
						nested
					)
					: vscode.l10n.t('Delete sub-shelf “{0}”? (Books will not be deleted)', node.name);
			if (await confirmDelete(message)) {
				await library.deleteShelf(node.name);
			}
		}),
		vscode.commands.registerCommand('xReader.addBookToShelf', async (book?: BookInfo) => {
			const target = book ?? library.getCurrentBook();
			if (!target) {
				return;
			}
			const shelves = await library.listShelves();
			const pick = await vscode.window.showQuickPick(
				[
					...shelves
						.filter((s) => !s.books.includes(target.name))
						.map((s) => ({
							label: shelfLeafName(s.name),
							description: shelfParentPath(s.name),
							shelfPath: s.name as string | undefined,
						})),
					{ label: vscode.l10n.t('New Sub-shelf…'), shelfPath: undefined },
				],
				{
					title: vscode.l10n.t('Add to Sub-shelf'),
					placeHolder: vscode.l10n.t('Choose a sub-shelf for “{0}”', target.name),
				}
			);
			if (!pick) {
				return;
			}
			if (pick.shelfPath) {
				await library.addBookToShelf(pick.shelfPath, target.name);
				return;
			}
			const name = await promptName(
				vscode.l10n.t('New Sub-shelf'),
				vscode.l10n.t('Sub-shelf name (use “/” for multiple levels)')
			);
			if (!name) {
				return;
			}
			await createOrNotify(async () => library.addBookToShelf(await library.createShelf(name), target.name));
		}),
		vscode.commands.registerCommand('xReader.addShelfBook', async (node?: BookshelfItem) => {
			if (!node || node.kind !== 'shelf' || node.isDefault) {
				return;
			}
			const shelf = (await library.listShelves()).find((s) => s.name === node.name);
			const books = (await library.listBooks()).filter((b) => !shelf?.books.includes(b.name));
			if (books.length === 0) {
				void vscode.window.showInformationMessage(vscode.l10n.t('All books are already in this sub-shelf'));
				return;
			}
			const pick = await vscode.window.showQuickPick(
				books.map((b) => ({ label: b.name, book: b })),
				{
					title: vscode.l10n.t('Add Book to Sub-shelf'),
					placeHolder: vscode.l10n.t('Choose a book to add'),
				}
			);
			if (pick) {
				await library.addBookToShelf(node.name, pick.book.name);
			}
		}),
		vscode.commands.registerCommand('xReader.removeBookFromShelf', async (node?: BookshelfItem) => {
			if (!node || node.kind !== 'book' || node.isDefaultShelf) {
				return;
			}
			if (await confirmDelete(vscode.l10n.t('Remove “{0}” from sub-shelf “{1}”?', node.name, node.shelfName))) {
				await library.removeBookFromShelf(node.shelfName, node.name);
			}
		}),
		// 世界书/角色卡/笔记三处的「新建条目」：书架书名节点传 BookInfo，分类节点传分类路径
		vscode.commands.registerCommand('xReader.newCharacterCard', (arg?: BookInfo | EntryCategoryNode) => {
			const { book, categoryPath } = entryTarget(arg);
			return createEntry(book, CARDS_DIR, vscode.l10n.t('Character Card'), categoryPath);
		}),
		vscode.commands.registerCommand('xReader.newWorldEntry', (arg?: BookInfo | EntryCategoryNode) => {
			const { book, categoryPath } = entryTarget(arg);
			return createEntry(book, WORLD_DIR, vscode.l10n.t('World Entry'), categoryPath);
		}),
		vscode.commands.registerCommand('xReader.newNote', (arg?: BookInfo | EntryCategoryNode) => {
			const { book, categoryPath } = entryTarget(arg);
			return createNote(book, categoryPath);
		}),
		vscode.commands.registerCommand('xReader.deleteChapter', async (chapter?: ChapterFile) => {
			const book = library.getCurrentBook();
			if (!book || !chapter) {
				return;
			}
			if (await confirmDelete(vscode.l10n.t('Delete chapter “{0}”?', chapter.title))) {
				await library.removeChapter(book, chapter);
			}
		}),
		vscode.commands.registerCommand('xReader.newChapterVersion', async (chapter?: ChapterFile) => {
			const book = library.getCurrentBook();
			if (!book || !chapter) {
				return;
			}
			const versions = await library.listChapterVersions(book, chapter);
			const name = await promptName(
				vscode.l10n.t('New Version'),
				vscode.l10n.t('Version name'),
				vscode.l10n.t('Version {0}', versions.length + 1)
			);
			if (!name) {
				return;
			}
			await createOrNotify(async () => {
				const filePath = await library.createChapterVersion(book, chapter, name);
				await vscode.window.showTextDocument(vscode.Uri.file(filePath));
			});
		}),
		vscode.commands.registerCommand('xReader.openChapterVersion', async (node?: ChapterVersionNode) => {
			const book = library.getCurrentBook();
			if (!book || !node) {
				return;
			}
			await vscode.window.showTextDocument(
				vscode.Uri.file(library.chapterVersionPath(book, node.chapter, node.name))
			);
		}),
		vscode.commands.registerCommand('xReader.setPrimaryChapterVersion', async (node?: ChapterVersionNode) => {
			const book = library.getCurrentBook();
			if (!book || !node) {
				return;
			}
			const message = vscode.l10n.t(
				'Set “{0}” as the primary version of chapter “{1}”? The current primary version will be kept as version “{2}”.',
				node.name,
				node.chapter.title,
				PRIMARY_KEEP_VERSION_NAME
			);
			const answer = await vscode.window.showInformationMessage(message, { modal: true }, vscode.l10n.t('Switch'));
			if (answer !== vscode.l10n.t('Switch')) {
				return;
			}
			await library.promoteChapterVersion(book, node.chapter, node.name);
			await openChapter(book.dir, node.chapter.volumeDir, node.chapter.fileName, node.chapter);
		}),
		vscode.commands.registerCommand('xReader.renameChapterVersion', async (node?: ChapterVersionNode) => {
			const book = library.getCurrentBook();
			if (!book || !node) {
				return;
			}
			await renameWithInput(
				vscode.l10n.t('Rename Version'),
				node.name,
				(name) => library.renameChapterVersion(book, node.chapter, node.name, name),
				vscode.l10n.t('Version name')
			);
		}),
		vscode.commands.registerCommand('xReader.deleteChapterVersion', async (node?: ChapterVersionNode) => {
			const book = library.getCurrentBook();
			if (!book || !node) {
				return;
			}
			if (await confirmDelete(vscode.l10n.t('Delete version “{0}” of chapter “{1}”?', node.name, node.chapter.title))) {
				await library.deleteChapterVersion(book, node.chapter, node.name);
			}
		}),
		vscode.commands.registerCommand('xReader.renameChapter', async (chapter?: ChapterFile) => {
			const book = library.getCurrentBook();
			if (!book || !chapter) {
				return;
			}
			await renameWithInput(
				vscode.l10n.t('Rename Chapter'),
				chapter.title,
				async (title) => {
					const newFileName = await library.renameChapter(book, chapter, title);
					await openChapter(book.dir, chapter.volumeDir, newFileName);
				},
				vscode.l10n.t('New title')
			);
		}),
		vscode.commands.registerCommand('xReader.moveChapter', async (chapter?: ChapterFile) => {
			const book = library.getCurrentBook();
			if (!book || !chapter) {
				return;
			}
			const volumes = await library.listVolumes(book);
			const targets = [
				{ label: vscode.l10n.t('(root)'), target: undefined as string | undefined },
				...volumes.filter((v) => v.dirName).map((v) => ({ label: v.name, target: v.dirName as string | undefined })),
			].filter((c) => c.target !== chapter.volumeDir);
			const pick = await vscode.window.showQuickPick(targets, {
				title: vscode.l10n.t('Move Chapter to Volume'),
				placeHolder: vscode.l10n.t('Select target volume'),
			});
			if (!pick) {
				return;
			}
			// 移动失败（如目标卷已有同名章节）时保持原状，不再跳转
			const moved = await notifyFailure(vscode.l10n.t('Move failed: {0}'), () =>
				library.moveChapter(book, chapter, pick.target)
			);
			if (moved) {
				await openChapter(book.dir, pick.target, chapter.fileName);
			}
		}),
		vscode.commands.registerCommand('xReader.renameBook', async (book?: BookInfo) => {
			if (!book) {
				return;
			}
			await renameWithInput(vscode.l10n.t('Rename Book'), book.name, (name) => library.renameBook(book, name));
		}),
		vscode.commands.registerCommand(
			'xReader.renameEntry',
			renameEntryHandler(vscode.l10n.t('Rename Entry'))
		),
		vscode.commands.registerCommand(
			'xReader.renameNote',
			renameEntryHandler(vscode.l10n.t('Rename Note'))
		),
		vscode.commands.registerCommand('xReader.moveEntry', moveEntryHandler),
		vscode.commands.registerCommand('xReader.newVolume', async () => {
			const book = library.getCurrentBook();
			if (!book) {
				return;
			}
			const name = await promptName(vscode.l10n.t('New Volume'), vscode.l10n.t('Volume name'));
			if (!name) {
				return;
			}
			await library.createVolume(book, name);
		}),
		vscode.commands.registerCommand('xReader.newChapter', async (volume?: ChapterVolume | string) => {
			const book = library.getCurrentBook();
			if (!book) {
				return;
			}
			// 右键分卷传入对象/字符串；标题栏或命令面板触发时跟随章节视图选中的分卷
			let volumeDir = typeof volume === 'string' ? volume : volume?.dirName;
			if (volumeDir === undefined) {
				const selected = chaptersView.selection[0];
				if (selected && 'chapters' in selected) {
					volumeDir = selected.dirName;
				}
			}
			const title = await promptName(vscode.l10n.t('New Chapter'), vscode.l10n.t('Chapter title'));
			if (!title) {
				return;
			}
			const fileName = await library.createChapter(book, title, volumeDir);
			await openChapter(book.dir, volumeDir, fileName);
		}),
		vscode.commands.registerCommand('xReader.renameVolume', async (volume?: ChapterVolume) => {
			const book = library.getCurrentBook();
			if (!book || !volume?.dirName) {
				return;
			}
			const dirName = volume.dirName;
			await renameWithInput(vscode.l10n.t('Rename Volume'), volume.name, (name) =>
				library.renameVolume(book, dirName, name)
			);
		}),
		vscode.commands.registerCommand('xReader.deleteVolume', async (volume?: ChapterVolume) => {
			const book = library.getCurrentBook();
			if (!book || !volume?.dirName) {
				return;
			}
			const count = volume.chapters.length;
			if (
				await confirmDelete(
					count > 0
						? vscode.l10n.t('Delete volume “{0}” and its {1} chapters?', volume.name, count)
						: vscode.l10n.t('Delete volume “{0}”?', volume.name)
				)
			) {
				await library.deleteVolume(book, volume.dirName, count > 0);
			}
		}),
		vscode.commands.registerCommand(
			'xReader.deleteChapterSummary',
			async (bookDir?: string, volumeDir?: string, fileName?: string) => {
				if (!bookDir || !fileName) {
					return;
				}
				if (await confirmDelete(vscode.l10n.t('Delete chapter summary “{0}”?', fileName))) {
					await library.removeEntry(
						bookAt(bookDir),
						volumeDir ? `${CHAPTER_SUMMARIES_DIR}/${volumeDir}` : CHAPTER_SUMMARIES_DIR,
						fileName
					);
				}
			}
		),
		vscode.commands.registerCommand('xReader.deleteIntervalSummary', async (bookDir?: string, fileName?: string) => {
			if (!bookDir || !fileName) {
				return;
			}
			if (await confirmDelete(vscode.l10n.t('Delete interval summary “{0}”?', fileName))) {
				await library.removeEntry(bookAt(bookDir), INTERVAL_SUMMARIES_DIR, fileName);
			}
		}),
		// 分类操作：世界书/角色卡/笔记 三处共用（节点自带 rootDir）；标题栏按钮各自传根目录
		vscode.commands.registerCommand('xReader.newCategory', async (node?: EntryCategoryNode) => {
			if (node) {
				await createCategory(node.rootDir, node.path);
			}
		}),
		vscode.commands.registerCommand('xReader.newWorldCategory', () => createCategory(WORLD_DIR)),
		vscode.commands.registerCommand('xReader.newCharacterCategory', () => createCategory(CARDS_DIR)),
		vscode.commands.registerCommand('xReader.newNoteCategory', () => createCategory(NOTES_DIR)),
		vscode.commands.registerCommand('xReader.renameCategory', async (node?: EntryCategoryNode) => {
			const book = library.getCurrentBook();
			if (!book || !node) {
				return;
			}
			await renameWithInput(
				vscode.l10n.t('Rename Category'),
				node.name,
				(name) => library.renameCategory(book, node.rootDir, node.path, name),
				vscode.l10n.t('Category name')
			);
		}),
		vscode.commands.registerCommand('xReader.deleteCategory', async (node?: EntryCategoryNode) => {
			const book = library.getCurrentBook();
			if (!book || !node) {
				return;
			}
			if (await confirmDelete(vscode.l10n.t('Delete category “{0}” and all its entries?', node.path))) {
				await library.deleteCategory(book, node.rootDir, node.path);
			}
		}),
		vscode.commands.registerCommand(
			'xReader.deleteEntry',
			async (arg?: EntryNode) => {
				if (!arg) {
					return;
				}
				if (await confirmDelete(vscode.l10n.t('Delete entry “{0}”?', arg.name))) {
					await library.removeEntry(bookAt(arg.bookDir), arg.subDir, arg.fileName);
				}
			}
		),
		vscode.commands.registerCommand(
			'xReader.openChapterSummary',
			async (bookDir?: string, volumeDir?: string, fileName?: string) => {
				if (!bookDir || !fileName) {
					return;
				}
				const parsed = parseChapterFileName(fileName);
				const chapter: ChapterFile = {
					seq: parsed?.seq ?? 0,
					title: parsed?.title ?? fileName,
					fileName,
					volumeDir,
				};
				const filePath = await library.ensureChapterSummary(bookAt(bookDir), chapter);
				await vscode.window.showTextDocument(vscode.Uri.file(filePath));
			}
		),
		vscode.commands.registerCommand(
			'xReader.openIntervalSummary',
			async (bookDir?: string, interval?: IntervalSummary) => {
				if (!bookDir || !interval) {
					return;
				}
				const filePath = await library.ensureIntervalSummary(bookAt(bookDir), interval);
				await vscode.window.showTextDocument(vscode.Uri.file(filePath));
			}
		),
		vscode.commands.registerCommand('xReader.snapshot', async () => {
			const root = library.getLibraryPath();
			if (!root) {
				return;
			}
			const book = library.getCurrentBook();
			if (!book) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Select a book in the bookshelf first'));
				return;
			}
			const ok = await commitAll(root, `快照《${book.name}》 ${localTimestamp()}`, [
				path.relative(root, book.dir),
			]);
			void vscode.window.showInformationMessage(
				ok
					? vscode.l10n.t('Snapshot saved')
					: vscode.l10n.t('No changes to commit (or git unavailable)')
			);
		}),
		vscode.commands.registerCommand('xReader.resetHistory', async () => {
			const root = library.getLibraryPath();
			if (!root) {
				return;
			}
			const clearLabel = vscode.l10n.t('Clear Git History');
			const answer = await vscode.window.showWarningMessage(
				vscode.l10n.t('Clear all git history of the library and start over from the current files?'),
				{ modal: true },
				clearLabel
			);
			if (answer !== clearLabel) {
				return;
			}
			// 大书库重建要重新入库全部文件（100MB 级别可达数十秒），用通知进度提示避免看起来卡死
			const result = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: vscode.l10n.t('Clearing git history and rebuilding from current files…'),
					cancellable: false,
				},
				() => resetHistory(root, `重建仓库 ${localTimestamp()}`)
			);
			if (result.ok) {
				void vscode.window.showInformationMessage(
					vscode.l10n.t('Git history cleared; a fresh commit was created from the current state')
				);
				return;
			}
			// 按具体原因提示，避免把「位于其他仓库内部」与「git 命令失败」混为一谈
			const message =
				result.reason === 'nested-repo'
					? vscode.l10n.t(
						'Clear Git history failed: the library folder is inside another repository, so its history belongs to that repository.'
					)
					: result.reason === 'gitnotdir'
						? vscode.l10n.t(
							'Clear Git history failed: the library .git is not a directory (it may be a worktree or submodule).'
						)
						: vscode.l10n.t('Clear Git history failed: {0}', result.detail);
			void vscode.window.showWarningMessage(message);
		}),
		vscode.commands.registerCommand(
			'xReader.speakChapter',
			async (chapterArg?: ChapterFile | string, volumeDir?: string, fileName?: string) => {
				await speakChapter('plain', chapterArg, volumeDir, fileName);
			}
		),
		vscode.commands.registerCommand(
			'xReader.speakChapterWithRoles',
			async (chapterArg?: ChapterFile | string, volumeDir?: string, fileName?: string) => {
				await speakChapter('roles', chapterArg, volumeDir, fileName);
			}
		),
		vscode.commands.registerCommand('xReader.speakSelection', async () => {
			const editor = vscode.window.activeTextEditor;
			const selection = editor?.document.getText(editor.selection) ?? '';
			if (selection.trim().length === 0) {
				void vscode.window.showWarningMessage(vscode.l10n.t('Select some text to read aloud first'));
				return;
			}
			const ok = await speakViaAudio(mdToPlainText(selection), 'plain', editor?.document.uri);
			if (!ok) {
				await promptInstallAudio();
			}
		})
	);
}

export function deactivate(): void { }
