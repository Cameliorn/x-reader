import * as vscode from 'vscode';
import type {
	ChapterSummaryEntry,
	ChapterSummaryGroup,
	IntervalSummary,
	SummaryState,
	VolumeSummary,
} from '../model/book';
import {
	CHAPTER_SUMMARIES_DIR,
	chapterRelPath,
	INTERVAL_SUMMARIES_DIR,
	LibraryService,
	VOLUME_SUMMARIES_DIR,
} from '../services/library';
import { LibraryTreeProvider } from './libraryTreeProvider';

/** 顶层分组：卷摘要 / 区间摘要 / 章节摘要；children 在取根节点时一次算好，展开时不重复扫描。 */
interface GroupNode {
	kind: 'volumeSummaries' | 'chapterSummaries' | 'intervalSummaries';
	description: string;
	children: SummaryNode[];
}

type SummaryNode = GroupNode | VolumeSummary | ChapterSummaryGroup | ChapterSummaryEntry | IntervalSummary;

/** 状态标记：✓ 最新、⚠ 待维护、✎ 计划（目标尚未写全）；未创建不显示。 */
const stateMark = (state: SummaryState | undefined): string | undefined =>
	state === 'ok' ? '✓' : state === 'stale' ? '⚠' : state === 'planned' ? '✎' : undefined;

/** 计划条目的描述：标记 + 「计划」字样，与已建 / 待维护区分。 */
const planMark = (): string => `✎ ${vscode.l10n.t('Plan')}`;

/** 摘要视图：顶层分 卷摘要（卷）/ 区间摘要（每 10 章）/ 章节摘要（卷→章）三组，✓ 最新 / ⚠ 待维护 / ✎ 计划；点击打开（不存在则从模板创建）。 */
export class SummaryProvider extends LibraryTreeProvider<SummaryNode> {
	constructor(
		library: LibraryService,
		private readonly groupIcon: vscode.Uri,
		private readonly volumeIcon: vscode.Uri,
		private readonly chapterSummaryIcon: vscode.Uri,
		private readonly intervalIcon: vscode.Uri,
		private readonly volumeSummaryIcon: vscode.Uri
	) {
		super(library);
	}

	async getChildren(element?: SummaryNode): Promise<SummaryNode[]> {
		const book = this.library.getCurrentBook();
		if (!book) {
			return [];
		}
		if (element === undefined) {
			const volumes = await this.library.listVolumes(book);
			const [states, intervals, volumeSummaries] = await Promise.all([
				this.library.listChapterSummaryStates(book, volumes),
				this.library.listIntervalSummaries(book),
				this.library.listVolumeSummaries(book, volumes),
			]);
			// 无章节也无任何摘要 / 计划时置空，让 viewsWelcome 的空态提示生效
			if (states.size === 0 && intervals.length === 0 && !volumeSummaries.some((s) => s.state !== 'missing')) {
				return [];
			}
			return [
				{
					kind: 'volumeSummaries',
					description: this.countDescription(volumeSummaries.map((summary) => summary.state)),
					children: volumeSummaries,
				},
				{
					kind: 'intervalSummaries',
					description: this.countDescription(intervals.map((i) => i.state)),
					children: intervals,
				},
				{
					kind: 'chapterSummaries',
					description: this.countDescription([...states.values()]),
					children: await this.library.listChapterSummaries(book),
				},
			];
		}
		if ('kind' in element) {
			return element.children;
		}
		return 'entries' in element ? element.entries : [];
	}

	/** 分组/分卷描述：已建比例 + 待维护数量 + 计划数量。 */
	private countDescription(states: SummaryState[]): string {
		const done = states.filter((state) => state !== 'missing').length;
		const parts = [vscode.l10n.t('{0}/{1} created', done, states.length)];
		const stale = states.filter((state) => state === 'stale').length;
		if (stale > 0) {
			parts.push(vscode.l10n.t('{0} stale', stale));
		}
		const planned = states.filter((state) => state === 'planned').length;
		if (planned > 0) {
			parts.push(vscode.l10n.t('{0} planned', planned));
		}
		return parts.join(' · ');
	}

	getTreeItem(node: SummaryNode): vscode.TreeItem {
		if ('kind' in node) {
			return this.groupItem(node);
		}
		if ('startSeq' in node) {
			return this.intervalItem(node);
		}
		if ('entries' in node) {
			return this.summaryGroupItem(node);
		}
		return 'seq' in node ? this.chapterItem(node) : this.volumeSummaryItem(node);
	}

	private groupItem(group: GroupNode): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const titles = {
			volumeSummaries: vscode.l10n.t('Volume Summaries'),
			intervalSummaries: vscode.l10n.t('Interval Summaries'),
			chapterSummaries: vscode.l10n.t('Chapter Summaries'),
		};
		const item = new vscode.TreeItem(titles[group.kind], vscode.TreeItemCollapsibleState.Expanded);
		item.id = book ? `${book.dir}/summaries/${group.kind}` : undefined;
		item.iconPath = this.groupIcon;
		item.contextValue = 'summaryGroup';
		item.description = group.description;
		return item;
	}

	private volumeSummaryItem(summary: VolumeSummary): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const item = new vscode.TreeItem(summary.name, vscode.TreeItemCollapsibleState.None);
		item.id = book ? `${book.dir}/${VOLUME_SUMMARIES_DIR}/${summary.fileName}` : undefined;
		item.iconPath = this.volumeSummaryIcon;
		// 只有还没写正文的卷摘要（未来卷 / 空卷）与计划状态的卷摘要能删；有正文的随分卷删除级联清理
		const deletable = summary.state === 'planned' || summary.chapters.length === 0;
		item.contextValue = deletable ? 'plannedVolumeSummary' : 'volumeSummary';
		item.description = summary.state === 'planned' ? planMark() : stateMark(summary.state);
		const state =
			summary.state === 'planned'
				? vscode.l10n.t('plan (chapters in this volume still unwritten)')
				: summary.state === 'stale'
					? vscode.l10n.t('needs update')
					: summary.state === 'ok'
						? vscode.l10n.t('summary created')
						: vscode.l10n.t('click to create summary');
		item.tooltip = `${summary.fileName} · ${vscode.l10n.t('{0} chapters', summary.chapters.length)}\n${state}`;
		if (book) {
			item.command = {
				command: 'xReader.openVolumeSummary',
				title: vscode.l10n.t('Open Volume Summary'),
				arguments: [book.dir, summary],
			};
		}
		return item;
	}

	private summaryGroupItem(group: ChapterSummaryGroup): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const item = new vscode.TreeItem(group.name, vscode.TreeItemCollapsibleState.Expanded);
		item.id = book ? `${book.dir}/${CHAPTER_SUMMARIES_DIR}/${group.dirName ?? ''}` : undefined;
		item.iconPath = this.volumeIcon;
		item.contextValue = 'summaryVolume';
		item.description = this.countDescription(group.entries.map((entry) => entry.state));
		return item;
	}

	private chapterItem(entry: ChapterSummaryEntry): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const item = new vscode.TreeItem(entry.title, vscode.TreeItemCollapsibleState.None);
		item.id = book
			? `${book.dir}/${CHAPTER_SUMMARIES_DIR}/${entry.volumeDir ? entry.volumeDir + '/' : ''}${entry.fileName}`
			: undefined;
		item.iconPath = this.chapterSummaryIcon;
		// 计划章节（正文尚未创建）单独给一个 contextValue：「按计划写正文」与「删除」只对它显示（有正文的摘要随正文一起删）
		item.contextValue = entry.state === 'planned' ? 'plannedChapterSummary' : 'chapterSummary';
		item.description = entry.state === 'planned' ? planMark() : stateMark(entry.state);
		const relPath = chapterRelPath(entry);
		item.tooltip =
			entry.state === 'planned'
				? vscode.l10n.t('{0} · plan (chapter not created yet)', relPath)
				: entry.state === 'stale'
					? vscode.l10n.t('{0} · needs update', relPath)
					: entry.state === 'ok'
						? vscode.l10n.t('{0} · summary created', relPath)
						: vscode.l10n.t('{0} · click to create summary', relPath);
		if (book) {
			item.command = {
				command: 'xReader.openChapterSummary',
				title: vscode.l10n.t('Open Summary'),
				arguments: [book.dir, entry.volumeDir, entry.fileName],
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
		// 计划区间（起止越出现存章节范围）才有删除入口；已覆盖正文的区间只能改起止
		item.contextValue = interval.state === 'planned' ? 'plannedIntervalSummary' : 'intervalSummary';
		item.description = interval.state === 'planned' ? planMark() : stateMark(interval.state);
		const chapterList = interval.chapters.map((c) => c.title).join('、');
		const state =
			interval.state === 'planned'
				? vscode.l10n.t('plan (chapters not created yet)')
				: interval.state === 'stale'
					? vscode.l10n.t('needs update')
					: interval.state === 'ok'
						? vscode.l10n.t('summary created')
						: vscode.l10n.t('click to create summary');
		item.tooltip = `${label} · ${vscode.l10n.t('{0} chapters', interval.chapters.length)}\n${chapterList ? `${chapterList}\n` : ''}${state}`;
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
