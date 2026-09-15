// 演示种子数据：
//  calls/2025-x  已截稿、已评审、已定稿（含榜单与递补候补，可演示撤回/顺位递补）
//  calls/2026-x  征稿中（可演示提交、去重、截止、锁定、分配、回避、评分、定稿全流程）
//
// 关系数据刻意制造了同机构与两年内合作冲突，便于演示分配回避：
//   - 评审 r-qin 与作者 a-lin 同属「湖畔美院」，且 r-qin 与 a-feng 2025 年有合作；
//   - 评审 r-he 与作者 a-feng 2024 年有合作（超过两年窗口，不构成回避，仅作对照）。

export const GROUPS = {
  G1: { name: "实验蓝晒组", quota2025: 1, quota2026: 2 },
  G2: { name: "古典工艺组", quota2025: 1, quota2026: 2 },
  G3: { name: "摄影书册组", quota2025: 2, quota2026: 1 },
};

export const USERS = {
  // 作者
  "a-lin":   { id: "a-lin",   name: "林予安", role: "author",   org: "湖畔美术学院", expertise: ["G1"] },
  "a-zhao":  { id: "a-zhao",  name: "赵临川", role: "author",   org: "独立创作者",   expertise: ["G2"] },
  "a-feng":  { id: "a-feng",  name: "冯晚舟", role: "author",   org: "白纸摄影中心", expertise: ["G1", "G3"] },
  "a-he":    { id: "a-he",    name: "何栖迟", role: "author",   org: "浮光印社",     expertise: ["G2", "G3"] },
  "a-shen":  { id: "a-shen",  name: "沈砚青", role: "author",   org: "独立创作者",   expertise: ["G1"] },
  "a-cheng": { id: "a-cheng", name: "程岁宁", role: "author",   org: "白纸摄影中心", expertise: ["G3"] },
  // 评审
  "r-qin": {
    id: "r-qin", name: "秦既明", role: "reviewer", org: "湖畔美术学院",
    expertise: ["G1", "G3"],
    // userId + 合作年份；分配时若当前年份 - 合作年份 < 2 则回避
    collaborations: [{ userId: "a-feng", year: 2025 }],
  },
  "r-he": {
    id: "r-he", name: "何砚之", role: "reviewer", org: "北岸艺术空间",
    expertise: ["G2", "G3"],
    collaborations: [{ userId: "a-feng", year: 2024 }], // 超过两年窗口：对照用，不回避
  },
  "r-shen": {
    id: "r-shen", name: "申无咎", role: "reviewer", org: "素影学会",
    expertise: ["G1"],
    // 2026 年合作：2026 夏季征稿中与林予安互为回避对象
    collaborations: [{ userId: "a-lin", year: 2026 }],
  },
  "r-luo": {
    id: "r-luo", name: "罗清商", role: "reviewer", org: "素影学会",
    expertise: ["G2", "G3"],
    collaborations: [],
  },
  "r-gu": {
    id: "r-gu", name: "顾寒山", role: "reviewer", org: "潮声画廊",
    expertise: ["G1", "G2"],
    collaborations: [],
  },
  "r-wei": {
    id: "r-wei", name: "魏知微", role: "reviewer", org: "潮声画廊",
    expertise: ["G3"],
    collaborations: [],
  },
  // 这两名评审用于让 2026 征稿 G1 组在排除同机构/合作评审后仍能凑齐三人：
  // G1-001（林予安，湖畔美院）会排除 r-qin（同机构）与 r-shen（2026 合作），
  // 只剩 r-gu / r-yan / r-su 三人可分配。
  "r-yan": {
    id: "r-yan", name: "颜少棠", role: "reviewer", org: "云麓美术馆",
    expertise: ["G1"],
    collaborations: [],
  },
  "r-su": {
    id: "r-su", name: "苏抱朴", role: "reviewer", org: "青野工坊",
    expertise: ["G1"],
    collaborations: [],
  },
  // 第四名 G3 评审：让 G3 作品在有人回避后仍能补足三人
  "r-ming": {
    id: "r-ming", name: "明夜白", role: "reviewer", org: "乌木社",
    expertise: ["G3"],
    collaborations: [],
  },
  // 管理员（评审台管理员，非作者/评审）
  admin: { id: "admin", name: "评审台管理员", role: "admin", org: "蓝晒工作室" },
};

// 年份用于“两年内合作”判定，测试中可注入固定年份。
const CURRENT_YEAR = 2026;

function sub(seq, { callId, groupId, authorId, title, medium, statement, createdAt }) {
  return {
    id: `${groupId}-${String(seq).padStart(3, "0")}`,
    callId,
    groupId,
    authorId,
    title,
    medium,
    statement,
    createdAt, // ISO 字符串，同时作为同分“提交先后”的依据
    status: "submitted", // submitted | locked | selected | waitlisted | retired | withdrawn
  };
}

function asg(seq, submissionId, reviewerId, status = "scored", score = null, scoredAt = null, note = "") {
  return {
    id: seq,
    submissionId,
    reviewerId,
    status, // assigned | scored | recused
    score,
    note,
    assignedAt: "2025-09-02T09:00:00+08:00",
    scoredAt,
    recusedAt: status === "recused" ? "2025-09-03T10:00:00+08:00" : null,
    recuseReason: status === "recused" ? "发现与作者近期有共同展览合作" : null,
  };
}

export function buildSeed(now) {
  const t = now || (() => new Date().toISOString())();

  // ---- 2025 年度展：已定稿，用于演示榜单 / 撤回 / 顺位递补 ----
  const oldSubs = [
    sub(1, { callId: "2025-annual", groupId: "G1", authorId: "a-lin",
      title: "潮间带·七联", medium: "纯棉纸蓝晒，78×54cm×7",
      statement: "以七次潮汐时刻记录海岸线的显影变化。", createdAt: "2025-08-02T10:15:00+08:00" }),
    sub(1, { callId: "2025-annual", groupId: "G2", authorId: "a-zhao",
      title: "古法十二道", medium: "玻璃负片·蓝晒手账",
      statement: "复原十九世纪蓝晒十二道工序并记录偏差。", createdAt: "2025-08-05T14:20:00+08:00" }),
    sub(2, { callId: "2025-annual", groupId: "G2", authorId: "a-he",
      title: "水洗之书", medium: "棉布蓝晒长卷",
      statement: "以不同水源比较氧化成色。", createdAt: "2025-08-12T09:40:00+08:00" }),
    sub(1, { callId: "2025-annual", groupId: "G3", authorId: "a-feng",
      title: "负片档案室", medium: "摄影书·手工装帧",
      statement: "把一百张失败底片重新编目成书。", createdAt: "2025-08-08T16:05:00+08:00" }),
    sub(2, { callId: "2025-annual", groupId: "G3", authorId: "a-cheng",
      title: "蓝晒信札", medium: "艺术家手作书",
      statement: "以晒蓝信纸写成的往来书信。", createdAt: "2025-08-15T11:30:00+08:00" }),
  ];
  oldSubs.forEach((s) => (s.status = "locked"));

  // 每个作品 3 位评审独立评分（去最高最低后中位即均值）。
  // G2-002 80 分落榜，构成候补链：G2 组若有人撤回，由其顺位递补。
  const oldAssignments = [
    // G1-001 → 90 入选。作者林予安（湖畔美院）：r-qin 同机构、r-shen 有合作，
    // 旧榜由 r-gu / r-yan / r-su 三名无冲突评审评分。
    asg("A-001", "G1-001", "r-yan", "scored", 95, "2025-09-08T10:00:00+08:00"),
    asg("A-002", "G1-001", "r-gu",  "scored", 90, "2025-09-08T11:00:00+08:00"),
    asg("A-003", "G1-001", "r-su",  "scored", 88, "2025-09-08T12:00:00+08:00"),
    // G2-001 → 86 入选
    asg("A-004", "G2-001", "r-gu",  "scored", 90, "2025-09-08T10:30:00+08:00"),
    asg("A-005", "G2-001", "r-luo", "scored", 86, "2025-09-08T11:30:00+08:00"),
    asg("A-006", "G2-001", "r-he",  "scored", 70, "2025-09-08T12:30:00+08:00"),
    // G2-002 → 80 候补
    asg("A-007", "G2-002", "r-he",  "scored", 88, "2025-09-08T13:00:00+08:00"),
    asg("A-008", "G2-002", "r-gu",  "scored", 80, "2025-09-08T13:30:00+08:00"),
    asg("A-009", "G2-002", "r-luo", "scored", 60, "2025-09-08T14:00:00+08:00"),
    // G3-001 → 92 入选；含一次回避 + 一次补分配（4 条记录中 1 条 recused）
    asg("A-010", "G3-001", "r-qin", "recused"),
    asg("A-011", "G3-001", "r-wei", "scored", 95, "2025-09-09T10:00:00+08:00"),
    asg("A-012", "G3-001", "r-he",  "scored", 92, "2025-09-09T10:30:00+08:00"),
    asg("A-013", "G3-001", "r-luo", "scored", 88, "2025-09-09T11:00:00+08:00"),
    // G3-002 → 91 入选
    asg("A-014", "G3-002", "r-wei", "scored", 94, "2025-09-09T11:30:00+08:00"),
    asg("A-015", "G3-002", "r-luo", "scored", 91, "2025-09-09T12:00:00+08:00"),
    asg("A-016", "G3-002", "r-qin", "scored", 80, "2025-09-09T12:30:00+08:00"),
  ];

  const oldResult = {
    callId: "2025-annual",
    minScore: 60,
    finalizedAt: "2025-09-15T17:00:00+08:00",
    locked: true,
    ranking: [
      { submissionId: "G3-001", groupId: "G3", avgScore: 92, rank: 1, outcome: "selected" },
      { submissionId: "G3-002", groupId: "G3", avgScore: 91, rank: 2, outcome: "selected" },
      { submissionId: "G1-001", groupId: "G1", avgScore: 90, rank: 3, outcome: "selected" },
      { submissionId: "G2-001", groupId: "G2", avgScore: 86, rank: 4, outcome: "selected" },
      { submissionId: "G2-002", groupId: "G2", avgScore: 80, rank: 5, outcome: "waitlisted" },
    ],
  };
  for (const s of oldSubs) {
    const row = oldResult.ranking.find((r) => r.submissionId === s.id);
    s.status = row ? row.outcome : "locked";
  }

  // ---- 2026 夏季征稿：征稿中 ----
  // 编号按组别全局递增（2025 已占用 G1-001/G2-001,002/G3-001,002），新作品从 101 段开始。
  const newSubs = [
    sub(101, { callId: "2026-summer", groupId: "G1", authorId: "a-lin",
      title: "晴雨表", medium: "蓝晒·金属底板",
      statement: "以曝光时长记录连续三十天的阴晴。", createdAt: "2026-09-02T09:10:00+08:00" }),
    sub(101, { callId: "2026-summer", groupId: "G2", authorId: "a-zhao",
      title: "纸上的盐", medium: "古典涂层蓝晒",
      statement: "比较柠檬酸铵浓度对阶调的影响。", createdAt: "2026-09-05T15:00:00+08:00" }),
    sub(101, { callId: "2026-summer", groupId: "G3", authorId: "a-feng",
      title: "未寄出的卷", medium: "蓝晒摄影书",
      statement: "十二封未寄出信件构成的图像叙事。", createdAt: "2026-09-08T20:30:00+08:00" }),
    sub(102, { callId: "2026-summer", groupId: "G3", authorId: "a-cheng",
      title: "装订练习", medium: "手作书册",
      statement: "五种装帧结构与晒蓝图版的配合。", createdAt: "2026-09-10T10:00:00+08:00" }),
  ];

  return {
    version: 1,
    // 深拷贝模块级常量，避免调用方（含测试）的就地修改污染后续种子。
    groups: structuredClone(GROUPS),
    users: structuredClone(USERS),
    collaborationWindowYears: 2,
    currentYearForDemo: CURRENT_YEAR,
    calls: [
      {
        id: "2025-annual",
        title: "2025 年度蓝晒作品展",
        deadline: "2025-09-01T23:59:59+08:00",
        minScore: 60,
        quotas: { G1: 1, G2: 1, G3: 2 },
        reviewersPerSubmission: 3,
        status: "finalized", // open | locked | assigned | finalized
        createdAt: "2025-06-01T00:00:00+08:00",
      },
      {
        id: "2026-summer",
        title: "2026 夏季开放征稿",
        // 默认远在未来，保证演示环境处于“可提交”状态；测试可用环境变量覆盖。
        deadline: process.env.CALL_2026_DEADLINE || "2026-12-31T23:59:59+08:00",
        minScore: 60,
        quotas: { G1: 2, G2: 2, G3: 1 },
        reviewersPerSubmission: 3,
        status: "open",
        createdAt: "2026-06-01T00:00:00+08:00",
      },
    ],
    submissions: [...oldSubs, ...newSubs],
    assignments: oldAssignments,
    results: [oldResult],
    audit: [
      { at: "2025-09-01T23:59:59+08:00", actorId: "admin", action: "call.locked", callId: "2025-annual" },
      { at: "2025-09-02T09:00:00+08:00", actorId: "admin", action: "assignment.created", callId: "2025-annual", count: 16 },
      { at: "2025-09-15T17:00:00+08:00", actorId: "admin", action: "result.finalized", callId: "2025-annual" },
    ],
    // 幂等键：idempotencyKey -> { response, at }。随状态一起持久化，重启后仍生效。
    idempotency: {},
    // 作品编号按组别全局递增（key 为 groupId），避免不同征稿间编号撞号。
    seq: { submission: { G1: 101, G2: 101, G3: 102 }, assignment: 16 },
    boot: { lastStartedAt: t },
  };
}
