import * as vscode from 'vscode';
import type { ChapterFile, ChapterVolume } from '../model/book';
import { CHAPTER_SUMMARIES_DIR, chapterRelPath, LibraryService } from '../services/library';

type SummaryChapter = ChapterFile & { hasSummary?: boolean };
type SummaryNode = ChapterVolume | SummaryChapter;

/** 章节摘要视图：按卷分组展示章节，✓ 标记已建摘要；点击打开（不存在则从模板创建）。 */
export class ChapterSummaryProvider implements vscode.TreeDataProvider<SummaryNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly library: LibraryService) {
        library.onDidChange(() => this._onDidChangeTreeData.fire());
    }

    async getChildren(element?: SummaryNode): Promise<SummaryNode[]> {
        const book = this.library.getCurrentBook();
        if (!book) {
            return [];
        }
        if (element === undefined) {
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
        return 'chapters' in element ? element.chapters : [];
    }

    getTreeItem(node: SummaryNode): vscode.TreeItem {
        return 'chapters' in node ? this.volumeItem(node) : this.chapterItem(node);
    }

    private volumeItem(volume: ChapterVolume): vscode.TreeItem {
        const book = this.library.getCurrentBook();
        const item = new vscode.TreeItem(volume.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = book ? `${book.dir}/${CHAPTER_SUMMARIES_DIR}/${volume.dirName ?? ''}` : undefined;
        item.iconPath = new vscode.ThemeIcon('library');
        item.contextValue = 'summaryVolume';
        const done = volume.chapters.filter((c) => (c as SummaryChapter).hasSummary).length;
        item.description = `${done}/${volume.chapters.length} 已建`;
        return item;
    }

    private chapterItem(chapter: SummaryChapter): vscode.TreeItem {
        const book = this.library.getCurrentBook();
        const item = new vscode.TreeItem(chapter.title, vscode.TreeItemCollapsibleState.None);
        item.id = book
            ? `${book.dir}/${CHAPTER_SUMMARIES_DIR}/${chapter.volumeDir ? chapter.volumeDir + '/' : ''}${chapter.fileName}`
            : undefined;
        item.iconPath = new vscode.ThemeIcon('note');
        item.contextValue = 'chapterSummary';
        item.description = chapter.hasSummary ? '✓' : undefined;
        item.tooltip = chapter.hasSummary
            ? `${chapterRelPath(chapter)} · 摘要已建`
            : `${chapterRelPath(chapter)} · 点击创建摘要`;
        if (book) {
            item.command = {
                command: 'xReader.openChapterSummary',
                title: '打开摘要',
                arguments: [book.dir, chapter.volumeDir, chapter.fileName],
            };
        }
        return item;
    }
}
