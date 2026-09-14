import * as vscode from 'vscode';
import type { BookInfo, Shelf } from '../model/book';
import { DEFAULT_SHELF_NAME, LibraryService, shelfLeafName, shelfParentPath } from '../services/library';
import { LibraryTreeProvider } from './libraryTreeProvider';

/** 书架树节点：子书架（name 为多级路径，count 为子树内书数），或某子书架下的书（书节点自身即 BookInfo，可直接传给既有书籍命令）。 */
export type BookshelfItem =
	| { kind: 'shelf'; name: string; isDefault: boolean; count: number }
	| ({ kind: 'book'; shelfName: string; isDefaultShelf: boolean } & BookInfo);

/** 同步补齐计数的书数上限：超过则改为后台补齐，保证大书库展开书架时立即出节点。 */
const INLINE_CHAPTER_COUNT_LIMIT = 50;

export class BookshelfProvider extends LibraryTreeProvider<BookshelfItem> {
	private chapterCounts = new Map<string, number>();
	/** 后台正在统计的书目录，避免同一次展开重复排队。 */
	private readonly pendingCounts = new Set<string>();
	/** 计数代次：书库变更后丢弃在途的后台统计结果。 */
	private countsGeneration = 0;
	/** 同一次刷新内的书目缓存：一次刷新会为每个已展开的节点调用 getChildren。 */
	private booksCache: BookInfo[] | undefined;

	constructor(
		library: LibraryService,
		private readonly bookIcon: vscode.Uri,
		private readonly shelfIcon: vscode.Uri
	) {
		super(library);
	}

	protected onLibraryChanged(): void {
		// 计数只扫目录不读正文，变更后重算的代价可控
		this.chapterCounts.clear();
		this.pendingCounts.clear();
		this.countsGeneration++;
		this.booksCache = undefined;
	}

	/** 书目列表（同一次刷新内复用，避免每个已展开的节点各扫一遍库根）。 */
	private async getBooks(): Promise<BookInfo[]> {
		this.booksCache ??= await this.library.listBooks();
		return this.booksCache;
	}

	async getChildren(element?: BookshelfItem): Promise<BookshelfItem[]> {
		if (element?.kind === 'book') {
			return [];
		}
		if (!this.library.getLibraryPath()) {
			return [];
		}
		const books = await this.getBooks();
		if (!element) {
			await this.loadChapterCounts(books);
			return [
				{ kind: 'shelf', name: DEFAULT_SHELF_NAME, isDefault: true, count: books.length },
				...this.childShelfNodes(await this.library.listShelves(), undefined),
			];
		}
		if (element.isDefault) {
			await this.loadChapterCounts(books);
			return this.bookNodes(books, DEFAULT_SHELF_NAME, true);
		}
		const shelves = await this.library.listShelves();
		// 链接按书文件夹名解析，已删除的书直接跳过
		const byName = new Map(books.map((b) => [b.name, b]));
		const shelf = shelves.find((s) => s.name === element.name);
		const linked = (shelf?.books ?? []).map((name) => byName.get(name)).filter((b) => b !== undefined);
		await this.loadChapterCounts(linked);
		return [...this.childShelfNodes(shelves, element.name), ...this.bookNodes(linked, element.name, false)];
	}

	/** 某一层的直接下级子书架节点（count 取子树内去重后的书数，父分类不会显示 0 本）。 */
	private childShelfNodes(shelves: Shelf[], parentPath: string | undefined): BookshelfItem[] {
		return shelves
			.filter((s) => shelfParentPath(s.name) === parentPath)
			.map((s) => ({
				kind: 'shelf' as const,
				name: s.name,
				isDefault: false,
				count: this.subtreeBookCount(shelves, s.name),
			}));
	}

	private subtreeBookCount(shelves: Shelf[], path: string): number {
		const names = new Set<string>();
		for (const shelf of shelves) {
			if (shelf.name === path || shelf.name.startsWith(`${path}/`)) {
				shelf.books.forEach((book) => names.add(book));
			}
		}
		return names.size;
	}

	/**
	 * 补齐书目录的章节计数（按书目录去重，同一本书在多个子书架只算一次）。
	 * 书少时同步补齐（计数不会闪一下才出现）；书多时排队后台统计，节点先渲染、计数到达后再刷新一次。
	 */
	private async loadChapterCounts(books: BookInfo[]): Promise<void> {
		const missing = books.filter((book) => !this.chapterCounts.has(book.dir) && !this.pendingCounts.has(book.dir));
		if (missing.length === 0) {
			return;
		}
		if (missing.length > INLINE_CHAPTER_COUNT_LIMIT) {
			void this.fillChapterCountsInBackground(missing);
			return;
		}
		this.applyCounts(await this.library.listChapterCounts(missing));
	}

	private async fillChapterCountsInBackground(books: BookInfo[]): Promise<void> {
		const generation = this.countsGeneration;
		books.forEach((book) => this.pendingCounts.add(book.dir));
		const counts = await this.library.listChapterCounts(books);
		// 统计期间书库又变了就丢弃本轮结果，交由下一次展开重算
		if (generation !== this.countsGeneration) {
			return;
		}
		this.applyCounts(counts);
		this._onDidChangeTreeData.fire();
	}

	private applyCounts(counts: Map<string, number>): void {
		for (const [dir, count] of counts) {
			this.chapterCounts.set(dir, count);
			this.pendingCounts.delete(dir);
		}
	}

	private bookNodes(books: BookInfo[], shelfName: string, isDefaultShelf: boolean): BookshelfItem[] {
		return books.map((book) => ({ kind: 'book' as const, shelfName, isDefaultShelf, ...book }));
	}

	getTreeItem(item: BookshelfItem): vscode.TreeItem {
		return item.kind === 'shelf' ? this.shelfTreeItem(item) : this.bookTreeItem(item);
	}

	private shelfTreeItem(node: { name: string; isDefault: boolean; count: number }): vscode.TreeItem {
		const item = new vscode.TreeItem(shelfLeafName(node.name), vscode.TreeItemCollapsibleState.Collapsed);
		item.id = `shelf:${node.name}`;
		item.iconPath = this.shelfIcon;
		item.contextValue = node.isDefault ? 'defaultShelf' : 'customShelf';
		item.description = vscode.l10n.t('{0} books', node.count);
		// 末级名已是路径，悬浮提示补全整条路径
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
