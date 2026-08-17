import * as vscode from 'vscode';
import type { ChapterFile, ChapterVolume, IntervalSummary } from '../model/book';
import { CHAPTER_SUMMARIES_DIR, chapterRelPath, INTERVAL_SUMMARIES_DIR, LibraryService } from '../services/library';
import { LibraryTreeProvider } from './libraryTreeProvider';

type SummaryChapter = ChapterFile & { hasSummary?: boolean };

/** 顶层分组：章节摘要 / 区间摘要。 */
interface GroupNode {
	kind: 'chapterSummaries' | 'intervalSummaries';
	description: string;
}

type SummaryNode = GroupNode | ChapterVolume | SummaryChapter | IntervalSummary;

/** 摘要视图：顶层分 章节摘要（卷→章）与 区间摘要（每 10 章一个区间）两组，✓ 标记已建；点击打开（不存在则从模板创建）。 */
export class SummaryProvider extends LibraryTreeProvider<SummaryNode> {
	constructor(
		library: LibraryService,
		private readonly groupIcon: vscode.Uri,
		private readonly volumeIcon: vscode.Uri,
		private readonly chapterSummaryIcon: vscode.Uri,
		private readonly intervalIcon: vscode.Uri
	) {
		super(library);
	}

	async getChildren(element?: SummaryNode): Promise<SummaryNode[]> {
		const book = this.library.getCurrentBook();
		if (!book) {
			return [];
		}
		if (element === undefined) {
			const [volumes, keys, intervals] = await Promise.all([
				this.library.listVolumes(book),
				this.library.listChapterSummaryKeys(book),
				this.library.listIntervalSummaries(book),
			]);
			const total = volumes.reduce((n, volume) => n + volume.chapters.length, 0);
			if (total === 0) {
				// 无章节时置空，让 viewsWelcome 的空态提示生效
				return [];
			}
			const done = volumes.reduce(
				(n, volume) => n + volume.chapters.filter((c) => keys.has(chapterRelPath(c))).length,
				0
			);
			const intervalDone = intervals.filter((i) => i.exists).length;
			return [
				{
					kind: 'chapterSummaries',
					description: vscode.l10n.t('{0}/{1} created', done, total),
				},
				{
					kind: 'intervalSummaries',
					description: vscode.l10n.t('{0}/{1} created', intervalDone, intervals.length),
				},
			];
		}
		if ('kind' in element) {
			if (element.kind === 'intervalSummaries') {
				return this.library.listIntervalSummaries(book);
			}
			const [volumes, keys] = await Promise.all([
				this.library.listVolumes(book),
				this.library.listChapterSummaryKeys(book),
			]);
			return volumes.map((volume) => ({
				...volume,
				chapters: volume.chapters.map((chapter) => ({
					...chapter,
					hasSummary: keys.has(chapterRelPath(chapter)),
				})),
			}));
		}
		return 'chapters' in element && !('startSeq' in element) ? element.chapters : [];
	}

	getTreeItem(node: SummaryNode): vscode.TreeItem {
		if ('kind' in node) {
			return this.groupItem(node);
		}
		if ('startSeq' in node) {
			return this.intervalItem(node);
		}
		return 'chapters' in node ? this.volumeItem(node) : this.chapterItem(node);
	}

	private groupItem(group: GroupNode): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const isChapter = group.kind === 'chapterSummaries';
		const item = new vscode.TreeItem(
			isChapter ? vscode.l10n.t('Chapter Summaries') : vscode.l10n.t('Interval Summaries'),
			vscode.TreeItemCollapsibleState.Expanded
		);
		item.id = book ? `${book.dir}/summaries/${group.kind}` : undefined;
		item.iconPath = this.groupIcon;
		item.contextValue = 'summaryGroup';
		item.description = group.description;
		return item;
	}

	private volumeItem(volume: ChapterVolume): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const item = new vscode.TreeItem(volume.name, vscode.TreeItemCollapsibleState.Expanded);
		item.id = book ? `${book.dir}/${CHAPTER_SUMMARIES_DIR}/${volume.dirName ?? ''}` : undefined;
		item.iconPath = this.volumeIcon;
		item.contextValue = 'summaryVolume';
		const done = volume.chapters.filter((c) => (c as SummaryChapter).hasSummary).length;
		item.description = vscode.l10n.t('{0}/{1} created', done, volume.chapters.length);
		return item;
	}

	private chapterItem(chapter: SummaryChapter): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const item = new vscode.TreeItem(chapter.title, vscode.TreeItemCollapsibleState.None);
		item.id = book
			? `${book.dir}/${CHAPTER_SUMMARIES_DIR}/${chapter.volumeDir ? chapter.volumeDir + '/' : ''}${chapter.fileName}`
			: undefined;
		item.iconPath = this.chapterSummaryIcon;
		item.contextValue = 'chapterSummary';
		item.description = chapter.hasSummary ? '✓' : undefined;
		item.tooltip = chapter.hasSummary
			? vscode.l10n.t('{0} · summary created', chapterRelPath(chapter))
			: vscode.l10n.t('{0} · click to create summary', chapterRelPath(chapter));
		if (book) {
			item.command = {
				command: 'xReader.openChapterSummary',
				title: vscode.l10n.t('Open Summary'),
				arguments: [book.dir, chapter.volumeDir, chapter.fileName],
			};
		}
		return item;
	}

	private intervalItem(interval: IntervalSummary): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const label =
			interval.startSeq === interval.endSeq
				? vscode.l10n.t('Chapter {0}', interval.startSeq)
				: vscode.l10n.t('Chapters {0}–{1}', interval.startSeq, interval.endSeq);
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
		item.id = book ? `${book.dir}/${INTERVAL_SUMMARIES_DIR}/${interval.fileName}` : undefined;
		item.iconPath = this.intervalIcon;
		item.contextValue = 'intervalSummary';
		item.description = interval.exists ? '✓' : undefined;
		const chapterList = interval.chapters.map((c) => c.title).join('、');
		item.tooltip = `${label}（${interval.chapters.length} 章）\n${chapterList}\n${interval.exists
			? vscode.l10n.t('summary created')
			: vscode.l10n.t('click to create summary')
			}`;
		if (book) {
			item.command = {
				command: 'xReader.openIntervalSummary',
				title: vscode.l10n.t('Open Interval Summary'),
				arguments: [book.dir, interval],
			};
		}
		return item;
	}
}
