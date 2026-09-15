// JSON 文件持久化层。
// 设计要点（对应题目中的“重启恢复 / 并发”要求）：
//  - 所有写操作经一个 Promise 链串行化，读-改-写之间不会交错；
//  - 落盘采用“临时文件 + rename”原子替换，进程在写入中途崩溃也不会留下半个 JSON；
//  - 每次写入把 prevVersion/version 一并落盘，应用层据此做乐观并发（If-Match/expectedVersion）；
//  - 重启后原样读回，内存中不持有任何未持久化状态。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export class JsonStore {
  constructor(filePath, seedFactory, { now } = {}) {
    this.filePath = filePath;
    this.seedFactory = seedFactory;
    this.now = now || (() => new Date().toISOString());
    // 写队列：保证同一时刻只有一个事务在执行。
    this.writeChain = Promise.resolve();
    this.state = null;
  }

  async load() {
    if (!existsSync(this.filePath)) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.state = this.seedFactory(this.now);
      await this._flush();
    } else {
      const raw = await readFile(this.filePath, "utf8");
      this.state = JSON.parse(raw);
    }
    return this.state;
  }

  async _flush() {
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }

  // 只读快照。
  read() {
    return this.state;
  }

  // 串行化的读-改-写事务。fn 对 state 直接修改；抛错则整体放弃并回滚。
  // 返回 { data, version }，其中 data 为 fn 的返回值。
  async mutate(expectedVersion, fn) {
    const run = async () => {
      if (expectedVersion != null && this.state.version !== expectedVersion) {
        const err = new Error("version_conflict");
        err.code = "version_conflict";
        err.expected = expectedVersion;
        err.actual = this.state.version;
        throw err;
      }
      const before = JSON.stringify(this.state);
      let result;
      try {
        result = fn(this.state);
        // 在落盘前递增版本（fn 失败则不会执行到这里）。
        this.state.version += 1;
        await this._flush();
      } catch (e) {
        // 回滚内存状态（落盘尚未发生，磁盘文件仍是上一版本）。
        this.state = JSON.parse(before);
        throw e;
      }
      return { data: result, version: this.state.version };
    };
    // 把 run 接到队列尾部：上一个事务 resolve/reject 后才开始。
    const runPromise = this.writeChain.then(run, run);
    // 队列本身永不 reject，只透传本次任务结果。
    this.writeChain = runPromise.then(
      () => undefined,
      () => undefined,
    );
    return runPromise;
  }
}
