import * as vscode from 'vscode';
import type { Chapter } from '../model/book';
import { BookStore } from '../services/bookStore';

/** 章节目录视图：元素为当前书的章节索引，标题从缓存章节列表读取。 */
export class ChapterProvider implements vscode.TreeDataProvider<number> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private chaptersCache: Chapter[] | undefined;

	constructor(private readonly store: BookStore) {
		store.onDidChange(() => {
			this.chaptersCache = undefined;
			this._onDidChangeTreeData.fire();
		});
	}

	async getChildren(element?: number): Promise<number[]> {
		if (element !== undefined) {
			return [];
		}
		const book = this.store.getCurrentBook();
		if (!book) {
			this.chaptersCache = undefined;
			return [];
		}
		this.chaptersCache = await this.store.getChapters(book);
		return this.chaptersCache.map((_, i) => i);
	}

	getTreeItem(chapterIndex: number): vscode.TreeItem {
		const book = this.store.getCurrentBook();
		const chapter = this.chaptersCache?.[chapterIndex];
		const item = new vscode.TreeItem(chapter?.title ?? `第 ${chapterIndex + 1} 章`, vscode.TreeItemCollapsibleState.None);
		item.id = book ? `${book.id}:${chapterIndex}` : undefined;
		item.iconPath = new vscode.ThemeIcon('file');
		item.contextValue = 'chapter';
		if (book && chapterIndex === book.lastReadChapter) {
			item.description = '●';
		}
		item.command = book
			? { command: 'xReader.openChapter', title: '阅读', arguments: [book.id, chapterIndex] }
			: undefined;
		return item;
	}
}
