import * as iconv from 'iconv-lite';
import { TextDecoder } from 'util';
import type { Chapter } from '../model/book';

/**
 * 将 txt 原始字节解码为字符串：
 * BOM 优先 → 无 BOM UTF-16 启发 → UTF-8 严格解码 → GB18030 回退。
 */
export function decodeBuffer(data: Uint8Array): string {
	const buf = Buffer.from(data);
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
		return iconv.decode(buf.subarray(3), 'utf8');
	}
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
		return iconv.decode(buf.subarray(2), 'utf16le');
	}
	if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
		return iconv.decode(buf.subarray(2), 'utf16-be');
	}
	const utf16 = detectUtf16(buf);
	if (utf16) {
		return iconv.decode(buf, utf16 === 'le' ? 'utf16le' : 'utf16-be');
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(buf);
	} catch {
		return iconv.decode(buf, 'gb18030');
	}
}

function detectUtf16(buf: Buffer): 'le' | 'be' | undefined {
	let nulCount = 0;
	for (let i = 0; i < Math.min(buf.length, 4096); i++) {
		if (buf[i] === 0) {
			nulCount++;
		}
	}
	if (nulCount / Math.min(buf.length, 4096) < 0.1) {
		return undefined;
	}
	// 高字节位 0 多为 UTF-16BE（偶数位），低字节位 0 多为 UTF-16LE（奇数位）
	let evenNul = 0;
	let oddNul = 0;
	for (let i = 0; i < Math.min(buf.length, 4096); i += 2) {
		if (buf[i] === 0) {
			evenNul++;
		}
		if (i + 1 < buf.length && buf[i + 1] === 0) {
			oddNul++;
		}
	}
	return evenNul >= oddNul ? 'be' : 'le';
}

// 主模式：第X章 / 第X回 / 第X卷 / 第X节 等
const CN_CHAPTER_RE = /^\s*第\s*([0-9零〇一二两三四五六七八九十百千万]+(?:\.[0-9]+)?)\s*([章节回卷部篇集话])\s*[：:、.．\-—\s]*(.*)$/;
// 特殊章节名
const SPECIAL_RE = /^\s*(序章|楔子|序言|前言|引子|番外|尾声|后记|后序)(?:[：:、.．\-—\s].*)?$/;
// 英文章节
const EN_CHAPTER_RE = /^\s*chapter\s+([0-9]+)\s*[：:、.．\-—\s]*(.*)$/i;
// 纯数字编号标题，如 "1、初见"
const NUM_TITLE_RE = /^\s*([0-9]{1,4})\s*[、.．]\s*\S+/;

function matchTitle(line: string): string | undefined {
	if (line.length > 60) {
		return undefined; // 超长行按正文处理
	}
	if (CN_CHAPTER_RE.test(line) || SPECIAL_RE.test(line) || EN_CHAPTER_RE.test(line) || NUM_TITLE_RE.test(line)) {
		return line.trim();
	}
	return undefined;
}

/**
 * 按行解析章节目录。解析失败（无任何章节）时返回整书为单章。
 * 正文为空的标题（如书首目录页中重复的章节名、卷标题）会被丢弃。
 */
export function parseChapters(text: string): Chapter[] {
	const lines = text.split(/\r\n|\r|\n/);
	const starts: number[] = [];
	const titles: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const title = matchTitle(lines[i]);
		if (title) {
			starts.push(i);
			titles.push(title);
		}
	}
	const chapters = starts.map((start, idx) => ({
		title: titles[idx],
		startLine: start,
		endLine: idx + 1 < starts.length ? starts[idx + 1] - 1 : lines.length - 1,
	})).filter((chapter) => hasBody(lines, chapter));
	// 书首目录页与正文标题重复时，保留最后一次出现（正文中的）
	const lastSeen = new Map<string, number>();
	chapters.forEach((chapter, idx) => lastSeen.set(normalizeTitle(chapter.title), idx));
	const deduped = chapters.filter((chapter, idx) => lastSeen.get(normalizeTitle(chapter.title)) === idx);
	if (deduped.length === 0) {
		return [{ title: '全文', startLine: 0, endLine: Math.max(0, lines.length - 1) }];
	}
	return deduped;
}

/** 标题行之后到下一标题之间是否存在非空正文行。 */
function hasBody(lines: string[], chapter: Chapter): boolean {
	for (let i = chapter.startLine + 1; i <= Math.min(chapter.endLine, lines.length - 1); i++) {
		if (lines[i].trim().length > 0) {
			return true;
		}
	}
	return false;
}

/** 目录去重用的标题规范化：去尾部页码与标点空白差异。 */
function normalizeTitle(title: string): string {
	return title
		.replace(/\s*[.．·…—\-~]*\s*[0-9]{1,5}\s*$/, '')
		.replace(/[\s：:、.．\-—]/g, '');
}

/** 提取某一章的正文文本（不含标题行）。 */
export function getChapterText(text: string, chapter: Chapter): string {
	const lines = text.split(/\r\n|\r|\n/);
	const end = Math.min(chapter.endLine, lines.length - 1);
	const body = [];
	for (let i = chapter.startLine + 1; i <= end; i++) {
		body.push(lines[i]);
	}
	return body.join('\n');
}
