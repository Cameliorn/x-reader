import * as path from 'path';
import * as vscode from 'vscode';
import type { BookInfo, ChapterFile, IntervalSummary } from './model/book';
import { commitAll } from './services/git';
import { CARDS_DIR, chapterRelPath, CHAPTERS_DIR, LibraryService, WORLD_DIR } from './services/library';
import { parseChapterFileName } from './services/markdown';
import { registerAgentTools } from './tools';
import { BookshelfProvider } from './views/bookshelfProvider';
import { ChapterProvider } from './views/chapterProvider';
import { ChapterSummaryProvider } from './views/chapterSummaryProvider';
import { EntryProvider } from './views/entryProvider';
import { IntervalSummaryProvider } from './views/intervalSummaryProvider';
import { NoteProvider } from './views/noteProvider';

export function activate(context: vscode.ExtensionContext): void {
	const library = new LibraryService(context);
	const bookshelfProvider = new BookshelfProvider(library);
	const chapterProvider = new ChapterProvider(library);
	const worldProvider = new EntryProvider(library, WORLD_DIR, 'globe');
	const cardsProvider = new EntryProvider(library, CARDS_DIR, 'person');
	const chapterSummaryProvider = new ChapterSummaryProvider(library);
	const intervalSummaryProvider = new IntervalSummaryProvider(library);
	const noteProvider = new NoteProvider(library);

	const bookshelfView = vscode.window.createTreeView('xReader.bookshelf', {
		treeDataProvider: bookshelfProvider,
	});
	const chaptersView = vscode.window.createTreeView('xReader.chapters', {
		treeDataProvider: chapterProvider,
	});
	const worldView = vscode.window.createTreeView('xReader.worldbook', {
		treeDataProvider: worldProvider,
	});
	const cardsView = vscode.window.createTreeView('xReader.characters', {
		treeDataProvider: cardsProvider,
	});
	const chapterSummariesView = vscode.window.createTreeView('xReader.chapterSummaries', {
		treeDataProvider: chapterSummaryProvider,
	});
	const intervalSummariesView = vscode.window.createTreeView('xReader.intervalSummaries', {
		treeDataProvider: intervalSummaryProvider,
	});
	const notesView = vscode.window.createTreeView('xReader.notes', {
		treeDataProvider: noteProvider,
	});

	registerAgentTools(context, library);

	/** 状态栏：显示当前书与阅读进度，点击回到进度章节。 */
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	statusBar.command = 'xReader.openBook';
	statusBar.tooltip = '回到阅读进度';

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
			{ view: chaptersView, name: '章节目录' },
			{ view: chapterSummariesView, name: '章节摘要' },
			{ view: intervalSummariesView, name: '区间摘要' },
			{ view: worldView, name: '世界书' },
			{ view: cardsView, name: '角色卡' },
			{ view: notesView, name: '笔记' },
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
		void vscode.window.showInformationMessage('X Reader 已升级为文件夹书库，旧书架数据不兼容，请重新导入 txt 小说。');
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

	/** 关闭旧章节页签（已被替换时无需处理），避免翻章累积新页签。 */
	const closeOldChapterTab = async (oldPath: string | undefined): Promise<void> => {
		if (!oldPath) {
			return;
		}
		const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				const input = tab.input;
				const uri =
					input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
				if (uri && uri.fsPath === oldPath && tab !== activeTab) {
					await vscode.window.tabGroups.close(tab, true);
				}
			}
		}
	};

	/** 按当前查看模式打开章节：复用当前页签（不新开），渲染/源码模式保持不变，并滚动到开头。 */
	const openChapter = async (bookDir: string, volumeDir: string | undefined, fileName: string): Promise<void> => {
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
		void chaptersView
			.reveal(
				{ seq: parsed?.seq ?? 0, title: parsed?.title ?? fileName, fileName, volumeDir },
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
			const chapterIdx = segments.indexOf(CHAPTERS_DIR);
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
			void vscode.window.showInformationMessage(offset === 1 ? '已经是最后一章' : '已经是第一章');
			return;
		}
		await openChapter(bookDir, neighbor.volumeDir, neighbor.fileName);
	};

	/** 在当前书（或指定书）的 世界书/角色卡 下新建条目并打开。 */
	const createEntry = async (book: BookInfo | undefined, subDir: string, kindLabel: string): Promise<void> => {
		const target = book ?? library.getCurrentBook();
		if (!target) {
			return;
		}
		const name = await vscode.window.showInputBox({ title: `新建${kindLabel}`, prompt: '条目名称（将成为文件名）' });
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
		const name = await vscode.window.showInputBox({ title: '新建笔记（1/3）', prompt: '笔记名称（将成为文件名）' });
		if (!name?.trim()) {
			return;
		}
		const categories = await library.listNoteCategories(target);
		const category = await vscode.window.showInputBox({
			title: '新建笔记（2/3）',
			prompt:
				categories.length > 0
					? `分类（可选，留空则不分类；现有：${categories.map((c) => c.name).join('、')}）`
					: '分类（可选，留空则不分类）',
		});
		if (category === undefined) {
			return;
		}
		const chapters = await library.listChapters(target);
		const items: ({ label: string; description?: string; chapter?: ChapterFile })[] = [
			{ label: '（不关联章节）' },
			...chapters.map((c) => ({ label: c.title, description: chapterRelPath(c), chapter: c })),
		];
		const picked = await vscode.window.showQuickPick(items, {
			title: '新建笔记（3/3）',
			placeHolder: '关联章节（可选，可输入筛选）',
		});
		if (!picked) {
			return;
		}
		const filePath = await library.createNote(target, name.trim(), category.trim() || undefined, picked.chapter);
		await vscode.window.showTextDocument(vscode.Uri.file(filePath));
	};

	context.subscriptions.push(
		bookshelfView,
		chaptersView,
		worldView,
		cardsView,
		chapterSummariesView,
		intervalSummariesView,
		notesView,
		statusBar,
		vscode.commands.registerCommand('xReader.chooseLibraryPath', async () => {
			await library.ensureLibraryPath(true);
		}),
		vscode.commands.registerCommand('xReader.importBook', async () => {
			const picked = await vscode.window.showOpenDialog({
				title: '选择小说 txt 文件',
				filters: { '文本文件': ['txt'] },
				canSelectMany: false,
				canSelectFolders: false,
			});
			if (!picked || picked.length === 0) {
				return;
			}
			try {
				const result = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: '正在导入小说…' },
					() => library.importBook(picked[0])
				);
				if (result) {
					await vscode.commands.executeCommand('xReader.openBook', result.book.dir);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`导入小说失败：${message}`);
			}
		}),
		vscode.commands.registerCommand('xReader.openBook', async (bookDir?: string) => {
			let dir = bookDir ?? library.getCurrentBook()?.dir;
			if (!dir) {
				const books = await library.listBooks();
				if (books.length === 0) {
					void vscode.window.showInformationMessage('小说库还是空的，请先导入 txt 小说。');
					return;
				}
				const picked = await vscode.window.showQuickPick(
					books.map((b) => ({ label: b.name, book: b })),
					{ title: '打开书籍', placeHolder: '选择要打开的书' }
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
				void vscode.window.showInformationMessage('本书还没有章节，可在 章节/ 目录中新建 md 文件');
				return;
			}
			const progress = library.getProgress(dir);
			const target = progress
				? (await library.findChapterByProgress(book, progress)) ?? chapters[0]
				: chapters[0];
			await openChapter(dir, target.volumeDir, target.fileName);
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
			const answer = await vscode.window.showWarningMessage(
				`确定删除《${book.name}》？书文件夹将被删除（如有 git 历史可恢复）。`,
				{ modal: true },
				'删除'
			);
			if (answer !== '删除') {
				return;
			}
			await library.removeBook(book);
		}),
		vscode.commands.registerCommand('xReader.newCharacterCard', (book?: BookInfo) =>
			createEntry(book, CARDS_DIR, '角色卡')
		),
		vscode.commands.registerCommand('xReader.newWorldEntry', (book?: BookInfo) =>
			createEntry(book, WORLD_DIR, '世界书条目')
		),
		vscode.commands.registerCommand('xReader.newNote', (book?: BookInfo) => createNote(book)),
		vscode.commands.registerCommand(
			'xReader.deleteEntry',
			async (arg?: { bookDir: string; subDir: string; fileName: string; name: string }) => {
				if (!arg) {
					return;
				}
				const answer = await vscode.window.showWarningMessage(
					`确定删除「${arg.name}」？（如有 git 历史可恢复）`,
					{ modal: true },
					'删除'
				);
				if (answer !== '删除') {
					return;
				}
				await library.removeEntry({ name: path.basename(arg.bookDir), dir: arg.bookDir }, arg.subDir, arg.fileName);
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
			const ok = await commitAll(root, `快照 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
			void vscode.window.showInformationMessage(ok ? '已保存快照' : '没有需要提交的变更（或 git 不可用）');
		}),
		vscode.commands.registerCommand('xReader.refreshBookshelf', () => {
			bookshelfProvider.refresh();
		})
	);
}

export function deactivate(): void { }
