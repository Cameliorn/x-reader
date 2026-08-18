import * as path from 'path';
import * as vscode from 'vscode';
import type { BookInfo, ChapterFile } from './model/book';
import { CARDS_DIR, CHAPTERS_DIR, chapterRelPath, LibraryService } from './services/library';

/** x-audio 扩展 ID（发布者 cameliorn）。 */
export const AUDIO_EXTENSION_ID = 'cameliorn.x-audio';

/** 角色卡解析出的音色配置（与 x-audio 的目录音色配置结构兼容）。 */
export interface VoiceConfig {
	/** 角色名 → 音色 ID 映射 */
	readonly characterVoices: Record<string, string>;
	/** 角色类型 → 音色 ID 映射（narrator/male/female/girl/boy/child/elderly） */
	readonly roleTypeVoices: Record<string, string>;
	/** 语音参数覆盖（角色卡暂不支持，恒为空） */
	readonly voiceParams: Record<string, unknown>;
}

const NARRATOR_NAME = '旁白';
const VOICE_LINE_RE = /^\s*(?:[-*]\s*)?音色\s*[:：]\s*(\S.*?)\s*$/u;
const VOICE_FRONTMATTER_RE = /^\s*voice\s*Id?\s*[:：]\s*(\S.*?)\s*$/i;
const TYPE_LINE_RE = /^\s*(?:[-*]\s*)?类型\s*[:：]\s*(\S.*?)\s*$/u;
const TITLE_RE = /^\s*#\s+(.+?)\s*$/u;
const ROLE_VOICE_TYPES = ['narrator', 'male', 'female', 'girl', 'boy', 'child', 'elderly'] as const;
const ROLE_TYPE_LABELS: Readonly<Record<string, (typeof ROLE_VOICE_TYPES)[number]>> = {
	'旁白': 'narrator',
	'男': 'male',
	'成年男性': 'male',
	'女': 'female',
	'成年女性': 'female',
	'少女': 'girl',
	'少年': 'boy',
	'幼童': 'child',
	'小孩': 'child',
	'老人': 'elderly',
	'老者': 'elderly',
};

/** 角色类型文本 → x-audio 角色类型；支持中文标签或英文原名。 */
function parseRoleType(value: string): string | undefined {
	const trimmed = value.trim();
	const mapped = ROLE_TYPE_LABELS[trimmed];
	if (mapped) {
		return mapped;
	}
	return (ROLE_VOICE_TYPES as readonly string[]).includes(trimmed) ? trimmed : undefined;
}

/** x-audio 是否已安装并激活。 */
export function isAudioAvailable(): boolean {
	const ext = vscode.extensions.getExtension(AUDIO_EXTENSION_ID);
	return ext !== undefined && ext.isActive;
}

/** 通过 x-audio 朗读文本：执行 xaudio.speakText 命令；扩展不可用/调用失败时返回 false。 */
export async function speakViaAudio(
	text: string,
	mode: 'plain' | 'roles',
	documentUri?: vscode.Uri,
	voiceConfig?: VoiceConfig
): Promise<boolean> {
	if (!isAudioAvailable()) {
		return false;
	}
	try {
		const args: Record<string, unknown> = { text, mode };
		if (documentUri) {
			args.documentUri = documentUri;
		}
		if (voiceConfig) {
			args.voiceConfig = voiceConfig;
		}
		await vscode.commands.executeCommand('xaudio.speakText', args);
		return true;
	} catch {
		return false;
	}
}

/**
 * 从书的角色卡目录读取音色配置：每张卡片 `# 角色名` 即角色名，
 * `- 音色：xxx`（或 `音色: xxx`、frontmatter `voice: xxx` / `voiceId: xxx`）指定音色，
 * 可选 `- 类型：男/女/少女/少年/幼童/老人/旁白` 把音色同时映射到角色类型；
 * 名为「旁白」的卡片音色自动作为旁白音色。没有卡片带音色时返回 undefined。
 */
export async function readCharacterVoiceConfig(
	library: LibraryService,
	bookDir: string
): Promise<VoiceConfig | undefined> {
	const book: BookInfo = { name: path.basename(bookDir), dir: bookDir };
	const entries = await library.listEntries(book, CARDS_DIR);
	const characterVoices: Record<string, string> = {};
	const roleTypeVoices: Record<string, string> = {};

	for (const entry of entries) {
		const cardUri = vscode.Uri.file(path.join(bookDir, CARDS_DIR, entry.fileName));
		let raw: string;
		try {
			raw = Buffer.from(await vscode.workspace.fs.readFile(cardUri)).toString('utf8');
		} catch {
			continue;
		}
		const lines = raw.split(/\r?\n/);

		let name = entry.name;
		for (const line of lines) {
			const titleMatch = line.match(TITLE_RE);
			if (titleMatch) {
				name = titleMatch[1].trim();
				break;
			}
		}

		let voice: string | undefined;
		let type: string | undefined;
		for (const line of lines) {
			if (!voice) {
				const voiceMatch = line.match(VOICE_LINE_RE) ?? line.match(VOICE_FRONTMATTER_RE);
				if (voiceMatch) {
					voice = voiceMatch[1].trim();
				}
			}
			if (!type) {
				const typeMatch = line.match(TYPE_LINE_RE);
				if (typeMatch) {
					type = parseRoleType(typeMatch[1]);
				}
			}
		}
		if (!voice) {
			continue;
		}

		if (name === NARRATOR_NAME) {
			roleTypeVoices.narrator = voice;
		} else if (type) {
			roleTypeVoices[type] = voice;
		} else {
			characterVoices[name] = voice;
		}
	}

	return Object.keys(characterVoices).length > 0 || Object.keys(roleTypeVoices).length > 0
		? { characterVoices, roleTypeVoices, voiceParams: {} }
		: undefined;
}

/** 引导用户安装 x-audio 扩展；返回是否已处理（已安装或已跳转）。 */
export async function promptInstallAudio(): Promise<void> {
	const install = vscode.l10n.t('Install x-audio');
	const picked = await vscode.window.showWarningMessage(
		vscode.l10n.t('x-audio extension is required for reading aloud. Install it first.'),
		install
	);
	if (picked === install) {
		await vscode.commands.executeCommand('workbench.extensions.installExtension', AUDIO_EXTENSION_ID);
	}
}

/** 解析要朗读的章节：优先命令参数（书架树节点 ChapterFile 或 bookDir/volumeDir/fileName），否则活动编辑器所在章节，最后当前书进度。 */
export async function resolveChapter(
	library: LibraryService,
	chapterOrBookDir?: ChapterFile | string,
	volumeDir?: string,
	fileName?: string
): Promise<{ bookDir: string; chapter: ChapterFile } | undefined> {
	// 书架树节点：上下文菜单命令参数为 ChapterFile，书取当前书
	if (chapterOrBookDir && typeof chapterOrBookDir !== 'string') {
		const book = library.getCurrentBook();
		if (!book) {
			return undefined;
		}
		return { bookDir: book.dir, chapter: chapterOrBookDir };
	}

	const bookDir = chapterOrBookDir;
	if (bookDir && fileName) {
		const book: BookInfo = { name: path.basename(bookDir), dir: bookDir };
		const chapters = await library.listChapters(book);
		const found = chapters.find((c) => chapterRelPath(c) === chapterRelPath({ fileName, volumeDir }));
		if (found) {
			return { bookDir, chapter: found };
		}
		return { bookDir, chapter: { seq: 0, title: fileName, fileName, volumeDir } };
	}

	const editorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
	if (editorPath && path.extname(editorPath) === '.md') {
		const segments = editorPath.split(path.sep);
		// 取最后一个「章节」段：库路径本身含同名目录时不误判
		const chapterIdx = segments.lastIndexOf(CHAPTERS_DIR);
		if (chapterIdx >= 0 && (chapterIdx === segments.length - 2 || chapterIdx === segments.length - 3)) {
			const resolvedBookDir = segments.slice(0, chapterIdx).join(path.sep);
			const resolvedFile = segments[segments.length - 1];
			const resolvedVolume = chapterIdx === segments.length - 3 ? segments[chapterIdx + 1] : undefined;
			const book: BookInfo = { name: path.basename(resolvedBookDir), dir: resolvedBookDir };
			try {
				const chapters = await library.listChapters(book);
				const found = chapters.find(
					(c) => chapterRelPath(c) === chapterRelPath({ fileName: resolvedFile, volumeDir: resolvedVolume })
				);
				if (found) {
					return { bookDir: resolvedBookDir, chapter: found };
				}
			} catch {
				// 编辑器文件不在库内时直接朗读该文件
			}
			return { bookDir: resolvedBookDir, chapter: { seq: 0, title: resolvedFile, fileName: resolvedFile, volumeDir: resolvedVolume } };
		}
	}

	const book = library.getCurrentBook();
	const progress = book ? library.getProgress(book.dir) : undefined;
	if (!book || !progress) {
		return undefined;
	}
	const found = await library.findChapterByProgress(book, progress);
	return found ? { bookDir: book.dir, chapter: found } : undefined;
}

/** 读取章节正文：优先活动编辑器文档（含未保存修改），否则从磁盘读取。 */
export async function readChapterText(
	bookDir: string,
	chapter: ChapterFile
): Promise<{ text: string; uri: vscode.Uri } | undefined> {
	const uri = vscode.Uri.file(path.join(bookDir, CHAPTERS_DIR, chapter.volumeDir ?? '', chapter.fileName));
	const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
	if (doc) {
		return { text: doc.getText(), uri };
	}
	try {
		const data = await vscode.workspace.fs.readFile(uri);
		return { text: Buffer.from(data).toString('utf8'), uri };
	} catch {
		return undefined;
	}
}

/** 章节 markdown → 纯文本：去 BOM、导航、分隔线、标题标记、链接与强调符号。 */
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
