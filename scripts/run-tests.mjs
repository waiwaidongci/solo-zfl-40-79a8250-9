// 跨版本测试入口。
// 背景：Node 22+ 会把 `node --test <目录>` 中的目录当成待执行模块，
// 而 Node 20 需要显式文件路径或目录扫描。这里统一由运行器枚举 test/ 下的
// *.test.js 并以“显式文件列表”调用 node --test，两种版本都稳定；
// 子进程退出码原样透传，任何用例失败时 `npm test` 返回非零。
//
// 用法：
//   node scripts/run-tests.mjs          # 运行 test/ 下全部用例
//   node scripts/run-tests.mjs <目录>   # 运行指定目录（供测试入口自身的测试使用）
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] || join(process.cwd(), "test"));

let entries;
try {
  entries = readdirSync(root);
} catch (err) {
  console.error(`无法读取测试目录 ${root}: ${err.message}`);
  process.exit(1);
}

const files = entries
  .filter((f) => f.endsWith(".test.js") || f.endsWith(".test.mjs"))
  .sort()
  .map((f) => join(root, f));

if (files.length === 0) {
  console.error(`测试目录 ${root} 下没有找到 *.test.js 用例`);
  process.exit(1);
}

// 关键：当本运行器本身运行在 `node --test` 之下时，环境变量 NODE_TEST_CONTEXT
// 会让子进程的 node:test 误以为是递归调用而“跳过执行文件”。清掉它，
// 保证子进程始终以顶层测试运行器身份发现并执行全部用例。
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", env });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
