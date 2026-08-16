/** 章节文件名：`NNNN-标题.md`，导入时序号四位零填充；识别时放宽为任意位数，兼容手写/agent 创建的文件。 */
export const CHAPTER_FILE_RE = /^(\d+)-(.+)\.md$/;

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;
const WINDOWS_RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_TITLE_LENGTH = 50;

/** 清洗标题为合法文件名片段（含 Windows 保留名与尾部点/空格规避）。 */
export function sanitizeFileTitle(title: string): string {
	let cleaned = title.replace(ILLEGAL_FILENAME_CHARS, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
	if (WINDOWS_RESERVED_NAME_RE.test(cleaned)) {
		cleaned = `${cleaned}_`;
	}
	return (cleaned || '未命名').slice(0, MAX_TITLE_LENGTH);
}

/** 转义 Markdown 链接文字中的方括号（标题含 [ ] 时不破坏链接语法）。 */
export function escapeMdLinkText(text: string): string {
	return text.replace(/[[\]]/g, '\\$&');
}

export function chapterFileName(seq: number, title: string): string {
	return `${String(seq).padStart(4, '0')}-${sanitizeFileTitle(title)}.md`;
}

export function parseChapterFileName(fileName: string): { seq: number; title: string } | undefined {
	const match = CHAPTER_FILE_RE.exec(fileName);
	if (!match) {
		return undefined;
	}
	return { seq: Number.parseInt(match[1], 10), title: match[2] };
}

/** 章间导航相对路径：从 from 卷的文件所在目录指向 to 章文件（同卷为文件名，跨卷用 ../）。 */
export function navRelPath(fromVolume: string | undefined, toVolume: string | undefined, toFileName: string): string {
	if ((fromVolume ?? '') === (toVolume ?? '')) {
		return toFileName;
	}
	if (fromVolume === undefined) {
		return `${toVolume}/${toFileName}`;
	}
	return toVolume === undefined ? `../${toFileName}` : `../${toVolume}/${toFileName}`;
}

const PREV_NAV_RE = /^\[← 上一章\]\(<[^>]*>\)/m;
const NEXT_NAV_RE = /\[下一章 →\]\(<[^>]*>\)$/m;

/** 重写章节 md 底部导航链接：prev/next 为目标路径（相对当前文件），undefined 表示移除对应链接。仅匹配独立导航行（行首 prev / 行尾 next），不动正文中的内联同名链接。 */
export function updateChapterNav(md: string, prev?: string, next?: string): string {
	let out = md;
	if (prev !== undefined) {
		out = out.replace(PREV_NAV_RE, () => `[← 上一章](<${prev}>)`);
	} else {
		out = out.replace(/^\[← 上一章\]\(<[^>]*>\)[ \t]*·[ \t]*/m, '');
		out = out.replace(PREV_NAV_RE, '');
	}
	if (next !== undefined) {
		out = out.replace(NEXT_NAV_RE, () => `[下一章 →](<${next}>)`);
	} else {
		out = out.replace(/[ \t]*·[ \t]*\[下一章 →\]\(<[^>]*>\)$/m, '');
		out = out.replace(NEXT_NAV_RE, '');
	}
	// 两个链接都移除后清理空的导航段（--- 行）
	out = out.replace(/\n---\n\s*$/, '\n');
	return out;
}

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字转整数（支持 十百千万 混合写法，如 一百零五 → 105）；解析失败返回 undefined。 */
export function chineseNumberToInt(text: string): number | undefined {
	let total = 0;
	let current = 0;
	for (const ch of text) {
		if (ch in CN_DIGIT) {
			current = CN_DIGIT[ch];
		} else if (ch === '十') {
			total += (current || 1) * 10;
			current = 0;
		} else if (ch === '百') {
			total += (current || 1) * 100;
			current = 0;
		} else if (ch === '千') {
			total += (current || 1) * 1000;
			current = 0;
		} else if (ch === '万') {
			total = (total + current) * 10000;
			current = 0;
		} else {
			return undefined;
		}
	}
	return total + current;
}

/** 从 markdown 首行提取一级标题（`# 标题`，兼容 `#标题`）；二级标题/正文返回 undefined。 */
export function extractMarkdownTitle(firstLine: string): string | undefined {
	const match = /^#(?!#)\s*(.+)$/.exec(firstLine);
	const title = match?.[1]?.trim();
	return title ? title : undefined;
}

/** 生成章节 md：# 标题 + 段落空行 + 底部上一章/下一章导航（相对 章节/ 的相对路径，尖括号包裹以兼容含空格文件名）。 */
export function buildChapterMarkdown(title: string, body: string, prevRelPath?: string, nextRelPath?: string): string {
	const paragraphs = body
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const links: string[] = [];
	if (prevRelPath) {
		links.push(`[← 上一章](<${prevRelPath}>)`);
	}
	if (nextRelPath) {
		links.push(`[下一章 →](<${nextRelPath}>)`);
	}
	const nav = links.length > 0 ? `\n---\n${links.join(' · ')}\n` : '';
	return `# ${title}\n\n${paragraphs.join('\n\n')}\n\n${nav}`;
}

/** 元数据.md：frontmatter 存字段，正文的"写作要求"充当 agent 的常驻 instructions。 */
export function buildMetadataMarkdown(title: string, sourceFileName: string): string {
	const date = new Date().toISOString().slice(0, 10);
	return [
		'---',
		`title: ${JSON.stringify(title)}`,
		'author: ""',
		`created: ${date}`,
		`source: ${JSON.stringify(sourceFileName)}`,
		'---',
		'',
		'## 简介',
		'',
		'',
		'## 写作要求',
		'',
		'',
	].join('\n');
}

/** 角色卡/世界书条目模板。 */
export function buildEntryMarkdown(name: string): string {
	return `# ${name}\n\n`;
}

/** 区间摘要文件名：`NNNN-MMMM.md`（首尾章节序号四位零填充）。 */
export function intervalSummaryFileName(startSeq: number, endSeq: number): string {
	return `${String(startSeq).padStart(4, '0')}-${String(endSeq).padStart(4, '0')}.md`;
}

/** 章节摘要模板：标题 + 原文链接 + 摘要小节。 */
export function buildChapterSummaryMarkdown(title: string, chapterFile: string, chapterHref: string): string {
	return `# ${title} · 摘要\n\n> 原文：[${chapterFile}](<${chapterHref}>)\n\n## 摘要\n\n`;
}

/** 区间摘要模板：章节范围列表 + 摘要小节。 */
export function buildIntervalSummaryMarkdown(
	startSeq: number,
	endSeq: number,
	chapters: { seq: number; title: string }[]
): string {
	const list = chapters.map((c) => `- ${String(c.seq).padStart(4, '0')} ${c.title}`).join('\n');
	return `# 第 ${startSeq}–${endSeq} 章 · 区间摘要\n\n## 章节范围\n\n${list}\n\n## 摘要\n\n`;
}

/** 笔记关联的章节信息。 */
export interface NoteChapterLink {
	/** 章节相对路径（分卷含目录名），写入 frontmatter */
	relPath: string;
	/** 章节标题 */
	title: string;
	/** 从笔记文件指向章节的相对链接 */
	href: string;
}

/** 笔记模板；关联章节时写入 frontmatter chapter 字段与正文链接。 */
export function buildNoteMarkdown(name: string, chapter?: NoteChapterLink): string {
	if (!chapter) {
		return `# ${name}\n\n`;
	}
	return [
		'---',
		`chapter: ${JSON.stringify(chapter.relPath)}`,
		'---',
		'',
		`# ${name}`,
		'',
		`> 关联章节：[${escapeMdLinkText(chapter.title)}](<${chapter.href}>)`,
		'',
		'',
	].join('\n');
}
