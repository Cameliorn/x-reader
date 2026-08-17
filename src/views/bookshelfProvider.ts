import * as vscode from 'vscode';
import type { BookInfo } from '../model/book';
import { LibraryService } from '../services/library';
import { LibraryTreeProvider } from './libraryTreeProvider';

export class BookshelfProvider extends LibraryTreeProvider<BookInfo> {
	private chapterCounts = new Map<string, number>();

	constructor(library: LibraryService, private readonly bookIcon: vscode.Uri) {
		super(library);
	}

	protected onLibraryChanged(): void {
		this.chapterCounts.clear();
	}

	async getChildren(element?: BookInfo): Promise<BookInfo[]> {
		if (element) {
			return [];
		}
		const books = await this.library.listBooks();
		await Promise.all(
			books.map(async (book) => {
				this.chapterCounts.set(book.dir, (await this.library.listChapters(book)).length);
			})
		);
		return books;
	}

	getTreeItem(book: BookInfo): vscode.TreeItem {
		const item = new vscode.TreeItem(book.name, vscode.TreeItemCollapsibleState.None);
		item.id = book.dir;
		item.iconPath = this.bookIcon;
		item.contextValue = 'book';
		const count = this.chapterCounts.get(book.dir);
		const isCurrent = this.library.getCurrentBook()?.dir === book.dir;
		item.description = `${count === undefined ? '' : vscode.l10n.t('{0} chapters', count)}${isCurrent ? vscode.l10n.t(' · current') : ''
			}`;
		item.tooltip = isCurrent ? `${book.dir}\n${vscode.l10n.t('Current book')}` : book.dir;
		item.command = { command: 'xReader.openBook', title: vscode.l10n.t('Open'), arguments: [book.dir] };
		return item;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}
}
