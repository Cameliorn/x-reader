import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	buildChapterMarkdown,
	chapterFileName,
	chineseNumberToInt,
	parseChapterFileName,
	sanitizeFileTitle,
} from '../services/markdown';
import { CARDS_DIR, CHAPTERS_DIR, createBookFromText, META_FILE, WORLD_DIR } from '../services/bookFactory';

suite('markdown helpers', () => {
	test('sanitizeFileTitle 去除非法字符、压缩空白并截断', () => {
		assert.strictEqual(sanitizeFileTitle('第一章:雨/夜?'), '第一章雨夜');
		assert.strictEqual(sanitizeFileTitle('  第一章  雨夜  '), '第一章 雨夜');
		assert.strictEqual(sanitizeFileTitle('   '), '未命名');
		assert.strictEqual(sanitizeFileTitle('x'.repeat(60)).length, 50);
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
});

suite('createBookFromText', () => {
	test('生成四件套与章节 md，书名冲突时追加序号', async () => {
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
			await fs.access(path.join(dir, WORLD_DIR, '.gitkeep'));
			await fs.access(path.join(dir, CARDS_DIR, '.gitkeep'));

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
