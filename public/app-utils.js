// 页面纯工具：无 DOM 依赖，可被页面 <script type="module"> 与 Node 单测同时 import。
//  - identity：页面刷新后从 localStorage 恢复已选身份
//  - ranking ：榜单原始分明细的健壮读取（兼容接口旧数据未返回 scores 的情况）
const IDENTITY_KEY = "review.identity.userId";

// 读取已保存的身份。传入 localStorage 兼容对象（无则返回 null）。
export function readStoredIdentity(storage) {
  try {
    const id = storage && storage.getItem ? storage.getItem(IDENTITY_KEY) : null;
    return id && String(id).trim() ? String(id) : null;
  } catch {
    return null; // 隐私模式等场景下 localStorage 可能不可用
  }
}

export function writeStoredIdentity(storage, userId) {
  try {
    if (!storage) return;
    if (userId) storage.setItem(IDENTITY_KEY, String(userId));
    else storage.removeItem(IDENTITY_KEY);
  } catch { /* ignore */ }
}

// 榜单行的原始分数：优先接口字段；缺失时返回空数组而不是抛错。
export function rowScores(row) {
  if (!row) return [];
  if (Array.isArray(row.scores)) return row.scores.filter((n) => typeof n === "number");
  // 兼容历史数据：只有均分时无可展开的明细，返回空数组。
  return [];
}

// 形如 “[80, 86, 90]” 的明细文本；无分数时给占位符，均分缺失给 “—”。
export function formatScoreDetail(row) {
  const scores = rowScores(row);
  const scoreText = scores.length ? "[" + scores.join(", ") + "]" : "[—]";
  const avg = typeof row?.avgScore === "number" ? row.avgScore : "—";
  return { scores, scoreText, avg };
}

// 名次空值安全：退出者（或旧数据缺名次）名次为 null，页面显示 “—” 而不是 undefined。
export function displayRank(value) {
  return Number.isInteger(value) && value > 0 ? String(value) : "—";
}

// 去掉一个最高分、一个最低分后取平均（与后端一致，用于页面端校验展示）。
export function trimmedAverage(nums) {
  const xs = (nums || []).filter((n) => typeof n === "number").slice().sort((a, b) => a - b);
  if (xs.length < 3) return null;
  const rest = xs.slice(1, xs.length - 1);
  return Math.round((rest.reduce((a, b) => a + b, 0) / rest.length) * 100) / 100;
}

const ReviewUtils = {
  IDENTITY_KEY,
  readStoredIdentity,
  writeStoredIdentity,
  rowScores,
  formatScoreDetail,
  displayRank,
  trimmedAverage,
};

export default ReviewUtils;
