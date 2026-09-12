import * as vscode from 'vscode';
import type { EntryCategory, EntryFile } from '../model/book';
import { LibraryService } from '../services/library';
import { LibraryTreeProvider } from './libraryTreeProvider';

/** 分类节点：携带所属书与条目根目录（世界书/角色卡/笔记）。 */
export interface EntryCategoryNode extends EntryCategory {
	kind: 'category';
	bookDir: string;
	rootDir: string;
}

/** 条目节点：携带所属书、条目根目录与所在目录（含分类路径）。 */
export interface EntryNode extends EntryFile {
	kind: 'entry';
	bookDir: string;
	rootDir: string;
	subDir: string;
}

export type EntryTreeNode = EntryCategoryNode | EntryNode;

export interface EntryProviderOptions {
	/** 条目根目录（世界书/角色卡/笔记） */
	rootDir: string;
	/** 条目节点图标 */
	entryIcon: vscode.Uri;
	/** 分类节点图标（三处共用） */
	categoryIcon: vscode.Uri;
	/** 条目节点的 contextValue，决定右键菜单（entry / note） */
	entryContextValue: string;
	/** 条目节点的打开命令标题（世界书/角色卡为 Open，笔记为 Open Note） */
	openTitle: string;
}

/** 条目视图（世界书/角色卡/笔记）：分类目录（可多级折叠）+ 各层条目。 */
export class EntryProvider extends LibraryTreeProvider<EntryTreeNode> {
	constructor(library: LibraryService, private readonly options: EntryProviderOptions) {
		super(library);
	}

	async getChildren(element?: EntryTreeNode): Promise<EntryTreeNode[]> {
		if (element?.kind === 'entry') {
			return [];
		}
		const book = this.library.getCurrentBook();
		if (!book) {
			return [];
		}
		const { rootDir } = this.options;
		const categoryPath = element?.path;
		const [categories, entries] = await Promise.all([
			this.library.listChildCategories(book, rootDir, categoryPath),
			this.library.listEntries(book, rootDir, categoryPath),
		]);
		return [
			...categories.map((category) => this.categoryNode(book.dir, category)),
			...entries.map((entry) => this.entryNode(book.dir, categoryPath, entry)),
		];
	}

	getTreeItem(node: EntryTreeNode): vscode.TreeItem {
		return node.kind === 'category' ? this.categoryItem(node) : this.entryItem(node);
	}

	private categoryNode(bookDir: string, category: EntryCategory): EntryCategoryNode {
		return { kind: 'category', bookDir, rootDir: this.options.rootDir, ...category };
	}

	private entryNode(bookDir: string, categoryPath: string | undefined, entry: EntryFile): EntryNode {
		const { rootDir } = this.options;
		const subDir = categoryPath ? `${rootDir}/${categoryPath}` : rootDir;
		return { kind: 'entry', bookDir, rootDir, subDir, ...entry };
	}

	private categoryItem(node: EntryCategoryNode): vscode.TreeItem {
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
		// id 前缀区分分类与条目，否则「分类名.md」目录会与同名条目撞 id
		item.id = `category:${node.bookDir}/${node.rootDir}/${node.path}`;
		item.iconPath = this.options.categoryIcon;
		item.contextValue = 'entryCategory';
		item.tooltip = vscode.l10n.t('Category: {0}', `${node.rootDir}/${node.path}`);
		return item;
	}

	private entryItem(node: EntryNode): vscode.TreeItem {
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
		item.id = `entry:${node.bookDir}/${node.subDir}/${node.fileName}`;
		item.iconPath = this.options.entryIcon;
		item.contextValue = this.options.entryContextValue;
		item.tooltip = `${node.subDir}/${node.fileName}`;
		item.command = {
			command: 'xReader.openEntry',
			title: this.options.openTitle,
			arguments: [node.bookDir, node.subDir, node.fileName],
		};
		return item;
	}
}
