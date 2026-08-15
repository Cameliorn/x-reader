/** 导入解析出的章节（仅导入时使用）：标题 + 行区间。 */
export interface Chapter {
	/** 章节标题（原始行内容，已去除首尾空白） */
	title: string;
	/** 标题所在行号（0 起） */
	startLine: number;
	/** 正文结束行号（含），即下一章标题行 - 1 */
	endLine: number;
}

/** 库中的一本书：以文件夹为单位。 */
export interface BookInfo {
	/** 书名，即文件夹名 */
	name: string;
	/** 书文件夹绝对路径 */
	dir: string;
}

/** 章节文件：从 `NNNN-标题.md` 文件名解析而来。 */
export interface ChapterFile {
	/** 序号（文件名前缀数字） */
	seq: number;
	/** 标题（文件名去序号与扩展名） */
	title: string;
	/** 文件名，如 0001-第一章.md */
	fileName: string;
	/** 所在卷的目录名；undefined 表示章节目录根（默认第一卷） */
	volumeDir?: string;
}

/** 章节分卷：章节目录下的子目录；根目录章节归入默认卷 第一卷。 */
export interface ChapterVolume {
	/** 卷名（默认卷为 第一卷） */
	name: string;
	/** 卷目录名；undefined 表示默认卷（章节目录根） */
	dirName: string | undefined;
	/** 卷内章节文件 */
	chapters: ChapterFile[];
}

/** 条目文件：世界书/角色卡 目录下的 md 文件。 */
export interface EntryFile {
	/** 条目名（文件名去扩展名） */
	name: string;
	/** 文件名 */
	fileName: string;
}
