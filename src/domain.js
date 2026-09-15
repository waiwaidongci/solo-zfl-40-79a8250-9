// 评审领域逻辑：所有函数都在 store.mutate 事务内或纯函数中执行。
// 纯函数（trimmedAverage / rankSubmissions / hasConflict / eligibleReviewers）
// 不依赖 IO，便于自动化测试直接断言。
import {
  ApiError, badRequest, conflict, forbidden, invalidState,
  notFound, unprocessable,
} from "./errors.js";

const SCORE_MIN = 1;
const SCORE_MAX = 100;

/* ---------------- 基础查询 ---------------- */

export function getCall(db, callId) {
  const call = db.calls.find((c) => c.id === callId);
  if (!call) throw notFound(`征稿「${callId}」不存在`);
  return call;
}

export function getUser(db, userId) {
  const u = db.users[userId];
  if (!u) throw notFound(`用户「${userId}」不存在`);
  return u;
}

export function getSubmission(db, submissionId) {
  const s = db.submissions.find((x) => x.id === submissionId);
  if (!s) throw notFound(`作品「${submissionId}」不存在`);
  return s;
}

export function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) {
    throw forbidden(`当前身份「${user.role}」无权执行此操作，需要：${roles.join(" / ")}`);
  }
}

function audit(db, actorId, action, detail = {}) {
  db.audit.push({ at: new Date().toISOString(), actorId, action, ...detail });
}

/* ---------------- 回避判定 ---------------- */

// 同机构，或在合作窗口内（currentYear - collabYear < window，即近两年）有合作记录。
// 评审侧的 collaborations 为权威来源；同时对称检查作者侧记录（若有）。
export function hasConflict(db, reviewer, authorId) {
  const author = db.users[authorId];
  if (!author) return false;
  if (reviewer.org && author.org && reviewer.org === author.org) {
    return { reason: "same_org", org: reviewer.org };
  }
  const year = db.currentYearForDemo ?? new Date().getFullYear();
  const window = db.collaborationWindowYears ?? 2;
  const reviewerHits = (reviewer.collaborations || [])
    .filter((c) => c.userId === authorId && year - c.year < window);
  if (reviewerHits.length) {
    return { reason: "recent_collaboration", years: reviewerHits.map((c) => c.year) };
  }
  const authorRec = db.users[authorId];
  const authorHits = (authorRec.collaborations || [])
    .filter((c) => c.userId === reviewer.id && year - c.year < window);
  if (authorHits.length) {
    return { reason: "recent_collaboration", years: authorHits.map((c) => c.year) };
  }
  return null;
}

// 某作品在某组别下可分配的评审：评审身份、具备该组专长、无回避、尚未被分配（含已回避）。
export function eligibleReviewers(db, submission, excludeAssigned = true) {
  const assigned = excludeAssigned
    ? new Set(db.assignments.filter((a) => a.submissionId === submission.id).map((a) => a.reviewerId))
    : new Set();
  return Object.values(db.users)
    .filter((u) => u.role === "reviewer")
    .filter((u) => (u.expertise || []).includes(submission.groupId))
    .filter((u) => !assigned.has(u.id))
    .filter((u) => !hasConflict(db, u, submission.authorId));
}

// 管理员预览：逐作品列出全部冲突评审及原因（含专长不符）。
export function conflictMatrix(db, callId) {
  const call = getCall(db, callId);
  const subs = db.submissions.filter((s) => s.callId === callId && s.status !== "withdrawn");
  return subs.map((s) => {
    const conflicts = Object.values(db.users)
      .filter((u) => u.role === "reviewer")
      .map((u) => {
        let blockedBy = null;
        if (!(u.expertise || []).includes(s.groupId)) blockedBy = { reason: "no_expertise" };
        else blockedBy = hasConflict(db, u, s.authorId);
        return blockedBy ? { reviewerId: u.id, reviewerName: u.name, ...blockedBy } : null;
      })
      .filter(Boolean);
    return {
      submissionId: s.id,
      groupId: s.groupId,
      // 评审视图只给编号，不给作者；管理预览可以给作者，用于核对回避。
      authorId: s.authorId,
      authorName: db.users[s.authorId]?.name,
      conflicts,
    };
  });
}

/* ---------------- 征稿提交 ---------------- */

// 截止边界：createdAt <= deadline 即视为有效（与“截止时刻瞬间”提交不冲突）。
export function isBeforeDeadline(deadlineIso, atMs) {
  return atMs <= new Date(deadlineIso).getTime();
}

export function submitWork(db, actorId, input, { nowMs, idempotencyKey }) {
  const author = getUser(db, actorId);
  requireRole(author, "author");
  const call = getCall(db, input.callId);

  if (call.status !== "open") {
    throw invalidState("提交作品", call.status, ["open"]);
  }
  if (!isBeforeDeadline(call.deadline, nowMs)) {
    throw unprocessable("deadline_passed", `征稿已于 ${call.deadline} 截止`, { deadline: call.deadline });
  }
  if (!db.groups[input.groupId]) throw badRequest(`未知组别：${input.groupId}`);
  if (!call.quotas[input.groupId]) throw badRequest(`本组别不接受投稿：${input.groupId}`);
  const title = (input.title || "").trim();
  const medium = (input.medium || "").trim();
  const statement = (input.statement || "").trim();
  if (!title) throw badRequest("作品标题不能为空");
  if (!medium) throw badRequest("作品媒介/尺寸不能为空");
  if (!statement) throw badRequest("作品阐述不能为空");

  // 重复提交：同一征稿同一作者只允许一件在途作品（已撤回的不占位）。
  const dup = db.submissions.find(
    (s) => s.callId === call.id && s.authorId === author.id && s.status !== "withdrawn",
  );
  if (dup) {
    throw conflict("duplicate_submission",
      `您在本征稿中已提交作品 ${dup.id}，如需更换请先撤回`,
      { existingSubmissionId: dup.id });
  }
  // 同标题同作者也视为重复（防止撤回-重投刷编号之外的重复登记）。
  const dupTitle = db.submissions.find(
    (s) => s.callId === call.id && s.authorId === author.id && s.title === title,
  );
  if (dupTitle) throw conflict("duplicate_submission", "相同标题的作品已提交过");

  db.seq.submission[input.groupId] = (db.seq.submission[input.groupId] || 0) + 1;
  const seq = db.seq.submission[input.groupId];
  const submission = {
    id: `${input.groupId}-${String(seq).padStart(3, "0")}`,
    callId: call.id,
    groupId: input.groupId,
    authorId: author.id,
    title,
    medium,
    statement,
    createdAt: new Date(nowMs).toISOString(),
    status: "submitted",
    idempotencyKey: idempotencyKey || null,
  };
  db.submissions.push(submission);
  audit(db, author.id, "submission.created", { callId: call.id, submissionId: submission.id });
  return publicSubmission(submission, author);
}

// 作者在截止前撤回自己的在途作品。
export function withdrawOwnWork(db, actorId, submissionId, { nowMs }) {
  const author = getUser(db, actorId);
  requireRole(author, "author");
  const s = getSubmission(db, submissionId);
  if (s.authorId !== author.id) throw forbidden("只能撤回自己的作品");
  const call = getCall(db, s.callId);
  if (s.status !== "submitted") {
    throw invalidState("作者撤回", s.status, ["submitted"]);
  }
  if (!isBeforeDeadline(call.deadline, nowMs)) {
    throw unprocessable("deadline_passed", "已截止，作品锁定，不能自行撤回");
  }
  s.status = "withdrawn";
  audit(db, author.id, "submission.withdrawn", { submissionId: s.id });
  return s;
}

/* ---------------- 锁定与分配 ---------------- */

export function lockCall(db, actorId, callId, { nowMs }) {
  const actor = getUser(db, actorId);
  requireRole(actor, "admin");
  const call = getCall(db, callId);
  if (call.status !== "open") throw invalidState("截止锁定", call.status, ["open"]);
  if (isBeforeDeadline(call.deadline, nowMs)) {
    throw unprocessable("deadline_not_reached", "尚未到截止时间，不能提前锁定",
      { deadline: call.deadline });
  }
  call.status = "locked";
  for (const s of db.submissions) {
    if (s.callId === callId && s.status === "submitted") s.status = "locked";
  }
  audit(db, actor.id, "call.locked", { callId });
  return call;
}

function nextAssignmentId(db) {
  db.seq.assignment += 1;
  return `A-${String(db.seq.assignment).padStart(3, "0")}`;
}

// 专长均衡分配：
//  1) 每件作品只从「具备该组专长且无回避」的评审中选；
//  2) 作品按“可分配评审数”升序处理（最稀缺的先分）；
//  3) 每件作品逐个补位，选择当前在本征稿中负担最小的评审（平手按 ID），
//     从而在专长约束内尽量摊平工作量；
//  4) 任何作品凑不够 reviewersPerSubmission 人则整批回滚（事务内抛错）。
export function assignReviewers(db, actorId, callId, opts = {}) {
  const actor = getUser(db, actorId);
  requireRole(actor, "admin");
  const call = getCall(db, callId);
  if (!["locked", "assigned"].includes(call.status)) {
    throw invalidState("分配评审", call.status, ["locked", "assigned"]);
  }
  const subs = db.submissions.filter(
    (s) => s.callId === callId && s.status !== "withdrawn" && s.status !== "retired",
  );

  const target = opts.reviewersPerSubmission || call.reviewersPerSubmission;
  const load = new Map(); // reviewerId -> 本征稿有效分配数（不含已回避）
  for (const u of Object.values(db.users)) {
    if (u.role === "reviewer") load.set(u.id, 0);
  }
  for (const a of db.assignments) {
    const sub = db.submissions.find((s) => s.id === a.submissionId);
    if (sub?.callId === callId && a.status !== "recused") load.set(a.reviewerId, (load.get(a.reviewerId) || 0) + 1);
  }

  // 每件作品的“缺额”。
  const need = subs.map((s) => {
    const active = db.assignments.filter(
      (a) => a.submissionId === s.id && a.status !== "recused",
    ).length;
    return { s, missing: Math.max(0, target - active) };
  });

  // 可分配池在每次选完后收缩；按稀缺度排序处理顺序。
  const poolSize = (s) => eligibleReviewers(db, s, true).length;
  need.sort((a, b) => poolSize(a.s) - poolSize(b.s) || a.s.id.localeCompare(b.s.id));

  let created = 0;
  const report = [];
  for (const { s, missing } of need) {
    const picked = [];
    for (let i = 0; i < missing; i++) {
      const candidates = eligibleReviewers(db, s, true);
      if (candidates.length === 0) {
        const assignedNow = db.assignments.filter(
          (a) => a.submissionId === s.id && a.status !== "recused",
        ).length;
        throw unprocessable("not_enough_reviewers",
          `作品 ${s.id} 无法凑齐 ${target} 名合格评审（现有 ${assignedNow} 名）`,
          { submissionId: s.id, required: target, active: assignedNow });
      }
      candidates.sort((a, b) =>
        (load.get(a.id) || 0) - (load.get(b.id) || 0) || a.id.localeCompare(b.id));
      const choice = candidates[0];
      db.assignments.push({
        id: nextAssignmentId(db),
        submissionId: s.id,
        reviewerId: choice.id,
        status: "assigned",
        score: null,
        note: "",
        assignedAt: new Date().toISOString(),
        scoredAt: null,
        recusedAt: null,
        recuseReason: null,
      });
      load.set(choice.id, (load.get(choice.id) || 0) + 1);
      picked.push(choice.id);
      created += 1;
    }
    if (picked.length) report.push({ submissionId: s.id, assignedReviewerIds: picked });
  }

  call.status = "assigned";
  audit(db, actor.id, "assignment.created", { callId, count: created, report });
  return { created, report };
}

/* ---------------- 回避与评分（并发安全） ---------------- */

function myAssignment(db, reviewer, submissionId) {
  const a = db.assignments.find((x) => x.submissionId === submissionId && x.reviewerId === reviewer.id);
  if (!a) throw forbidden("您未被分配到该作品，不能操作", { submissionId });
  return a;
}

export function recuse(db, actorId, submissionId, reason) {
  const reviewer = getUser(db, actorId);
  requireRole(reviewer, "reviewer");
  const s = getSubmission(db, submissionId);
  const call = getCall(db, s.callId);
  if (!["locked", "assigned"].includes(call.status)) {
    throw invalidState("申请回避", call.status, ["locked", "assigned"]);
  }
  const a = myAssignment(db, reviewer, submissionId);
  if (a.status === "recused") throw conflict("already_recused", "您已回避该作品");
  if (a.status === "scored") {
    throw conflict("already_scored", "已提交评分，不能再回避；如确有利益冲突请联系管理员");
  }
  a.status = "recused";
  a.score = null;
  a.recusedAt = new Date().toISOString();
  a.recuseReason = reason || "评审主动回避";
  audit(db, reviewer.id, "assignment.recused", { submissionId, reason: a.recuseReason });

  // 即时给出补位提示（管理员需重新运行分配；自动补位不在这里做，避免评审得知回避后推断作者身份）。
  const active = db.assignments.filter(
    (x) => x.submissionId === submissionId && x.status !== "recused",
  ).length;
  const target = call.reviewersPerSubmission;
  return { assignment: a, activeReviewers: active, needsBackfill: active < target };
}

export function submitScore(db, actorId, submissionId, input) {
  const reviewer = getUser(db, actorId);
  requireRole(reviewer, "reviewer");
  const s = getSubmission(db, submissionId);
  const call = getCall(db, s.callId);
  if (!["locked", "assigned"].includes(call.status)) {
    throw invalidState("提交评分", call.status, ["locked", "assigned"]);
  }
  const a = myAssignment(db, reviewer, submissionId);
  // 并发/重复提交：两个并发请求只有第一个能把 assigned → scored。
  if (a.status === "scored") {
    throw conflict("already_scored", "您已评分，重复提交被拒绝；如需修改请使用改分接口",
      { existingScore: a.score });
  }
  if (a.status === "recused") throw conflict("already_recused", "您已回避该作品，不能评分");

  const score = toScore(input.score);
  const note = (input.note || "").trim();
  a.status = "scored";
  a.score = score;
  a.note = note;
  a.scoredAt = new Date().toISOString();
  audit(db, reviewer.id, "assignment.scored", { submissionId, score });
  return reviewerViewOfAssignment(db, a);
}

// 定稿前允许评审修改自己的分数；定稿/锁定榜单后拒绝（保证名单可复现）。
export function amendScore(db, actorId, submissionId, input) {
  const reviewer = getUser(db, actorId);
  requireRole(reviewer, "reviewer");
  const s = getSubmission(db, submissionId);
  const call = getCall(db, s.callId);
  if (call.status === "finalized") {
    throw invalidState("修改评分", call.status, ["locked", "assigned"]);
  }
  if (!["locked", "assigned"].includes(call.status)) {
    throw invalidState("修改评分", call.status, ["locked", "assigned"]);
  }
  const a = myAssignment(db, reviewer, submissionId);
  if (a.status === "recused") throw conflict("already_recused", "已回避，无分数可改");
  if (a.status !== "scored") throw conflict("not_scored", "尚未评分，请直接提交评分");
  const oldScore = a.score;
  a.score = toScore(input.score);
  if (input.note !== undefined) a.note = (input.note || "").trim();
  a.scoredAt = new Date().toISOString();
  audit(db, reviewer.id, "assignment.amended", { submissionId, oldScore, newScore: a.score });
  return reviewerViewOfAssignment(db, a);
}

function toScore(value) {
  // 接受数字或数字字符串；必须为 1..100 的整数。
  const n = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isInteger(n) || n < SCORE_MIN || n > SCORE_MAX) {
    throw unprocessable("invalid_score", `评分必须是 ${SCORE_MIN}-${SCORE_MAX} 的整数`, { received: value });
  }
  return n;
}

/* ---------------- 汇总：去最高最低平均 + 榜单 ---------------- */

// 去掉一个最高分、一个最低分后取算术平均；三人时恰为中位数。
// 只有 ≥3 个有效分时才有结果；2 人（无法同时去掉高低）返回 null。
export function trimmedAverage(scores) {
  const xs = scores.filter((n) => typeof n === "number").slice().sort((a, b) => a - b);
  if (xs.length < 3) return null;
  const rest = xs.slice(1, xs.length - 1);
  // 与手工榜单一致：保留两位小数。
  return Math.round((rest.reduce((a, b) => a + b, 0) / rest.length) * 100) / 100;
}

export function submissionScores(db, callId) {
  const map = new Map();
  for (const s of db.submissions.filter((x) => x.callId === callId && x.status !== "withdrawn")) {
    const scored = db.assignments
      .filter((a) => a.submissionId === s.id && a.status === "scored")
      .map((a) => a.score);
    const active = db.assignments.filter((a) => a.submissionId === s.id && a.status !== "recused").length;
    const recused = db.assignments.filter((a) => a.submissionId === s.id && a.status === "recused").length;
    map.set(s.id, {
      submissionId: s.id,
      groupId: s.groupId,
      scores: scored,
      activeAssignments: active,
      recusedAssignments: recused,
      avgScore: trimmedAverage(scored),
    });
  }
  return map;
}

// 统一排序口径：均分降序 → 提交先后（createdAt 升序，按时间戳比较以兼容不同时区写法）
// → 编号升序。跨组总排名与组内排名都用它，保证同分不乱序、结果可复现。
export function compareRanked(a, b) {
  const byScore = b.avgScore - a.avgScore;
  if (byScore !== 0) return byScore;
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  if (Number.isFinite(ta) && !Number.isFinite(tb)) return -1;
  if (!Number.isFinite(ta) && Number.isFinite(tb)) return 1;
  return String(a.submissionId).localeCompare(String(b.submissionId));
}

// 为“当前有效名单”赋名次：退出（retired）者保留在榜单上但不占名次（rank/groupRank=null），
// 其余按统一口径重排。组内名次只在同组有效作品间连续编号。
export function assignRanks(rows) {
  const active = rows.filter((r) => r.currentStatus !== "retired");
  active.sort(compareRanked);

  const groupCounters = {};
  const groupRankBySubmission = {};
  for (const r of active) {
    groupCounters[r.groupId] = (groupCounters[r.groupId] || 0) + 1;
    groupRankBySubmission[r.submissionId] = groupCounters[r.groupId];
  }
  const globalRankBySubmission = {};
  active.forEach((r, i) => { globalRankBySubmission[r.submissionId] = i + 1; });

  // 输出保持按有效总排名排列，退出者沉到最后（仍按均分排列，名次为空）。
  const retired = rows.filter((r) => r.currentStatus === "retired");
  retired.sort(compareRanked);
  return [...active, ...retired].map((r) => ({
    ...r,
    rank: globalRankBySubmission[r.submissionId] ?? null,
    groupRank: groupRankBySubmission[r.submissionId] ?? null,
  }));
}

// 入选规则：avgScore >= minScore；组内按均分降序、提交先后（createdAt 升序，编号为次级键）排序；
// 前 quota 名入选，其余满足分数线者进入候补链（保持同一顺序，供顺位递补）。
export function rankSubmissions(db, callId) {
  const call = getCall(db, callId);
  const rows = [...submissionScores(db, callId).values()]
    .filter((r) => r.avgScore !== null)
    .map((r) => {
      const s = db.submissions.find((x) => x.id === r.submissionId);
      return { ...r, createdAt: s.createdAt, currentStatus: s.status };
    });

  // 先按统一口径做组内排序、确定 selected/waitlisted。
  const byGroup = {};
  for (const r of rows) {
    byGroup[r.groupId] ||= [];
    byGroup[r.groupId].push(r);
  }
  const decided = [];
  for (const [groupId, list] of Object.entries(byGroup)) {
    const quota = call.quotas[groupId] || 0;
    list.sort(compareRanked);
    list.forEach((r, idx) => {
      const qualified = r.avgScore >= call.minScore;
      const outcome = qualified ? (idx < quota ? "selected" : "waitlisted") : "unranked";
      decided.push({ ...r, groupId, outcome });
    });
  }
  // 总排名与组内名次由统一函数按当前有效名单赋值。
  return assignRanks(decided).map((r) => ({
    rank: r.rank,
    submissionId: r.submissionId,
    groupId: r.groupId,
    groupRank: r.groupRank,
    avgScore: r.avgScore,
    scores: r.scores,
    outcome: r.outcome,
  }));
}

export function finalize(db, actorId, callId, { nowMs, force = false }) {
  const actor = getUser(db, actorId);
  requireRole(actor, "admin");
  const call = getCall(db, callId);
  if (call.status === "finalized") throw invalidState("定稿", call.status, ["assigned", "locked"]);
  if (!["locked", "assigned"].includes(call.status)) {
    throw invalidState("定稿", call.status, ["assigned", "locked"]);
  }
  if (!force && isBeforeDeadline(call.deadline, nowMs)) {
    throw unprocessable("deadline_not_reached", "尚未到截止时间");
  }

  // 定稿前置条件：每件在途作品至少 3 个独立有效评分。
  const scores = submissionScores(db, callId);
  const incomplete = [...scores.values()]
    .filter((r) => r.scores.length < call.reviewersPerSubmission);
  if (incomplete.length) {
    throw unprocessable("scoring_incomplete", "仍有作品未达到最低独立评分数，不能定稿", {
      required: call.reviewersPerSubmission,
      incomplete: incomplete.map((r) => ({
        submissionId: r.submissionId,
        scored: r.scores.length,
        active: r.activeAssignments,
        recused: r.recusedAssignments,
      })),
    });
  }

  const ranking = rankSubmissions(db, callId);
  const result = {
    callId,
    minScore: call.minScore,
    finalizedAt: new Date(nowMs).toISOString(),
    locked: true,
    ranking,
  };
  const existing = db.results.findIndex((r) => r.callId === callId);
  if (existing >= 0) db.results[existing] = result;
  else db.results.push(result);

  for (const s of db.submissions.filter((x) => x.callId === callId)) {
    const row = ranking.find((r) => r.submissionId === s.id);
    if (row && (row.outcome === "selected" || row.outcome === "waitlisted")) s.status = row.outcome;
    else if (s.status !== "withdrawn") s.status = "locked";
  }
  call.status = "finalized";
  audit(db, actor.id, "result.finalized", {
    callId,
    selected: ranking.filter((r) => r.outcome === "selected").length,
    waitlisted: ranking.filter((r) => r.outcome === "waitlisted").length,
  });
  return result;
}

/* ---------------- 定稿锁定后的撤回与顺位递补 ---------------- */

// 只有入选者可以“退出入选名单”；退出后作品置为 retired，
// 名额只能由【同组】未入选者（候补链）顺位递补，不允许管理员任意指派。
export function withdrawSelection(db, actorId, submissionId, reason) {
  const s = getSubmission(db, submissionId);
  const call = getCall(db, s.callId);
  const actor = getUser(db, actorId);
  const result = db.results.find((r) => r.callId === call.id && r.locked);
  if (!result || call.status !== "finalized") {
    throw invalidState("退出入选名单", call.status, ["finalized"]);
  }
  // 作者本人或管理员均可发起；其他人禁止。
  if (actor.role !== "admin" && actor.id !== s.authorId) {
    throw forbidden("只有作者本人或管理员可以办理退出");
  }
  if (s.status !== "selected") {
    throw invalidState("退出入选名单", s.status, ["selected"]);
  }

  // 候补链：同组、当前 waitlisted、未 retired，按定稿排名（即分数→提交先后）取首位。
  const replacement = result.ranking
    .filter((r) => r.groupId === s.groupId && r.outcome === "waitlisted")
    .map((r) => ({ row: r, sub: db.submissions.find((x) => x.id === r.submissionId) }))
    .filter((x) => x.sub && x.sub.status === "waitlisted")
    .sort((a, b) => a.row.rank - b.row.rank)[0];

  s.status = "retired";
  s.retiredReason = reason || "作者申请退出";
  s.retiredAt = new Date().toISOString();
  const selectedRow = result.ranking.find((r) => r.submissionId === s.id);
  if (selectedRow) selectedRow.outcome = "retired";

  let promoted = null;
  if (replacement) {
    replacement.sub.status = "selected";
    replacement.row.outcome = "selected";
    promoted = {
      submissionId: replacement.sub.id,
      groupId: replacement.row.groupId,
      avgScore: replacement.row.avgScore,
    };
  }
  audit(db, actor.id, "selection.withdrawn", {
    callId: call.id, submissionId: s.id, promotedSubmissionId: promoted?.submissionId || null,
  });
  if (promoted) {
    audit(db, "system", "selection.promoted", {
      callId: call.id, groupId: s.groupId, ...promoted, replacedSubmissionId: s.id,
    });
  }
  return { withdrawn: s.id, promoted, quotaLeftUnfilled: !promoted };
}

/* ---------------- 视图 ---------------- */

// 作者视角：含自己的作品全文。
export function publicSubmission(s, viewer) {
  return {
    id: s.id, callId: s.callId, groupId: s.groupId, status: s.status,
    title: s.title, medium: s.medium, statement: s.statement,
    createdAt: s.createdAt,
    authorId: viewer?.role === "admin" ? s.authorId : undefined,
    mine: viewer?.id === s.authorId,
  };
}

// 评审视角：锁定后只看得到“编号 + 作品内容”，作者信息一律剥离（匿名）。
export function reviewerWorkView(db, submissionId, reviewer) {
  const s = getSubmission(db, submissionId);
  const call = getCall(db, s.callId);
  const assignment = db.assignments.find(
    (a) => a.submissionId === s.id && a.reviewerId === reviewer.id,
  );
  return {
    submissionId: s.id,
    callId: call.id,
    groupId: s.groupId,
    // 故意不返回 title 之外的作者字段；标题属于作品内容的一部分。
    title: s.title,
    medium: s.medium,
    statement: s.statement,
    myAssignment: assignment ? reviewerViewOfAssignment(db, assignment) : null,
  };
}

export function reviewerViewOfAssignment(db, a) {
  const s = getSubmission(db, a.submissionId);
  return {
    assignmentId: a.id,
    submissionId: a.submissionId,
    groupId: s.groupId,
    status: a.status,
    score: a.score,
    note: a.note,
    assignedAt: a.assignedAt,
    scoredAt: a.scoredAt,
    recusedAt: a.recusedAt,
    recuseReason: a.recuseReason,
  };
}

export function reviewerQueue(db, reviewerId, callId) {
  const reviewer = getUser(db, reviewerId);
  requireRole(reviewer, "reviewer");
  getCall(db, callId);
  return db.assignments
    .filter((a) => a.reviewerId === reviewer.id)
    .map((a) => ({ ...reviewerViewOfAssignment(db, a), callId: getSubmission(db, a.submissionId).callId }))
    .filter((a) => a.callId === callId);
}

export function callOverview(db, callId, viewer) {
  const call = getCall(db, callId);
  const subs = db.submissions.filter((s) => s.callId === callId && s.status !== "withdrawn");
  const scores = call.status === "finalized" || call.status === "assigned" || call.status === "locked"
    ? submissionScores(db, callId)
    : null;
  return {
    id: call.id,
    title: call.title,
    deadline: call.deadline,
    status: call.status,
    minScore: call.minScore,
    quotas: call.quotas,
    reviewersPerSubmission: call.reviewersPerSubmission,
    submissions: subs.map((s) => {
      const base = {
        id: s.id, groupId: s.groupId, status: s.status, createdAt: s.createdAt,
        title: s.title, medium: s.medium, statement: s.statement,
      };
      if (viewer?.role === "admin" || call.status === "finalized") {
        base.authorId = s.authorId;
        base.authorName = db.users[s.authorId]?.name;
      }
      const scoreRow = scores?.get(s.id);
      if (scoreRow && (viewer?.role === "admin" || viewer?.role === "reviewer" || call.status === "finalized")) {
        base.scoreCount = scoreRow.scores.length;
        base.activeAssignments = scoreRow.activeAssignments;
        base.recusedAssignments = scoreRow.recusedAssignments;
        base.avgScore = scoreRow.avgScore;
      }
      return base;
    }),
  };
}

export function resultView(db, callId) {
  const result = db.results.find((r) => r.callId === callId);
  const call = getCall(db, callId);
  if (!result) return { callId, status: call.status, locked: false, ranking: [] };

  // 榜单读取时按“当前有效名单”即时重算名次：
  // 退出/递补会改变作品状态，总排名与组内名次都要立即反映，而不是沿用定稿时的快照。
  const rows = result.ranking.map((r) => {
    const s = getSubmission(db, r.submissionId);
    // 原始分数以评分分配记录为权威来源（旧榜种子的手写行不含 scores，在此补齐）。
    const scores = db.assignments
      .filter((a) => a.submissionId === r.submissionId && a.status === "scored")
      .map((a) => a.score)
      .sort((x, y) => x - y);
    // outcome 以作品当前状态为准：selected / waitlisted / retired，其余保留定稿结论。
    const outcome = { selected: "selected", waitlisted: "waitlisted", retired: "retired" }[s.status]
      || r.outcome;
    return {
      submissionId: r.submissionId,
      groupId: r.groupId,
      avgScore: r.avgScore ?? trimmedAverage(scores),
      scores,
      createdAt: s.createdAt,
      currentStatus: s.status,
      recusedCount: db.assignments.filter(
        (a) => a.submissionId === r.submissionId && a.status === "recused").length,
      storedOutcome: r.outcome,
      outcome,
      submission: {
        id: s.id, title: s.title, groupId: s.groupId,
        authorName: db.users[s.authorId]?.name,
        authorOrg: db.users[s.authorId]?.org,
        createdAt: s.createdAt,
      },
    };
  });

  const ranking = assignRanks(rows).map(({ storedOutcome, ...rest }) => rest);
  return { ...result, ranking };
}
