/** 章节文件名：`NNNN-标题.md`，导入时序号四位零填充；识别时放宽为任意位数，兼容手写/agent 创建的文件。 */
export const CHAPTER_FILE_RE = /^(\d+)-(.+)\.md$/;

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;
const MAX_TITLE_LENGTH = 50;

/** 清洗标题为合法文件名片段。 */
export function sanitizeFileTitle(title: string): string {
	const cleaned = title.replace(ILLEGAL_FILENAME_CHARS, '').replace(/\s+/g, ' ').trim();
	return (cleaned || '未命名').slice(0, MAX_TITLE_LENGTH);
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

/** 生成章节 md：# 标题 + 段落空行 + 底部上一章/下一章导航（尖括号包裹以兼容含空格文件名）。 */
export function buildChapterMarkdown(title: string, body: string, prevFile?: string, nextFile?: string): string {
	const paragraphs = body
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const links: string[] = [];
	if (prevFile) {
		links.push(`[← 上一章](<${prevFile}>)`);
	}
	if (nextFile) {
		links.push(`[下一章 →](<${nextFile}>)`);
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
