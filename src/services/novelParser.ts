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

// 中文/阿拉伯数字字符类（匹配前已做全角→半角归一化）
const CN_NUM = '0-9零〇一二两三四五六七八九十百千万拾佰仟';
// 主模式：第X章 / 第X回 / 第X卷 / 第X节 等
const CN_CHAPTER_RE = new RegExp(`^第\\s*[${CN_NUM}]+(?:\\.[0-9]+)?\\s*[章节回卷部篇集话]`);
// 全X章（全本一章），如 "全一章"
const QUAN_RE = new RegExp(`^全[${CN_NUM}]+章(?=$|[：:、.．\\-—\\s])`);
// 第X天（日记式分章），单位词后须紧跟分隔符或结尾，防 "第三天他就…" 类正文
const DAY_RE = new RegExp(`^第\\s*[${CN_NUM}]+\\s*天(?=$|[：:、.．\\-—\\s])`);
// 卷X 风格标题，如 "卷一 风起"
const VOLUME_RE = new RegExp(`^卷[${CN_NUM}]+(?=$|[：:、.．\\-—\\s])`);
// 特殊章节名
const SPECIAL_RE = /^(序章|楔子|序言|前言|引子|序|尾声|终章|后记|后序|附录)(?=$|[：:、.．\-—\s])/;
// 番外（可带编号），如 "番外一 日常" / "番外：初雪"
const FANWAI_RE = new RegExp(`^番外(?:篇)?[${CN_NUM}]*(?=$|[：:、.．\\-—\\s])`);
// 英文章节
const EN_CHAPTER_RE = /^chapter\s+[0-9]+/i;
// 纯数字编号标题，如 "1、初见"
const NUM_TITLE_RE = /^[0-9]{1,4}\s*[、.．]\s*\S/;
// ☆ 符号标题，如 "☆、变态之神（01）"
const STAR_TITLE_RE = /^☆、\S+/;
// Markdown 标题井号前缀（部分 txt 是 Markdown 导出，标题形如 ## 第一章）
const MD_HEADING_RE = /^\s{0,3}#{1,6}\s*/;
// 成对包裹标题的括号/书名号/加粗星号，如 【第一章】、**第二章**
const WRAPPED_TITLE_RE = /^[【\[（(「『〈《*]+(.*?)[】\]）)」』〉》*]+$/;
const FULLWIDTH_DIGIT_RE = /[０-９]/g;
const ZERO_WIDTH_RE = new RegExp('[\\u200B-\\u200D\\uFEFF]', 'g');
// 标题中不应出现的句子标点（，；？！…）；句读「。」仅允许在末尾（如 "第二章。"）
const BODY_PUNCT_RE = /[，；？！…]|。(?!$)/;
// 章/节等单位词后引入副标题的分隔符，如 "第一章：雨夜"
const SUBTITLE_SEP_RE = /^[：:、.．\-—\s]/;

/** 归一化标题行：去 Markdown 井号、成对包裹符号与零宽字符，全角数字转半角。 */
function normalizeTitleLine(line: string): string {
	let candidate = line.replace(MD_HEADING_RE, '').replace(ZERO_WIDTH_RE, '').trim();
	const wrapped = WRAPPED_TITLE_RE.exec(candidate);
	if (wrapped) {
		candidate = wrapped[1].trim();
	}
	return candidate.replace(FULLWIDTH_DIGIT_RE, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function matchTitle(line: string): string | undefined {
	const candidate = normalizeTitleLine(line);
	if (candidate.length === 0 || candidate.length > 60) {
		return undefined; // 超长行按正文处理
	}
	// 第X章 类：单位词后紧跟分隔符时信任副标题（可含标点）；直接连写时不允许句子标点（防 "第三部分，…" 类正文）
	const cn = CN_CHAPTER_RE.exec(candidate);
	if (cn) {
		const rest = candidate.slice(cn[0].length);
		return SUBTITLE_SEP_RE.test(rest) || !BODY_PUNCT_RE.test(candidate) ? candidate : undefined;
	}
	// 单位词/关键词后要求分隔符或结尾的模式，判定即信任
	if (
		QUAN_RE.test(candidate) ||
		DAY_RE.test(candidate) ||
		VOLUME_RE.test(candidate) ||
		SPECIAL_RE.test(candidate) ||
		FANWAI_RE.test(candidate) ||
		EN_CHAPTER_RE.test(candidate)
	) {
		return candidate;
	}
	// 数字编号与 ☆ 符号标题：误伤面大，始终要求无句子标点
	if ((NUM_TITLE_RE.test(candidate) || STAR_TITLE_RE.test(candidate)) && !BODY_PUNCT_RE.test(candidate)) {
		return candidate;
	}
	return undefined;
}

// 卷标题（第X卷…）：作为分组标记，其后的章节归属该卷
const VOLUME_TITLE_RE = new RegExp(`^第\\s*[${CN_NUM}]+\\s*卷`);

/**
 * 按行解析章节目录，返回章节（可带所属卷 volumeName）。
 * - 卷标题（第X卷…）作为分组标记：其后章节归属该卷，卷标题本身不产生章节。
 * - 卷简介前置布局：无章节跟随且同名卷标题在之后作为正文卷再次出现的卷标题是书首简介块，被丢弃。
 * - 正文为空的标题（书首目录页重复名、孤立的卷标）被丢弃。
 * - 解析失败（无任何章节）时返回整书为单章。
 */
export function parseChapters(text: string): Chapter[] {
	const lines = text.split(/\r\n|\r|\n/);
	interface Candidate {
		title: string;
		startLine: number;
		endLine: number;
		isVolume: boolean;
	}
	const starts: number[] = [];
	const titles: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const title = matchTitle(lines[i]);
		if (title) {
			starts.push(i);
			titles.push(title);
		}
	}
	const candidates: Candidate[] = [];
	for (let idx = 0; idx < starts.length; idx++) {
		const candidate: Candidate = {
			title: titles[idx],
			startLine: starts[idx],
			endLine: idx + 1 < starts.length ? starts[idx + 1] - 1 : lines.length - 1,
			isVolume: VOLUME_TITLE_RE.test(titles[idx]),
		};
		// 卷标题即使区间无正文也保留（其后紧跟章节标题时区间为空）；普通标题须有正文
		if (candidate.isVolume || hasBody(lines, candidate)) {
			candidates.push(candidate);
		}
	}
	if (candidates.length === 0) {
		return [{ title: '全文', startLine: 0, endLine: Math.max(0, lines.length - 1) }];
	}
	// 简介卷标题：无章节跟随（下一候选是卷标题或结尾）且同名卷标题在之后作为正文卷出现 → 书首简介块，丢弃
	// 反向扫描一次：先见到正文卷标题（其后跟章节），再遇到同名无章节卷标题即为简介
	const bodyVolumeSeen = new Set<string>();
	const introSet = new Set<number>();
	for (let i = candidates.length - 1; i >= 0; i--) {
		const c = candidates[i];
		if (!c.isVolume) {
			continue;
		}
		const hasChapterAfter = i + 1 < candidates.length && !candidates[i + 1].isVolume;
		if (hasChapterAfter) {
			bodyVolumeSeen.add(normalizeTitle(c.title));
		} else if (bodyVolumeSeen.has(normalizeTitle(c.title))) {
			introSet.add(i);
		}
	}
	const kept = candidates.filter((_, idx) => !introSet.has(idx));

	// 卷标题作为分组标记，其后章节归属该卷；卷标题前的章节（前言等）无卷
	let currentVolume: string | undefined;
	const chapters: Chapter[] = [];
	for (const candidate of kept) {
		if (candidate.isVolume) {
			currentVolume = candidate.title;
			continue;
		}
		chapters.push({
			title: candidate.title,
			startLine: candidate.startLine,
			endLine: candidate.endLine,
			volumeName: currentVolume,
		});
	}
	if (chapters.length === 0) {
		return [{ title: '全文', startLine: 0, endLine: Math.max(0, lines.length - 1) }];
	}
	return chapters;
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

/** 标题规范化（简介卷标题判定用）：去尾部页码与标点空白差异。 */
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
