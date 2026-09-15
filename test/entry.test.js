// 修复回归：测试入口（scripts/run-tests.mjs）在各 Node 版本下
// 都能“发现并运行目录内全部用例”，失败返回非零。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runner = join(root, "scripts", "run-tests.mjs");

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "review-test-entry-"));
}

function runRunner(dir) {
  return spawnSync(process.execPath, [runner, dir], { encoding: "utf8" });
}

test("测试入口：默认 npm test 命令指向跨版本运行器（不再把目录直接传给 --test）", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /scripts\/run-tests\.mjs/);
  assert.doesNotMatch(pkg.scripts.test, /--test\s+test\/?\s*$/);
});

test("测试入口：自动发现目录内多个 *.test.js 并全部运行（成功退出 0）", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "a.test.js"), `
      import { test } from "node:test";
      import assert from "node:assert/strict";
      test("用例 A", () => assert.equal(1, 1));
    `);
    writeFileSync(join(dir, "b.test.js"), `
      import { test } from "node:test";
      import assert from "node:assert/strict";
      test("用例 B1", () => assert.ok(true));
      test("用例 B2", () => assert.equal([1,2,3].length, 3));
    `);
    // 非 .test.js 文件不应被当成用例（模拟“目录被当模块”的陷阱）
    writeFileSync(join(dir, "not-a-test.js"), `throw new Error("不应被执行");`);

    const r = runRunner(dir);
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /用例 A/);
    assert.match(r.stdout, /用例 B1/);
    assert.match(r.stdout, /用例 B2/);
    assert.doesNotMatch(r.stdout, /不应被执行/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("测试入口：有用例失败时退出码非零", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "fail.test.js"), `
      import { test } from "node:test";
      import assert from "node:assert/strict";
      test("必然失败", () => assert.equal(1, 2));
    `);
    const r = runRunner(dir);
    assert.notEqual(r.status, 0);
    assert.notEqual(r.status, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("测试入口：目录无用例或不存在时退出码非零", () => {
  const empty = makeTempDir();
  const missing = join(empty, "no-such-dir");
  try {
    assert.notEqual(runRunner(empty).status, 0);
    assert.notEqual(runRunner(missing).status, 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
