import * as vscode from 'vscode';
import type { BookInfo } from '../model/book';
import { DEFAULT_SHELF_NAME, LibraryService } from '../services/library';
import { LibraryTreeProvider } from './libraryTreeProvider';

/** 书架树节点：子书架（count 为收录书数），或某子书架下的书（书节点自身即 BookInfo，可直接传给既有书籍命令）。 */
export type BookshelfItem =
	| { kind: 'shelf'; name: string; isDefault: boolean; count: number }
	| ({ kind: 'book'; shelfName: string; isDefaultShelf: boolean } & BookInfo);

export class BookshelfProvider extends LibraryTreeProvider<BookshelfItem> {
	private chapterCounts = new Map<string, number>();

	constructor(
		library: LibraryService,
		private readonly bookIcon: vscode.Uri,
		private readonly shelfIcon: vscode.Uri
	) {
		super(library);
	}

	protected onLibraryChanged(): void {
		this.chapterCounts.clear();
	}

	async getChildren(element?: BookshelfItem): Promise<BookshelfItem[]> {
		if (!element) {
			const shelves = await this.library.listShelves();
			const books = await this.library.listBooks();
			return [
				{ kind: 'shelf', name: DEFAULT_SHELF_NAME, isDefault: true, count: books.length },
				...shelves.map((s) => ({ kind: 'shelf' as const, name: s.name, isDefault: false, count: s.books.length })),
			];
		}
		if (element.kind !== 'shelf') {
			return [];
		}
		if (element.isDefault) {
			const books = await this.library.listBooks();
			await this.fillChapterCounts(books);
			return this.bookNodes(books, DEFAULT_SHELF_NAME, true);
		}
		// 链接按书文件夹名解析，已删除的书直接跳过
		const shelf = (await this.library.listShelves()).find((s) => s.name === element.name);
		if (!shelf) {
			return [];
		}
		const byName = new Map((await this.library.listBooks()).map((b) => [b.name, b]));
		const books = shelf.books.map((name) => byName.get(name)).filter((b) => b !== undefined);
		await this.fillChapterCounts(books);
		return this.bookNodes(books, element.name, false);
	}

	/** 补齐书目录的章节计数（按书目录去重，同一本书在多个子书架只算一次）。 */
	private async fillChapterCounts(books: BookInfo[]): Promise<void> {
		await Promise.all(
			books.map(async (book) => {
				if (!this.chapterCounts.has(book.dir)) {
					this.chapterCounts.set(book.dir, (await this.library.listChapters(book)).length);
				}
			})
		);
	}

	private bookNodes(books: BookInfo[], shelfName: string, isDefaultShelf: boolean): BookshelfItem[] {
		return books.map((book) => ({ kind: 'book' as const, shelfName, isDefaultShelf, ...book }));
	}

	getTreeItem(item: BookshelfItem): vscode.TreeItem {
		return item.kind === 'shelf' ? this.shelfTreeItem(item) : this.bookTreeItem(item);
	}

	private shelfTreeItem(node: { name: string; isDefault: boolean; count: number }): vscode.TreeItem {
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
		item.id = `shelf:${node.name}`;
		item.iconPath = this.shelfIcon;
		item.contextValue = node.isDefault ? 'defaultShelf' : 'customShelf';
		item.description = vscode.l10n.t('{0} books', node.count);
		item.tooltip = node.isDefault
			? `${node.name}\n${vscode.l10n.t('All books appear in the default shelf')}`
			: node.name;
		return item;
	}

	private bookTreeItem(book: BookInfo & { kind: 'book'; shelfName: string; isDefaultShelf: boolean }): vscode.TreeItem {
		const item = new vscode.TreeItem(book.name, vscode.TreeItemCollapsibleState.None);
		// 同一本书会出现在多个子书架，id 需带上书架名保证唯一
		item.id = `${book.shelfName}:${book.dir}`;
		item.iconPath = this.bookIcon;
		item.contextValue = book.isDefaultShelf ? 'book' : 'shelfBook';
		const count = this.chapterCounts.get(book.dir);
		const isCurrent = this.library.getCurrentBook()?.dir === book.dir;
		const countText = count === undefined ? '' : vscode.l10n.t('{0} chapters', count);
		// 当前书标记与章节目录视图的「读到」标记保持同一形式
		item.description = isCurrent ? (countText ? `● ${countText}` : '●') : countText;
		item.tooltip = isCurrent ? `${book.dir}\n${vscode.l10n.t('Current book')}` : book.dir;
		item.command = { command: 'xReader.openBook', title: vscode.l10n.t('Open'), arguments: [book] };
		return item;
	}
}
