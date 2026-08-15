import { execFile } from 'child_process';

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

/** 未配置身份时写入仓库级兜底身份，避免 commit 失败。 */
async function ensureIdentity(cwd: string): Promise<void> {
	try {
		await run(cwd, ['config', 'user.name']);
	} catch {
		await run(cwd, ['config', 'user.name', 'x-reader']);
		await run(cwd, ['config', 'user.email', 'x-reader@localhost']);
	}
}

/** 确保 root 是 git 仓库并提交全部变更。git 不可用或无变更时返回 false。 */
export async function commitAll(root: string, message: string): Promise<boolean> {
	try {
		try {
			await run(root, ['rev-parse', '--is-inside-work-tree']);
		} catch {
			await run(root, ['init']);
		}
		await ensureIdentity(root);
		await run(root, ['add', '-A']);
		await run(root, ['commit', '-m', message]);
		return true;
	} catch {
		return false;
	}
}
