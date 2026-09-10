import * as vscode from 'vscode';
import { LibraryService } from '../services/library';
import { LibraryTreeProvider } from './libraryTreeProvider';

/** frontmatter 常用键的显示标签；未列出的键原样显示。 */
const FIELD_LABELS: Record<string, () => string> = {
    title: () => vscode.l10n.t('Title'),
    author: () => vscode.l10n.t('Author'),
    created: () => vscode.l10n.t('Created'),
};

/** 元数据项：frontmatter 字段或正文小节，点击跳到 元数据.md 对应行。 */
export interface MetadataNode {
    /** 显示名（字段标签或小节标题） */
    label: string;
    /** 完整值（作 tooltip） */
    value: string;
    /** 目标行号（0 起） */
    line: number;
}

/** 值预览：折叠空白后截断；空值显示空态文案。 */
function preview(value: string): string {
    const flat = value.replace(/\s+/g, ' ').trim();
    if (flat.length === 0) {
        return vscode.l10n.t('(empty)');
    }
    return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

/** 元数据视图：展示当前书 元数据.md 的字段与正文小节。 */
export class MetadataProvider extends LibraryTreeProvider<MetadataNode> {
    constructor(library: LibraryService, private readonly metaIcon: vscode.Uri) {
        super(library);
    }

    async getChildren(element?: MetadataNode): Promise<MetadataNode[]> {
        if (element) {
            return [];
        }
        const book = this.library.getCurrentBook();
        if (!book) {
            return [];
        }
        const meta = await this.library.readMetadata(book);
        if (!meta) {
            return [];
        }
        return [
            ...meta.fields.map((field) => ({
                label: FIELD_LABELS[field.key]?.() ?? field.key,
                value: field.value,
                line: field.line,
            })),
            ...meta.sections.map((section) => ({
                label: section.title,
                value: section.body,
                line: section.line,
            })),
        ];
    }

    getTreeItem(node: MetadataNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `metadata:${node.line}`;
        item.iconPath = this.metaIcon;
        item.description = preview(node.value);
        item.tooltip = node.value.trim() || undefined;
        item.command = {
            command: 'xReader.openMetadata',
            title: vscode.l10n.t('Open'),
            arguments: [node.line],
        };
        return item;
    }
}
