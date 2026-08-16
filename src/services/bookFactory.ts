import * as fs from 'fs/promises';
import * as path from 'path';
import type { BookInfo } from '../model/book';
import { buildChapterMarkdown, buildMetadataMarkdown, chapterFileName, navRelPath, sanitizeFileTitle } from './markdown';
import { parseChapters } from './novelParser';

export const CHAPTERS_DIR = '章节';
export const WORLD_DIR = '世界书';
export const CARDS_DIR = '角色卡';
export const CHAPTER_SUMMARIES_DIR = '章节摘要';
export const INTERVAL_SUMMARIES_DIR = '区间摘要';
export const NOTES_DIR = '笔记';
export const META_FILE = '元数据.md';

/** 除 章节/ 外的空目录骨架（放 .gitkeep 以便 git 跟踪）。 */
const EMPTY_DIRS = [WORLD_DIR, CARDS_DIR, CHAPTER_SUMMARIES_DIR, INTERVAL_SUMMARIES_DIR, NOTES_DIR];

/** 在 libraryRoot 下创建书文件夹（目录骨架 + 章节 md），返回书信息与章节数。 */
export async function createBookFromText(
	libraryRoot: string,
	rawName: string,
	sourceFileName: string,
	text: string
): Promise<{ book: BookInfo; chapterCount: number }> {
	const name = await uniqueBookName(libraryRoot, sanitizeFileTitle(rawName));
	const dir = path.join(libraryRoot, name);
	await fs.mkdir(path.join(dir, CHAPTERS_DIR), { recursive: true });
	for (const sub of EMPTY_DIRS) {
		await fs.mkdir(path.join(dir, sub), { recursive: true });
		await fs.writeFile(path.join(dir, sub, '.gitkeep'), '');
	}
	await fs.writeFile(path.join(dir, META_FILE), buildMetadataMarkdown(name, sourceFileName), 'utf8');

	const chapters = parseChapters(text);
	const lines = text.split(/\r\n|\r|\n/);
	// 两级目录：章节文件按卷放入 章节/<卷名>/ 子目录；卷名前的章节（前言等）放章节目录根
	const volumeDirOf = (chapter: { volumeName?: string }): string | undefined =>
		chapter.volumeName ? sanitizeFileTitle(chapter.volumeName) : undefined;
	const volumeDirs = new Set<string>();
	for (const chapter of chapters) {
		const volumeDir = volumeDirOf(chapter);
		if (volumeDir) {
			volumeDirs.add(volumeDir);
		}
	}
	for (const volumeDir of volumeDirs) {
		await fs.mkdir(path.join(dir, CHAPTERS_DIR, volumeDir), { recursive: true });
	}
	// 全局顺序编号；跨卷导航用相对当前文件的路径（同卷为文件名，跨卷用 ../）
	const relPaths = chapters.map((chapter, i) => {
		const volumeDir = volumeDirOf(chapter);
		const fileName = chapterFileName(i + 1, chapter.title);
		return volumeDir ? `${volumeDir}/${fileName}` : fileName;
	});
	await Promise.all(
		chapters.map(async (chapter, i) => {
			const end = Math.min(chapter.endLine, lines.length - 1);
			const body = lines.slice(chapter.startLine + 1, end + 1).join('\n');
			const fromVolume = volumeDirOf(chapter);
			const prevNav =
				i > 0 ? navRelPath(fromVolume, volumeDirOf(chapters[i - 1]), chapterFileName(i, chapters[i - 1].title)) : undefined;
			const nextNav =
				i < chapters.length - 1
					? navRelPath(fromVolume, volumeDirOf(chapters[i + 1]), chapterFileName(i + 2, chapters[i + 1].title))
					: undefined;
			const md = buildChapterMarkdown(chapter.title, body, prevNav, nextNav);
			await fs.writeFile(path.join(dir, CHAPTERS_DIR, relPaths[i]), md, 'utf8');
		})
	);
	return { book: { name, dir }, chapterCount: chapters.length };
}

/** 库根下生成不与现有书/目录冲突的书文件夹名（重名自动加 -2、-3…）。 */
export async function uniqueBookName(libraryRoot: string, base: string): Promise<string> {
	let name = base;
	for (let suffix = 2; ; suffix++) {
		try {
			await fs.access(path.join(libraryRoot, name));
			name = `${base}-${suffix}`;
		} catch {
			return name;
		}
	}
}
