import * as vscode from 'vscode';
import type { ChapterFile, ChapterVolume } from '../model/book';
import { chapterRelPath, CHAPTERS_DIR, LibraryService } from '../services/library';
import { LibraryTreeProvider } from './libraryTreeProvider';

type ChapterNode = ChapterVolume | ChapterFile;

/** 章节目录视图：按卷分组展示当前书的章节文件，● 标记上次读到。 */
export class ChapterProvider extends LibraryTreeProvider<ChapterNode> {
	constructor(
		library: LibraryService,
		private readonly volumeIcon: vscode.Uri,
		private readonly chapterIcon: vscode.Uri
	) {
		super(library);
	}

	async getChildren(element?: ChapterNode): Promise<ChapterNode[]> {
		if (element === undefined) {
			const book = this.library.getCurrentBook();
			return book ? this.library.listVolumes(book) : [];
		}
		return 'chapters' in element ? element.chapters : [];
	}

	/** 供 TreeView.reveal 定位章节：章节节点的父节点是所属卷。 */
	async getParent(element: ChapterNode): Promise<ChapterVolume | undefined> {
		if ('chapters' in element) {
			return undefined;
		}
		const book = this.library.getCurrentBook();
		if (!book) {
			return undefined;
		}
		const volumes = await this.library.listVolumes(book);
		return volumes.find((v) =>
			v.chapters.some((c) => c.fileName === element.fileName && (c.volumeDir ?? '') === (element.volumeDir ?? ''))
		);
	}

	getTreeItem(node: ChapterNode): vscode.TreeItem {
		return 'chapters' in node ? this.volumeItem(node) : this.chapterItem(node);
	}

	private volumeItem(volume: ChapterVolume): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const item = new vscode.TreeItem(volume.name, vscode.TreeItemCollapsibleState.Expanded);
		item.id = book ? `${book.dir}/${CHAPTERS_DIR}/${volume.dirName ?? ''}` : undefined;
		item.iconPath = this.volumeIcon;
		// 虚拟默认卷（根目录章节）无真实目录，不提供重命名/删除
		item.contextValue = volume.dirName ? 'volume' : 'volumeRoot';
		item.description = vscode.l10n.t('{0} chapters', volume.chapters.length);
		return item;
	}

	private chapterItem(chapter: ChapterFile): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const item = new vscode.TreeItem(chapter.title, vscode.TreeItemCollapsibleState.None);
		item.id = book
			? `${book.dir}/${CHAPTERS_DIR}/${chapter.volumeDir ? chapter.volumeDir + '/' : ''}${chapter.fileName}`
			: undefined;
		item.iconPath = this.chapterIcon;
		item.contextValue = 'chapter';
		item.tooltip = vscode.l10n.t('Chapter {0} · {1}', chapter.seq, chapterRelPath(chapter));
		if (book) {
			const progress = this.library.getProgress(book.dir);
			if (progress && (progress === chapter.fileName || progress === chapterRelPath(chapter))) {
				item.description = '●';
			}
			item.command = {
				command: 'xReader.openChapter',
				title: vscode.l10n.t('Open'),
				arguments: [book.dir, chapter.volumeDir, chapter.fileName],
			};
		}
		return item;
	}
}
