import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as iconv from 'iconv-lite';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	CARDS_DIR,
	CHAPTER_SUMMARIES_DIR,
	CHAPTERS_DIR,
	createBookFromText,
	INTERVAL_SUMMARIES_DIR,
	META_FILE,
	NOTES_DIR,
	WORLD_DIR,
} from '../services/bookFactory';
import { chapterRelPath, LibraryService } from '../services/library';
import {
	buildChapterMarkdown,
	buildChapterSummaryMarkdown,
	buildIntervalSummaryMarkdown,
	buildNoteMarkdown,
	chapterFileName,
	chineseNumberToInt,
	extractMarkdownTitle,
	intervalSummaryFileName,
	navRelPath,
	parseChapterFileName,
	sanitizeFileTitle,
	updateChapterNav,
} from '../services/markdown';
import { decodeBuffer, parseChapters } from '../services/novelParser';

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

	test('parseChapterFileName 解析合法文件名，拒绝非章节文件', () => {
		assert.deepStrictEqual(parseChapterFileName('0003-初见.md'), { seq: 3, title: '初见' });
		assert.deepStrictEqual(parseChapterFileName('0010-第一章 雨夜.md'), { seq: 10, title: '第一章 雨夜' });
		assert.deepStrictEqual(parseChapterFileName('5-手写序号.md'), { seq: 5, title: '手写序号' });
		assert.strictEqual(parseChapterFileName('readme.md'), undefined);
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
			const first = await createBookFromText(root, '测试书', '测试书.txt', text);
			assert.strictEqual(first.book.name, '测试书');
			assert.strictEqual(first.chapterCount, 2);

			const dir = first.book.dir;
			const meta = await fs.readFile(path.join(dir, META_FILE), 'utf8');
			assert.ok(meta.includes('title: "测试书"'));
			assert.ok(meta.includes('## 写作要求'));
			for (const sub of [WORLD_DIR, CARDS_DIR, CHAPTER_SUMMARIES_DIR, INTERVAL_SUMMARIES_DIR, NOTES_DIR]) {
				await fs.access(path.join(dir, sub, '.gitkeep'));
			}

			const chapterFiles = (await fs.readdir(path.join(dir, CHAPTERS_DIR))).sort();
			assert.deepStrictEqual(chapterFiles, ['0001-第一章 起.md', '0002-第二章 承.md']);
			const ch1 = await fs.readFile(path.join(dir, CHAPTERS_DIR, chapterFiles[0]), 'utf8');
			assert.ok(ch1.includes('# 第一章 起'));
			assert.ok(ch1.includes('内容一'));
			assert.ok(ch1.includes('[下一章 →](<0002-第二章 承.md>)'));

			const second = await createBookFromText(root, '测试书', '测试书.txt', text);
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
			const result = await createBookFromText(root, '卷书', '卷书.txt', text);
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
			const result = await createBookFromText(root, '无章节', '无章节.txt', '没有标题的正文');
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
	const exists = async (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

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
				for (const sub of [WORLD_DIR, CARDS_DIR, CHAPTER_SUMMARIES_DIR, INTERVAL_SUMMARIES_DIR, NOTES_DIR]) {
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

	test('renameChapter 同步文件名、摘要镜像、导航、进度与笔记关联（含无引号 frontmatter）', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', '书.txt', THREE_CHAPTER_TEXT);
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

	test('renameChapter 同步内容首行标题，文件名不变时也纠正首行', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', '书.txt', THREE_CHAPTER_TEXT);
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

	test('syncChapterTitle 内容首行改名后同步文件名、导航、摘要与进度', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', '书.txt', THREE_CHAPTER_TEXT);
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
			const { book } = await createBookFromText(root, '书', '书.txt', THREE_CHAPTER_TEXT);
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

	test('renameVolume 同步镜像目录、跨卷导航、进度键与笔记卷前缀', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', '书.txt', TWO_VOLUME_TEXT);
			const chapters = await service.listChapters(book);
			const first = chapters[0];
			await service.ensureChapterSummary(book, first);
			await service.setProgress(book.dir, chapterRelPath(first));
			const notePath = await service.createNote(book, '卷笔记', undefined, first);

			const target = await service.renameVolume(book, '第一卷', '第零卷');
			assert.strictEqual(target, '第零卷');

			assert.ok(await exists(path.join(book.dir, CHAPTERS_DIR, '第零卷', first.fileName)));
			const summary = path.join(book.dir, CHAPTER_SUMMARIES_DIR, '第零卷', first.fileName);
			assert.ok(await exists(summary));
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

	test('deleteVolume 删除卷后剩余章导航重排，卷内进度迁移到剩余首章', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xreader-lib-'));
		try {
			const service = makeService();
			const { book } = await createBookFromText(root, '书', '书.txt', TWO_VOLUME_TEXT);
			const chapters = await service.listChapters(book);
			await service.setProgress(book.dir, chapterRelPath(chapters[0]));

			await service.deleteVolume(book, '第一卷', true);

			assert.ok(!(await exists(path.join(book.dir, CHAPTERS_DIR, '第一卷'))));
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
			const { book } = await createBookFromText(root, '旧书', '旧书.txt', THREE_CHAPTER_TEXT);
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
