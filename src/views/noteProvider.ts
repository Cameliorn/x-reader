import * as vscode from 'vscode';
import type { NoteCategory, NoteFile } from '../model/book';
import { LibraryService, NOTES_DIR } from '../services/library';
import { LibraryTreeProvider } from './libraryTreeProvider';

type NoteNode = NoteCategory | (NoteFile & { bookDir: string; subDir: string });

const isCategory = (node: NoteNode): node is NoteCategory => 'dirName' in node;

/** 笔记视图：分类目录（可折叠）+ 未分类笔记；点击打开笔记。 */
export class NoteProvider extends LibraryTreeProvider<NoteNode> {
	constructor(library: LibraryService) {
		super(library);
	}

	async getChildren(element?: NoteNode): Promise<NoteNode[]> {
		const book = this.library.getCurrentBook();
		if (!book) {
			return [];
		}
		if (element === undefined) {
			const [categories, rootNotes] = await Promise.all([
				this.library.listNoteCategories(book),
				this.library.listNotes(book),
			]);
			return [...categories, ...rootNotes.map((note) => this.withContext(book.dir, note))];
		}
		if (isCategory(element)) {
			const notes = await this.library.listNotes(book, element.dirName);
			return notes.map((note) => this.withContext(book.dir, note));
		}
		return [];
	}

	private withContext(bookDir: string, note: NoteFile): NoteFile & { bookDir: string; subDir: string } {
		return {
			...note,
			bookDir,
			subDir: note.categoryDir ? `${NOTES_DIR}/${note.categoryDir}` : NOTES_DIR,
		};
	}

	getTreeItem(node: NoteNode): vscode.TreeItem {
		return isCategory(node) ? this.categoryItem(node) : this.noteItem(node);
	}

	private categoryItem(category: NoteCategory): vscode.TreeItem {
		const book = this.library.getCurrentBook();
		const item = new vscode.TreeItem(category.name, vscode.TreeItemCollapsibleState.Collapsed);
		item.id = book ? `${book.dir}/${NOTES_DIR}/${category.dirName}` : undefined;
		item.iconPath = new vscode.ThemeIcon('folder');
		item.contextValue = 'noteCategory';
		item.tooltip = vscode.l10n.t('Category: {0}', category.dirName);
		return item;
	}

	private noteItem(note: NoteFile & { bookDir: string; subDir: string }): vscode.TreeItem {
		const item = new vscode.TreeItem(note.name, vscode.TreeItemCollapsibleState.None);
		item.id = `${note.bookDir}/${note.subDir}/${note.fileName}`;
		item.iconPath = new vscode.ThemeIcon('note');
		item.contextValue = 'note';
		item.tooltip = `${note.subDir}/${note.fileName}`;
		item.command = {
			command: 'xReader.openEntry',
			title: vscode.l10n.t('Open Note'),
			arguments: [note.bookDir, note.subDir, note.fileName],
		};
		return item;
	}
}
