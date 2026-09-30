/**
 * 目录扫描并发上限：大书库（上千本书 / 单本上千章）下无上限的 Promise.all 会同时打开过多句柄（EMFILE），
 * 也更容易拖慢磁盘；按批执行兼顾吞吐与稳定。
 */
export const SCAN_CONCURRENCY = 16;

/** 按并发上限并行映射，结果顺序与输入一致（task 的第二参数为下标）。 */
export async function mapLimit<T, R>(
    items: readonly T[],
    limit: number,
    task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (; ;) {
            const index = cursor++;
            if (index >= items.length) {
                return;
            }
            results[index] = await task(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}
