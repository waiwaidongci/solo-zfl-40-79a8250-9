// 领域逻辑单元测试：不启动 HTTP，直接在内存数据库上跑事务。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { JsonStore } from "../src/store.js";
import { buildSeed } from "../src/seed.js";
import * as D from "../src/domain.js";

const DB = new URL("./_domain-db.json", import.meta.url);
let store;

after(async () => {
  await rm(DB.pathname, { force: true });
});

function freshStore() {
  return new JsonStore(DB.pathname, () => buildSeed("2026-09-15T12:00:00+08:00"));
}

beforeEach(async () => {
  await rm(DB.pathname, { force: true });
  store = freshStore();
  await store.load();
});

async function mut(fn, expectedVersion) {
  const { data } = await store.mutate(expectedVersion, (db) => fn(db));
  return data;
}

const AT = Object.freeze({
  beforeDeadline: new Date("2026-12-30T10:00:00+08:00").getTime(),
  deadlineInstant: new Date("2026-12-31T23:59:59+08:00").getTime(),
  afterDeadline: new Date("2027-01-01T00:00:00+08:00").getTime(),
});

/* ---------------- 去最高最低平均 ---------------- */

test("trimmedAverage：去掉一个最高、一个最低后取平均", () => {
  assert.equal(D.trimmedAverage([95, 90, 88]), 90);        // 三人 -> 中位数
  assert.equal(D.trimmedAverage([60, 80, 88]), 80);
  assert.equal(D.trimmedAverage([70, 80, 90, 100]), 85);   // 去 100/70 -> (80+90)/2
  assert.equal(D.trimmedAverage([1, 2, 3, 4, 100]), 3);    // 去 100/1 -> (2+3+4)/3
});

test("trimmedAverage：不足三人无有效结果", () => {
  assert.equal(D.trimmedAverage([]), null);
  assert.equal(D.trimmedAverage([90]), null);
  assert.equal(D.trimmedAverage([90, 80]), null);
});

/* ---------------- 回避判定 ---------------- */

test("回避：同机构命中 same_org", () => mut((db) => {
  const qin = db.users["r-qin"]; // 湖畔美术学院
  const hit = D.hasConflict(db, qin, "a-lin"); // 林予安 湖畔美术学院
  assert.equal(hit.reason, "same_org");
}));

test("回避：两年内合作命中 recent_collaboration，超过两年不命中", () => mut((db) => {
  // r-qin 与 a-feng 2025 合作，当前 2026 -> 2026-2025=1 < 2 -> 回避
  assert.equal(D.hasConflict(db, db.users["r-qin"], "a-feng").reason, "recent_collaboration");
  // r-he 与 a-feng 2024 合作 -> 2026-2024=2，不 < 2 -> 不构成回避
  assert.equal(D.hasConflict(db, db.users["r-he"], "a-feng"), null);
}));

test("eligibleReviewers：排除无专长、同机构、合作者及已分配者", () => mut((db) => {
  const g1 = db.submissions.find((s) => s.id === "G1-101");
  // G1-101 是 2026 的林予安作品
  const ids = D.eligibleReviewers(db, g1).map((u) => u.id).sort();
  assert.deepEqual(ids, ["r-gu", "r-su", "r-yan"]);
}));

/* ---------------- 提交：重复与截止边界 ---------------- */

test("提交成功并生成组内顺序编号", async () => {
  const s = await mut((db) => D.submitWork(db, "a-shen", {
    callId: "2026-summer", groupId: "G1", title: "蓝湖实验", medium: "纸本", statement: "阐述",
  }, { nowMs: AT.beforeDeadline, idempotencyKey: "k1" }));
  assert.equal(s.id, "G1-102"); // G1 种子用到 101
  assert.equal(s.status, "submitted");
});

test("重复提交：同一作者同征稿只能有一件在途作品", async () => {
  await mut((db) => D.submitWork(db, "a-shen", {
    callId: "2026-summer", groupId: "G1", title: "作品甲", medium: "纸本", statement: "阐述",
  }, { nowMs: AT.beforeDeadline }));
  await assert.rejects(
    () => mut((db) => D.submitWork(db, "a-shen", {
      callId: "2026-summer", groupId: "G1", title: "作品乙", medium: "纸本", statement: "阐述",
    }, { nowMs: AT.beforeDeadline })),
    (e) => e.status === 409 && e.code === "duplicate_submission",
  );
});

test("截止边界：deadline 瞬间仍可提交，之后被拒", async () => {
  // == 边界（<=）允许
  await mut((db) => D.submitWork(db, "a-shen", {
    callId: "2026-summer", groupId: "G1", title: "压线作品", medium: "纸本", statement: "阐述",
  }, { nowMs: AT.deadlineInstant }));
  // 撤回后再投，制造 afterDeadline 场景
  await mut((db) => {
    const s = db.submissions.find((x) => x.title === "压线作品");
    s.status = "withdrawn";
  });
  await assert.rejects(
    () => mut((db) => D.submitWork(db, "a-shen", {
      callId: "2026-summer", groupId: "G1", title: "迟到作品", medium: "纸本", statement: "阐述",
    }, { nowMs: AT.afterDeadline })),
    (e) => e.status === 422 && e.code === "deadline_passed",
  );
});

test("非法状态：非开放征稿不能提交；锁定前不能提前锁定", async () => {
  await assert.rejects(
    () => mut((db) => D.submitWork(db, "a-lin", {
      callId: "2025-annual", groupId: "G1", title: "x", medium: "y", statement: "z",
    }, { nowMs: AT.beforeDeadline })),
    (e) => e.status === 409 && e.code === "invalid_state",
  );
  await assert.rejects(
    () => mut((db) => D.lockCall(db, "admin", "2026-summer", { nowMs: AT.beforeDeadline })),
    (e) => e.status === 422 && e.code === "deadline_not_reached",
  );
});

test("权限：作者不能锁定、不能分配；评审不能投稿", async () => {
  await assert.rejects(
    () => mut((db) => D.lockCall(db, "a-lin", "2026-summer", { nowMs: AT.afterDeadline })),
    (e) => e.status === 403,
  );
  await mut((db) => D.lockCall(db, "admin", "2026-summer", { nowMs: AT.afterDeadline }));
  await assert.rejects(
    () => mut((db) => D.assignReviewers(db, "a-lin", "2026-summer")),
    (e) => e.status === 403,
  );
  await assert.rejects(
    () => mut((db) => D.submitWork(db, "r-gu", {
      callId: "2026-summer", groupId: "G1", title: "x", medium: "y", statement: "z",
    }, { nowMs: AT.beforeDeadline })),
    (e) => e.status === 403,
  );
});

/* ---------------- 分配：均衡 + 回避 + 三人 ---------------- */

test("分配：每件作品至少三名合格评审，且不产生回避对象", async () => {
  await mut((db) => D.lockCall(db, "admin", "2026-summer", { nowMs: AT.afterDeadline }));
  const r = await mut((db) => D.assignReviewers(db, "admin", "2026-summer"));
  assert.ok(r.created >= 12, `至少 4 件作品 × 3 人，实际新增 ${r.created}`);
  await mut((db) => {
    const subs = db.submissions.filter((s) => s.callId === "2026-summer");
    for (const s of subs) {
      const active = db.assignments.filter((a) => a.submissionId === s.id && a.status !== "recused");
      assert.equal(active.length, 3, `${s.id} 应有 3 名有效评审`);
      for (const a of active) {
        const rv = db.users[a.reviewerId];
        assert.ok(rv.expertise.includes(s.groupId), `${a.reviewerId} 具备 ${s.groupId} 专长`);
        assert.equal(D.hasConflict(db, rv, s.authorId), null, `${a.reviewerId} 与 ${s.authorId} 无冲突`);
      }
    }
  });
});

test("分配：专长均衡，评审负担相差不超过 1", async () => {
  await mut((db) => D.lockCall(db, "admin", "2026-summer", { nowMs: AT.afterDeadline }));
  await mut((db) => D.assignReviewers(db, "admin", "2026-summer"));
  await mut((db) => {
    const load = new Map();
    for (const a of db.assignments) {
      const sub = db.submissions.find((s) => s.id === a.submissionId);
      if (sub.callId !== "2026-summer" || a.status === "recused") continue;
      load.set(a.reviewerId, (load.get(a.reviewerId) || 0) + 1);
    }
    const counts = [...load.values()].filter((n) => n > 0);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1,
      `负担应均衡：${[...load.entries()].map(([k, v]) => `${k}=${v}`).join(",")}`);
  });
});

test("分配：合格评审不足时整批拒绝（事务回滚，不留半成品）", async () => {
  // 人为把 G1-101 的合格评审裁到 2 人：删除 r-su。
  await mut((db) => {
    delete db.users["r-su"];
    db.calls.find((c) => c.id === "2026-summer").status = "locked";
    for (const s of db.submissions) if (s.callId === "2026-summer") s.status = "locked";
  });
  await assert.rejects(
    () => mut((db) => D.assignReviewers(db, "admin", "2026-summer")),
    (e) => e.code === "not_enough_reviewers",
  );
  await mut((db) => {
    const created = db.assignments.filter((a) =>
      db.submissions.find((s) => s.id === a.submissionId)?.callId === "2026-summer");
    assert.equal(created.length, 0, "失败回滚后不应留下任何 2026 分配");
  });
});

/* ---------------- 评分：并发冲突 / 越界 / 匿名 ---------------- */

async function lockAndAssign() {
  await mut((db) => D.lockCall(db, "admin", "2026-summer", { nowMs: AT.afterDeadline }));
  await mut((db) => D.assignReviewers(db, "admin", "2026-summer"));
}

test("评分：未被分配的评审不能评分（403）；分数越界 422", async () => {
  await lockAndAssign();
  await assert.rejects(
    () => mut((db) => D.submitScore(db, "r-wei", "G1-101", { score: 90 })),
    (e) => e.status === 403,
  );
  const assigned = await mut((db) =>
    db.assignments.find((a) => a.submissionId === "G1-101").reviewerId);
  await assert.rejects(
    () => mut((db) => D.submitScore(db, assigned, "G1-101", { score: 0 })),
    (e) => e.status === 422 && e.code === "invalid_score",
  );
  await assert.rejects(
    () => mut((db) => D.submitScore(db, assigned, "G1-101", { score: 101 })),
    (e) => e.status === 422,
  );
  await assert.rejects(
    () => mut((db) => D.submitScore(db, assigned, "G1-101", { score: "88.5" })),
    (e) => e.status === 422,
  );
});

test("重复评分：同一评审对同一作品只能评分一次（并发安全）", async () => {
  await lockAndAssign();
  const reviewerId = await mut((db) =>
    db.assignments.find((a) => a.submissionId === "G1-101").reviewerId);
  await mut((db) => D.submitScore(db, reviewerId, "G1-101", { score: 88 }));
  // 模拟两个并发重试请求：写队列串行执行，第二个必须看到 scored 并 409。
  const results = await Promise.all([
    store.mutate(undefined, (db) => D.submitScore(db, reviewerId, "G1-101", { score: 77 }))
      .then(() => "ok").catch((e) => e.code),
    store.mutate(undefined, (db) => D.submitScore(db, reviewerId, "G1-101", { score: 66 }))
      .then(() => "ok").catch((e) => e.code),
  ]);
  assert.deepEqual(results.sort(), ["already_scored", "already_scored"]);
  const kept = await mut((db) =>
    db.assignments.find((a) => a.submissionId === "G1-101" && a.reviewerId === reviewerId).score);
  assert.equal(kept, 88); // 首次评分保留
});

test("定稿后不能改分（锁定分数可复现）", async () => {
  // 2025 已定稿：r-gu 给 G1-001 打了 90。
  await assert.rejects(
    () => mut((db) => D.amendScore(db, "r-gu", "G1-001", { score: 99 })),
    (e) => e.status === 409 && e.code === "invalid_state",
  );
});

test("评审视图匿名：只给编号与作品内容，剥离作者信息", async () => {
  await lockAndAssign();
  await mut((db) => {
    const rv = db.users["r-gu"];
    const view = D.reviewerWorkView(db, "G1-101", rv);
    assert.equal(view.submissionId, "G1-101");
    assert.ok(!("authorId" in view), "评审视图不得含 authorId");
    assert.ok(view.title && view.statement, "作品内容可见");
  });
});

/* ---------------- 回避后补位 ---------------- */

test("回避：已分配评审可回避，重新分配后仍满足三人", async () => {
  await lockAndAssign();
  // 找 G3-101（冯晚舟）：r-qin 因合作被自动排除；让已被分配的某人回避。
  const target = await mut((db) => {
    const a = db.assignments.find((x) => x.submissionId === "G3-101");
    return a.reviewerId;
  });
  const rec = await mut((db) => D.recuse(db, target, "G3-101", "发现共同展览"));
  assert.equal(rec.needsBackfill, true);
  assert.equal(rec.activeReviewers, 2);
  // 再次运行分配：补一人，总数回到 3；回避者不会被再次分配。
  await mut((db) => D.assignReviewers(db, "admin", "2026-summer"));
  await mut((db) => {
    const active = db.assignments.filter((a) => a.submissionId === "G3-101" && a.status !== "recused");
    assert.equal(active.length, 3);
    assert.ok(active.every((a) => a.reviewerId !== target));
  });
  // 已回避者再评分 -> 冲突
  await assert.rejects(
    () => mut((db) => D.submitScore(db, target, "G3-101", { score: 80 })),
    (e) => e.code === "already_recused",
  );
});

/* ---------------- 定稿：配额 + 最低分 + 同分提交先后 ---------------- */

test("定稿：同时满足组别配额与最低分，同分按提交先后", async () => {
  // 独立小征稿：G2 组三件作品，配额 2，最低分 70。
  await mut((db) => {
    db.calls.push({
      id: "call-rank", title: "排名测试征稿", deadline: "2026-01-01T00:00:00+08:00",
      minScore: 70, quotas: { G2: 2 }, reviewersPerSubmission: 3,
      status: "assigned", createdAt: "2025-12-01T00:00:00+08:00",
    });
    const mk = (id, authorId, createdAt) => db.submissions.push({
      id, callId: "call-rank", groupId: "G2", authorId,
      title: id, medium: "x", statement: "x", createdAt, status: "locked",
    });
    // s1 早于 s2 提交；二者同分 85；s3 65 分低于最低分。
    mk("T2-001", "a-zhao", "2026-09-19T09:00:00+08:00");
    mk("T2-002", "a-he",   "2026-09-20T09:00:00+08:00");
    mk("T2-003", "a-feng", "2026-09-10T09:00:00+08:00");
    const revs = ["r-gu", "r-he", "r-luo"];
    const give = (sid, scores) => scores.forEach((sc, i) => db.assignments.push({
      id: `X-${sid}-${i}`, submissionId: sid, reviewerId: revs[i],
      status: "scored", score: sc, note: "", assignedAt: "x", scoredAt: "x",
      recusedAt: null, recuseReason: null,
    }));
    give("T2-001", [85, 85, 85]);
    give("T2-002", [85, 85, 85]);
    give("T2-003", [65, 65, 65]);
  });
  const result = await mut((db) => D.finalize(db, "admin", "call-rank", {
    nowMs: AT.afterDeadline, force: true,
  }));
  const g2 = result.ranking.filter((r) => r.groupId === "G2");
  // 配额 2：T2-001（同分先提交）与 T2-002 入选；即使 T2-003 提交更早，65 < 70 也不入选。
  assert.deepEqual(
    g2.filter((r) => r.outcome === "selected").map((r) => r.submissionId),
    ["T2-001", "T2-002"],
  );
  const order = g2.map((r) => r.submissionId);
  assert.ok(order.indexOf("T2-001") < order.indexOf("T2-002"), "同分按提交先后");
  assert.equal(g2.find((r) => r.submissionId === "T2-003").outcome, "unranked");
});

test("定稿前置：有作品不足三人评分时拒绝定稿", async () => {
  await lockAndAssign();
  await assert.rejects(
    () => mut((db) => D.finalize(db, "admin", "2026-summer", { nowMs: AT.afterDeadline })),
    (e) => e.status === 422 && e.code === "scoring_incomplete" && e.details.incomplete.length >= 1,
  );
});

/* ---------------- 撤回与顺位递补 ---------------- */

test("顺位递补：入选者退出只能由同组未入选者顺位顶替", async () => {
  // 种子 2025：G2 组 G2-001 入选、G2-002(80) 候补。
  const out = await mut((db) => D.withdrawSelection(db, "admin", "G2-001", "作者退出"));
  assert.equal(out.promoted.submissionId, "G2-002");
  assert.equal(out.promoted.groupId, "G2");
  await mut((db) => {
    assert.equal(db.submissions.find((s) => s.id === "G2-001").status, "retired");
    assert.equal(db.submissions.find((s) => s.id === "G2-002").status, "selected");
  });
  // 不能对已退出者再次操作
  await assert.rejects(
    () => mut((db) => D.withdrawSelection(db, "admin", "G2-001", "再退一次")),
    (e) => e.status === 409,
  );
});

test("非法退出：非入选作品不能走退出/递补", async () => {
  await assert.rejects(
    () => mut((db) => D.withdrawSelection(db, "admin", "G2-002", "候补者退出")) ,
    (e) => e.status === 409 && e.code === "invalid_state",
  );
});

test("权限：他人不能替作者办理退出", async () => {
  await assert.rejects(
    () => mut((db) => D.withdrawSelection(db, "a-zhao", "G1-001", "代退")),
    (e) => e.status === 403,
  );
});

test("无同组候补时名额空缺", async () => {
  // G1 组配额 1，仅 G1-001 入选且无候补 -> 退出后 unfilled。
  const out = await mut((db) => D.withdrawSelection(db, "a-lin", "G1-001", "个人原因"));
  assert.equal(out.promoted, null);
  assert.equal(out.quotaLeftUnfilled, true);
});

/* ---------------- 名次：组内 / 总排名 / 同分 / 递补重算 ---------------- */

test("compareRanked：均分优先，同分按提交先后，再同按编号（绝不乱序）", () => {
  const rows = [
    { submissionId: "B", avgScore: 80, createdAt: "2026-09-02T00:00:00+08:00" },
    { submissionId: "A", avgScore: 90, createdAt: "2026-09-10T00:00:00+08:00" },
    { submissionId: "C", avgScore: 90, createdAt: "2026-09-01T00:00:00+08:00" },
    { submissionId: "D", avgScore: 90, createdAt: "2026-09-01T00:00:00+08:00" },
  ];
  const sorted = rows.slice().sort(D.compareRanked).map((r) => r.submissionId);
  // C、D 同分同时间 -> 编号 C 在前；90 分两位在 80 分之前。
  assert.deepEqual(sorted, ["C", "D", "A", "B"]);
});

test("assignRanks：跨组总排名连续，组内名次各自连续", () => {
  const rows = [
    { submissionId: "G1-1", groupId: "G1", avgScore: 90, currentStatus: "selected", createdAt: "2026-09-01" },
    { submissionId: "G2-1", groupId: "G2", avgScore: 95, currentStatus: "selected", createdAt: "2026-09-02" },
    { submissionId: "G1-2", groupId: "G1", avgScore: 85, currentStatus: "waitlisted", createdAt: "2026-09-03" },
    { submissionId: "G2-2", groupId: "G2", avgScore: 70, currentStatus: "unranked", createdAt: "2026-09-04" },
  ];
  const ranked = D.assignRanks(rows);
  const byId = Object.fromEntries(ranked.map((r) => [r.submissionId, r]));
  // 总排名：G2-1(95) > G1-1(90) > G1-2(85) > G2-2(70)
  assert.equal(byId["G2-1"].rank, 1);
  assert.equal(byId["G1-1"].rank, 2);
  assert.equal(byId["G1-2"].rank, 3);
  assert.equal(byId["G2-2"].rank, 4);
  // 组内：G1-1 第 1、G1-2 第 2；G2-1 第 1、G2-2 第 2
  assert.equal(byId["G1-1"].groupRank, 1);
  assert.equal(byId["G1-2"].groupRank, 2);
  assert.equal(byId["G2-1"].groupRank, 1);
  assert.equal(byId["G2-2"].groupRank, 2);
});

test("assignRanks：retired 者不占名次，其余立即重排且退出者沉底", () => {
  const rows = [
    { submissionId: "X1", groupId: "G1", avgScore: 90, currentStatus: "retired", createdAt: "2026-09-01" },
    { submissionId: "X2", groupId: "G1", avgScore: 88, currentStatus: "selected", createdAt: "2026-09-02" },
    { submissionId: "X3", groupId: "G1", avgScore: 80, currentStatus: "waitlisted", createdAt: "2026-09-03" },
  ];
  const ranked = D.assignRanks(rows);
  const byId = Object.fromEntries(ranked.map((r) => [r.submissionId, r]));
  assert.equal(byId["X1"].rank, null);
  assert.equal(byId["X1"].groupRank, null);
  assert.equal(byId["X2"].rank, 1);
  assert.equal(byId["X2"].groupRank, 1);
  assert.equal(byId["X3"].rank, 2);
  assert.equal(byId["X3"].groupRank, 2);
  // 输出顺序：有效者在前、退出者沉底
  assert.equal(ranked[ranked.length - 1].submissionId, "X1");
});

test("旧榜 resultView：补出 groupRank，跨组总排名与组内名次正确（2025 种子）", () => mut((db) => {
  const v = D.resultView(db, "2025-annual");
  const byId = Object.fromEntries(v.ranking.map((r) => [r.submissionId, r]));
  // G3-001 92 总第 1、G3 组第 1；G1-001 90 总第 3、G1 组第 1；G2-002 80 组内第 2
  assert.equal(byId["G3-001"].rank, 1);
  assert.equal(byId["G3-001"].groupRank, 1);
  assert.equal(byId["G1-001"].rank, 3);
  assert.equal(byId["G1-001"].groupRank, 1);
  assert.equal(byId["G2-001"].groupRank, 1);
  assert.equal(byId["G2-002"].groupRank, 2);
  for (const r of v.ranking) {
    assert.ok(Number.isInteger(r.groupRank), `${r.submissionId} 必须有组内名次（旧种子缺该字段，需补算）`);
    assert.ok(Number.isInteger(r.rank));
    assert.ok(Array.isArray(r.scores));
  }
}));

test("退出递补后：总排名与组内名次按新有效名单立即重算", () => mut((db) => {
  // 2025：G2-001(86) 入选、G2-002(80) 候补。退出 G2-001 → G2-002 递补。
  D.withdrawSelection(db, "admin", "G2-001", "退出");
  const v = D.resultView(db, "2025-annual");
  const byId = Object.fromEntries(v.ranking.map((r) => [r.submissionId, r]));
  // G2-001 退出：不再占名次
  assert.equal(byId["G2-001"].rank, null);
  assert.equal(byId["G2-001"].groupRank, null);
  assert.equal(byId["G2-001"].currentStatus, "retired");
  // G2-002 递补入选，并占据 G2 组内第 1
  assert.equal(byId["G2-002"].outcome, "selected");
  assert.equal(byId["G2-002"].currentStatus, "selected");
  assert.equal(byId["G2-002"].groupRank, 1);
  // 有效总排名连续：G3-001(92)、G3-002(91)、G1-001(90)、G2-002(80)
  const active = v.ranking.filter((r) => r.currentStatus !== "retired");
  assert.deepEqual(active.map((r) => r.submissionId), ["G3-001", "G3-002", "G1-001", "G2-002"]);
  assert.deepEqual(active.map((r) => r.rank), [1, 2, 3, 4]);
  // 退出者沉底
  assert.equal(v.ranking[v.ranking.length - 1].submissionId, "G2-001");
}));

test("跨组同分：跨组也按提交先后排总名次，组内仍独立编号", () => mut((db) => {
  // 构造独立征稿：G1、G2 各一件，均分同为 88，G1 先提交。
  db.calls.push({
    id: "call-tie", title: "跨组同分", deadline: "2026-01-01T00:00:00+08:00",
    minScore: 60, quotas: { G1: 1, G2: 1 }, reviewersPerSubmission: 3,
    status: "assigned", createdAt: "2025-12-01T00:00:00+08:00",
  });
  const mk = (id, groupId, createdAt) => db.submissions.push({
    id, callId: "call-tie", groupId, authorId: "a-lin", title: id, medium: "x",
    statement: "x", createdAt, status: "locked",
  });
  mk("GT1", "G1", "2026-09-01T09:00:00+08:00");
  mk("GT2", "G2", "2026-09-05T09:00:00+08:00");
  const give = (sid, revs) => revs.forEach((rv, i) => db.assignments.push({
    id: `T-${sid}-${i}`, submissionId: sid, reviewerId: rv, status: "scored",
    score: 88, note: "", assignedAt: "x", scoredAt: "x", recusedAt: null, recuseReason: null,
  }));
  give("GT1", ["r-gu", "r-yan", "r-su"]); // 三位无冲突的 G1 专长
  give("GT2", ["r-he", "r-luo", "r-gu"]);   // 三位含 G2 专长
  const ranking = D.rankSubmissions(db, "call-tie");
  assert.deepEqual(ranking.map((r) => r.submissionId), ["GT1", "GT2"]); // 同分先提交在前
  assert.equal(ranking[0].rank, 1);
  assert.equal(ranking[1].rank, 2);
  assert.equal(ranking[0].groupRank, 1);
  assert.equal(ranking[1].groupRank, 1); // 不同组，各自组内第 1
}));
