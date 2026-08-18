import * as path from 'path';
import * as vscode from 'vscode';
import type { BookInfo, ChapterFile, ChapterVolume, IntervalSummary, NoteCategory } from './model/book';
import { commitAll } from './services/git';
import {
	CARDS_DIR,
	CHAPTER_SUMMARIES_DIR,
	chapterRelPath,
	CHAPTERS_DIR,
	closeFileTabs,
	INTERVAL_SUMMARIES_DIR,
	LibraryService,
	WORLD_DIR,
} from './services/library';
import { parseChapterFileName } from './services/markdown';
import { registerAgentTools } from './tools';
import { BookshelfProvider } from './views/bookshelfProvider';
import { ChapterProvider } from './views/chapterProvider';
import { EntryProvider } from './views/entryProvider';
import { NoteProvider } from './views/noteProvider';
import { SummaryProvider } from './views/summaryProvider';

export function activate(context: vscode.ExtensionContext): void {
	const library = new LibraryService(context);
	// 视图图标同时用作各视图的树节点图标（默认活动栏分区布局不显示视图图标）
	const viewIcon = (name: string): vscode.Uri =>
		vscode.Uri.joinPath(context.extensionUri, 'resources', 'icons', name);
	const bookshelfProvider = new BookshelfProvider(library, viewIcon('bookshelf.svg'));
	const chapterProvider = new ChapterProvider(library, viewIcon('volume.svg'), viewIcon('chapter.svg'));
	const worldProvider = new EntryProvider(library, WORLD_DIR, viewIcon('worldbook.svg'));
	const cardsProvider = new EntryProvider(library, CARDS_DIR, viewIcon('characters.svg'));
	const summaryProvider = new SummaryProvider(
		library,
		viewIcon('summaries.svg'),
		viewIcon('volume.svg'),
		viewIcon('summary-chapter.svg'),
		viewIcon('summary-interval.svg')
	);
	const noteProvider = new NoteProvider(library, viewIcon('notes.svg'), viewIcon('note-category.svg'));

	const bookshelfView = vscode.window.createTreeView('xReader.bookshelf', {
		treeDataProvider: bookshelfProvider,
	});
	// 书架选中即当前书：agent 工具（省略 book 参数）跟随书架选中
	bookshelfView.onDidChangeSelection(
		(e) => {
			const book = e.selection[0];
			if (book) {
				void library.setCurrentBook(book.dir);
			}
		},
		undefined,
		context.subscriptions
	);
	const chaptersView = vscode.window.createTreeView('xReader.chapters', {
		treeDataProvider: chapterProvider,
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
		treeDataProvider: noteProvider,
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
		setContext('noBooks', Boolean(libraryPath) && (await library.listBooks()).length === 0);
		setContext('noBook', !book);

		const titledViews: { view: { title?: string }; name: string }[] = [
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
			setContext('emptyWorld', false);
			setContext('emptyCards', false);
			setContext('emptyNotes', false);
			statusBar.hide();
			return;
		}
		const [chapters, world, cards, noteCategories, rootNotes] = await Promise.all([
			library.listChapters(book),
			library.listEntries(book, WORLD_DIR),
			library.listEntries(book, CARDS_DIR),
			library.listNoteCategories(book),
			library.listNotes(book),
		]);
		setContext('emptyChapters', chapters.length === 0);
		setContext('emptyWorld', world.length === 0);
		setContext('emptyCards', cards.length === 0);
		setContext('emptyNotes', noteCategories.length === 0 && rootNotes.length === 0);

		const progress = library.getProgress(book.dir);
		const index = progress
			? chapters.findIndex((c) => chapterRelPath(c) === progress || c.fileName === progress)
			: -1;
		statusBar.text =
			index >= 0 ? `$(book) ${book.name} · ${index + 1}/${chapters.length}` : `$(book) ${book.name}`;
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
			(await library.listChapters({ name: path.basename(bookDir), dir: bookDir })).find(
				(c) => chapterRelPath(c) === chapterRelPath({ fileName, volumeDir })
			);
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
		let bookDir: string | undefined;
		let currentFile: string | undefined;
		let currentVolume: string | undefined;
		if (editorPath && path.extname(editorPath) === '.md') {
			const segments = editorPath.split(path.sep);
			// 取最后一个「章节」段：库路径本身含同名目录时不误判
			const chapterIdx = segments.lastIndexOf(CHAPTERS_DIR);
			if (chapterIdx >= 0 && (chapterIdx === segments.length - 2 || chapterIdx === segments.length - 3)) {
				bookDir = segments.slice(0, chapterIdx).join(path.sep);
				currentFile = segments[segments.length - 1];
				currentVolume = chapterIdx === segments.length - 3 ? segments[chapterIdx + 1] : undefined;
			}
		}
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
		const book: BookInfo = { name: path.basename(bookDir), dir: bookDir };
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

	/** 在当前书（或指定书）的 世界书/角色卡 下新建条目并打开。 */
	const createEntry = async (book: BookInfo | undefined, subDir: string, kindLabel: string): Promise<void> => {
		const target = book ?? library.getCurrentBook();
		if (!target) {
			return;
		}
		const name = await vscode.window.showInputBox({
			title: vscode.l10n.t('New {0}', kindLabel),
			prompt: vscode.l10n.t('Entry name'),
		});
		if (!name?.trim()) {
			return;
		}
		const filePath = await library.createEntry(target, subDir, name.trim());
		await vscode.window.showTextDocument(vscode.Uri.file(filePath));
	};

	/** 新建笔记：名称 → 分类（可选）→ 关联章节（可选），然后创建并打开。 */
	const createNote = async (book: BookInfo | undefined): Promise<void> => {
		const target = book ?? library.getCurrentBook();
		if (!target) {
			return;
		}
		const name = await vscode.window.showInputBox({
			title: vscode.l10n.t('New Note (1/3)'),
			prompt: vscode.l10n.t('Note name'),
		});
		if (!name?.trim()) {
			return;
		}
		const categories = await library.listNoteCategories(target);
		const categoryPicked = await vscode.window.showQuickPick(
			[
				{ label: vscode.l10n.t('(no category)'), dirName: '' },
				...categories.map((c) => ({ label: c.name, dirName: c.dirName })),
				{ label: vscode.l10n.t('$(add) New category…'), dirName: undefined },
			],
			{ title: vscode.l10n.t('New Note (2/3)'), placeHolder: vscode.l10n.t('Category') }
		);
		if (!categoryPicked) {
			return;
		}
		let categoryDir = categoryPicked.dirName;
		if (categoryDir === undefined) {
			const input = await vscode.window.showInputBox({
				title: vscode.l10n.t('New Note (2/3)'),
				prompt: vscode.l10n.t('Category'),
			});
			if (input === undefined) {
				return;
			}
			categoryDir = input.trim();
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
		const filePath = await library.createNote(target, name.trim(), categoryDir || undefined, picked.chapter);
		await vscode.window.showTextDocument(vscode.Uri.file(filePath));
	};

	/** 弹出重命名输入框并执行；取消或留空时不动作。 */
	const renameWithInput = async (
		title: string,
		current: string,
		action: (name: string) => Promise<unknown>
	): Promise<void> => {
		const name = await vscode.window.showInputBox({ title, value: current, prompt: vscode.l10n.t('New name') });
		if (!name?.trim()) {
			return;
		}
		await action(name.trim());
	};

	/** 弹出 modal 删除确认；返回是否确认。 */
	const confirmDelete = async (message: string): Promise<boolean> => {
		const deleteLabel = vscode.l10n.t('Delete');
		const answer = await vscode.window.showWarningMessage(message, { modal: true }, deleteLabel);
		return answer === deleteLabel;
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
			const name = await vscode.window.showInputBox({
				title: vscode.l10n.t('New Novel'),
				prompt: vscode.l10n.t('Book name'),
			});
			if (!name?.trim()) {
				return;
			}
			try {
				const book = await library.createBook(name.trim());
				await vscode.commands.executeCommand('xReader.openBook', book.dir);
			} catch (error) {
				void vscode.window.showErrorMessage(
					vscode.l10n.t('Failed to create: {0}', error instanceof Error ? error.message : String(error))
				);
			}
		}),
		vscode.commands.registerCommand('xReader.openBook', async (bookDir?: string | BookInfo) => {
			let dir = typeof bookDir === 'string' ? bookDir : (bookDir?.dir ?? library.getCurrentBook()?.dir);
			if (!dir) {
				const books = await library.listBooks();
				if (books.length === 0) {
					void vscode.window.showInformationMessage(
						vscode.l10n.t('The library is empty. Import or create a novel.')
					);
					return;
				}
				const picked = await vscode.window.showQuickPick(
					books.map((b) => ({ label: b.name, book: b })),
					{
						title: vscode.l10n.t('Open Book'),
						placeHolder: vscode.l10n.t('Choose a book to open'),
					}
				);
				if (!picked) {
					return;
				}
				dir = picked.book.dir;
			}
			const book: BookInfo = { name: path.basename(dir), dir };
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
		vscode.commands.registerCommand('xReader.prevChapter', () => openNeighbor(-1)),
		vscode.commands.registerCommand('xReader.nextChapter', () => openNeighbor(1)),
		vscode.commands.registerCommand('xReader.removeBook', async (book?: BookInfo) => {
			if (!book) {
				return;
			}
			if (await confirmDelete(vscode.l10n.t('Delete book “{0}”?', book.name))) {
				await library.removeBook(book);
			}
		}),
		vscode.commands.registerCommand('xReader.newCharacterCard', (book?: BookInfo) =>
			createEntry(book, CARDS_DIR, vscode.l10n.t('Character Card'))
		),
		vscode.commands.registerCommand('xReader.newWorldEntry', (book?: BookInfo) =>
			createEntry(book, WORLD_DIR, vscode.l10n.t('World Entry'))
		),
		vscode.commands.registerCommand('xReader.newNote', (book?: BookInfo) => createNote(book)),
		vscode.commands.registerCommand('xReader.deleteChapter', async (chapter?: ChapterFile) => {
			const book = library.getCurrentBook();
			if (!book || !chapter) {
				return;
			}
			if (await confirmDelete(vscode.l10n.t('Delete chapter “{0}”?', chapter.title))) {
				await library.removeChapter(book, chapter);
			}
		}),
		vscode.commands.registerCommand('xReader.renameChapter', async (chapter?: ChapterFile) => {
			const book = library.getCurrentBook();
			if (!book || !chapter) {
				return;
			}
			const title = await vscode.window.showInputBox({
				title: vscode.l10n.t('Rename Chapter'),
				prompt: vscode.l10n.t('New title'),
				value: chapter.title,
			});
			if (!title?.trim()) {
				return;
			}
			const newFileName = await library.renameChapter(book, chapter, title.trim());
			await openChapter(book.dir, chapter.volumeDir, newFileName);
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
			await library.moveChapter(book, chapter, pick.target);
			await openChapter(book.dir, pick.target, chapter.fileName);
		}),
		vscode.commands.registerCommand('xReader.renameBook', async (book?: BookInfo) => {
			if (!book) {
				return;
			}
			await renameWithInput(vscode.l10n.t('Rename Book'), book.name, (name) => library.renameBook(book, name));
		}),
		vscode.commands.registerCommand(
			'xReader.renameEntry',
			async (arg?: { bookDir: string; subDir: string; fileName: string; name: string }) => {
				if (!arg) {
					return;
				}
				const book = { name: path.basename(arg.bookDir), dir: arg.bookDir };
				await renameWithInput(vscode.l10n.t('Rename Entry'), arg.name, (name) =>
					library.renameEntry(book, arg.subDir, arg.fileName, name)
				);
			}
		),
		vscode.commands.registerCommand(
			'xReader.renameNote',
			async (arg?: { bookDir: string; subDir: string; fileName: string; name: string }) => {
				if (!arg) {
					return;
				}
				const book = { name: path.basename(arg.bookDir), dir: arg.bookDir };
				await renameWithInput(vscode.l10n.t('Rename Note'), arg.name, (name) =>
					library.renameEntry(book, arg.subDir, arg.fileName, name)
				);
			}
		),
		vscode.commands.registerCommand('xReader.newVolume', async () => {
			const book = library.getCurrentBook();
			if (!book) {
				return;
			}
			const name = await vscode.window.showInputBox({
				title: vscode.l10n.t('New Volume'),
				prompt: vscode.l10n.t('Volume name'),
			});
			if (!name?.trim()) {
				return;
			}
			await library.createVolume(book, name.trim());
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
			const title = await vscode.window.showInputBox({
				title: vscode.l10n.t('New Chapter'),
				prompt: vscode.l10n.t('Chapter title'),
			});
			if (!title?.trim()) {
				return;
			}
			const fileName = await library.createChapter(book, title.trim(), volumeDir);
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
						{ name: path.basename(bookDir), dir: bookDir },
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
				await library.removeEntry({ name: path.basename(bookDir), dir: bookDir }, INTERVAL_SUMMARIES_DIR, fileName);
			}
		}),
		vscode.commands.registerCommand('xReader.renameNoteCategory', async (category?: NoteCategory) => {
			const book = library.getCurrentBook();
			if (!book || !category) {
				return;
			}
			await renameWithInput(vscode.l10n.t('Rename Note Category'), category.name, (name) =>
				library.renameNoteCategory(book, category.dirName, name)
			);
		}),
		vscode.commands.registerCommand('xReader.deleteNoteCategory', async (category?: NoteCategory) => {
			const book = library.getCurrentBook();
			if (!book || !category) {
				return;
			}
			if (await confirmDelete(vscode.l10n.t('Delete note category “{0}” and all its notes?', category.name))) {
				await library.deleteNoteCategory(book, category.dirName);
			}
		}),
		vscode.commands.registerCommand(
			'xReader.deleteEntry',
			async (arg?: { bookDir: string; subDir: string; fileName: string; name: string }) => {
				if (!arg) {
					return;
				}
				if (await confirmDelete(vscode.l10n.t('Delete entry “{0}”?', arg.name))) {
					await library.removeEntry(
						{ name: path.basename(arg.bookDir), dir: arg.bookDir },
						arg.subDir,
						arg.fileName
					);
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
				const filePath = await library.ensureChapterSummary({ name: path.basename(bookDir), dir: bookDir }, chapter);
				await vscode.window.showTextDocument(vscode.Uri.file(filePath));
			}
		),
		vscode.commands.registerCommand(
			'xReader.openIntervalSummary',
			async (bookDir?: string, interval?: IntervalSummary) => {
				if (!bookDir || !interval) {
					return;
				}
				const filePath = await library.ensureIntervalSummary(
					{ name: path.basename(bookDir), dir: bookDir },
					interval
				);
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
			const ok = await commitAll(
				root,
				`快照《${book.name}》 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
				[path.relative(root, book.dir)]
			);
			void vscode.window.showInformationMessage(
				ok
					? vscode.l10n.t('Snapshot saved')
					: vscode.l10n.t('No changes to commit (or git unavailable)')
			);
		}),
		vscode.commands.registerCommand('xReader.refreshBookshelf', () => {
			bookshelfProvider.refresh();
		})
	);
}

export function deactivate(): void { }
