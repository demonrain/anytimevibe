type ApiErrorBody = {
  error?: string;
  message?: string;
  details?: {
    formErrors?: string[];
    fieldErrors?: Record<string, string[] | undefined>;
  };
};

const ERROR_LABELS: Record<string, string> = {
  invalid_request: "请求参数无效",
  empty_json_body: "请求体不能为空",
  invalid_credentials: "用户名或密码错误",
  account_disabled: "账号已被禁用",
  registration_disabled: "当前未开放注册",
  user_limit_reached: "注册人数已达上限",
  username_taken: "用户名已被占用",
  invalid_setup_token: "设置令牌不正确",
  already_initialized: "服务已初始化",
  internal_error: "服务器内部错误"
};

function formatApiError(body: ApiErrorBody, status: number): string {
  if (typeof body.message === "string" && body.message.trim()) {
    return body.message.trim();
  }

  const fieldErrors = body.details?.fieldErrors;
  if (fieldErrors) {
    const parts: string[] = [];
    for (const [field, messages] of Object.entries(fieldErrors)) {
      if (!messages?.length) continue;
      const label = field === "username" ? "用户名" : field === "password" ? "密码" : field === "setupToken" ? "设置令牌" : field;
      parts.push(`${label}：${messages[0]}`);
    }
    if (parts.length) return parts.join("；");
  }

  const formErrors = body.details?.formErrors?.filter(Boolean);
  if (formErrors?.length) return formErrors.join("；");

  if (typeof body.error === "string" && body.error.trim()) {
    return ERROR_LABELS[body.error] ?? body.error;
  }

  return `请求失败（HTTP ${status}）`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers
  });
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
  if (!response.ok) throw new Error(formatApiError(body, response.status));
  return body as T;
}

export function websocketUrl(path: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${path}`;
}
