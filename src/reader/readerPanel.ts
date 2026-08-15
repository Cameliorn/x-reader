import * as vscode from 'vscode';
import type { BookMeta, Chapter } from '../model/book';
import { BookStore } from '../services/bookStore';

/**
 * 阅读面板（单例 Webview）。章节正文由扩展侧渲染，webview 内无脚本，
 * 翻页通过 command URI 链接回传，避免放宽 CSP。
 */
export class ReaderPanel {
	private static current: ReaderPanel | undefined;

	static show(store: BookStore, book: BookMeta, chapterIndex: number): void {
		if (ReaderPanel.current) {
			ReaderPanel.current.reveal(book, chapterIndex);
		} else {
			ReaderPanel.current = new ReaderPanel(store, book, chapterIndex);
		}
	}

	private readonly panel: vscode.WebviewPanel;
	private book: BookMeta;
	private chapterIndex: number;
	private renderSeq = 0;

	private constructor(
		private readonly store: BookStore,
		book: BookMeta,
		chapterIndex: number
	) {
		this.book = book;
		this.chapterIndex = chapterIndex;
		this.panel = vscode.window.createWebviewPanel(
			'xReader.reader',
			book.title,
			vscode.ViewColumn.One,
			{ enableScripts: false, enableCommandUris: ['xReader.openChapter'], retainContextWhenHidden: true }
		);
		this.panel.onDidDispose(() => {
			ReaderPanel.current = undefined;
		});
		void this.render();
	}

	static closeIfShowing(bookId: string): void {
		if (ReaderPanel.current?.book.id === bookId) {
			ReaderPanel.current.panel.dispose();
		}
	}

	private async reveal(book: BookMeta, chapterIndex: number): Promise<void> {
		this.book = book;
		this.chapterIndex = chapterIndex;
		this.panel.reveal(vscode.ViewColumn.One);
		await this.render();
	}

	private async render(): Promise<void> {
		const seq = ++this.renderSeq;
		const chapters = await this.store.getChapters(this.book);
		const index = clamp(this.chapterIndex, 0, chapters.length - 1);
		this.chapterIndex = index;

		const chapter = chapters[index];
		const body = await this.store.getChapterText(this.book, index);
		if (seq !== this.renderSeq) {
			return; // 已有更新的渲染请求，丢弃过期结果
		}
		this.panel.title = `${this.book.title} — ${chapter.title}`;
		this.panel.webview.html = buildHtml(chapter, index, chapters.length, body, this.book.id);
		await this.store.setLastRead(this.book.id, index);
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function buildHtml(chapter: Chapter, index: number, total: number, body: string, bookId: string): string {
	const paragraphs = splitParagraphs(body).map(escapeHtml).map((p) => `<p>${p}</p>`).join('\n');
	const nav = buildNav(bookId, index, total);
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
	body {
		max-width: 46rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
		font-family: var(--vscode-font-family);
		font-size: 16px;
		line-height: 1.9;
		color: var(--vscode-editor-foreground);
		background-color: var(--vscode-editor-background);
	}
	h1 {
		font-size: 1.4em;
		text-align: center;
		margin: 0 0 2em;
	}
	p {
		text-indent: 2em;
		margin: 0.5em 0;
	}
	.nav {
		display: flex;
		justify-content: center;
		gap: 2.5em;
		margin-top: 3em;
		padding-top: 1.5em;
		border-top: 1px solid var(--vscode-panel-border);
	}
	.nav a {
		font-size: 14px;
		color: var(--vscode-textLink-foreground);
		text-decoration: none;
	}
	.nav a.disabled {
		color: var(--vscode-disabledForeground);
		pointer-events: none;
	}
</style>
</head>
<body>
<h1>${escapeHtml(chapter.title)}</h1>
${paragraphs}
<div class="nav">${nav}</div>
</body>
</html>`;
}

function buildNav(bookId: string, index: number, total: number): string {
	const prev = index > 0
		? `<a href="command:xReader.openChapter?${navArgs(bookId, index - 1)}">‹ 上一章</a>`
		: '<a class="disabled">‹ 上一章</a>';
	const next = index < total - 1
		? `<a href="command:xReader.openChapter?${navArgs(bookId, index + 1)}">下一章 ›</a>`
		: '<a class="disabled">下一章 ›</a>';
	return `${prev}${next}`;
}

function navArgs(bookId: string, chapterIndex: number): string {
	return encodeURIComponent(JSON.stringify([bookId, chapterIndex]));
}

/** 按空行分段，段内行合并（中文 txt 常每行一段）。 */
function splitParagraphs(text: string): string[] {
	const groups: string[] = [];
	let current: string[] = [];
	const flush = (): void => {
		if (current.length > 0) {
			groups.push(current.join('').trim());
			current = [];
		}
	};
	for (const line of text.split(/\r\n|\r|\n/)) {
		if (line.trim().length === 0) {
			flush();
		} else {
			current.push(line.trim());
		}
	}
	flush();
	return groups.filter((g) => g.length > 0);
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
