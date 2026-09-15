// HTTP 端到端测试：启动真实 HTTP 服务（临时数据库），覆盖
// 征稿→锁定→分配（含回避补位）→并发评分→定稿→榜单的完整流程，
// 以及 401/403/404/409/422、幂等重试、截止边界和重启恢复。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { JsonStore } from "../src/store.js";

const TMP_DB = new URL("./_http-db.json", import.meta.url).pathname;
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = "test";
process.env.PORT = "0";

const { server, store } = await import("../src/server.js");
await store.load();
await new Promise((resolve) => server.listen(0, resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(TMP_DB, { force: true });
  await rm(TMP_DB + `.tmp-${process.pid}`, { force: true });
});

async function req(method, path, { user, body, key, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (user) opts.headers["X-User-Id"] = user;
  if (key) opts.headers["Idempotency-Key"] = key;
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, replay: res.headers.get("Idempotent-Replay") };
}

const CALL = "2026-summer";

test("健康：首页可打开", async () => {
  const res = await fetch(BASE + "/");
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("蓝晒工作室"));
});

test("未带身份的写请求 → 401", async () => {
  const r = await req("POST", `/api/calls/${CALL}/lock`, { body: {} });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "unauthorized");
});

test("非法 JSON → 400；未知路由 → 404；未知资源 → 404", async () => {
  const bad = await req("POST", `/api/calls/${CALL}/submissions`, {
    user: "a-shen", body: "{不是json",
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "bad_request");

  const nf = await req("GET", "/api/nope");
  assert.equal(nf.status, 404);

  const missing = await req("GET", "/api/submissions/G9-999", { user: "admin" });
  assert.equal(missing.status, 404);
});

test("投稿：成功 201；重复提交 409；幂等键重试只产生一件作品", async () => {
  const payload = { groupId: "G1", title: "蓝湖实验", medium: "纸本蓝晒", statement: "关于光与铁盐的系列实验" };

  const r1 = await req("POST", `/api/calls/${CALL}/submissions`, { user: "a-shen", body: payload, key: "idem-001" });
  assert.equal(r1.status, 201, JSON.stringify(r1.json));
  assert.equal(r1.json.id, "G1-102");
  assert.equal(r1.replay, null);

  // 同一幂等键重试：原样回放，不新建作品
  const r2 = await req("POST", `/api/calls/${CALL}/submissions`, { user: "a-shen", body: payload, key: "idem-001" });
  assert.equal(r2.status, 200);
  assert.equal(r2.replay, "true");
  assert.equal(r2.json.id, "G1-102");

  // 不带幂等键的真实重复投稿 → 冲突
  const r3 = await req("POST", `/api/calls/${CALL}/submissions`, {
    user: "a-shen", body: { ...payload, title: "另一件作品" },
  });
  assert.equal(r3.status, 409);
  assert.equal(r3.json.error, "duplicate_submission");
  assert.equal(r3.json.details.existingSubmissionId, "G1-102");

  // 评审身份不能投稿
  const r4 = await req("POST", `/api/calls/${CALL}/submissions`, {
    user: "r-gu", body: payload, key: "idem-x",
  });
  assert.equal(r4.status, 403);

  // 字段缺失 → 400
  const r5 = await req("POST", `/api/calls/${CALL}/submissions`, {
    user: "a-cheng", body: { groupId: "G3", title: "", medium: "x", statement: "y" },
  });
  assert.equal(r5.status, 400);
});

test("截止边界与锁定：到点前不能锁（422），到点后作者不能锁（403），管理员锁定成功", async () => {
  // 当前真实时间 2026-09 < deadline，提前锁定被拒
  const early = await req("POST", `/api/calls/${CALL}/lock`, { user: "admin", body: {} });
  assert.equal(early.status, 422);
  assert.equal(early.json.error, "deadline_not_reached");

  // 作者无权锁定
  const forbidden = await req("POST", `/api/calls/${CALL}/lock`, { user: "a-lin", body: {} });
  assert.equal(forbidden.status, 403);

  // 把服务端时钟拨到截止之后
  process.env.REVIEW_FAKE_NOW = "2027-01-02T10:00:00+08:00";

  // 截止后投稿 → 422（换一位尚无作品的作者）
  const late = await req("POST", `/api/calls/${CALL}/submissions`, {
    user: "a-he", body: { groupId: "G2", title: "迟到", medium: "x", statement: "y" }, key: "late-1",
  });
  assert.equal(late.status, 422);
  assert.equal(late.json.error, "deadline_passed");

  const locked = await req("POST", `/api/calls/${CALL}/lock`, { user: "admin", body: {} });
  assert.equal(locked.status, 200);
  assert.equal(locked.json.status, "locked");

  // 锁定后再投 → 409 invalid_state
  const afterLock = await req("POST", `/api/calls/${CALL}/submissions`, {
    user: "a-he", body: { groupId: "G2", title: "锁定后", medium: "x", statement: "y" }, key: "late-2",
  });
  assert.equal(afterLock.status, 409);
  assert.equal(afterLock.json.error, "invalid_state");

  // 重复锁定 → 409
  const again = await req("POST", `/api/calls/${CALL}/lock`, { user: "admin", body: {} });
  assert.equal(again.status, 409);
});

test("分配：每件作品 3 名合格评审；分配矩阵对非管理员 403", async () => {
  const matrixDenied = await req("GET", `/api/calls/${CALL}/conflicts`, { user: "r-gu" });
  assert.equal(matrixDenied.status, 403);

  const r = await req("POST", `/api/calls/${CALL}/assignments`, { user: "admin", body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // 种子 4 件 + 新投稿 1 件 = 5 件 × 3 = 15
  assert.equal(r.json.created, 15);

  const matrix = await req("GET", `/api/calls/${CALL}/conflicts`, { user: "admin" });
  assert.equal(matrix.status, 200);
  const g1 = matrix.json.matrix.find((m) => m.submissionId === "G1-101");
  const reasons = g1.conflicts.map((c) => `${c.reviewerId}:${c.reason}`);
  assert.ok(reasons.includes("r-qin:same_org"), "r-qin 同机构应被排除");
  assert.ok(reasons.some((x) => x.startsWith("r-shen:recent_collaboration")), "r-shen 合作应被排除");

  // 作者不能分配
  const denied = await req("POST", `/api/calls/${CALL}/assignments`, { user: "a-lin", body: {} });
  assert.equal(denied.status, 403);
});

test("评审匿名：评审只能看到被分配作品且无作者字段", async () => {
  const call = await req("GET", `/api/calls/${CALL}`, { user: "r-gu" });
  assert.equal(call.status, 200);
  for (const s of call.json.submissions) {
    assert.equal(s.authorId, undefined, "评审视图不得含 authorId");
    assert.equal(s.authorName, undefined);
  }
  // r-gu 只会看到分配给他的作品（少于全部 5 件）
  assert.ok(call.json.submissions.length < 5);
  assert.ok(call.json.submissions.length >= 1);

  // 直接取作品详情也无作者信息
  const one = await req("GET", `/api/submissions/${call.json.submissions[0].id}`, { user: "r-gu" });
  assert.equal(one.json.authorId, undefined);
  assert.ok(one.json.myAssignment);
});

test("评分：未分配者 403、越界 422、重复评分 409；并发提交只有第一次生效", async () => {
  const { json } = await req("GET", `/api/me/assignments?callId=${CALL}`, { user: "r-gu" });
  const target = json.queue[0].submissionId;

  const notAssigned = await req("PUT", `/api/submissions/${target}/score`, {
    user: "r-wei", body: { score: 80 },
  });
  assert.equal(notAssigned.status, 403);

  for (const bad of [0, 101, 88.5, "abc"]) {
    const r = await req("PUT", `/api/submissions/${target}/score`, { user: "r-gu", body: { score: bad } });
    assert.equal(r.status, 422, `分数 ${bad} 应被拒`);
  }

  const ok = await req("PUT", `/api/submissions/${target}/score`, { user: "r-gu", body: { score: 88, note: "阶调扎实" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, "scored");

  const dup = await req("PUT", `/api/submissions/${target}/score`, { user: "r-gu", body: { score: 70 } });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, "already_scored");

  // 并发重试（两个请求同时到达）：写队列串行化，必须恰好一个 200/一个 409。
  // 先挑一件 r-gu 尚未评分的新作品来做。
  const fresh = (await req("GET", `/api/me/assignments?callId=${CALL}`, { user: "r-gu" }))
    .json.queue.find((a) => a.status === "assigned");
  const results = await Promise.all([
    req("PUT", `/api/submissions/${fresh.submissionId}/score`, { user: "r-gu", body: { score: 77 } }),
    req("PUT", `/api/submissions/${fresh.submissionId}/score`, { user: "r-gu", body: { score: 66 } }),
  ]);
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 409]);
  const kept = (await req("GET", `/api/me/assignments?callId=${CALL}`, { user: "r-gu" }))
    .json.queue.find((a) => a.submissionId === fresh.submissionId);
  assert.equal(kept.score, 77);

  // 定稿前可以改分
  const amend = await req("PATCH", `/api/submissions/${target}/score`, { user: "r-gu", body: { score: 91 } });
  assert.equal(amend.status, 200);
  assert.equal(amend.json.score, 91);
});

test("回避与补位：回避后有效人数降为 2，重新分配补足 3 人", async () => {
  const queue = (await req("GET", `/api/me/assignments?callId=${CALL}`, { user: "r-wei" })).json.queue;
  const target = queue.find((a) => a.status === "assigned") || queue[0];
  const rec = await req("POST", `/api/submissions/${target.submissionId}/recuse`, {
    user: "r-wei", body: { reason: "发现与作者同机构" },
  });
  assert.equal(rec.status, 200);
  assert.equal(rec.json.activeReviewers, 2);
  assert.equal(rec.json.needsBackfill, true);

  // 再次回避 → 409
  const again = await req("POST", `/api/submissions/${target.submissionId}/recuse`, {
    user: "r-wei", body: { reason: "x" },
  });
  assert.equal(again.status, 409);

  // 管理员补位
  const backfill = await req("POST", `/api/calls/${CALL}/assignments`, { user: "admin", body: {} });
  assert.equal(backfill.status, 200);
  assert.equal(backfill.json.created, 1);

  // 回避者不能再评分
  const scoreAfterRecuse = await req("PUT", `/api/submissions/${target.submissionId}/score`, {
    user: "r-wei", body: { score: 80 },
  });
  assert.equal(scoreAfterRecuse.status, 409);
});

test("定稿：评分未齐 → 422；补齐后定稿锁定", async () => {
  const incomplete = await req("POST", `/api/calls/${CALL}/finalize`, { user: "admin", body: {} });
  assert.equal(incomplete.status, 422);
  assert.equal(incomplete.json.error, "scoring_incomplete");
  assert.ok(incomplete.json.details.incomplete.length >= 1);

  // 用每位评审自己的队列把分补齐（回避/已评分的跳过）
  const reviewers = ["r-qin", "r-he", "r-shen", "r-luo", "r-gu", "r-wei", "r-yan", "r-su", "r-ming"];
  let score = 70;
  for (const rv of reviewers) {
    const { json } = await req("GET", `/api/me/assignments?callId=${CALL}`, { user: rv });
    for (const a of json.queue) {
      if (a.status !== "assigned") continue;
      score = ((score - 60) % 35) + 65; // 65..99 之间轮转，保证可复现
      const r = await req("PUT", `/api/submissions/${a.submissionId}/score`, {
        user: rv, body: { score },
      });
      assert.equal(r.status, 200, `${rv} 给 ${a.submissionId} 评分失败：${JSON.stringify(r.json)}`);
    }
  }

  const fin = await req("POST", `/api/calls/${CALL}/finalize`, { user: "admin", body: {} });
  assert.equal(fin.status, 200, JSON.stringify(fin.json));
  assert.equal(fin.json.locked, true);
  assert.ok(fin.json.ranking.length === 5);

  // 定稿后再改分 → 409
  const some = (await req("GET", `/api/me/assignments?callId=${CALL}`, { user: "r-gu" })).json.queue[0];
  const amend = await req("PATCH", `/api/submissions/${some.submissionId}/score`, {
    user: "r-gu", body: { score: 99 },
  });
  assert.equal(amend.status, 409);

  // 定稿后再次定稿 → 409
  const again = await req("POST", `/api/calls/${CALL}/finalize`, { user: "admin", body: {} });
  assert.equal(again.status, 409);
});

test("榜单：公开结果，含原始分、去极值均分与状态", async () => {
  const r = await req("GET", `/api/calls/${CALL}/results`);
  assert.equal(r.status, 200);
  assert.equal(r.json.locked, true);
  for (const row of r.json.ranking) {
    assert.ok(Array.isArray(row.scores));
    assert.equal(typeof row.avgScore, "number");
    assert.ok(["selected", "waitlisted", "unranked", "retired"].includes(row.outcome));
  }
  // 至少满足各组配额
  const selected = r.json.ranking.filter((x) => x.outcome === "selected");
  assert.ok(selected.length >= 3); // G1:2 + G2:2 + G3:1，但分数需过线
});

test("顺位递补：2025 旧榜 G2 入选者退出 → G2-002 顺位入选；非法退出 409", async () => {
  // 候补者不能直接退出
  const bad = await req("POST", "/api/submissions/G2-002/withdraw", {
    user: "a-he", body: { reason: "x" },
  });
  assert.equal(bad.status, 409);

  const out = await req("POST", "/api/submissions/G2-001/withdraw", {
    user: "a-zhao", body: { reason: "档期冲突" },
  });
  assert.equal(out.status, 200);
  assert.equal(out.json.promoted.submissionId, "G2-002");
  assert.equal(out.json.promoted.groupId, "G2");

  // 榜单状态随之更新
  const res = await req("GET", "/api/calls/2025-annual/results");
  const g2001 = res.json.ranking.find((x) => x.submissionId === "G2-001");
  const g2002 = res.json.ranking.find((x) => x.submissionId === "G2-002");
  assert.equal(g2001.outcome, "retired");
  assert.equal(g2002.outcome, "selected");

  // 已退出者再次操作 → 409
  const again = await req("POST", "/api/submissions/G2-001/withdraw", {
    user: "a-zhao", body: { reason: "x" },
  });
  assert.equal(again.status, 409);
});

test("重启恢复：新建存储实例读回同一文件，作品/分配/榜单/幂等键全部仍在", async () => {
  const recovered = new JsonStore(TMP_DB, () => { throw new Error("不应重新种子化"); });
  await recovered.load();
  const db = recovered.read();

  assert.ok(db.submissions.some((s) => s.id === "G1-102"), "新投稿持久化");
  const call2026 = db.calls.find((c) => c.id === CALL);
  assert.equal(call2026.status, "finalized");
  assert.ok(db.results.some((r) => r.callId === CALL && r.locked));
  // 每件在途作品仍满足 3 个有效评审
  for (const s of db.submissions.filter((x) => x.callId === CALL)) {
    const active = db.assignments.filter((a) => a.submissionId === s.id && a.status !== "recused");
    assert.equal(active.length, 3, `${s.id} 应有 3 个有效评审`);
  }
  // 幂等键随盘持久化
  assert.ok(db.idempotency["idem-001"], "幂等键在重启后仍存在");
  // 递补状态持久化
  assert.equal(db.submissions.find((s) => s.id === "G2-001").status, "retired");
  assert.equal(db.submissions.find((s) => s.id === "G2-002").status, "selected");
});

test("乐观并发：expectedVersion 过期时写事务被拒（version_conflict）", async () => {
  const v = store.read().version;
  // 先用旧版本号发起一次“必定成功”的写（版本已前进），再用同一个旧版本号写 → 冲突
  await store.mutate(undefined, (db) => { db.boot.touch = (db.boot.touch || 0) + 1; });
  await assert.rejects(
    () => store.mutate(v, (db) => { db.boot.touch += 1; }),
    (e) => e.code === "version_conflict",
  );
});
