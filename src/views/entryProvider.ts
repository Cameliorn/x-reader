import * as vscode from 'vscode';
import type { EntryFile } from '../model/book';
import { LibraryService } from '../services/library';
import { LibraryTreeProvider } from './libraryTreeProvider';

/** 条目元素：携带所属书与目录，供右键删除命令使用。 */
export type EntryNode = EntryFile & { bookDir: string; subDir: string };

/** 条目视图（世界书/角色卡）：展示当前书对应目录下的 md 条目。 */
export class EntryProvider extends LibraryTreeProvider<EntryNode> {
	constructor(
		library: LibraryService,
		private readonly subDir: string,
		private readonly icon: string
	) {
		super(library);
	}

	async getChildren(element?: EntryNode): Promise<EntryNode[]> {
		if (element !== undefined) {
			return [];
		}
		const book = this.library.getCurrentBook();
		if (!book) {
			return [];
		}
		const entries = await this.library.listEntries(book, this.subDir);
		return entries.map((entry) => ({ ...entry, bookDir: book.dir, subDir: this.subDir }));
	}

	getTreeItem(entry: EntryNode): vscode.TreeItem {
		const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
		item.id = `${entry.bookDir}/${entry.subDir}/${entry.fileName}`;
		item.iconPath = new vscode.ThemeIcon(this.icon);
		item.contextValue = 'entry';
		item.tooltip = `${entry.subDir}/${entry.fileName}`;
		item.command = {
			command: 'xReader.openEntry',
			title: '打开',
			arguments: [entry.bookDir, entry.subDir, entry.fileName],
		};
		return item;
	}
}
