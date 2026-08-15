import * as vscode from 'vscode';
import type { BookMeta } from './model/book';
import { BookStore } from './services/bookStore';
import { ReaderPanel } from './reader/readerPanel';
import { BookshelfProvider } from './views/bookshelfProvider';
import { ChapterProvider } from './views/chapterProvider';

export function activate(context: vscode.ExtensionContext): void {
	const store = new BookStore(context);
	const bookshelfProvider = new BookshelfProvider(store);
	const chapterProvider = new ChapterProvider(store);

	const bookshelfView = vscode.window.createTreeView('xReader.bookshelf', {
		treeDataProvider: bookshelfProvider,
	});
	const chaptersView = vscode.window.createTreeView('xReader.chapters', {
		treeDataProvider: chapterProvider,
	});

	const updateMessages = (): void => {
		bookshelfView.message = store.getBooks().length === 0
			? '书架空空如也，\n点击上方按钮导入 txt 小说'
			: undefined;
		chaptersView.message = store.getCurrentBook() ? undefined : '在书架中选择一本书开始阅读';
	};
	store.onDidChange(updateMessages);
	updateMessages();

	context.subscriptions.push(
		bookshelfView,
		chaptersView,
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
				const book = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: '正在导入小说…' },
					() => store.importBook(picked[0])
				);
				await vscode.commands.executeCommand('xReader.openBook', book.id);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`导入小说失败：${message}`);
			}
		}),
		vscode.commands.registerCommand('xReader.openBook', async (bookId?: string) => {
			const id = bookId ?? store.getCurrentBook()?.id;
			const book = id ? store.getBook(id) : undefined;
			if (!book) {
				return;
			}
			await store.setCurrentBook(book.id);
			ReaderPanel.show(store, book, book.lastReadChapter >= 0 ? book.lastReadChapter : 0);
		}),
		vscode.commands.registerCommand('xReader.openChapter', async (bookId?: string, chapterIndex?: number) => {
			if (bookId === undefined || chapterIndex === undefined) {
				return;
			}
			const book = store.getBook(bookId);
			if (!book) {
				return;
			}
			await store.setCurrentBook(book.id);
			ReaderPanel.show(store, book, chapterIndex);
		}),
		vscode.commands.registerCommand('xReader.removeBook', async (book?: BookMeta) => {
			if (!book) {
				return;
			}
			const answer = await vscode.window.showWarningMessage(
				`确定从书架移除《${book.title}》？书籍文件将被删除。`,
				{ modal: true },
				'移除'
			);
			if (answer !== '移除') {
				return;
			}
			ReaderPanel.closeIfShowing(book.id);
			await store.removeBook(book.id);
		}),
		vscode.commands.registerCommand('xReader.refreshBookshelf', () => {
			bookshelfProvider.refresh();
		})
	);
}

export function deactivate(): void {}
