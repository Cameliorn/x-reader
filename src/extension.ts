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
	const bookshelfProvider = new BookshelfProvider(library);
	const chapterProvider = new ChapterProvider(library);
	const worldProvider = new EntryProvider(library, WORLD_DIR, 'globe');
	const cardsProvider = new EntryProvider(library, CARDS_DIR, 'person');
	const summaryProvider = new SummaryProvider(library);
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
			{ view: summariesView, name: '摘要' },
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
		void vscode.window.showInformationMessage('X Reader 已升级为文件夹书库，旧书架数据不兼容，请重新导入小说。');
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
			void vscode.window.showInformationMessage(offset === 1 ? '已经是最后一章' : '已经是第一章');
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
		const name = await vscode.window.showInputBox({ title: `新建${kindLabel}`, prompt: '条目名称' });
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
		const name = await vscode.window.showInputBox({ title: '新建笔记（1/3）', prompt: '笔记名称' });
		if (!name?.trim()) {
			return;
		}
		const categories = await library.listNoteCategories(target);
		const categoryPicked = await vscode.window.showQuickPick(
			[
				{ label: '（不分类）', dirName: '' },
				...categories.map((c) => ({ label: c.name, dirName: c.dirName })),
				{ label: '$(add) 新建分类…', dirName: undefined },
			],
			{ title: '新建笔记（2/3）', placeHolder: '分类' }
		);
		if (!categoryPicked) {
			return;
		}
		let categoryDir = categoryPicked.dirName;
		if (categoryDir === undefined) {
			const input = await vscode.window.showInputBox({ title: '新建笔记（2/3）', prompt: '分类' });
			if (input === undefined) {
				return;
			}
			categoryDir = input.trim();
		}
		const chapters = await library.listChapters(target);
		const items: ({ label: string; description?: string; chapter?: ChapterFile })[] = [
			{ label: '（不关联章节）' },
			...chapters.map((c) => ({ label: c.title, description: chapterRelPath(c), chapter: c })),
		];
		const picked = await vscode.window.showQuickPick(items, {
			title: '新建笔记（3/3）',
			placeHolder: '关联章节',
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
		const name = await vscode.window.showInputBox({ title, value: current, prompt: '新名称' });
		if (!name?.trim()) {
			return;
		}
		await action(name.trim());
	};

	/** 弹出 modal 删除确认；返回是否确认。 */
	const confirmDelete = async (message: string): Promise<boolean> => {
		const answer = await vscode.window.showWarningMessage(message, { modal: true }, '删除');
		return answer === '删除';
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
				title: '选择小说 txt 文件',
				filters: { '文本文件': ['txt'] },
				canSelectMany: true,
				canSelectFolders: false,
			});
			if (!picked || picked.length === 0) {
				return;
			}
			const imported: { book: BookInfo; chapterCount: number }[] = [];
			const failed: string[] = [];
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: '正在导入小说…' },
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
				void vscode.window.showWarningMessage(`导入失败 ${failed.length} 本：${failed.join('；')}`);
			}
			if (imported.length > 0) {
				await vscode.commands.executeCommand('xReader.openBook', imported[0].book.dir);
			}
		}),
		vscode.commands.registerCommand('xReader.newBook', async () => {
			const name = await vscode.window.showInputBox({
				title: '新建小说',
				prompt: '书名',
			});
			if (!name?.trim()) {
				return;
			}
			try {
				const book = await library.createBook(name.trim());
				await vscode.commands.executeCommand('xReader.openBook', book.dir);
			} catch (error) {
				void vscode.window.showErrorMessage(
					`新建失败：${error instanceof Error ? error.message : String(error)}`
				);
			}
		}),
		vscode.commands.registerCommand('xReader.openBook', async (bookDir?: string | BookInfo) => {
			let dir = typeof bookDir === 'string' ? bookDir : (bookDir?.dir ?? library.getCurrentBook()?.dir);
			if (!dir) {
				const books = await library.listBooks();
				if (books.length === 0) {
					void vscode.window.showInformationMessage('小说库还是空的，请导入或新建小说。');
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
				void vscode.window.showInformationMessage('本书还没有章节，请先新建章节。');
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
			if (await confirmDelete(`确定删除《${book.name}》？`)) {
				await library.removeBook(book);
			}
		}),
		vscode.commands.registerCommand('xReader.newCharacterCard', (book?: BookInfo) =>
			createEntry(book, CARDS_DIR, '角色卡')
		),
		vscode.commands.registerCommand('xReader.newWorldEntry', (book?: BookInfo) =>
			createEntry(book, WORLD_DIR, '世界书条目')
		),
		vscode.commands.registerCommand('xReader.newNote', (book?: BookInfo) => createNote(book)),
		vscode.commands.registerCommand('xReader.deleteChapter', async (chapter?: ChapterFile) => {
			const book = library.getCurrentBook();
			if (!book || !chapter) {
				return;
			}
			if (await confirmDelete(`确定删除章节「${chapter.title}」？`)) {
				await library.removeChapter(book, chapter);
			}
		}),
		vscode.commands.registerCommand('xReader.renameChapter', async (chapter?: ChapterFile) => {
			const book = library.getCurrentBook();
			if (!book || !chapter) {
				return;
			}
			const title = await vscode.window.showInputBox({
				title: '重命名章节',
				prompt: '新标题',
				value: chapter.title,
			});
			if (!title?.trim()) {
				return;
			}
			const newFileName = await library.renameChapter(book, chapter, title.trim());
			await openChapter(book.dir, chapter.volumeDir, newFileName);
		}),
		vscode.commands.registerCommand('xReader.renameBook', async (book?: BookInfo) => {
			if (!book) {
				return;
			}
			await renameWithInput('重命名书籍', book.name, (name) => library.renameBook(book, name));
		}),
		vscode.commands.registerCommand(
			'xReader.renameEntry',
			async (arg?: { bookDir: string; subDir: string; fileName: string; name: string }) => {
				if (!arg) {
					return;
				}
				const book = { name: path.basename(arg.bookDir), dir: arg.bookDir };
				await renameWithInput('重命名条目', arg.name, (name) =>
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
				await renameWithInput('重命名笔记', arg.name, (name) =>
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
				title: '新建分卷',
				prompt: '分卷名',
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
				title: '新建章节',
				prompt: '章节标题',
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
			await renameWithInput('重命名分卷', volume.name, (name) => library.renameVolume(book, dirName, name));
		}),
		vscode.commands.registerCommand('xReader.deleteVolume', async (volume?: ChapterVolume) => {
			const book = library.getCurrentBook();
			if (!book || !volume?.dirName) {
				return;
			}
			const count = volume.chapters.length;
			if (
				await confirmDelete(
					count > 0 ? `确定删除分卷「${volume.name}」及其 ${count} 个章节？` : `确定删除分卷「${volume.name}」？`
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
				if (await confirmDelete(`确定删除章节摘要「${fileName}」？`)) {
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
			if (await confirmDelete(`确定删除区间摘要「${fileName}」？`)) {
				await library.removeEntry({ name: path.basename(bookDir), dir: bookDir }, INTERVAL_SUMMARIES_DIR, fileName);
			}
		}),
		vscode.commands.registerCommand('xReader.renameNoteCategory', async (category?: NoteCategory) => {
			const book = library.getCurrentBook();
			if (!book || !category) {
				return;
			}
			await renameWithInput('重命名笔记分类', category.name, (name) =>
				library.renameNoteCategory(book, category.dirName, name)
			);
		}),
		vscode.commands.registerCommand('xReader.deleteNoteCategory', async (category?: NoteCategory) => {
			const book = library.getCurrentBook();
			if (!book || !category) {
				return;
			}
			if (await confirmDelete(`确定删除笔记分类「${category.name}」及其全部笔记？`)) {
				await library.deleteNoteCategory(book, category.dirName);
			}
		}),
		vscode.commands.registerCommand(
			'xReader.deleteEntry',
			async (arg?: { bookDir: string; subDir: string; fileName: string; name: string }) => {
				if (!arg) {
					return;
				}
				if (await confirmDelete(`确定删除「${arg.name}」？`)) {
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
				void vscode.window.showInformationMessage('请先在书架中选择一本书');
				return;
			}
			const ok = await commitAll(
				root,
				`快照《${book.name}》 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
				[path.relative(root, book.dir)]
			);
			void vscode.window.showInformationMessage(ok ? '已保存快照' : '没有需要提交的变更（或 git 不可用）');
		}),
		vscode.commands.registerCommand('xReader.refreshBookshelf', () => {
			bookshelfProvider.refresh();
		})
	);
}

export function deactivate(): void { }
