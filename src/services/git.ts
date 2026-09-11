import { execFile } from 'child_process';
import { rm, stat } from 'fs/promises';
import * as path from 'path';

/**
 * git 输出缓冲上限。大书库首次提交时 `git commit` 会为每个文件打印一行 create mode，
 * 默认 1MB 会触发 ERR_CHILD_PROCESS_STDIO_MAXBUFFER 导致命令被误判为失败。
 */
const MAX_BUFFER = 32 * 1024 * 1024;

function run(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
			if (error) {
				// spawn 失败（如未安装 git）时 stderr 可能为空，回退到 error.message
				reject(new Error(String(stderr ?? '').trim() || error.message));
			} else {
				resolve(stdout.trim());
			}
		});
	});
}

/** 未配置身份时写入仓库级兜底身份，避免 commit 失败。已确认的 root 不再重复检查。 */
const identityEnsured = new Set<string>();

async function ensureIdentity(cwd: string): Promise<void> {
	if (identityEnsured.has(cwd)) {
		return;
	}
	try {
		await run(cwd, ['config', 'user.name']);
	} catch {
		await run(cwd, ['config', 'user.name', 'x-reader']);
		await run(cwd, ['config', 'user.email', 'x-reader@localhost']);
	}
	identityEnsured.add(cwd);
}

/** 串行化提交，避免并发写操作触发 git index.lock 冲突。 */
let queue: Promise<unknown> = Promise.resolve();

/** 确保 root 是 git 仓库并提交变更。paths 限定只提交这些路径（相对 root）。git 不可用或无变更时返回 false。 */
export function commitAll(root: string, message: string, paths?: string[]): Promise<boolean> {
	const runCommit = async (): Promise<boolean> => {
		try {
			try {
				await run(root, ['rev-parse', '--is-inside-work-tree']);
			} catch {
				await run(root, ['init']);
			}
			await ensureIdentity(root);
			// `--` 分隔选项与路径，防书名以 - 开头时被当作选项
			await run(root, ['add', '-A', '--', ...(paths ?? [])]);
			// --quiet 省去逐文件 create mode 输出（大书库会撑爆输出缓冲）
			await run(root, ['commit', '--quiet', '-m', message]);
			return true;
		} catch {
			return false;
		}
	};
	const result = queue.then(runCommit, runCommit);
	queue = result.catch(() => undefined);
	return result;
}

/** 清除历史的结果：失败时区分原因，便于界面给出可操作的提示。 */
export type ResetHistoryResult =
	| { ok: true }
	/** 库目录位于其他仓库内部：其历史属于那个仓库，不能删除 */
	| { ok: false; reason: 'nested-repo' }
	/** `.git` 是文件（worktree/submodule），不擅自删除 */
	| { ok: false; reason: 'gitnotdir' }
	/** git 命令失败（未安装、权限、磁盘等），detail 为 git 的原始错误 */
	| { ok: false; reason: 'git-error'; detail: string };

/** 丢弃全部历史，以当前文件状态重建仓库与首个提交。 */
export function resetHistory(root: string, message: string): Promise<ResetHistoryResult> {
	const runReset = async (): Promise<ResetHistoryResult> => {
		try {
			// 非空 prefix 说明库目录只是某个更大仓库的子目录，其历史不属于本插件
			if ((await run(root, ['rev-parse', '--show-prefix'])) !== '') {
				return { ok: false, reason: 'nested-repo' };
			}
		} catch {
			// 还不是仓库，直接新建
		}
		const gitDir = path.join(root, '.git');
		try {
			if ((await stat(gitDir).catch(() => undefined))?.isFile()) {
				return { ok: false, reason: 'gitnotdir' };
			}
			await rm(gitDir, { recursive: true, force: true });
			identityEnsured.delete(root);
			await run(root, ['init']);
			await ensureIdentity(root);
			await run(root, ['add', '-A']);
			// --quiet 省去逐文件 create mode 输出（大书库会撑爆输出缓冲）
			await run(root, ['commit', '--quiet', '--allow-empty', '-m', message]);
			return { ok: true };
		} catch (error) {
			return { ok: false, reason: 'git-error', detail: error instanceof Error ? error.message : String(error) };
		}
	};
	const result = queue.then(runReset, runReset);
	queue = result.catch(() => undefined);
	return result;
}
