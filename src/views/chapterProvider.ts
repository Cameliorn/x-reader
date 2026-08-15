import * as vscode from 'vscode';
import type { ChapterFile, ChapterVolume } from '../model/book';
import { CHAPTERS_DIR, chapterRelPath, LibraryService } from '../services/library';

type ChapterNode = ChapterVolume | ChapterFile;

/** 章节目录视图：按卷分组展示当前书的章节文件，● 标记上次读到。 */
export class ChapterProvider implements vscode.TreeDataProvider<ChapterNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly library: LibraryService) {
		library.onDidChange(() => this._onDidChangeTreeData.fire());
	}

	async getChildren(element?: ChapterNode): Promise<ChapterNode[]> {
		if (element === undefined) {
			const book = this.library.getCurrentBook();
			return book ? this.library.listVolumes(book) : [];
		}
		return 'chapters' in element ? element.chapters : [];
	}

	getTreeItem(node: ChapterNode): vscode.TreeItem {
		return 'chapters' in node ? this.volumeItem(node) : this.chapterItem(node);
	}

	private volumeItem(volume: ChapterVolume): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const item = new vscode.TreeItem(volume.name, vscode.TreeItemCollapsibleState.Expanded);
		item.id = book ? `${book.dir}/${CHAPTERS_DIR}/${volume.dirName ?? ''}` : undefined;
		item.iconPath = new vscode.ThemeIcon('library');
		item.contextValue = 'volume';
		item.description = `${volume.chapters.length} 章`;
		return item;
	}

	private chapterItem(chapter: ChapterFile): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const item = new vscode.TreeItem(chapter.title, vscode.TreeItemCollapsibleState.None);
		item.id = book
			? `${book.dir}/${CHAPTERS_DIR}/${chapter.volumeDir ? chapter.volumeDir + '/' : ''}${chapter.fileName}`
			: undefined;
		item.iconPath = new vscode.ThemeIcon('file');
		item.contextValue = 'chapter';
		if (book) {
			const progress = this.library.getProgress(book.dir);
			if (progress && (progress === chapter.fileName || progress === chapterRelPath(chapter))) {
				item.description = '●';
			}
			item.command = {
				command: 'xReader.openChapter',
				title: '打开',
				arguments: [book.dir, chapter.volumeDir, chapter.fileName],
			};
		}
		return item;
	}
}
