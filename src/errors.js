// 统一的领域 / 接口错误类型。status 为 HTTP 状态码，code 为机器可读错误码。
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new ApiError(400, "bad_request", message, details);
export const unauthorized = (message = "请先选择身份") =>
  new ApiError(401, "unauthorized", message);
export const forbidden = (message, details) => new ApiError(403, "forbidden", message, details);
export const notFound = (message = "资源不存在") => new ApiError(404, "not_found", message);
// 与当前状态冲突：重复提交、已评分、已回避、名单锁定后再改分等。
export const conflict = (code, message, details) => new ApiError(409, code, message, details);
// 请求本身合法，但业务规则不满足：未到截止时间、评分人数不足、分数越界。
export const unprocessable = (code, message, details) =>
  new ApiError(422, code, message, details);
export const preconditionFailed = (message, details) =>
  new ApiError(412, "precondition_failed", message, details);

// 非法状态转移的统一入口。
export function invalidState(action, current, allowed, details) {
  return new ApiError(409, "invalid_state", `当前状态为「${current}」，不能执行「${action}」`, {
    current,
    allowed,
    ...details,
  });
}
