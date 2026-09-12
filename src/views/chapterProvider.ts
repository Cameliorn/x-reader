import * as vscode from 'vscode';
import type { BookInfo, ChapterFile, ChapterVolume, EntryFile } from '../model/book';
import {
	chapterRelPath,
	CHAPTERS_DIR,
	LibraryService,
	matchesProgress,
	sameChapter,
	VERSIONS_DIR,
} from '../services/library';
import { LibraryTreeProvider } from './libraryTreeProvider';

/** 章节的备选版本节点。 */
export interface ChapterVersionNode extends EntryFile {
	/** 区分于卷/章节节点的判别字段 */
	kind: 'version';
	/** 所属章节 */
	chapter: ChapterFile;
}

type ChapterNode = ChapterVolume | ChapterFile | ChapterVersionNode;

/** 章节目录视图：按卷分组展示当前书的章节文件（有备选版本的章节可展开），● 标记上次读到。 */
export class ChapterProvider extends LibraryTreeProvider<ChapterNode> {
	/** 章节相对路径 → 备选版本数（getChildren 组装卷时填充）。 */
	private versionCounts = new Map<string, number>();

	constructor(
		library: LibraryService,
		private readonly volumeIcon: vscode.Uri,
		private readonly chapterIcon: vscode.Uri,
		private readonly versionIcon: vscode.Uri
	) {
		super(library);
	}

	protected onLibraryChanged(): void {
		this.versionCounts.clear();
	}

	async getChildren(element?: ChapterNode): Promise<ChapterNode[]> {
		if (element === undefined) {
			const book = this.library.getCurrentBook();
			return book ? this.loadVolumes(book) : [];
		}
		if ('chapters' in element) {
			return element.chapters;
		}
		// ChapterFile 有 seq，版本节点没有；据此收窄联合类型
		if (!('seq' in element)) {
			return [];
		}
		const book = this.library.getCurrentBook();
		if (!book) {
			return [];
		}
		const versions = await this.library.listChapterVersions(book, element);
		return versions.map((v) => ({ kind: 'version' as const, chapter: element, ...v }));
	}

	/** 列出分卷并统计各章节的备选版本数（每卷一次目录扫描）。 */
	private async loadVolumes(book: BookInfo): Promise<ChapterVolume[]> {
		const volumes = await this.library.listVolumes(book);
		await Promise.all(
			volumes.map(async (volume) => {
				const counts = await this.library.listVolumeVersionCounts(book, volume.dirName);
				for (const [base, count] of counts) {
					const chapter = volume.chapters.find((c) => c.fileName.replace(/\.md$/, '') === base);
					if (chapter) {
						this.versionCounts.set(chapterRelPath(chapter), count);
					}
				}
			})
		);
		return volumes;
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
		const chapter = 'seq' in element ? element : element.chapter;
		return volumes.find((v) => v.chapters.some((c) => sameChapter(c, chapter)));
	}

	getTreeItem(node: ChapterNode): vscode.TreeItem {
		if ('chapters' in node) {
			return this.volumeItem(node);
		}
		return 'seq' in node ? this.chapterItem(node) : this.versionItem(node);
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
		const versionCount = this.versionCounts.get(chapterRelPath(chapter)) ?? 0;
		const item = new vscode.TreeItem(
			chapter.title,
			versionCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
		);
		item.id = book
			? `${book.dir}/${CHAPTERS_DIR}/${chapter.volumeDir ? chapter.volumeDir + '/' : ''}${chapter.fileName}`
			: undefined;
		item.iconPath = this.chapterIcon;
		item.contextValue = 'chapter';
		item.tooltip = vscode.l10n.t('Chapter {0} · {1}', chapter.seq, chapterRelPath(chapter));
		if (book) {
			if (matchesProgress(chapter, this.library.getProgress(book.dir))) {
				item.description = '●';
			}
			if (versionCount > 0) {
				item.description = [item.description, vscode.l10n.t('{0} versions', versionCount)]
					.filter(Boolean)
					.join(' · ');
			}
			item.command = {
				command: 'xReader.openChapter',
				title: vscode.l10n.t('Open'),
				arguments: [book.dir, chapter.volumeDir, chapter.fileName],
			};
		}
		return item;
	}

	private versionItem(node: ChapterVersionNode): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
		item.id = book
			? `${book.dir}/${VERSIONS_DIR}/${node.chapter.volumeDir ? node.chapter.volumeDir + '/' : ''}${node.chapter.fileName.replace(/\.md$/, '')}/${node.fileName}`
			: undefined;
		item.iconPath = this.versionIcon;
		item.contextValue = 'chapterVersion';
		item.tooltip = vscode.l10n.t('Version of chapter “{0}”', node.chapter.title);
		if (book) {
			item.command = {
				command: 'xReader.openChapterVersion',
				title: vscode.l10n.t('Open'),
				arguments: [node],
			};
		}
		return item;
	}
}
