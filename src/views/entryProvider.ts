import * as vscode from 'vscode';
import type { EntryFile } from '../model/book';
import { LibraryService } from '../services/library';

/** 条目视图（世界书/角色卡）：展示当前书对应目录下的 md 条目。 */
export class EntryProvider implements vscode.TreeDataProvider<EntryFile> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly library: LibraryService,
		private readonly subDir: string,
		private readonly icon: string
	) {
		library.onDidChange(() => this._onDidChangeTreeData.fire());
	}

	async getChildren(element?: EntryFile): Promise<EntryFile[]> {
		if (element !== undefined) {
			return [];
		}
		const book = this.library.getCurrentBook();
		return book ? this.library.listEntries(book, this.subDir) : [];
	}

	getTreeItem(entry: EntryFile): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
		item.id = book ? `${book.dir}/${this.subDir}/${entry.fileName}` : undefined;
		item.iconPath = new vscode.ThemeIcon(this.icon);
		item.contextValue = 'entry';
		item.command = book
			? { command: 'xReader.openEntry', title: '打开', arguments: [book.dir, this.subDir, entry.fileName] }
			: undefined;
		return item;
	}
}
