import * as vscode from 'vscode';
import type { BookMeta, Chapter } from '../model/book';
import { decodeBuffer, getChapterText, parseChapters } from './novelParser';

/** 书籍元数据与书籍文件的统一存取入口。 */
export class BookStore {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private readonly booksKey = 'x-reader.books.v1';
	private readonly currentKey = 'x-reader.currentBook.v1';

	private books: BookMeta[];
	private currentBookId: string | undefined;
	/** 最近解码的正文缓存，连续切换章节时避免重复解码 */
	private textCache: { bookId: string; text: string } | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.books = context.globalState.get<BookMeta[]>(this.booksKey) ?? [];
		this.currentBookId = context.globalState.get<string>(this.currentKey);
	}

	getBooks(): BookMeta[] {
		return this.books;
	}

	getBook(id: string): BookMeta | undefined {
		return this.books.find((b) => b.id === id);
	}

	getCurrentBook(): BookMeta | undefined {
		return this.currentBookId ? this.getBook(this.currentBookId) : undefined;
	}

	async setCurrentBook(id: string): Promise<void> {
		if (!this.getBook(id)) {
			return;
		}
		this.currentBookId = id;
		await this.context.globalState.update(this.currentKey, id);
	}

	/** 导入 txt：解码 → 解析章节 → 拷贝书籍文件与章节缓存到 globalStorage。 */
	async importBook(fileUri: vscode.Uri): Promise<BookMeta> {
		const bytes = await vscode.workspace.fs.readFile(fileUri);
		const text = decodeBuffer(bytes);
		const chapters = parseChapters(text);

		const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
		const bookDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'books', id);
		await vscode.workspace.fs.createDirectory(bookDir);
		await vscode.workspace.fs.copy(fileUri, vscode.Uri.joinPath(bookDir, 'book.txt'), { overwrite: true });
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(bookDir, 'chapters.json'),
			Buffer.from(JSON.stringify(chapters), 'utf8')
		);

		const meta: BookMeta = {
			id,
			title: stripExtension(fileUri),
			fileName: fileUri.path.split('/').pop() ?? 'book.txt',
			addedAt: Date.now(),
			lastReadChapter: -1,
		};
		this.books.unshift(meta);
		await this.persistBooks();
		this.textCache = { bookId: id, text };
		this._onDidChange.fire();
		return meta;
	}

	async removeBook(id: string): Promise<void> {
		this.books = this.books.filter((b) => b.id !== id);
		await this.persistBooks();
		if (this.currentBookId === id) {
			this.currentBookId = undefined;
			await this.context.globalState.update(this.currentKey, undefined);
		}
		await vscode.workspace.fs.delete(
			vscode.Uri.joinPath(this.context.globalStorageUri, 'books', id),
			{ recursive: true, useTrash: false }
		);
		this.textCache = undefined;
		this._onDidChange.fire();
	}

	/** 章节列表：优先读缓存，缺失时从正文重解析并写回。 */
	async getChapters(book: BookMeta): Promise<Chapter[]> {
		const chaptersUri = vscode.Uri.joinPath(this.context.globalStorageUri, 'books', book.id, 'chapters.json');
		try {
			const data = await vscode.workspace.fs.readFile(chaptersUri);
			return JSON.parse(Buffer.from(data).toString('utf8')) as Chapter[];
		} catch {
			const text = await this.getText(book);
			const chapters = parseChapters(text);
			await vscode.workspace.fs.writeFile(chaptersUri, Buffer.from(JSON.stringify(chapters), 'utf8'));
			return chapters;
		}
	}

	async getChapterText(book: BookMeta, chapterIndex: number): Promise<string> {
		const chapters = await this.getChapters(book);
		const chapter = chapters[chapterIndex];
		if (!chapter) {
			throw new Error(`章节不存在: ${chapterIndex}`);
		}
		const text = await this.getText(book);
		return getChapterText(text, chapter);
	}

	async getChapterCount(book: BookMeta): Promise<number> {
		return (await this.getChapters(book)).length;
	}

	/** 记录阅读进度并触发视图刷新。 */
	async setLastRead(bookId: string, chapterIndex: number): Promise<void> {
		const book = this.getBook(bookId);
		if (!book || book.lastReadChapter === chapterIndex) {
			return;
		}
		book.lastReadChapter = chapterIndex;
		await this.persistBooks();
		this._onDidChange.fire();
	}

	private async getText(book: BookMeta): Promise<string> {
		if (this.textCache?.bookId === book.id) {
			return this.textCache.text;
		}
		const data = await vscode.workspace.fs.readFile(
			vscode.Uri.joinPath(this.context.globalStorageUri, 'books', book.id, 'book.txt')
		);
		const text = decodeBuffer(data);
		this.textCache = { bookId: book.id, text };
		return text;
	}

	private async persistBooks(): Promise<void> {
		await this.context.globalState.update(this.booksKey, this.books);
	}
}

function stripExtension(uri: vscode.Uri): string {
	const name = uri.path.split('/').pop() ?? 'book.txt';
	return name.replace(/\.txt$/i, '');
}
