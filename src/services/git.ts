import { execFile } from 'child_process';
import { rm, stat } from 'fs/promises';
import * as path from 'path';

function run(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout) => {
			if (error) {
				reject(error);
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
			await run(root, ['commit', '-m', message]);
			return true;
		} catch {
			return false;
		}
	};
	const result = queue.then(runCommit, runCommit);
	queue = result.catch(() => undefined);
	return result;
}

/** 丢弃全部历史，以当前文件状态重建仓库与首个提交。库目录位于其他仓库内部或 git 不可用时返回 false。 */
export function resetHistory(root: string, message: string): Promise<boolean> {
	const runReset = async (): Promise<boolean> => {
		try {
			// 非空 prefix 说明库目录只是某个更大仓库的子目录，其历史不属于本插件
			if ((await run(root, ['rev-parse', '--show-prefix'])) !== '') {
				return false;
			}
		} catch {
			// 还不是仓库，直接新建
		}
		try {
			const gitDir = path.join(root, '.git');
			// `.git` 是文件（worktree/submodule）时不擅自删除
			if ((await stat(gitDir).catch(() => undefined))?.isFile()) {
				return false;
			}
			await rm(gitDir, { recursive: true, force: true });
			identityEnsured.delete(root);
			await run(root, ['init']);
			await ensureIdentity(root);
			await run(root, ['add', '-A']);
			await run(root, ['commit', '--allow-empty', '-m', message]);
			return true;
		} catch {
			return false;
		}
	};
	const result = queue.then(runReset, runReset);
	queue = result.catch(() => undefined);
	return result;
}
