/** 章节文件名：`NNNN-标题.md`，导入时序号四位零填充；识别时放宽为任意位数，兼容手写/agent 创建的文件。 */
const CHAPTER_FILE_RE = /^(\d+)-(.+)\.md$/;

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

/** 插入章节的序号方案。 */
export interface ChapterInsertPlan {
	/** 新章节序号 */
	seq: number;
	/** 需要顺延 +1 的起始序号（含）；undefined 表示有空档，无需顺延 */
	shiftFrom?: number;
}

/** 计算在 seqs（全书章节按显示顺序的序号列表）第 index 个位置插章时的序号方案：优先用空档，无空档则顺延该位置及其后的序号。 */
export function planChapterInsertSeq(seqs: number[], index: number): ChapterInsertPlan {
	const prev = index > 0 ? seqs[index - 1] : undefined;
	const next = index < seqs.length ? seqs[index] : undefined;
	if (next === undefined) {
		// 追加到末尾：直接接最大值
		return { seq: seqs.reduce((max, seq) => Math.max(max, seq), 0) + 1 };
	}
	// 序号唯一但按（分卷, 序号）排序，故候选号还须确认未被其他分卷占用
	const candidate = prev === undefined ? next - 1 : prev + 1;
	if (candidate > 0 && candidate < next && (prev === undefined || candidate > prev) && !seqs.includes(candidate)) {
		return { seq: candidate };
	}
	return { seq: next, shiftFrom: next };
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

/** 章节 markdown → 纯文本：去 BOM、导航、分隔线、标题标记、链接与强调符号（朗读与导出共用）。 */
export function mdToPlainText(raw: string): string {
	return raw
		.replace(/^\uFEFF/, '')
		.split(/\r?\n/)
		.map((line) => {
			const trimmed = line.trim();
			// 去掉底部导航行与分隔线
			if (trimmed.startsWith('---')) {
				return '';
			}
			if (/^\[← 上一章\]|^\[下一章 →\]/.test(trimmed)) {
				return '';
			}
			return line;
		})
		.join('\n')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/^#{1,6}\s*(.*)$/gm, '$1')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^>\s?/gm, '')
		.replace(/[*_~`]/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** 从 markdown 首行提取一级标题（`# 标题`，兼容 `#标题`）；二级标题/正文返回 undefined。 */
export function extractMarkdownTitle(firstLine: string): string | undefined {
	const match = /^#(?!#)\s*(.+)$/.exec(firstLine);
	const title = match?.[1]?.trim();
	return title ? title : undefined;
}

/** 元数据.md 的 frontmatter 字段。 */
export interface MetadataField {
	/** frontmatter 键（title/author 等） */
	key: string;
	/** 值（已去引号） */
	value: string;
	/** 该行行号（0 起） */
	line: number;
}

/** 元数据.md 的正文二级小节（## 简介 / ## 说明 等）。 */
export interface MetadataSection {
	/** 小节标题 */
	title: string;
	/** 小节正文（首尾空白已去） */
	body: string;
	/** 标题行行号（0 起） */
	line: number;
}

export interface BookMetadata {
	fields: MetadataField[];
	sections: MetadataSection[];
}

const FM_DELIM_RE = /^---\s*$/;
// 键允许中文/空格等手写写法，只排除 YAML 列表项（- 开头）、注释与缩进行
const FM_LINE_RE = /^(?![-#\s])([^:]*?)\s*:\s*(.*)$/;
const H2_RE = /^##(?!#)\s*(.+?)\s*$/;

/** 去 YAML 字符串引号（写盘时用 JSON.stringify，含转义需按 JSON 解析）。 */
function unquoteYamlValue(raw: string): string {
	const value = raw.trim();
	if (!value.startsWith('"') || !value.endsWith('"')) {
		return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
	}
	try {
		return JSON.parse(value) as string;
	} catch {
		return value.slice(1, -1);
	}
}

/** 解析 元数据.md：frontmatter 键值对 + 正文二级小节（三级标题归入小节正文）。 */
export function parseBookMetadata(text: string): BookMetadata {
	const lines = text.split(/\r\n|\r|\n/);
	const fields: MetadataField[] = [];
	const sections: MetadataSection[] = [];
	let index = 0;
	if (FM_DELIM_RE.test(lines[0] ?? '')) {
		for (index = 1; index < lines.length && !FM_DELIM_RE.test(lines[index]); index++) {
			const match = FM_LINE_RE.exec(lines[index]);
			if (match) {
				fields.push({ key: match[1], value: unquoteYamlValue(match[2]), line: index });
			}
		}
		index++;
	}
	for (; index < lines.length; index++) {
		const match = H2_RE.exec(lines[index]);
		if (!match) {
			continue;
		}
		let end = index + 1;
		while (end < lines.length && !H2_RE.test(lines[end])) {
			end++;
		}
		sections.push({ title: match[1], body: lines.slice(index + 1, end).join('\n').trim(), line: index });
		index = end - 1;
	}
	return { fields, sections };
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

/** 元数据.md：frontmatter 存字段，正文的"说明"充当 agent 的常驻 instructions。 */
export function buildMetadataMarkdown(title: string): string {
	const date = new Date().toISOString().slice(0, 10);
	return [
		'---',
		`title: ${JSON.stringify(title)}`,
		'author: ""',
		`created: ${date}`,
		'---',
		'',
		'## 简介',
		'',
		'',
		'## 说明',
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

/** 解析区间摘要文件名（`NNNN-MMMM.md`）为起止序号；非区间摘要文件返回 undefined。 */
export function parseIntervalSummaryFileName(fileName: string): { startSeq: number; endSeq: number } | undefined {
	const match = /^(\d+)-(\d+)\.md$/.exec(fileName);
	if (!match) {
		return undefined;
	}
	return { startSeq: Number.parseInt(match[1], 10), endSeq: Number.parseInt(match[2], 10) };
}

/** 卷摘要文件名：`<卷目录名>.md`（默认卷用其卷名，即 第一卷.md）。 */
export function volumeSummaryFileName(volumeKey: string): string {
	return `${sanitizeFileTitle(volumeKey)}.md`;
}

/** 章节摘要模板：标题 + 原文链接 + 摘要小节；章节尚未创建（计划）时原文链接留空占位。 */
export function buildChapterSummaryMarkdown(title: string, chapterFile: string, chapterHref?: string): string {
	const original = chapterHref ? `[${escapeMdLinkText(chapterFile)}](<${chapterHref}>)` : '（尚未创建）';
	return `# ${title} · 摘要\n\n> 原文：${original}\n\n## 摘要\n\n`;
}

/** 卷摘要模板：章节范围列表 + 摘要小节（计划写在章节计划与区间计划里，卷摘要不含计划）。 */
export function buildVolumeSummaryMarkdown(
	volumeName: string,
	chapters: { seq: number; title: string; planned?: boolean }[]
): string {
	const list =
		chapters.length > 0
			? chapters
				.map((c) => `- ${String(c.seq).padStart(4, '0')} ${c.title}${c.planned ? '（计划）' : ''}`)
				.join('\n')
			: '- （尚无章节）';
	return `# ${volumeName} · 卷摘要\n\n## 章节范围\n\n${list}\n\n## 摘要\n\n`;
}

/** 区间摘要的「章节范围」列表；无章节时给占位（区间可以有尚未创建的章节）。 */
function intervalChapterList(chapters: { seq: number; title: string }[]): string {
	return chapters.length > 0
		? chapters.map((c) => `- ${String(c.seq).padStart(4, '0')} ${c.title}`).join('\n')
		: '- （尚无章节）';
}

/** 区间摘要模板：章节范围列表 + 摘要小节。 */
export function buildIntervalSummaryMarkdown(
	startSeq: number,
	endSeq: number,
	chapters: { seq: number; title: string }[]
): string {
	return `# 第 ${startSeq}–${endSeq} 章 · 区间摘要\n\n## 章节范围\n\n${intervalChapterList(chapters)}\n\n## 摘要\n\n`;
}

/** 重写区间摘要的标题行与「章节范围」小节（改区间起止时用），其它内容（摘要正文）原样保留。 */
export function rewriteIntervalRange(
	md: string,
	startSeq: number,
	endSeq: number,
	chapters: { seq: number; title: string }[]
): string {
	const lines = md.replace(/\r\n/g, '\n').split('\n');
	if (lines[0]?.startsWith('# ')) {
		lines[0] = `# 第 ${startSeq}–${endSeq} 章 · 区间摘要`;
	}
	const body = ['', ...intervalChapterList(chapters).split('\n'), ''];
	const heading = lines.findIndex((line) => /^##\s*章节范围\s*$/.test(line));
	if (heading < 0) {
		lines.splice(1, 0, '', '## 章节范围', ...body);
	} else {
		let end = heading + 1;
		while (end < lines.length && !lines[end].startsWith('## ')) {
			end++;
		}
		lines.splice(heading + 1, end - heading - 1, ...body);
	}
	return lines.join('\n');
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
