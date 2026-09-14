import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as iconv from 'iconv-lite';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { readCharacterVoiceConfig } from '../services/audio';
import {
	CARDS_DIR,
	CHAPTER_SUMMARIES_DIR,
	CHAPTERS_DIR,
	createBookFromText,
	INTERVAL_SUMMARIES_DIR,
	META_FILE,
	NOTES_DIR,
	VERSIONS_DIR,
	VOLUME_SUMMARIES_DIR,
	WORLD_DIR,
} from '../services/bookFactory';
import { commitAll, resetHistory } from '../services/git';
import { chapterRelPath, LibraryService, parseChapterFilePath, shelfLeafName, shelfParentPath, SHELVES_FILE } from '../services/library';
import {
	buildChapterMarkdown,
	buildChapterSummaryMarkdown,
	buildIntervalSummaryMarkdown,
	buildMetadataMarkdown,
	buildNoteMarkdown,
	chapterFileName,
	chineseNumberToInt,
	extractMarkdownTitle,
	intervalSummaryFileName,
	navRelPath,
	parseBookMetadata,
	parseChapterFileName,
	planChapterInsertSeq,
	sanitizeFileTitle,
	updateChapterNav,
} from '../services/markdown';
import { decodeBuffer, parseChapters } from '../services/novelParser';

/** 文件是否存在。 */
const exists = async (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

/** 构造只带内存 globalState 的 LibraryService（测试不依赖 VS Code 宿主）。 */
const makeService = (): LibraryService => {
	const store = new Map<string, unknown>();
	const fakeContext = {
		globalState: {
			get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
			update: async (key: string, value: unknown) => {
				if (value === undefined) {
					store.delete(key);
				} else {
					store.set(key, value);
				}
			},
			keys: () => [...store.keys()],
			setKeysForSync: () => undefined,
		},
		subscriptions: [] as vscode.Disposable[],
	} as unknown as vscode.ExtensionContext;
	return new LibraryService(fakeContext);
};

suite('markdown helpers', () => {
	test('sanitizeFileTitle 去除非法字符、压缩空白并截断', () => {
		assert.strictEqual(sanitizeFileTitle('第一章:雨/夜?'), '第一章雨夜');
		assert.strictEqual(sanitizeFileTitle('  第一章  雨夜  '), '第一章 雨夜');
		assert.strictEqual(sanitizeFileTitle('   '), '未命名');
		assert.strictEqual(sanitizeFileTitle('x'.repeat(60)).length, 50);
		assert.strictEqual(sanitizeFileTitle('CON'), 'CON_');
		assert.strictEqual(sanitizeFileTitle('com1'), 'com1_');
		assert.strictEqual(sanitizeFileTitle('标题.'), '标题');
		assert.strictEqual(sanitizeFileTitle('...'), '未命名');
	});

	test('chapterFileName 序号四位零填充', () => {
		assert.strictEqual(chapterFileName(3, '初见'), '0003-初见.md');
		assert.strictEqual(chapterFileName(12345, '尾声'), '12345-尾声.md');
	});

	test('planChapterInsertSeq 有空档直接插，无空档顺延其后序号', () => {
		// 连续序号：顺延
		assert.deepStrictEqual(planChapterInsertSeq([1, 2, 3], 1), { seq: 2, shiftFrom: 2 });
		assert.deepStrictEqual(planChapterInsertSeq([1, 2, 3], 3), { seq: 4 });
		// 有空档：直接插入，不顺延
		assert.deepStrictEqual(planChapterInsertSeq([1, 5, 9], 1), { seq: 2 });
		// 插到最前：序号 1 被占用时顺延，否则取 next-1
		assert.deepStrictEqual(planChapterInsertSeq([1, 2], 0), { seq: 1, shiftFrom: 1 });
		assert.deepStrictEqual(planChapterInsertSeq([4, 5], 0), { seq: 3 });
		// 空档号被其他分卷占用（序号全局唯一）：顺延
		assert.deepStrictEqual(planChapterInsertSeq([1, 3, 2], 1), { seq: 3, shiftFrom: 3 });
		// 空书追加
		assert.deepStrictEqual(planChapterInsertSeq([], 0), { seq: 1 });
	});

	test('parseChapterFileName 解析合法文件名，拒绝非章节文件', () => {
		assert.deepStrictEqual(parseChapterFileName('0003-初见.md'), { seq: 3, title: '初见' });
		assert.deepStrictEqual(parseChapterFileName('0010-第一章 雨夜.md'), { seq: 10, title: '第一章 雨夜' });
		assert.deepStrictEqual(parseChapterFileName('5-手写序号.md'), { seq: 5, title: '手写序号' });
		assert.strictEqual(parseChapterFileName('readme.md'), undefined);
	});

	test('parseChapterFilePath 解析书/卷/章节，拒绝非章节文件与更深层级', () => {
		const bookDir = path.join(path.sep, 'lib', '书A');
		assert.deepStrictEqual(parseChapterFilePath(path.join(bookDir, CHAPTERS_DIR, '0001-雨夜.md')), {
			bookDir,
			volumeDir: undefined,
			fileName: '0001-雨夜.md',
		});
		assert.deepStrictEqual(parseChapterFilePath(path.join(bookDir, CHAPTERS_DIR, '第一卷', '0002-清晨.md')), {
			bookDir,
			volumeDir: '第一卷',
			fileName: '0002-清晨.md',
		});
		assert.strictEqual(parseChapterFilePath(path.join(bookDir, CHAPTERS_DIR, 'readme.md')), undefined);
		assert.strictEqual(
			parseChapterFilePath(path.join(bookDir, CHAPTERS_DIR, '第一卷', '第二层', '0001-雨夜.md')),
			undefined
		);
		assert.strictEqual(parseChapterFilePath(path.join(bookDir, NOTES_DIR, '0001-想法.md')), undefined);
		// 库路径本身含同名分支时取最后一个「章节」段
		const tricky = path.join(path.sep, 'lib', '我的章节摘录');
		assert.deepStrictEqual(parseChapterFilePath(path.join(tricky, CHAPTERS_DIR, '0003-x.md')), {
			bookDir: tricky,
			volumeDir: undefined,
			fileName: '0003-x.md',
		});
	});

	test('extractMarkdownTitle 提取一级标题，忽略二级标题与正文', () => {
		assert.strictEqual(extractMarkdownTitle('# 第一章'), '第一章');
		assert.strictEqual(extractMarkdownTitle('#第一章'), '第一章');
		assert.strictEqual(extractMarkdownTitle('# 第一章 #'), '第一章 #');
		assert.strictEqual(extractMarkdownTitle('## 二级标题'), undefined);
		assert.strictEqual(extractMarkdownTitle('### 三级标题'), undefined);
		assert.strictEqual(extractMarkdownTitle('正文开始'), undefined);
		assert.strictEqual(extractMarkdownTitle('#  '), undefined);
		assert.strictEqual(extractMarkdownTitle(''), undefined);
	});

	test('chineseNumberToInt 中文数字转整数', () => {
		assert.strictEqual(chineseNumberToInt('一'), 1);
		assert.strictEqual(chineseNumberToInt('两'), 2);
		assert.strictEqual(chineseNumberToInt('十'), 10);
		assert.strictEqual(chineseNumberToInt('十二'), 12);
		assert.strictEqual(chineseNumberToInt('二十三'), 23);
		assert.strictEqual(chineseNumberToInt('一百零五'), 105);
		assert.strictEqual(chineseNumberToInt('一千零一'), 1001);
		assert.strictEqual(chineseNumberToInt('一万零一'), 10001);
		assert.strictEqual(chineseNumberToInt('〇'), 0);
		assert.strictEqual(chineseNumberToInt('abc'), undefined);
	});

	test('parseBookMetadata 解析 frontmatter 字段与正文小节', () => {
		const text = buildMetadataMarkdown('雨夜');
		const meta = parseBookMetadata(text);
		assert.deepStrictEqual(
			meta.fields.map((f) => f.key),
			['title', 'author', 'created']
		);
		assert.deepStrictEqual(
			meta.fields.map((f) => f.value),
			['雨夜', '', meta.fields[2].value]
		);
		assert.match(meta.fields[2].value, /^\d{4}-\d{2}-\d{2}$/);
		// 行号指向字段/小节标题本身所在行（0 起）
		assert.strictEqual(text.split('\n')[meta.fields[0].line], 'title: "雨夜"');
		assert.deepStrictEqual(
			meta.sections.map((s) => s.title),
			['简介', '说明']
		);
		assert.strictEqual(text.split('\n')[meta.sections[1].line], '## 说明');
	});

	test('parseBookMetadata 处理引号转义、手写键名与三级标题', () => {
		const meta = parseBookMetadata(
			[
				'---',
				'title: "雨天\\"夜"',
				'custom: 2026-01-01',
				'书名: 雨夜',
				'not a field',
				'- 列表项: 忽略',
				'# 注释: 忽略',
				'---',
				'## 简介',
				'',
				'第一行',
				'第二行',
				'',
				'### 子标题',
				'细节',
				'## 说明',
				'',
				'禁止上帝视角',
				'',
			].join('\n')
		);
		assert.deepStrictEqual(
			meta.fields.map((f) => [f.key, f.value]),
			[
				['title', '雨天"夜'],
				['custom', '2026-01-01'],
				['书名', '雨夜'],
			]
		);
		assert.deepStrictEqual(meta.sections, [
			{ title: '简介', body: '第一行\n第二行\n\n### 子标题\n细节', line: 8 },
			{ title: '说明', body: '禁止上帝视角', line: 15 },
		]);
		assert.deepStrictEqual(parseBookMetadata(''), { fields: [], sections: [] });
		assert.deepStrictEqual(parseBookMetadata('# 只有标题'), { fields: [], sections: [] });
	});

	test('buildChapterMarkdown 首章无上一章链接，中间章双向导航', () => {
		const first = buildChapterMarkdown('第一章 起', '段落一\n\n\n段落二', undefined, '0002-第二章.md');
		assert.ok(first.startsWith('# 第一章 起\n'));
		assert.ok(first.includes('段落一\n\n段落二'));
		assert.ok(!first.includes('上一章'));
		assert.ok(first.includes('[下一章 →](<0002-第二章.md>)'));

		const mid = buildChapterMarkdown('第二章', '正文', '0001-第一章 起.md', '0003-第三章.md');
		assert.ok(mid.includes('[← 上一章](<0001-第一章 起.md>)'));
		assert.ok(mid.includes('[下一章 →](<0003-第三章.md>)'));

		const last = buildChapterMarkdown('尾声', '正文', '0003-第三章.md', undefined);
		assert.ok(last.includes('[← 上一章](<0003-第三章.md>)'));
		assert.ok(!last.includes('下一章'));
	});

	test('intervalSummaryFileName 首尾序号四位零填充', () => {
		assert.strictEqual(intervalSummaryFileName(1, 10), '0001-0010.md');
		assert.strictEqual(intervalSummaryFileName(21, 25), '0021-0025.md');
		assert.strictEqual(intervalSummaryFileName(31, 31), '0031-0031.md');
	});

	test('buildChapterSummaryMarkdown 含原文链接与摘要小节', () => {
		const md = buildChapterSummaryMarkdown('第一章 起', '0001-第一章 起.md', '../章节/0001-第一章 起.md');
		assert.ok(md.startsWith('# 第一章 起 · 摘要\n'));
		assert.ok(md.includes('> 原文：[0001-第一章 起.md](<../章节/0001-第一章 起.md>)'));
		assert.ok(md.includes('## 摘要'));
	});

	test('buildIntervalSummaryMarkdown 含章节范围列表', () => {
		const md = buildIntervalSummaryMarkdown(1, 10, [
			{ seq: 1, title: '起' },
			{ seq: 2, title: '承' },
		]);
		assert.ok(md.startsWith('# 第 1–10 章 · 区间摘要\n'));
		assert.ok(md.includes('- 0001 起'));
		assert.ok(md.includes('- 0002 承'));
		assert.ok(md.includes('## 摘要'));
	});

	test('buildNoteMarkdown 无关联章节时仅标题，有关联时写 frontmatter 与链接', () => {
		assert.strictEqual(buildNoteMarkdown('随想'), '# 随想\n\n');

		const md = buildNoteMarkdown('雨夜分析', {
			relPath: '第一卷/0001-雨夜.md',
			title: '雨夜',
			href: '../../章节/第一卷/0001-雨夜.md',
		});
		assert.ok(md.startsWith('---\nchapter: "第一卷/0001-雨夜.md"\n---\n'));
		assert.ok(md.includes('# 雨夜分析'));
		assert.ok(md.includes('> 关联章节：[雨夜](<../../章节/第一卷/0001-雨夜.md>)'));
	});
});

suite('parseChapters', () => {
	test('识别 Markdown 井号标题与特殊章节名', () => {
		const text = ['# 第一卷', '', '## 前言', '序文', '', '## 第一章', '正文一', '## 第二章。', '正文二'].join('\n');
		const chapters = parseChapters(text);
		assert.deepStrictEqual(chapters.map((c) => c.title), ['前言', '第一章', '第二章。']);
	});

	test('兼容括号包裹、全角数字、卷X、番外编号等写法', () => {
		const text = [
			'卷一 风起',
			'正文',
			'【第一章 雨夜】',
			'正文',
			'第２章　重逢',
			'正文',
			'番外一 日常',
			'正文',
			'序：',
			'正文',
		].join('\n');
		const chapters = parseChapters(text);
		assert.deepStrictEqual(chapters.map((c) => c.title), ['卷一 风起', '第一章 雨夜', '第2章　重逢', '番外一 日常', '序：']);
	});

	test('副标题含标点（分隔符后）仍识别，正文连写句不误判', () => {
		const text = [
			'## 第一章：早安，美好的世界',
			'正文',
			'第2章 表白成功只是开始，特训',
			'第三部分，各个动作都不到位',
			'正文',
			'4、最后一个栏目是剧场，每天精选节目',
			'正文',
		].join('\n');
		const chapters = parseChapters(text);
		assert.deepStrictEqual(chapters.map((c) => c.title), ['第一章：早安，美好的世界', '第2章 表白成功只是开始，特训']);
	});

	test('识别 全X章 / 第X天 / ☆符号 标题', () => {
		const text = [
			'## 全一章',
			'正文',
			'## 第一天',
			'正文',
			'☆、变态之神（01）',
			'正文',
			'☆、变态之神（02）',
			'第三天他就离开了',
			'正文',
		].join('\n');
		const chapters = parseChapters(text);
		assert.deepStrictEqual(chapters.map((c) => c.title), ['全一章', '第一天', '☆、变态之神（01）', '☆、变态之神（02）']);
	});

	test('卷标题作为分组标记，章节归属各卷', () => {
		const text = [
			'# 第一卷',
			'## 第1章 甲', '正文',
			'## 第2章 乙', '正文',
			'# 第二卷',
			'## 第1章 丙', '正文',
		].join('\n');
		const chapters = parseChapters(text);
		assert.deepStrictEqual(
			chapters.map((c) => ({ title: c.title, volume: c.volumeName })),
			[
				{ title: '第1章 甲', volume: '第一卷' },
				{ title: '第2章 乙', volume: '第一卷' },
				{ title: '第1章 丙', volume: '第二卷' },
			]
		);
	});

	test('卷简介前置且正文卷标题重复时丢弃简介块并归卷', () => {
		const text = [
			'前言', '书简介',
			'第一卷 风起', '卷一简介',
			'第二卷 云涌', '卷二简介',
			'第一卷 风起', '序章', '序正文',
			'第二卷 云涌', '第1章 魔电龙枪', '正文',
			'第三卷 雷动', '第1章 成熟修女', '正文',
		].join('\n');
		const chapters = parseChapters(text);
		assert.deepStrictEqual(
			chapters.map((c) => ({ title: c.title, volume: c.volumeName })),
			[
				{ title: '前言', volume: undefined },
				{ title: '序章', volume: '第一卷 风起' },
				{ title: '第1章 魔电龙枪', volume: '第二卷 云涌' },
				{ title: '第1章 成熟修女', volume: '第三卷 雷动' },
			]
		);
	});

	test('分册重复卷标题时章节按卷名归并（书首简介块丢弃）', () => {
		const text = [
			'前言', '书简介',
			'第一卷 风起', '卷一简介',
			'第二卷 云涌', '卷二简介',
			'第一卷 风起', '序章', '序正文', '第2章 接续', '正文',
			'第二卷 云涌', '第1章 甲', '正文',
			'第一卷 风起', '第1章 真假美人', '正文',
			'第二卷 云涌', '第2章 乙', '正文',
		].join('\n');
		const chapters = parseChapters(text);
		assert.deepStrictEqual(
			chapters.map((c) => ({ title: c.title, volume: c.volumeName })),
			[
				{ title: '前言', volume: undefined },
				{ title: '序章', volume: '第一卷 风起' },
				{ title: '第2章 接续', volume: '第一卷 风起' },
				{ title: '第1章 甲', volume: '第二卷 云涌' },
				{ title: '第1章 真假美人', volume: '第一卷 风起' },
				{ title: '第2章 乙', volume: '第二卷 云涌' },
			]
		);
	});

	test('分册重复的同名章节全部保留，不因去重丢失', () => {
		const text = [
			'# 第一卷',
			'## 第1章', '正文',
			'## 第1章', '正文二',
			'# 第二卷',
			'## 第1章', '正文',
		].join('\n');
		const chapters = parseChapters(text);
		assert.deepStrictEqual(
			chapters.map((c) => ({ title: c.title, volume: c.volumeName })),
			[
				{ title: '第1章', volume: '第一卷' },
				{ title: '第1章', volume: '第一卷' },
				{ title: '第1章', volume: '第二卷' },
			]
		);
	});

	test('无标题时整书为单章', () => {
		const chapters = parseChapters('没有标题的正文\n第二段');
		assert.strictEqual(chapters.length, 1);
		assert.strictEqual(chapters[0].title, '全文');
	});
});

suite('decodeBuffer', () => {
	test('无 BOM UTF-16LE/BE（含 ASCII）正确解码', () => {
		const text = '第1章 雨夜\n正文内容ABC';
		assert.strictEqual(decodeBuffer(iconv.encode(text, 'utf16-le')), text);
		assert.strictEqual(decodeBuffer(iconv.encode(text, 'utf16-be')), text);
	});

	test('UTF-8（含 BOM）、GB18030 正确解码', () => {
		const text = '第一章 起\n正文';
		assert.strictEqual(decodeBuffer(Buffer.from(`\uFEFF${text}`, 'utf8')), text);
		assert.strictEqual(decodeBuffer(Buffer.from(text, 'utf8')), text);
		assert.strictEqual(decodeBuffer(iconv.encode(text, 'gb18030')), text);
	});
});

suite('createBookFromText', () => {
	test('生成目录骨架与章节 md，书名冲突时追加序号', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const text = '第一章 起\n内容一\n\n第二章 承\n内容二';
			const first = await createBookFromText(root, '测试书', text);
			assert.strictEqual(first.book.name, '测试书');
			assert.strictEqual(first.chapterCount, 2);

			const dir = first.book.dir;
			const meta = await fs.readFile(path.join(dir, META_FILE), 'utf8');
			assert.ok(meta.includes('title: "测试书"'));
			assert.ok(meta.includes('## 说明'));
			for (const sub of [WORLD_DIR, CARDS_DIR, CHAPTER_SUMMARIES_DIR, INTERVAL_SUMMARIES_DIR, NOTES_DIR]) {
				await fs.access(path.join(dir, sub, '.gitkeep'));
			}

			const chapterFiles = (await fs.readdir(path.join(dir, CHAPTERS_DIR))).sort();
			assert.deepStrictEqual(chapterFiles, ['0001-第一章 起.md', '0002-第二章 承.md']);
			const ch1 = await fs.readFile(path.join(dir, CHAPTERS_DIR, chapterFiles[0]), 'utf8');
			assert.ok(ch1.includes('# 第一章 起'));
			assert.ok(ch1.includes('内容一'));
			assert.ok(ch1.includes('[下一章 →](<0002-第二章 承.md>)'));

			const second = await createBookFromText(root, '测试书', text);
			assert.strictEqual(second.book.name, '测试书-2');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('按卷建立两级目录，跨卷导航用相对路径', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const text = [
				'# 第一卷',
				'## 第1章 甲', '正文甲',
				'# 第二卷',
				'## 第1章 乙', '正文乙',
			].join('\n');
			const result = await createBookFromText(root, '卷书', text);
			const chaptersDir = path.join(result.book.dir, CHAPTERS_DIR);
			assert.deepStrictEqual((await fs.readdir(chaptersDir)).sort(), ['第一卷', '第二卷']);
			const vol1 = await fs.readdir(path.join(chaptersDir, '第一卷'));
			assert.deepStrictEqual(vol1, ['0001-第1章 甲.md']);
			const vol2 = await fs.readdir(path.join(chaptersDir, '第二卷'));
			assert.deepStrictEqual(vol2, ['0002-第1章 乙.md']);
			const ch1 = await fs.readFile(path.join(chaptersDir, '第一卷', vol1[0]), 'utf8');
			assert.ok(ch1.includes('[下一章 →](<../第二卷/0002-第1章 乙.md>)'));
			const ch2 = await fs.readFile(path.join(chaptersDir, '第二卷', vol2[0]), 'utf8');
			assert.ok(ch2.includes('[← 上一章](<../第一卷/0001-第1章 甲.md>)'));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('未解析出章节时整书作为单章导入', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const result = await createBookFromText(root, '无章节', '没有标题的正文');
			assert.strictEqual(result.chapterCount, 1);
			const files = await fs.readdir(path.join(result.book.dir, CHAPTERS_DIR));
			assert.deepStrictEqual(files, ['0001-全文.md']);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

test('navRelPath 同卷为文件名，跨卷/根目录用相对路径', () => {
	assert.strictEqual(navRelPath(undefined, undefined, '0002-第二章.md'), '0002-第二章.md');
	assert.strictEqual(navRelPath('第一卷', '第一卷', '0002-第二章.md'), '0002-第二章.md');
	assert.strictEqual(navRelPath(undefined, '第二卷', '0002-第二章.md'), '第二卷/0002-第二章.md');
	assert.strictEqual(navRelPath('第一卷', undefined, '0002-第二章.md'), '../0002-第二章.md');
	assert.strictEqual(navRelPath('第一卷', '第二卷', '0002-第二章.md'), '../第二卷/0002-第二章.md');
});

test('updateChapterNav 替换/移除导航链接，空导航段清理', () => {
	// 替换中间章目标
	const mid = buildChapterMarkdown('第一章', '正文', '0001-甲.md', '0003-丙.md');
	const rep = updateChapterNav(mid, '0001-新甲.md', '0003-新丙.md');
	assert.ok(rep.includes('[← 上一章](<0001-新甲.md>)'));
	assert.ok(rep.includes('[下一章 →](<0003-新丙.md>)'));
	// 删除末章：前章的下一章链接被移除
	const last = buildChapterMarkdown('第一章', '正文', '0001-甲.md', '0003-末章.md');
	const noNext = updateChapterNav(last, '0001-甲.md', undefined);
	assert.ok(noNext.includes('[← 上一章](<0001-甲.md>)'));
	assert.ok(!noNext.includes('下一章'));
	// 删除首章：后章的上一章链接被移除
	const first = buildChapterMarkdown('第二章', '正文', '0001-首章.md', '0003-丙.md');
	const noPrev = updateChapterNav(first, undefined, '0003-丙.md');
	assert.ok(noPrev.includes('[下一章 →](<0003-丙.md>)'));
	assert.ok(!noPrev.includes('上一章'));
	// 唯一链接也移除后清理空导航段
	const only = buildChapterMarkdown('第二章', '正文', '0001-甲.md', undefined);
	const none = updateChapterNav(only, undefined, undefined);
	assert.ok(!none.includes('---'));
	assert.ok(!none.includes('上一章'));
	// 正文中的内联同名链接不被误改
	const inline = buildChapterMarkdown('第一章', '正文引用 [← 上一章](<9999-假.md>) 这句话', '0001-甲.md', '0003-丙.md');
	const inlineOut = updateChapterNav(inline, '0001-新甲.md', undefined);
	assert.ok(inlineOut.includes('正文引用 [← 上一章](<9999-假.md>) 这句话'));
	assert.ok(inlineOut.includes('[← 上一章](<0001-新甲.md>)'));
});

suite('LibraryService 写操作', () => {
	const THREE_CHAPTER_TEXT = ['# 第一卷', '## 第1章 甲', '正文甲', '## 第2章 乙', '正文乙', '## 第3章 丙', '正文丙'].join('\n');
	const TWO_VOLUME_TEXT = ['# 第一卷', '## 第1章 甲', '正文甲', '# 第二卷', '## 第2章 乙', '正文乙'].join('\n');

	test('createBook 新建空书骨架并设为当前书，重名自动加序号', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const cfg = vscode.workspace.getConfiguration('xReader');
			const prev = cfg.get<string>('libraryPath');
			await cfg.update('libraryPath', root, vscode.ConfigurationTarget.Global);
			try {
				const book = await service.createBook('新书');
				assert.strictEqual(book.name, '新书');
				assert.strictEqual(service.getCurrentBook()?.dir, book.dir);
				await fs.access(path.join(book.dir, CHAPTERS_DIR));
				const meta = await fs.readFile(path.join(book.dir, META_FILE), 'utf8');
				assert.ok(meta.includes('title: "新书"'));
				for (const sub of [WORLD_DIR, CARDS_DIR, CHAPTER_SUMMARIES_DIR, INTERVAL_SUMMARIES_DIR, VOLUME_SUMMARIES_DIR, NOTES_DIR]) {
					await fs.access(path.join(book.dir, sub, '.gitkeep'));
				}
				const second = await service.createBook('新书');
				assert.strictEqual(second.name, '新书-2');
			} finally {
				await cfg.update('libraryPath', prev ?? '', vscode.ConfigurationTarget.Global);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('exportBookText 导出全文：多卷补卷名，单卷不加，Markdown 标记与导航行已去除', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', TWO_VOLUME_TEXT);
			const text = await service.exportBookText(book);
			assert.ok(text.includes('第一卷'));
			assert.ok(text.includes('第二卷'));
			assert.ok(text.includes('第1章 甲'));
			assert.ok(text.includes('正文乙'));
			assert.ok(!text.includes('#'));
			assert.ok(!text.includes('上一章'));
			assert.ok(!text.includes('下一章'));

			const single = await createBookFromText(root, '单卷书', THREE_CHAPTER_TEXT);
			const singleText = await service.exportBookText(single.book);
			assert.ok(!singleText.includes('第一卷'));
			assert.ok(singleText.includes('第3章 丙'));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('renameChapter 同步文件名、摘要镜像、导航、进度与笔记关联（含无引号 frontmatter）', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', THREE_CHAPTER_TEXT);
			const chapters = await service.listChapters(book);
			const mid = chapters[1];
			await service.ensureChapterSummary(book, mid);
			await service.setProgress(book.dir, chapterRelPath(mid));
			const quoted = await service.createNote(book, '带引号', undefined, mid);
			const unquoted = await service.createNote(book, '无引号', undefined, mid);
			const raw = await fs.readFile(unquoted, 'utf8');
			await fs.writeFile(unquoted, raw.replace(/^chapter: "(.*)"$/m, 'chapter: $1'), 'utf8');

			const newFileName = await service.renameChapter(book, mid, '第2章 新乙');
			assert.strictEqual(newFileName, '0002-第2章 新乙.md');

			const volDir = path.join(book.dir, CHAPTERS_DIR, '第一卷');
			assert.ok(await exists(path.join(volDir, newFileName)));
			assert.ok(!(await exists(path.join(volDir, mid.fileName))));
			const summary = path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷', newFileName);
			assert.ok(await exists(summary));
			const summaryMd = await fs.readFile(summary, 'utf8');
			assert.ok(summaryMd.includes('# 第2章 新乙 · 摘要'));
			assert.ok(summaryMd.includes(`(<../../章节/第一卷/${newFileName}>)`));
			const prevMd = await fs.readFile(path.join(volDir, chapters[0].fileName), 'utf8');
			assert.ok(prevMd.includes(`[下一章 →](<${newFileName}>)`));
			const nextMd = await fs.readFile(path.join(volDir, chapters[2].fileName), 'utf8');
			assert.ok(nextMd.includes(`[← 上一章](<${newFileName}>)`));
			assert.strictEqual(service.getProgress(book.dir), `第一卷/${newFileName}`);
			for (const notePath of [quoted, unquoted]) {
				const noteMd = await fs.readFile(notePath, 'utf8');
				assert.ok(noteMd.includes(`chapter: "第一卷/${newFileName}"`), notePath);
				assert.ok(noteMd.includes(`> 关联章节：[第2章 新乙](<../章节/第一卷/${newFileName}>)`), notePath);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('insertChapter 在两章之间插章并顺延其后序号（同步文件名、摘要镜像、导航、进度与笔记）', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', THREE_CHAPTER_TEXT);
			const [first, second, third] = await service.listChapters(book);
			await service.ensureChapterSummary(book, third);
			await service.setProgress(book.dir, chapterRelPath(third));
			const note = await service.createNote(book, '关联丙', undefined, third);

			const inserted = await service.insertChapter(book, '第1.5章 插', { after: first });
			assert.strictEqual(inserted.fileName, '0002-第1.5章 插.md');
			assert.strictEqual(inserted.renumbered, 2);

			const volDir = path.join(book.dir, CHAPTERS_DIR, '第一卷');
			assert.ok(await exists(path.join(volDir, inserted.fileName)));
			assert.ok(await exists(path.join(volDir, '0003-第2章 乙.md')));
			assert.ok(await exists(path.join(volDir, '0004-第3章 丙.md')));
			assert.ok(!(await exists(path.join(volDir, second.fileName))));
			assert.ok(!(await exists(path.join(volDir, third.fileName))));

			// 顺序不变，导航按新文件名重排
			const chapters = await service.listChapters(book);
			assert.deepStrictEqual(
				chapters.map((c) => chapterRelPath(c)),
				[
					'第一卷/0001-第1章 甲.md',
					'第一卷/0002-第1.5章 插.md',
					'第一卷/0003-第2章 乙.md',
					'第一卷/0004-第3章 丙.md',
				]
			);
			const insertedMd = await fs.readFile(path.join(volDir, inserted.fileName), 'utf8');
			assert.ok(insertedMd.includes('[← 上一章](<0001-第1章 甲.md>)'));
			assert.ok(insertedMd.includes('[下一章 →](<0003-第2章 乙.md>)'));
			const firstMd = await fs.readFile(path.join(volDir, '0001-第1章 甲.md'), 'utf8');
			assert.ok(firstMd.includes('[下一章 →](<0002-第1.5章 插.md>)'));

			// 摘要镜像跟随改名，原文链接同步
			const summary = path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷', '0004-第3章 丙.md');
			assert.ok(await exists(summary));
			assert.ok(!(await exists(path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷', third.fileName))));
			assert.ok((await fs.readFile(summary, 'utf8')).includes('(<../../章节/第一卷/0004-第3章 丙.md>)'));

			// 进度与笔记关联迁移到新文件名
			assert.strictEqual(service.getProgress(book.dir), '第一卷/0004-第3章 丙.md');
			assert.ok((await fs.readFile(note, 'utf8')).includes('chapter: "第一卷/0004-第3章 丙.md"'));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('insertChapter 序号有空档时直接插入，不顺延后续章节', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', THREE_CHAPTER_TEXT);
			const chapters = await service.listChapters(book);
			// 手工腾出空档：把第 2 章改名到 0005（跳过 0002）
			const volDir = path.join(book.dir, CHAPTERS_DIR, '第一卷');
			await fs.rename(path.join(volDir, chapters[1].fileName), path.join(volDir, '0005-第2章 乙.md'));

			const inserted = await service.insertChapter(book, '插章', { after: chapters[0] });
			assert.strictEqual(inserted.fileName, '0002-插章.md');
			assert.strictEqual(inserted.renumbered, 0);
			assert.ok(await exists(path.join(volDir, '0005-第2章 乙.md')));
			assert.deepStrictEqual(
				(await service.listChapters(book)).map((c) => c.fileName),
				['0001-第1章 甲.md', '0002-插章.md', '0003-第3章 丙.md', '0005-第2章 乙.md']
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('renameChapter 同步内容首行标题，文件名不变时也纠正首行', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', THREE_CHAPTER_TEXT);
			const chapters = await service.listChapters(book);
			const volDir = path.join(book.dir, CHAPTERS_DIR, '第一卷');
			const mid = chapters[1];
			// 常规重命名：文件名与内容首行一起更新（首行保留输入原文，半角冒号仅从文件名清洗掉）
			await service.renameChapter(book, mid, '第2章 新乙:改');
			const newFileName = '0002-第2章 新乙改.md';
			assert.ok(await exists(path.join(volDir, newFileName)));
			assert.ok(!(await exists(path.join(volDir, mid.fileName))));
			const md = await fs.readFile(path.join(volDir, newFileName), 'utf8');
			assert.ok(md.startsWith('# 第2章 新乙:改\n'));
			// 文件名清洗后不变时，仍纠正内容首行（如只改了标题行未改文件名）
			const last = chapters[2];
			const lastPath = path.join(volDir, last.fileName);
			const raw = await fs.readFile(lastPath, 'utf8');
			await fs.writeFile(lastPath, raw.replace(/^# .*/m, '# 第3章 丙乱改'), 'utf8');
			await service.renameChapter(book, last, '第3章 丙');
			const lastMd = await fs.readFile(lastPath, 'utf8');
			assert.ok(lastMd.startsWith('# 第3章 丙\n'));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('章节/区间摘要状态：摘要之后章节被改动即待维护，仅导航重写不算改动', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', THREE_CHAPTER_TEXT);
			const [first, second, third] = await service.listChapters(book);
			const volDir = path.join(book.dir, CHAPTERS_DIR, '第一卷');
			const firstSummary = await service.ensureChapterSummary(book, first);
			const secondSummary = await service.ensureChapterSummary(book, second);
			const base = Math.floor(Date.now() / 1000) - 60;
			const touch = (filePath: string, offset: number): Promise<void> =>
				fs.utimes(filePath, base + offset, base + offset);
			await touch(firstSummary, 10);
			await touch(path.join(volDir, first.fileName), 10);
			// 第二段：摘要后章节又被改动（章节 mtime 比摘要新）→ 待维护
			await touch(secondSummary, 5);
			await touch(path.join(volDir, second.fileName), 10);

			let states = await service.listChapterSummaryStates(book);
			assert.strictEqual(states.get(chapterRelPath(first)), 'ok');
			assert.strictEqual(states.get(chapterRelPath(second)), 'stale');
			assert.strictEqual(states.get(chapterRelPath(third)), 'missing');

			// 摘要更新到章节之后 → 恢复最新
			await touch(secondSummary, 20);
			states = await service.listChapterSummaryStates(book);
			assert.strictEqual(states.get(chapterRelPath(second)), 'ok');

			// 删除末章只会重写第二段的导航链接，不应把它的摘要判成待维护，也不该丢掉它的「上一章」链接
			const secondPath = path.join(volDir, second.fileName);
			assert.ok((await fs.readFile(secondPath, 'utf8')).includes('下一章'));
			await service.removeChapter(book, third);
			const secondMd = await fs.readFile(secondPath, 'utf8');
			assert.ok(!secondMd.includes('下一章'));
			assert.ok(secondMd.includes(`[← 上一章](<${first.fileName}>)`));
			// 仅导航变化不会把修改时间刷成当前时间
			assert.ok((await fs.stat(secondPath)).mtimeMs < Date.now() - 30_000);
			states = await service.listChapterSummaryStates(book);
			assert.strictEqual(states.get(chapterRelPath(second)), 'ok');

			// 区间摘要：区间内任一章节更新即待维护
			const [interval] = await service.listIntervalSummaries(book);
			const intervalPath = await service.ensureIntervalSummary(book, interval.startSeq, interval.endSeq);
			await touch(intervalPath, 30);
			assert.strictEqual((await service.listIntervalSummaries(book))[0].state, 'ok');
			await touch(path.join(volDir, first.fileName), 40);
			assert.strictEqual((await service.listIntervalSummaries(book))[0].state, 'stale');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('syncChapterTitle 内容首行改名后同步文件名、导航、摘要与进度', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', THREE_CHAPTER_TEXT);
			const chapters = await service.listChapters(book);
			const mid = chapters[1];
			await service.ensureChapterSummary(book, mid);
			await service.setProgress(book.dir, chapterRelPath(mid));
			// 模拟直接改首行保存：内容标题变了，文件名未变
			const volDir = path.join(book.dir, CHAPTERS_DIR, '第一卷');
			const midPath = path.join(volDir, mid.fileName);
			const raw = await fs.readFile(midPath, 'utf8');
			await fs.writeFile(midPath, raw.replace(/^# .*/m, '# 第2章 新乙'), 'utf8');

			const changed = await service.syncChapterTitle(book, mid, '第2章 新乙');
			assert.ok(changed);
			const newFileName = '0002-第2章 新乙.md';
			assert.ok(await exists(path.join(volDir, newFileName)));
			assert.ok(!(await exists(midPath)));
			assert.ok((await fs.readFile(path.join(volDir, newFileName), 'utf8')).startsWith('# 第2章 新乙\n'));
			const prevMd = await fs.readFile(path.join(volDir, chapters[0].fileName), 'utf8');
			assert.ok(prevMd.includes(`[下一章 →](<${newFileName}>)`));
			const nextMd = await fs.readFile(path.join(volDir, chapters[2].fileName), 'utf8');
			assert.ok(nextMd.includes(`[← 上一章](<${newFileName}>)`));
			assert.strictEqual(service.getProgress(book.dir), `第一卷/${newFileName}`);
			assert.ok(await exists(path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷', newFileName)));
			// 标题与文件名一致时不再重命名
			assert.strictEqual(
				await service.syncChapterTitle(book, { fileName: newFileName, volumeDir: '第一卷' }, '第2章 新乙'),
				false
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('removeChapter 重写相邻导航、删除摘要镜像、迁移进度并移除笔记关联', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', THREE_CHAPTER_TEXT);
			const chapters = await service.listChapters(book);
			const mid = chapters[1];
			await service.ensureChapterSummary(book, mid);
			await service.setProgress(book.dir, chapterRelPath(mid));
			const notePath = await service.createNote(book, '关联笔记', undefined, mid);

			await service.removeChapter(book, mid);

			const volDir = path.join(book.dir, CHAPTERS_DIR, '第一卷');
			assert.ok(!(await exists(path.join(volDir, mid.fileName))));
			assert.ok(!(await exists(path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷', mid.fileName))));
			const prevMd = await fs.readFile(path.join(volDir, chapters[0].fileName), 'utf8');
			assert.ok(prevMd.includes(`[下一章 →](<${chapters[2].fileName}>)`));
			const nextMd = await fs.readFile(path.join(volDir, chapters[2].fileName), 'utf8');
			assert.ok(nextMd.includes(`[← 上一章](<${chapters[0].fileName}>)`));
			assert.strictEqual(service.getProgress(book.dir), chapterRelPath(chapters[0]));
			const noteMd = await fs.readFile(notePath, 'utf8');
			assert.ok(!noteMd.includes('chapter:'));
			assert.ok(!noteMd.includes('> 关联章节：'));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('moveChapter 跨卷移动同步摘要镜像、导航、进度与笔记关联', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', TWO_VOLUME_TEXT);
			const chapters = await service.listChapters(book);
			const first = chapters[0];
			const second = chapters[1];
			await service.ensureChapterSummary(book, first);
			await service.setProgress(book.dir, chapterRelPath(first));
			const notePath = await service.createNote(book, '卷笔记', undefined, first);

			await service.moveChapter(book, first, '第二卷');

			const firstDir = path.join(book.dir, CHAPTERS_DIR, '第一卷');
			const secondDir = path.join(book.dir, CHAPTERS_DIR, '第二卷');
			assert.ok(await exists(path.join(secondDir, first.fileName)));
			assert.ok(!(await exists(path.join(firstDir, first.fileName))));
			const summary = path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第二卷', first.fileName);
			assert.ok(await exists(summary));
			assert.ok(!(await exists(path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷', first.fileName))));
			const summaryMd = await fs.readFile(summary, 'utf8');
			assert.ok(summaryMd.includes(`(<../../章节/第二卷/${first.fileName}>)`));
			const secondMd = await fs.readFile(path.join(secondDir, second.fileName), 'utf8');
			assert.ok(secondMd.includes(`[← 上一章](<${first.fileName}>)`));
			assert.strictEqual(service.getProgress(book.dir), `第二卷/${first.fileName}`);
			const noteMd = await fs.readFile(notePath, 'utf8');
			assert.ok(noteMd.includes(`chapter: "第二卷/${first.fileName}"`));
			assert.ok(noteMd.includes(`(<../章节/第二卷/${first.fileName}>)`));
			// 目标卷不存在或与当前卷相同时拒绝
			await assert.rejects(() => service.moveChapter(book, second, '不存在的卷'));
			await assert.rejects(() => service.moveChapter(book, second, '第二卷'));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('renameVolume 同步镜像目录、版本目录、跨卷导航、进度键与笔记卷前缀', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', TWO_VOLUME_TEXT);
			const chapters = await service.listChapters(book);
			const first = chapters[0];
			await service.ensureChapterSummary(book, first);
			await service.createChapterVersion(book, first, '备选');
			await service.setProgress(book.dir, chapterRelPath(first));
			const notePath = await service.createNote(book, '卷笔记', undefined, first);

			const target = await service.renameVolume(book, '第一卷', '第零卷');
			assert.strictEqual(target, '第零卷');

			assert.ok(await exists(path.join(book.dir, CHAPTERS_DIR, '第零卷', first.fileName)));
			const summary = path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第零卷', first.fileName);
			assert.ok(await exists(summary));
			assert.ok(!(await exists(path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷'))));
			// 版本目录随分卷重命名一起迁移，新卷名下仍能列出
			const versions = await service.listChapterVersions(book, { fileName: first.fileName, volumeDir: '第零卷' });
			assert.deepStrictEqual(versions.map((v) => v.fileName), ['备选.md']);
			assert.ok(!(await exists(path.join(book.dir, VERSIONS_DIR, '第一卷'))));
			const summaryMd = await fs.readFile(summary, 'utf8');
			assert.ok(summaryMd.includes(`(<../../章节/第零卷/${first.fileName}>)`));
			const secondMd = await fs.readFile(path.join(book.dir, CHAPTERS_DIR, '第二卷', chapters[1].fileName), 'utf8');
			assert.ok(secondMd.includes(`[← 上一章](<../第零卷/${first.fileName}>)`));
			assert.strictEqual(service.getProgress(book.dir), `第零卷/${first.fileName}`);
			const noteMd = await fs.readFile(notePath, 'utf8');
			assert.ok(noteMd.includes(`chapter: "第零卷/${first.fileName}"`));
			assert.ok(noteMd.includes(`(<../章节/第零卷/${first.fileName}>)`));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('renameVolume 目标卷名已有摘要镜像 / 版本目录时拒绝，不留下错位的摘要与版本', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', TWO_VOLUME_TEXT);
			const first = (await service.listChapters(book))[0];
			await service.ensureChapterSummary(book, first);
			// 未来卷的计划落在 章节摘要/第三卷/（分卷本身尚未创建）
			const plan = await service.createChapterPlan(book, '远景', { seq: 9, volumeDir: '第三卷' });

			await assert.rejects(() => service.renameVolume(book, '第一卷', '第三卷'), /已有章节摘要目录/);
			assert.ok(await exists(path.join(book.dir, CHAPTERS_DIR, '第一卷')), '分卷未被移动');
			assert.ok(
				await exists(path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷', first.fileName)),
				'原摘要留在原分卷镜像下'
			);
			assert.ok(await exists(plan.filePath), '未来卷的计划原样保留');
			assert.ok(
				await exists(path.join(book.dir, CHAPTERS_DIR, '第一卷', first.fileName)),
				'章节未被移动'
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('deleteVolume 删除卷后剩余章导航重排，卷内进度迁移到剩余首章，版本目录一并删除', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', TWO_VOLUME_TEXT);
			const chapters = await service.listChapters(book);
			await service.setProgress(book.dir, chapterRelPath(chapters[0]));
			await service.createChapterVersion(book, chapters[0], '备选');

			await service.deleteVolume(book, '第一卷', true);

			assert.ok(!(await exists(path.join(book.dir, CHAPTERS_DIR, '第一卷'))));
			assert.ok(!(await exists(path.join(book.dir, VERSIONS_DIR, '第一卷'))));
			const restMd = await fs.readFile(path.join(book.dir, CHAPTERS_DIR, '第二卷', chapters[1].fileName), 'utf8');
			assert.ok(!restMd.includes('上一章'));
			assert.strictEqual(service.getProgress(book.dir), chapterRelPath(chapters[1]));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('renameBook 迁移文件夹、元数据 title、当前书与进度键', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '旧书', THREE_CHAPTER_TEXT);
			const chapters = await service.listChapters(book);
			await service.setCurrentBook(book.dir);
			await service.setProgress(book.dir, chapterRelPath(chapters[0]));

			const renamed = await service.renameBook(book, '新书');

			assert.strictEqual(renamed.name, '新书');
			assert.ok(await exists(path.join(root, '新书')));
			assert.ok(!(await exists(book.dir)));
			const meta = await fs.readFile(path.join(renamed.dir, META_FILE), 'utf8');
			assert.ok(meta.includes('title: "新书"'));
			assert.strictEqual(service.getCurrentBook()?.dir, renamed.dir);
			assert.strictEqual(service.getProgress(renamed.dir), chapterRelPath(chapters[0]));
			assert.strictEqual(service.getProgress(book.dir), undefined);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

suite('摘要：卷摘要与计划摘要', () => {
	const BOOK_TEXT = ['# 第一卷', '## 第1章 甲', '正文甲', '## 第2章 乙', '正文乙', '## 第3章 丙', '正文丙'].join('\n');
	const VOLUME_SUMMARY_DIR = '卷摘要';
	/** 摘要文件的修改时间固定在 60 秒前，便于用 utimes 编排先后顺序。 */
	const PAST = Math.floor(Date.now() / 1000) - 60;

	test('卷摘要状态：未建 → 最新 → 卷内章节更新后待维护', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			const [volume] = await service.listVolumes(book);
			assert.strictEqual(volume.dirName, '第一卷');
			assert.strictEqual((await service.listVolumeSummaries(book))[0].state, 'missing');

			const filePath = await service.ensureVolumeSummary(book, volume);
			assert.strictEqual(filePath, path.join(book.dir, VOLUME_SUMMARY_DIR, '第一卷.md'));
			const md = await fs.readFile(filePath, 'utf8');
			assert.ok(md.includes('# 第一卷 · 卷摘要'));
			assert.ok(md.includes(`0001 ${volume.chapters[0].title}`));
			assert.ok(!md.includes('## 计划'), '卷摘要不含计划小节（计划写在章节计划 / 区间计划里）');
			assert.strictEqual((await service.listVolumeSummaries(book))[0].state, 'ok');

			// 卷内任一章比卷摘要新 → 待维护
			await fs.utimes(filePath, PAST, PAST);
			const chapterPath = path.join(book.dir, CHAPTERS_DIR, '第一卷', volume.chapters[1].fileName);
			await fs.utimes(chapterPath, PAST + 30, PAST + 30);
			assert.strictEqual((await service.listVolumeSummaries(book))[0].state, 'stale');

			// 卷内有「有摘要无正文」的计划章节 → 卷摘要即计划（优先于 mtime 判定）
			await service.createChapterPlan(book, '后续', { seq: 4, volumeDir: '第一卷' });
			assert.strictEqual((await service.listVolumeSummaries(book))[0].state, 'planned');
			// 正文补齐（计划接手）后回到 mtime 判定：正文比卷摘要新 → 待维护
			await service.createChapterAt(book, 4, '后续', '第一卷');
			assert.strictEqual((await service.listVolumeSummaries(book))[0].state, 'stale');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('卷摘要随分卷重命名与删除同步', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			const [volume] = await service.listVolumes(book);
			await service.ensureVolumeSummary(book, volume);

			await service.renameVolume(book, '第一卷', '第二卷');
			assert.ok(await exists(path.join(book.dir, VOLUME_SUMMARY_DIR, '第二卷.md')));
			assert.ok(!(await exists(path.join(book.dir, VOLUME_SUMMARY_DIR, '第一卷.md'))));

			await service.deleteVolume(book, '第二卷', true);
			assert.ok(!(await exists(path.join(book.dir, VOLUME_SUMMARY_DIR, '第二卷.md'))));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('计划章节摘要：正文未创建时为计划，正文创建时自动接手并转为待维护', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			const plan = await service.createChapterPlan(book, '旧名', { seq: 4, volumeDir: '第一卷' });
			assert.strictEqual(plan.filePath, path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷', '0004-旧名.md'));
			assert.strictEqual(plan.shifted, 0);

			let states = await service.listChapterSummaryStates(book);
			assert.strictEqual(states.get('第一卷/0004-旧名.md'), 'planned');
			const [group] = await service.listChapterSummaries(book);
			assert.strictEqual(group.entries.find((entry) => entry.fileName === '0004-旧名.md')?.state, 'planned');

			// 正文以同序号、不同标题创建 → 计划摘要移到正文名下，标题与原文链接补齐
			const fileName = await service.createChapter(book, '新名', '第一卷');
			assert.strictEqual(fileName, '0004-新名.md');
			assert.ok(!(await exists(plan.filePath)));
			const md = await fs.readFile(path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷', '0004-新名.md'), 'utf8');
			assert.ok(md.includes('# 新名 · 摘要'));
			assert.ok(md.includes('> 原文：[0004-新名.md](<../../章节/第一卷/0004-新名.md>)'));
			states = await service.listChapterSummaryStates(book);
			assert.strictEqual(states.get('第一卷/0004-新名.md'), 'stale');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('插章顺延序号时计划摘要一并顺延', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			await service.createChapterPlan(book, '后续', { seq: 4, volumeDir: '第一卷' });

			// 末章（序号 3）顺延为 4，计划摘要须让位顺延为 0005
			const chapters = await service.listChapters(book);
			await service.insertChapter(book, '插章', { before: chapters[2] });

			assert.ok(await exists(path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷', '0005-后续.md')));
			assert.ok(!(await exists(path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷', '0004-后续.md'))));
			assert.deepStrictEqual((await service.listChapters(book)).map((c) => c.seq), [1, 2, 3, 4]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('按计划写正文：createChapterAt 落到计划序号并接手，占用序号顺延、远处序号留空洞', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			// 计划落在存量之间：0002 被占用 → 建计划时顺延，计划占住 0002
			const plan = await service.createChapterPlan(book, '插曲', { seq: 2, volumeDir: '第一卷' });
			assert.strictEqual(plan.shifted, 2);
			assert.deepStrictEqual((await service.listChapters(book)).map((c) => c.seq), [1, 3, 4]);

			// 按计划写正文：序号 2 空闲 → 直接落位，计划摘要自动接手
			const created = await service.createChapterAt(book, 2, '插曲', '第一卷');
			assert.strictEqual(created.fileName, '0002-插曲.md');
			assert.strictEqual(created.shifted, 0);
			const md = await fs.readFile(
				path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷', '0002-插曲.md'),
				'utf8'
			);
			assert.ok(md.includes('> 原文：[0002-插曲.md]'));

			// 远处序号（500）：允许留空洞
			await service.createChapterAt(book, 500, '遥远的终章', '第一卷');
			assert.deepStrictEqual(
				(await service.listChapters(book)).map((c) => c.seq),
				[1, 2, 3, 4, 500]
			);

			// 已占用序号：其后全部顺延（含远处的 500）
			const pushed = await service.createChapterAt(book, 3, '挤进来', '第一卷');
			assert.strictEqual(pushed.shifted, 3);
			assert.deepStrictEqual(
				(await service.listChapters(book)).map((c) => c.seq),
				[1, 2, 3, 4, 5, 501]
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('重命名分卷时目标卷名已有卷摘要（未来卷的计划）则拒绝，不覆盖', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			await service.ensureVolumeSummary(book, { name: '第一卷', dirName: '第一卷' });
			const planFile = await service.ensureVolumeSummary(book, { name: '第二卷', dirName: '第二卷' });
			const planMd = await fs.readFile(planFile, 'utf8');

			await assert.rejects(() => service.renameVolume(book, '第一卷', '第二卷'), /已有卷摘要/);
			assert.ok(await exists(path.join(book.dir, CHAPTERS_DIR, '第一卷')), '分卷未被移动');
			assert.strictEqual(await fs.readFile(planFile, 'utf8'), planMd, '未来卷的计划原样保留');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('卷摘要状态：卷内计划章节未写成正文时为计划（分卷尚未创建亦然），chapterPlanSlot 清洗非法引用', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			const filePath = await service.ensureVolumeSummary(book, { name: '第二卷', dirName: '第二卷' });
			// 分卷尚未创建、卷内也没有计划章节 → 只按 mtime（摘要文件在 → 最新）
			assert.deepStrictEqual(
				(await service.listVolumeSummaries(book)).map((summary) => [summary.name, summary.state]),
				[
					['第一卷', 'missing'],
					['第二卷', 'ok'],
				]
			);
			// 卷内写入计划章节（正文未写）→ 该卷摘要转为计划
			await service.createChapterPlan(book, '抵达', { seq: 7, volumeDir: '第二卷' });
			assert.strictEqual(
				(await service.listVolumeSummaries(book)).find((summary) => summary.name === '第二卷')?.state,
				'planned'
			);
			const md = await fs.readFile(filePath, 'utf8');
			assert.ok(md.includes('- （尚无章节）'));

			const summaryDir = path.join(book.dir, CHAPTER_SUMMARIES_DIR);
			assert.deepStrictEqual(await service.chapterPlanSlot(book, '0004-抵达'), {
				filePath: path.join(summaryDir, '0004-抵达.md'),
			});
			assert.deepStrictEqual(await service.chapterPlanSlot(book, '第二卷/0005-抵达.md'), {
				filePath: path.join(summaryDir, '第二卷', '0005-抵达.md'),
			});
			assert.strictEqual(await service.chapterPlanSlot(book, '抵达'), undefined);
			assert.strictEqual(await service.chapterPlanSlot(book, '../../0005-越界'), undefined);
			// 序号已被正文占用：不能直接写计划，改走 manageChapter(insert, plan) 顺延
			const taken = await service.chapterPlanSlot(book, '0002-别处来的计划');
			assert.ok(taken && 'occupied' in taken && taken.occupied.kind === 'chapter');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('计划章节可落在存量中间：序号被占用时其后的正文与计划一并顺延', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			const before = await service.listChapters(book);
			// 先建一个末尾之后的计划（序号 4），再在中间（序号 2）建计划
			await service.createChapterPlan(book, '旧计划', { seq: 4, volumeDir: '第一卷' });
			const plan = await service.createChapterPlan(book, '插队计划', { seq: 2, volumeDir: '第一卷' });

			assert.strictEqual(plan.fileName, '0002-插队计划.md');
			assert.strictEqual(plan.shifted, 2);
			await fs.access(plan.filePath);
			const after = await service.listChapters(book);
			assert.deepStrictEqual(after.map((c) => c.seq), [1, 3, 4]);
			// 原有计划摘要跟着顺延到 0005，不会撞上顺延后的正文
			const summariesDir = path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第一卷');
			await fs.access(path.join(summariesDir, '0005-旧计划.md'));
			assert.ok(!(await exists(path.join(summariesDir, '0004-旧计划.md'))));
			// 顺延后相邻章导航重写为新的文件名
			const first = await fs.readFile(path.join(book.dir, CHAPTERS_DIR, '第一卷', before[0].fileName), 'utf8');
			assert.ok(first.includes(after[1].fileName));
			// 两条计划都在清单里
			const states = await service.listChapterSummaryStates(book);
			assert.strictEqual(states.get('第一卷/0002-插队计划.md'), 'planned');
			assert.strictEqual(states.get('第一卷/0005-旧计划.md'), 'planned');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('区间摘要：起止任意、可重叠，覆盖默认块后不再重复提示，越出正文即计划', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			const intervalDir = path.join(book.dir, INTERVAL_SUMMARIES_DIR);
			// 默认块：每 10 章一块；3 章的书只有一块，未被覆盖时提示未建
			let intervals = await service.listIntervalSummaries(book);
			assert.deepStrictEqual(
				intervals.map((interval) => [interval.fileName, interval.state]),
				[['0001-0003.md', 'missing']]
			);

			// 任意长度（2 章）的区间：覆盖了默认块，默认块不再提示
			await service.ensureIntervalSummary(book, 1, 2);
			const shortPath = path.join(intervalDir, '0001-0002.md');
			await fs.writeFile(
				shortPath,
				(await fs.readFile(shortPath, 'utf8')).replace('## 摘要', '## 摘要\n\n测试正文'),
				'utf8'
			);
			intervals = await service.listIntervalSummaries(book);
			assert.deepStrictEqual(
				intervals.map((interval) => [interval.fileName, interval.state]),
				[['0001-0002.md', 'ok']]
			);
			assert.deepStrictEqual(intervals[0].chapters.map((chapter) => chapter.seq), [1, 2]);

			// 重叠区间 + 越出现存章节的区间（后者即计划）
			await service.ensureIntervalSummary(book, 2, 12);
			intervals = await service.listIntervalSummaries(book);
			assert.deepStrictEqual(
				intervals.map((interval) => [interval.fileName, interval.state]),
				[
					['0001-0002.md', 'ok'],
					['0002-0012.md', 'planned'],
				]
			);

			// 改区间：文件改名，标题与「章节范围」重写，摘要正文保留
			const target = await service.editIntervalSummary(book, '0001-0002.md', 3, 5);
			assert.strictEqual(target, path.join(intervalDir, '0003-0005.md'));
			assert.ok(!(await exists(shortPath)));
			const md = await fs.readFile(target, 'utf8');
			assert.ok(md.includes('# 第 3–5 章 · 区间摘要'));
			assert.ok(md.includes('测试正文'));
			assert.ok(!md.includes('0001'));

			// 删除后只剩改过的那份（它覆盖了默认块）
			await service.removeIntervalSummary(book, '0002-0012.md');
			intervals = await service.listIntervalSummaries(book);
			assert.deepStrictEqual(intervals.map((interval) => interval.fileName), ['0003-0005.md']);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('卷内有计划章节但卷摘要未创建时状态仍是未建', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			await service.createChapterPlan(book, '远景', { seq: 9, volumeDir: '第一卷' });

			const [summary] = await service.listVolumeSummaries(book);
			assert.strictEqual(summary.state, 'missing');
			await assert.rejects(() => service.removeVolumePlan(book, '第一卷'), /尚未创建/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('摘要删除只对计划开放：章节 / 卷 / 区间摘要已有正文时拒绝单独删除', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			const [volume] = await service.listVolumes(book);
			const first = volume.chapters[0];

			// 章节摘要：有正文时不能单独删；计划可以（接受 章节摘要/ 前缀与 .md）
			await service.ensureChapterSummary(book, first);
			await assert.rejects(() => service.removeChapterPlan(book, chapterRelPath(first)), /已有正文/);
			const plan = await service.createChapterPlan(book, '远景', { seq: 9, volumeDir: '第一卷' });
			assert.strictEqual(await service.removeChapterPlan(book, '章节摘要/第一卷/0009-远景.md'), '第一卷/0009-远景.md');
			assert.ok(!(await exists(plan.filePath)));
			await assert.rejects(() => service.removeChapterPlan(book, '第一卷/0009-远景'), /找不到计划摘要/);

			// 卷摘要：卷内还没有正文时可删，有正文时拒绝
			await service.ensureVolumeSummary(book, { name: '第二卷', dirName: '第二卷' });
			assert.strictEqual(await service.removeVolumePlan(book, '第二卷'), '第二卷.md');
			assert.ok(!(await exists(path.join(book.dir, VOLUME_SUMMARIES_DIR, '第二卷.md'))));
			await service.ensureVolumeSummary(book, volume);
			await assert.rejects(() => service.removeVolumePlan(book, '第一卷'), /已有正文/);

			// 区间摘要：越出现存章节范围（计划）可删，覆盖正文的拒绝
			await service.ensureIntervalSummary(book, 9, 12);
			await service.removeIntervalSummary(book, intervalSummaryFileName(9, 12));
			await service.ensureIntervalSummary(book, 1, 3);
			await assert.rejects(
				() => service.removeIntervalSummary(book, intervalSummaryFileName(1, 3)),
				/已覆盖正文/
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

suite('条目分类（世界书/角色卡/笔记）', () => {
	const BOOK_TEXT = ['# 第一卷', '## 第1章 甲', '正文甲', '## 第2章 乙', '正文乙'].join('\n');

	test('createEntry/createCategory 支持多级分类，listCategories 递归展开', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);

			// 建条目时按 / 逐级创建分类
			const entry = await service.createEntry(book, WORLD_DIR, '王城', '地理/城邦');
			assert.strictEqual(path.relative(book.dir, entry), path.join(WORLD_DIR, '地理', '城邦', '王城.md'));

			// 显式新建空分类（含占位文件以便 git 跟踪）
			await service.createCategory(book, CARDS_DIR, '主角/配角');
			assert.ok(await exists(path.join(book.dir, CARDS_DIR, '主角', '配角', '.gitkeep')));

			assert.deepStrictEqual(
				(await service.listCategories(book, WORLD_DIR)).map((c) => c.path),
				['地理', '地理/城邦']
			);
			assert.deepStrictEqual(
				(await service.listChildCategories(book, WORLD_DIR)).map((c) => c.path),
				['地理']
			);
			assert.deepStrictEqual(
				(await service.listChildCategories(book, WORLD_DIR, '地理')).map((c) => c.path),
				['地理/城邦']
			);
			// listEntries 只列所在层
			assert.deepStrictEqual(
				(await service.listEntries(book, WORLD_DIR, '地理/城邦')).map((e) => e.name),
				['王城']
			);
			assert.deepStrictEqual(await service.listEntries(book, WORLD_DIR), []);
			// 同名分类重复创建时报错
			await assert.rejects(() => service.createCategory(book, CARDS_DIR, '主角'));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('renameCategory 只改末级名并保留父路径，deleteCategory 递归删除', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			await service.createEntry(book, CARDS_DIR, '林晚', '主角/配角');
			await service.createEntry(book, CARDS_DIR, '林晚的师父', '主角');

			const target = await service.renameCategory(book, CARDS_DIR, '主角/配角', '重要配角');

			assert.strictEqual(target, '主角/重要配角');
			assert.ok(await exists(path.join(book.dir, CARDS_DIR, '主角', '重要配角', '林晚.md')));
			assert.ok(!(await exists(path.join(book.dir, CARDS_DIR, '主角', '配角'))));

			await service.deleteCategory(book, CARDS_DIR, '主角');
			assert.ok(!(await exists(path.join(book.dir, CARDS_DIR, '主角'))));
			assert.deepStrictEqual(await service.listCategories(book, CARDS_DIR), []);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('renameCategory 改父分类名时子分类路径同步变化', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			await service.createEntry(book, WORLD_DIR, '王城', '地理/城邦');

			await service.renameCategory(book, WORLD_DIR, '地理', '地理设定');

			assert.deepStrictEqual(
				(await service.listCategories(book, WORLD_DIR)).map((c) => c.path),
				['地理设定', '地理设定/城邦']
			);
			assert.ok(await exists(path.join(book.dir, WORLD_DIR, '地理设定', '城邦', '王城.md')));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('moveEntry 跨分类移动条目，目标分类不存在则创建，重名时报错', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			await service.createEntry(book, WORLD_DIR, '王城', '地理/城邦');

			// 多级目标分类不存在时按路径创建
			await service.moveEntry(book, WORLD_DIR, '地理/城邦', '王城.md', '地理/城邦/首都');
			assert.ok(await exists(path.join(book.dir, WORLD_DIR, '地理', '城邦', '首都', '王城.md')));
			assert.ok(!(await exists(path.join(book.dir, WORLD_DIR, '地理', '城邦', '王城.md'))));
			assert.deepStrictEqual(
				(await service.listEntries(book, WORLD_DIR, '地理/城邦/首都')).map((e) => e.name),
				['王城']
			);

			// 移回根目录
			await service.moveEntry(book, WORLD_DIR, '地理/城邦/首都', '王城.md', undefined);
			assert.deepStrictEqual((await service.listEntries(book, WORLD_DIR)).map((e) => e.name), ['王城']);

			// 目标分类同名条目已存在
			await service.createEntry(book, WORLD_DIR, '王城', '地理');
			await assert.rejects(() => service.moveEntry(book, WORLD_DIR, undefined, '王城.md', '地理'), /已存在/);
			// 原地移动
			await assert.rejects(() => service.moveEntry(book, WORLD_DIR, undefined, '王城.md', undefined), /已在目标分类/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('moveEntry 移动笔记后按新层级重写关联章节链接', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			const chapter = (await service.listChapters(book))[0];
			const notePath = await service.createNote(book, '支线想法', '剧情', chapter);
			assert.ok((await fs.readFile(notePath, 'utf8')).includes(`(<../../${CHAPTERS_DIR}/第一卷/`));

			// 层级加深：链接前缀随之加长
			await service.moveEntry(book, NOTES_DIR, '剧情', '支线想法.md', '剧情/支线');
			const deeper = await fs.readFile(path.join(book.dir, NOTES_DIR, '剧情', '支线', '支线想法.md'), 'utf8');
			assert.ok(deeper.includes(`(<../../../${CHAPTERS_DIR}/第一卷/${chapter.fileName}>)`));
			assert.ok(deeper.includes('chapter: "第一卷/'));
			assert.ok(deeper.includes('> 关联章节：[第1章 甲]'));

			// 移回根目录：前缀还原为一级
			await service.moveEntry(book, NOTES_DIR, '剧情/支线', '支线想法.md', undefined);
			const restored = await fs.readFile(path.join(book.dir, NOTES_DIR, '支线想法.md'), 'utf8');
			assert.ok(restored.includes(`(<../${CHAPTERS_DIR}/第一卷/${chapter.fileName}>)`));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('嵌套分类笔记的章节关联链接按层级计算，章节改名后同步更新', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			const chapter = (await service.listChapters(book))[0];

			const notePath = await service.createNote(book, '支线想法', '剧情/支线', chapter);
			const noteMd = await fs.readFile(notePath, 'utf8');
			assert.ok(noteMd.includes('chapter: "第一卷/'));
			assert.ok(noteMd.includes(`(<../../../${CHAPTERS_DIR}/第一卷/${chapter.fileName}>)`));

			const newFileName = await service.renameChapter(book, chapter, '第1章 新甲');

			const updated = await fs.readFile(notePath, 'utf8');
			assert.ok(updated.includes(`(<../../../${CHAPTERS_DIR}/第一卷/${newFileName}>)`));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	test('分类路径统一清洗，含 .. 的输入不会越出条目根目录', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', BOOK_TEXT);
			const outside = path.join(root, '外部文件.md');
			await fs.writeFile(outside, 'x', 'utf8');

			// 新建：越界片段被化解为普通名字，条目仍落在条目根目录内
			const entry = await service.createEntry(book, WORLD_DIR, '王城', '../../外部');
			assert.strictEqual(
				path.relative(book.dir, entry),
				path.join(WORLD_DIR, '未命名', '未命名', '外部', '王城.md')
			);

			// 移动：源与目标都经清洗，落点仍在条目根目录内
			await service.moveEntry(book, WORLD_DIR, '../../外部', '王城.md', '../../../..');
			assert.ok(await exists(path.join(book.dir, WORLD_DIR, '未命名', '未命名', '未命名', '未命名', '王城.md')));

			// 删除与读取：越界路径既不删也读不到条目根目录之外的内容
			await service.deleteCategory(book, WORLD_DIR, '../../..');
			assert.ok(await exists(outside));
			assert.deepStrictEqual(await service.listEntries(book, WORLD_DIR, '../../../..'), []);
			assert.deepStrictEqual(await service.listChildCategories(book, WORLD_DIR, '../../../..'), []);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

suite('子书架（多级分类）', () => {
	const BOOK_TEXT = ['# 第一卷', '## 第1章 甲', '正文甲'].join('\n');
	let root = '';
	let prevLibraryPath: string | undefined;
	const service = makeService();

	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		const cfg = vscode.workspace.getConfiguration('xReader');
		prevLibraryPath = cfg.get<string>('libraryPath');
		await cfg.update('libraryPath', root, vscode.ConfigurationTarget.Global);
	});

	teardown(async () => {
		const cfg = vscode.workspace.getConfiguration('xReader');
		await cfg.update('libraryPath', prevLibraryPath ?? '', vscode.ConfigurationTarget.Global);
		await fs.rm(root, { recursive: true, force: true });
	});

	test('shelfParentPath/shelfLeafName 切分多级路径', () => {
		assert.strictEqual(shelfParentPath('题材'), undefined);
		assert.strictEqual(shelfParentPath('题材/同人/XXX'), '题材/同人');
		assert.strictEqual(shelfLeafName('题材'), '题材');
		assert.strictEqual(shelfLeafName('题材/同人/XXX'), 'XXX');
	});

	test('createShelf 支持多级路径，缺的上级一并落盘，重名与默认名冲突时报错', async () => {
		await service.createShelf('题材/同人/XXX');

		assert.deepStrictEqual(
			(await service.listShelves()).map((s) => s.name),
			['题材', '题材/同人', '题材/同人/XXX']
		);
		const raw = JSON.parse(await fs.readFile(path.join(root, SHELVES_FILE), 'utf8')) as { name: string }[];
		assert.deepStrictEqual(raw.map((s) => s.name), ['题材', '题材/同人', '题材/同人/XXX']);

		await assert.rejects(() => service.createShelf('题材/同人'), /已存在/);
		await assert.rejects(() => service.createShelf('默认/子类'), /冲突/);
	});

	test('书链接挂在多级子书架下，同级不同父可同名', async () => {
		const { book } = await createBookFromText(root, '书', BOOK_TEXT);
		await service.createShelf('题材/同人');
		await service.createShelf('体裁/同人');

		await service.addBookToShelf('题材/同人', book.name);
		assert.deepStrictEqual((await service.listShelves()).find((s) => s.name === '题材/同人')?.books, [book.name]);
		assert.deepStrictEqual((await service.listShelves()).find((s) => s.name === '体裁/同人')?.books, []);

		await service.removeBookFromShelf('题材/同人', book.name);
		assert.deepStrictEqual((await service.listShelves()).find((s) => s.name === '题材/同人')?.books, []);
	});

	test('renameShelf 只改末级名并同步下级路径，目标重名时报错', async () => {
		await service.createShelf('题材/同人/XXX');

		await service.renameShelf('题材/同人', '同人向');
		assert.deepStrictEqual(
			(await service.listShelves()).map((s) => s.name),
			['题材', '题材/同人向', '题材/同人向/XXX']
		);

		await service.createShelf('其他');
		await assert.rejects(() => service.renameShelf('其他', '题材'), /已存在/);
		// 改父分类名时整棵子树迁移
		await service.renameShelf('题材', '题材设定');
		assert.deepStrictEqual(
			(await service.listShelves()).map((s) => s.name),
			['其他', '题材设定', '题材设定/同人向', '题材设定/同人向/XXX']
		);
	});

	test('deleteShelf 连同下级一并删除，书目录不受影响', async () => {
		const { book } = await createBookFromText(root, '书', BOOK_TEXT);
		await service.createShelf('题材/同人/XXX');
		await service.createShelf('体裁');
		await service.addBookToShelf('题材/同人/XXX', book.name);

		await service.deleteShelf('题材');

		assert.deepStrictEqual((await service.listShelves()).map((s) => s.name), ['体裁']);
		assert.ok(await exists(book.dir));
	});

	test('书改名时多级子书架里的链接级联同步', async () => {
		const { book } = await createBookFromText(root, '书', BOOK_TEXT);
		await service.createShelf('题材/同人/XXX');
		await service.addBookToShelf('题材/同人/XXX', book.name);

		const renamed = await service.renameBook(book, '新书');

		assert.deepStrictEqual(
			(await service.listShelves()).find((s) => s.name === '题材/同人/XXX')?.books,
			[renamed.name]
		);
	});
});

suite('大书库扫描', () => {
	test('countChapters 与 listChapters 计数一致（含分卷与根目录章节）', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(
				root,
				'书',
				['# 第一卷', '## 第1章 甲', '正文甲', '# 第二卷', '## 第2章 乙', '正文乙'].join('\n')
			);
			await service.createChapter(book, '第3章 丙');

			assert.strictEqual(await service.countChapters(book), (await service.listChapters(book)).length);
			assert.strictEqual(await service.countChapters(book), 3);

			// 目录名不是章节文件、无章节的空书都按 0 处理
			const empty = await createBookFromText(root, '空书', '没有标题的正文');
			await fs.rm(path.join(empty.book.dir, CHAPTERS_DIR), { recursive: true, force: true });
			assert.strictEqual(await service.countChapters(empty.book), 0);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('listChapterCounts 按书目录批量返回章节数', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const first = await createBookFromText(root, '甲书', ['## 第1章', '正文', '## 第2章', '正文'].join('\n'));
			const second = await createBookFromText(root, '乙书', ['## 第1章', '正文'].join('\n'));

			const counts = await service.listChapterCounts([first.book, second.book]);

			assert.strictEqual(counts.get(first.book.dir), 2);
			assert.strictEqual(counts.get(second.book.dir), 1);
			assert.strictEqual(counts.size, 2);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('短时间内的多次写操作合并为一次刷新通知', async () => {
		const service = makeService();
		let fires = 0;
		service.onDidChange(() => fires++);

		for (let i = 0; i < 20; i++) {
			await service.setProgress('/lib/书', `第${i}章.md`);
		}
		await new Promise((resolve) => setTimeout(resolve, 200));

		assert.ok(fires >= 1, '变更后应通知刷新');
		assert.ok(fires <= 3, `20 次写操作应合并为 1 次左右通知，实际 ${fires} 次`);
	});

	test('listBooks 并发扫描后仍只把含 元数据.md 的目录当作书', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		const cfg = vscode.workspace.getConfiguration('xReader');
		const prev = cfg.get<string>('libraryPath');
		try {
			await cfg.update('libraryPath', root, vscode.ConfigurationTarget.Global);
			const service = makeService();
			await createBookFromText(root, '书B', '正文');
			await createBookFromText(root, '书A', '正文');
			await fs.mkdir(path.join(root, '不是书'), { recursive: true });
			await fs.writeFile(path.join(root, '不是书', 'readme.md'), '', 'utf8');
			await fs.writeFile(path.join(root, '散文件.md'), '', 'utf8');

			assert.deepStrictEqual(
				(await service.listBooks()).map((book) => book.name),
				['书A', '书B']
			);
		} finally {
			await cfg.update('libraryPath', prev ?? '', vscode.ConfigurationTarget.Global);
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

suite('git 服务', () => {
	/** 执行真实 git；git 不可用时返回 undefined（测试随之跳过）。 */
	const git = (cwd: string, args: string[]): Promise<string | undefined> =>
		new Promise((resolve) => {
			execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
		});

	test('git 输出很大时提交不被误判为失败（大书库逐文件 create mode 输出）', async () => {
		// 假 git 脚本依赖 sh
		if (process.platform === 'win32') {
			return;
		}
		const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-fakegit-'));
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-git-'));
		const prevPath = process.env.PATH;
		try {
			// commit 输出 2MB，超出 Node execFile 默认 1MB 缓冲
			const script = [
				'#!/bin/sh',
				'case "$1 $2" in',
				'  "rev-parse --is-inside-work-tree") echo true ;;',
				'  "config user.name") echo tester ;;',
				'  "commit "*) head -c 2097152 /dev/zero | tr "\\0" x ;;',
				'esac',
				'exit 0',
			].join('\n');
			await fs.writeFile(path.join(binDir, 'git'), script, { mode: 0o755 });
			process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`;
			assert.strictEqual(await commitAll(root, '大书库快照'), true);
		} finally {
			process.env.PATH = prevPath;
			await fs.rm(binDir, { recursive: true, force: true });
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('resetHistory 非仓库目录下重建成功', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-git-'));
		try {
			if ((await git(root, ['--version'])) === undefined) {
				return;
			}
			await fs.writeFile(path.join(root, 'a.md'), 'a');
			assert.deepStrictEqual(await resetHistory(root, '重建仓库'), { ok: true });
			assert.ok((await git(root, ['log', '--oneline'])) !== undefined);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('resetHistory 在库目录位于其他仓库内部时按原因拒绝', async () => {
		const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-git-'));
		try {
			if ((await git(outer, ['--version'])) === undefined) {
				return;
			}
			const inner = path.join(outer, 'books');
			await fs.mkdir(inner, { recursive: true });
			await fs.writeFile(path.join(inner, 'a.md'), 'a');
			await git(outer, ['init']);
			assert.deepStrictEqual(await resetHistory(inner, '重建仓库'), { ok: false, reason: 'nested-repo' });
		} finally {
			await fs.rm(outer, { recursive: true, force: true });
		}
	});

	test('resetHistory 在 .git 是文件时按原因拒绝', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-git-'));
		try {
			await fs.writeFile(path.join(root, '.git'), 'gitdir: /nonexistent');
			assert.deepStrictEqual(await resetHistory(root, '重建仓库'), { ok: false, reason: 'gitnotdir' });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

suite('分角色朗读音色配置', () => {
	test('读取根目录与分类下的角色卡：音色行、frontmatter voice/voiceId 与类型映射', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-voice-'));
		try {
			const bookDir = path.join(root, '书');
			const nested = path.join(bookDir, CARDS_DIR, '主角团', '配角');
			await fs.mkdir(nested, { recursive: true });
			// 根目录：旁白用「音色」行，自动作为旁白音色
			await fs.writeFile(path.join(bookDir, CARDS_DIR, '旁白.md'), '# 旁白\n\n- 音色：zh-narrator\n', 'utf8');
			// 二级分类：frontmatter voice + 类型映射
			await fs.writeFile(
				path.join(nested, '林月.md'),
				'---\nvoice: zh-female-01\n---\n\n# 林月\n\n- 类型：少女\n',
				'utf8'
			);
			// 二级分类：frontmatter voiceId，无类型时按角色名映射
			await fs.writeFile(path.join(nested, '陈默.md'), '---\nvoiceId: zh-male-09\n---\n\n# 陈默\n', 'utf8');

			assert.deepStrictEqual(await readCharacterVoiceConfig(makeService(), bookDir), {
				characterVoices: { 陈默: 'zh-male-09' },
				roleTypeVoices: { narrator: 'zh-narrator', girl: 'zh-female-01' },
				voiceParams: {},
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('没有任何卡片带音色时返回 undefined', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-voice-'));
		try {
			const bookDir = path.join(root, '书');
			await fs.mkdir(path.join(bookDir, CARDS_DIR), { recursive: true });
			await fs.writeFile(path.join(bookDir, CARDS_DIR, '甲.md'), '# 甲\n\n这个角色没有音色。\n', 'utf8');

			assert.strictEqual(await readCharacterVoiceConfig(makeService(), bookDir), undefined);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
