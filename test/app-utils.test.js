// 修复回归（纯函数，无需启动服务）：
//  - 身份选择在“刷新”后继续生效（localStorage 读取/写入/异常容忍）
//  - 旧年度榜单缺 scores 字段时，页面工具不报错并给出占位，有 scores 时正常展开明细
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const ReviewUtils = (await import("../public/app-utils.js")).default;

// 内存版 localStorage。
function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

/* ---------------- 身份刷新 ---------------- */

test("身份：未选择时读取为 null（页面因此保持游客，而不是错误身份）", () => {
  assert.equal(ReviewUtils.readStoredIdentity(memStorage()), null);
  assert.equal(ReviewUtils.readStoredIdentity(null), null);
  assert.equal(ReviewUtils.readStoredIdentity(memStorage({ [ReviewUtils.IDENTITY_KEY]: "  " })), null);
});

test("身份：写入后再次读取一致，模拟刷新后继续生效", () => {
  const ls = memStorage();
  ReviewUtils.writeStoredIdentity(ls, "r-gu");
  assert.equal(ReviewUtils.readStoredIdentity(ls), "r-gu");
  // 用同一个“存储”重新读（等价于页面重载）
  assert.equal(ReviewUtils.readStoredIdentity(ls), "r-gu");
});

test("身份：写空值即清除；localStorage 抛错时不影响页面", () => {
  const ls = memStorage({ [ReviewUtils.IDENTITY_KEY]: "r-qin" });
  ReviewUtils.writeStoredIdentity(ls, "");
  assert.equal(ReviewUtils.readStoredIdentity(ls), null);
  const throwing = { getItem: () => { throw new Error("disabled"); }, setItem: () => { throw new Error("disabled"); } };
  assert.equal(ReviewUtils.readStoredIdentity(throwing), null);
  assert.doesNotThrow(() => ReviewUtils.writeStoredIdentity(throwing, "admin"));
});

test("身份：页面脚本在首个请求前从 localStorage 恢复身份（修复刷新后评审队列误提示）", () => {
  const html = readFileSync(join(root, "public", "index.html"), "utf8");
  // 初始化 me 时必须读取已存储身份，而不是写死 null
  assert.match(html, /readStoredIdentity\(window\.localStorage\)/);
  // 选择新身份时必须持久化
  assert.match(html, /writeStoredIdentity\(window\.localStorage/);
  // 页面以 ES module 方式加载工具（<script type="module"> 内 import）
  assert.match(html, /<script type="module">/);
  assert.match(html, /import\s+ReviewUtils\s+from\s+"\.\/app-utils\.js"/);
});

/* ---------------- 榜单分数明细渲染 ---------------- */

test("榜单：旧榜行无 scores 字段时不报错，明细为占位 [—]", () => {
  const oldRow = { submissionId: "G2-002", avgScore: 80, outcome: "waitlisted" };
  assert.deepEqual(ReviewUtils.rowScores(oldRow), []);
  const d = ReviewUtils.formatScoreDetail(oldRow);
  assert.equal(d.scoreText, "[—]");
  assert.equal(d.avg, 80);
});

test("榜单：正常行展示全部原始分；非法元素被过滤", () => {
  const row = { submissionId: "G1-001", avgScore: 90, scores: [88, 90, 95] };
  assert.deepEqual(ReviewUtils.rowScores(row), [88, 90, 95]);
  assert.equal(ReviewUtils.formatScoreDetail(row).scoreText, "[88, 90, 95]");

  const messy = { scores: [80, "x", null, 86, 90] };
  assert.deepEqual(ReviewUtils.rowScores(messy), [80, 86, 90]);
});

test("榜单：页面渲染不再直接调用未兜底的 row.scores.join", () => {
  const html = readFileSync(join(root, "public", "index.html"), "utf8");
  assert.doesNotMatch(html, /row\.scores\.join/);
  assert.match(html, /formatScoreDetail\(row\)/);
});

test("榜单：页面端去极值均分与后端一致", () => {
  assert.equal(ReviewUtils.trimmedAverage([95, 90, 88]), 90);
  assert.equal(ReviewUtils.trimmedAverage([70, 80, 90, 100]), 85);
  assert.equal(ReviewUtils.trimmedAverage([90, 80]), null);
  assert.equal(ReviewUtils.trimmedAverage(undefined), null);
});
