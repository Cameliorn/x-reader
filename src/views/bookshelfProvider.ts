import * as vscode from 'vscode';
import type { BookMeta } from '../model/book';
import { BookStore } from '../services/bookStore';

export class BookshelfProvider implements vscode.TreeDataProvider<BookMeta> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private chapterCounts = new Map<string, number>();

	constructor(private readonly store: BookStore) {
		store.onDidChange(() => {
			this.chapterCounts.clear();
			void this.prefetchChapterCounts();
			this._onDidChangeTreeData.fire();
		});
	}

	getTreeItem(book: BookMeta): vscode.TreeItem {
		const item = new vscode.TreeItem(book.title, vscode.TreeItemCollapsibleState.None);
		item.id = book.id;
		item.iconPath = new vscode.ThemeIcon('book');
		item.contextValue = 'book';
		item.description = book.lastReadChapter >= 0 ? `第 ${book.lastReadChapter + 1} 章` : '未读';
		const count = this.chapterCounts.get(book.id) ?? '…';
		const progress = book.lastReadChapter >= 0 ? `读到第 ${book.lastReadChapter + 1} 章` : '未读';
		item.tooltip = `${book.fileName}\n共 ${count} 章，${progress}`;
		item.command = { command: 'xReader.openBook', title: '打开', arguments: [book.id] };
		return item;
	}

	getChildren(element?: BookMeta): BookMeta[] {
		return element ? [] : this.store.getBooks();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	private async prefetchChapterCounts(): Promise<void> {
		for (const book of this.store.getBooks()) {
			if (!this.chapterCounts.has(book.id)) {
				this.chapterCounts.set(book.id, await this.store.getChapterCount(book));
			}
		}
		this._onDidChangeTreeData.fire();
	}
}
