// HTTP 层：路由、身份、幂等键与乐观并发；业务规则全部在 domain.js。
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStore } from "./store.js";
import { buildSeed } from "./seed.js";
import { ApiError, badRequest, unauthorized } from "./errors.js";
import * as D from "./domain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DB_PATH = process.env.DB_PATH || join(ROOT, "data", "cyanotype-review.json");
const PORT = Number(process.env.PORT || 3040);

// 可注入时钟，测试用；nowMs 由 Date 派生。
// 测试可通过环境变量 REVIEW_FAKE_NOW（ISO 字符串）固定“当前时间”，用于截止边界断言。
const clock = {
  now: () => (process.env.REVIEW_FAKE_NOW ? new Date(process.env.REVIEW_FAKE_NOW).getTime() : Date.now()),
  iso: () => new Date(clock.now()).toISOString(),
};

export const store = new JsonStore(DB_PATH, (iso) => buildSeed(iso), { now: clock.iso });

/* ---------- 请求工具 ---------- */

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

function viewer(db, req) {
  // 演示系统：用请求头切换身份。生产应换成会话/JWT。
  const id = req.headers["x-user-id"];
  if (!id) return null;
  return db.users[String(id)] || null;
}

function requireViewer(db, req) {
  const u = viewer(db, req);
  if (!u) throw unauthorized();
  return u;
}

/* ---------- 路由 ---------- */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
const num = (v) => (v === undefined ? undefined : Number(v));

// --- 元数据 ---
route("GET", /^\/api\/meta$/, (req, res, p, db) => {
  return {
    groups: db.groups,
    users: Object.values(db.users)
      .filter((u) => u.role !== "admin")
      .map((u) => ({ id: u.id, name: u.name, role: u.role, org: u.org, expertise: u.expertise || [] })),
    me: viewer(db, req) ? (({ id, name, role, org, expertise }) => ({
      id, name, role, org, expertise: expertise || [],
    }))(viewer(db, req)) : null,
    serverTime: new Date(clock.now()).toISOString(),
    version: db.version,
  };
});

// --- 征稿 ---
route("GET", /^\/api\/calls$/, (req, res, p, db) => {
  const v = viewer(db, req);
  return { calls: db.calls.map((c) => ({
    id: c.id, title: c.title, deadline: c.deadline, status: c.status,
    minScore: c.minScore, quotas: c.quotas, reviewersPerSubmission: c.reviewersPerSubmission,
    submissionCount: db.submissions.filter((s) => s.callId === c.id && s.status !== "withdrawn").length,
    version: db.version,
    // 普通作者在征稿中不暴露他人作品细节；列表计数仍可看。
    mine: v ? db.submissions.filter((s) => s.callId === c.id && s.authorId === v.id && s.status !== "withdrawn")
      .map((s) => ({ id: s.id, status: s.status, title: s.title })) : [],
  })) };
});

route("GET", /^\/api\/calls\/(?<id>[^/]+)$/, (req, res, p, db) => {
  const v = viewer(db, req);
  const call = D.getCall(db, p.id);
  const overview = D.callOverview(db, call.id, v);
  // 征稿中：非作者本人、非管理员不能看到他人作品内容（匿名从锁定开始更严格）。
  if (call.status === "open" && v?.role !== "admin") {
    overview.submissions = overview.submissions
      .filter((s) => v && s.authorId === v.id)
      .map((s) => ({ ...s, authorId: undefined }));
  }
  if (v?.role === "reviewer" && call.status !== "open") {
    // 评审只能看到分配给自己的作品，且不带作者字段。
    const mine = new Set(D.reviewerQueue(db, v.id, call.id).map((a) => a.submissionId));
    overview.submissions = overview.submissions.filter((s) => mine.has(s.id)).map((s) => {
      const { authorId, authorName, ...rest } = s;
      return rest;
    });
  }
  return overview;
});

route("POST", /^\/api\/calls\/(?<id>[^/]+)\/lock$/, (req, res, p, db, body, ctx) => {
  const v = requireViewer(db, ctx.req);
  return D.lockCall(db, v.id, p.id, { nowMs: clock.now() });
});

route("POST", /^\/api\/calls\/(?<id>[^/]+)\/assignments$/, (req, res, p, db, body, ctx) => {
  const v = requireViewer(db, ctx.req);
  return D.assignReviewers(db, v.id, p.id, { reviewersPerSubmission: num(body.reviewersPerSubmission) });
});

route("GET", /^\/api\/calls\/(?<id>[^/]+)\/conflicts$/, (req, res, p, db, body, ctx) => {
  const v = requireViewer(db, ctx.req);
  if (v.role !== "admin") throw new ApiError(403, "forbidden", "仅管理员可查看回避矩阵");
  return { matrix: D.conflictMatrix(db, p.id) };
});

route("POST", /^\/api\/calls\/(?<id>[^/]+)\/finalize$/, (req, res, p, db, body, ctx) => {
  const v = requireViewer(db, ctx.req);
  return D.finalize(db, v.id, p.id, { nowMs: clock.now(), force: Boolean(body.force) });
});

// --- 作品 ---
route("POST", /^\/api\/calls\/(?<id>[^/]+)\/submissions$/, (req, res, p, db, body, ctx) => {
  const v = requireViewer(db, ctx.req);
  return D.submitWork(db, v.id, {
    callId: p.id,
    groupId: body.groupId,
    title: body.title,
    medium: body.medium,
    statement: body.statement,
  }, { nowMs: clock.now(), idempotencyKey: ctx.idempotencyKey });
});

route("GET", /^\/api\/submissions\/(?<sid>[^/]+)$/, (req, res, p, db, body, ctx) => {
  const v = requireViewer(db, ctx.req);
  const s = D.getSubmission(db, p.sid);
  if (v.role === "reviewer") return D.reviewerWorkView(db, s.id, v);
  if (v.role === "author") {
    if (s.authorId !== v.id) throw new ApiError(403, "forbidden", "只能查看自己的作品");
    return D.publicSubmission(s, v);
  }
  return D.publicSubmission(s, v);
});

route("POST", /^\/api\/submissions\/(?<sid>[^/]+)\/withdraw$/, (req, res, p, db, body, ctx) => {
  const v = requireViewer(db, ctx.req);
  // 定稿后该端点语义为“退出入选名单”（含顺位递补）；之前为作者自行撤回。
  const s = D.getSubmission(db, p.sid);
  const call = D.getCall(db, s.callId);
  if (call.status === "finalized") return D.withdrawSelection(db, v.id, s.id, body.reason);
  return D.withdrawOwnWork(db, v.id, s.id, { nowMs: clock.now() });
});

// --- 评审动作 ---
route("GET", /^\/api\/me\/assignments$/, (req, res, p, db, body, ctx) => {
  const v = requireViewer(db, ctx.req);
  const callId = ctx.url.searchParams.get("callId");
  if (!callId) throw badRequest("缺少 callId 查询参数");
  return { callId, queue: D.reviewerQueue(db, v.id, callId) };
});

route("POST", /^\/api\/submissions\/(?<sid>[^/]+)\/recuse$/, (req, res, p, db, body, ctx) => {
  const v = requireViewer(db, ctx.req);
  return D.recuse(db, v.id, p.sid, body.reason);
});

route("PUT", /^\/api\/submissions\/(?<sid>[^/]+)\/score$/, (req, res, p, db, body, ctx) => {
  const v = requireViewer(db, ctx.req);
  return D.submitScore(db, v.id, p.sid, body);
});

route("PATCH", /^\/api\/submissions\/(?<sid>[^/]+)\/score$/, (req, res, p, db, body, ctx) => {
  const v = requireViewer(db, ctx.req);
  return D.amendScore(db, v.id, p.sid, body);
});

// --- 榜单 ---
route("GET", /^\/api\/calls\/(?<id>[^/]+)\/results$/, (req, res, p, db) => {
  D.getCall(db, p.id);
  return D.resultView(db, p.id);
});

route("GET", /^\/api\/audit$/, (req, res, p, db, body, ctx) => {
  const v = requireViewer(db, ctx.req);
  if (v.role !== "admin") throw new ApiError(403, "forbidden", "仅管理员可查看审计日志");
  const callId = ctx.url.searchParams.get("callId");
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") || 200), 1000);
  const rows = db.audit.filter((a) => !callId || a.callId === callId).slice(-limit);
  return { audit: rows };
});

/* ---------- 静态首页 ---------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : normalize(pathname).replace(/^\/+/, "");
  const file = join(ROOT, "public", rel);
  if (!file.startsWith(join(ROOT, "public"))) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[file.slice(file.lastIndexOf("."))] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

/* ---------- 服务主体 ---------- */

// 判断路由的语义状态码：创建类 201，动作类 200。
function successStatus(method, pathname, replayed) {
  if (replayed) return 200;
  if (method !== "POST") return 200;
  const actionSuffixes = ["/lock", "/assignments", "/finalize", "/withdraw", "/recuse", "/score"];
  if (actionSuffixes.some((x) => pathname.endsWith(x))) return 200;
  return 201; // 提交作品等创建操作
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJson(req) : {};

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;

    // 幂等键：相同键的 POST 重试原样回放首次成功响应（随状态持久化，重启后仍生效）。
    // 写操作在同一个 mutate 事务内完成“查重→执行→登记”；读操作直接读快照，不递增版本。
    const idempotencyKey = req.headers["idempotency-key"]
      ? String(req.headers["idempotency-key"]) : null;
    const ctx = { req, url, idempotencyKey };

    if (req.method === "GET" || req.method === "HEAD") {
      const payload = r.handler(req, res, m.groups || {}, store.read(), body, ctx);
      return send(res, 200, payload);
    }

    const { data } = await store.mutate(undefined, (db) => {
      db.idempotency ||= {};
      if (req.method === "POST" && idempotencyKey) {
        const cached = db.idempotency[idempotencyKey];
        if (cached) return { __replay: true, payload: cached.payload };
      }
      const payload = r.handler(req, res, m.groups || {}, db, body, ctx);
      if (req.method === "POST" && idempotencyKey) {
        // 仅缓存成功响应；处理器抛错时事务整体回滚，不登记该键。
        db.idempotency[idempotencyKey] = {
          at: clock.iso(),
          path: url.pathname,
          userId: req.headers["x-user-id"] || null,
          payload,
        };
      }
      return { __replay: false, payload };
    });

    const status = successStatus(req.method, url.pathname, data.__replay);
    const headers = data.__replay ? { "Idempotent-Replay": "true" } : {};
    return send(res, status, data.payload, headers);
  }

  if (req.method === "GET") return serveStatic(req, res, url.pathname);
  return send(res, 404, { error: "not_found", message: "接口不存在" });
}
const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-User-Id, Idempotency-Key, If-Match",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,OPTIONS",
    });
    return res.end();
  }
  handle(req, res).catch((err) => {
    if (err instanceof ApiError) {
      return send(res, err.status, {
        error: err.code, message: err.message, details: err.details,
      });
    }
    // eslint-disable-next-line no-console
    console.error("[server]", err);
    send(res, 500, { error: "internal_error", message: err.message });
  });
});

async function start() {
  await store.load();
  // 记录一次启动（重启恢复可在审计中核对），仅在非测试环境写。
  if (process.env.NODE_ENV !== "test") {
    await store.mutate(undefined, (db) => {
      db.boot = db.boot || {};
      db.boot.lastStartedAt = clock.iso();
      db.boot.startCount = (db.boot.startCount || 1) + 1;
    });
  }
  if (process.env.NODE_ENV !== "test") {
    server.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`蓝晒评审台 listening on http://localhost:${PORT}  (db: ${DB_PATH})`);
    });
  }
  return server;
}

if (process.env.NODE_ENV !== "test") start();

export { server, start, clock };
