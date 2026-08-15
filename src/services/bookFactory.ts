import * as fs from 'fs/promises';
import * as path from 'path';
import type { BookInfo } from '../model/book';
import { buildChapterMarkdown, buildMetadataMarkdown, chapterFileName, sanitizeFileTitle } from './markdown';
import { getChapterText, parseChapters } from './novelParser';

export const CHAPTERS_DIR = '章节';
export const WORLD_DIR = '世界书';
export const CARDS_DIR = '角色卡';
export const META_FILE = '元数据.md';

/** 在 libraryRoot 下创建书文件夹（四件套 + 章节 md），返回书信息与章节数。 */
export async function createBookFromText(
	libraryRoot: string,
	rawName: string,
	sourceFileName: string,
	text: string
): Promise<{ book: BookInfo; chapterCount: number }> {
	const name = await uniqueBookName(libraryRoot, sanitizeFileTitle(rawName));
	const dir = path.join(libraryRoot, name);
	await fs.mkdir(path.join(dir, WORLD_DIR), { recursive: true });
	await fs.mkdir(path.join(dir, CARDS_DIR), { recursive: true });
	await fs.mkdir(path.join(dir, CHAPTERS_DIR), { recursive: true });
	await fs.writeFile(path.join(dir, WORLD_DIR, '.gitkeep'), '');
	await fs.writeFile(path.join(dir, CARDS_DIR, '.gitkeep'), '');
	await fs.writeFile(path.join(dir, META_FILE), buildMetadataMarkdown(name, sourceFileName), 'utf8');

	const chapters = parseChapters(text);
	const fileNames = chapters.map((chapter, i) => chapterFileName(i + 1, chapter.title));
	for (let i = 0; i < chapters.length; i++) {
		const body = getChapterText(text, chapters[i]);
		const md = buildChapterMarkdown(chapters[i].title, body, fileNames[i - 1], fileNames[i + 1]);
		await fs.writeFile(path.join(dir, CHAPTERS_DIR, fileNames[i]), md, 'utf8');
	}
	return { book: { name, dir }, chapterCount: chapters.length };
}

async function uniqueBookName(libraryRoot: string, base: string): Promise<string> {
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
