import * as vscode from 'vscode';
import type { BookInfo } from '../model/book';
import { LibraryService } from '../services/library';

export class BookshelfProvider implements vscode.TreeDataProvider<BookInfo> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private chapterCounts = new Map<string, number>();

	constructor(private readonly library: LibraryService) {
		library.onDidChange(() => {
			this.chapterCounts.clear();
			this._onDidChangeTreeData.fire();
		});
	}

	async getChildren(element?: BookInfo): Promise<BookInfo[]> {
		if (element) {
			return [];
		}
		const books = await this.library.listBooks();
		for (const book of books) {
			this.chapterCounts.set(book.dir, (await this.library.listChapters(book)).length);
		}
		return books;
	}

	getTreeItem(book: BookInfo): vscode.TreeItem {
		const item = new vscode.TreeItem(book.name, vscode.TreeItemCollapsibleState.None);
		item.id = book.dir;
		item.iconPath = new vscode.ThemeIcon('book');
		item.contextValue = 'book';
		const count = this.chapterCounts.get(book.dir);
		item.description = count === undefined ? '' : `${count} 章`;
		item.tooltip = book.dir;
		item.command = { command: 'xReader.openBook', title: '打开', arguments: [book.dir] };
		return item;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}
}
