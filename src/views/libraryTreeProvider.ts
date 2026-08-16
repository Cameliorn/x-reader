import * as vscode from 'vscode';
import { LibraryService } from '../services/library';

/** 树视图数据提供器基类：订阅书库变更自动刷新，子类只需实现节点读取。 */
export abstract class LibraryTreeProvider<T> implements vscode.TreeDataProvider<T> {
	protected readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(protected readonly library: LibraryService) {
		library.onDidChange(() => {
			this.onLibraryChanged();
			this._onDidChangeTreeData.fire();
		});
	}

	/** 书库变更时的额外处理（如清理缓存）；默认无。 */
	protected onLibraryChanged(): void { }

	abstract getChildren(element?: T): vscode.ProviderResult<T[]>;
	abstract getTreeItem(element: T): vscode.TreeItem | Thenable<vscode.TreeItem>;
}
