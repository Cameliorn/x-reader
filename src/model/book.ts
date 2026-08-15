export interface Chapter {
	/** 章节标题（原始行内容，已去除首尾空白） */
	title: string;
	/** 标题所在行号（0 起） */
	startLine: number;
	/** 正文结束行号（含），即下一章标题行 - 1 */
	endLine: number;
}

export interface BookMeta {
	/** 稳定 ID，也是 globalStorage 中文件名的组成部分 */
	id: string;
	/** 展示名（去掉扩展名的文件名） */
	title: string;
	/** 原始文件名 */
	fileName: string;
	/** 导入时间戳（ms） */
	addedAt: number;
	/** 上次阅读章节索引，-1 表示未读 */
	lastReadChapter: number;
}
