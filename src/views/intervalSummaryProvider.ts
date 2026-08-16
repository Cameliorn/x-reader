import * as vscode from 'vscode';
import type { IntervalSummary } from '../model/book';
import { INTERVAL_SUMMARIES_DIR, LibraryService } from '../services/library';

/** 区间摘要视图：每 10 章一个区间，✓ 标记已建摘要；点击打开（不存在则从模板创建）。 */
export class IntervalSummaryProvider implements vscode.TreeDataProvider<IntervalSummary> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly library: LibraryService) {
        library.onDidChange(() => this._onDidChangeTreeData.fire());
    }

    async getChildren(element?: IntervalSummary): Promise<IntervalSummary[]> {
        if (element !== undefined) {
            return [];
        }
        const book = this.library.getCurrentBook();
        return book ? this.library.listIntervalSummaries(book) : [];
    }

    getTreeItem(interval: IntervalSummary): vscode.TreeItem {
        const book = this.library.getCurrentBook();
        const label =
            interval.startSeq === interval.endSeq
                ? `第 ${interval.startSeq} 章`
                : `第 ${interval.startSeq}–${interval.endSeq} 章`;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = book ? `${book.dir}/${INTERVAL_SUMMARIES_DIR}/${interval.fileName}` : undefined;
        item.iconPath = new vscode.ThemeIcon('notebook');
        item.contextValue = 'intervalSummary';
        item.description = interval.exists ? '✓' : undefined;
        const chapterList = interval.chapters.map((c) => c.title).join('、');
        item.tooltip = `${label}（${interval.chapters.length} 章）\n${chapterList}\n${interval.exists ? '摘要已建' : '点击创建摘要'}`;
        if (book) {
            item.command = {
                command: 'xReader.openIntervalSummary',
                title: '打开区间摘要',
                arguments: [book.dir, interval],
            };
        }
        return item;
    }
}
