import { config, apiUrl } from "./config";

type Json = Record<string, any>;

export type LoginResponse = {
  ok: true;
  accessToken: string;
  role: "student" | "admin";
  expiresInSeconds: number;
};

export type ApiError = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
};

export type Item = {
  itemId: string;
  name: string;
  quantity: number;
  priceBdt?: number;
  details?: string[];
};

export type ItemsResponse = { ok: true; items: Item[] } | ApiError;

export type CreateOrderResponse =
  | {
      ok: true;
      orderId: string;
      status: string;
      message?: string;
      events?: any[];
      priceBdt?: number;
      amountBdt?: number;
    }
  | ApiError;

export type GetOrderResponse =
  | {
      ok: true;
      orderId: string;
      status: string;
      events?: { status: string; at: string | Date; message?: string }[];
      itemId?: string;
      quantity?: number;
      createdAt?: string | Date;
      updatedAt?: string | Date;
      priceBdt?: number;
      amountBdt?: number;
    }
  | ApiError;

export type HealthResponse =
  | {
      service: string;
      ok: boolean;
      dependencies?: any;
    }
  | ApiError;

export type MeResponse =
  | {
      ok: true;
      studentId: string;
      role: "student" | "admin";
      balanceBdt?: number;
    }
  | ApiError;

// wallet recharge response
export type WalletRechargeResponse =
  | {
      ok: true;
      studentId: string;
      amountBdt: number;
      balanceBdt: number;
      idempotentReplay: boolean;
    }
  | ApiError;

// admin upsert item response 
export type AdminUpsertItemResponse =
  | {
      ok: true;
      itemId: string;
      quantity: number;
      created: boolean;
      name?: string;
      priceBdt?: number;
      details?: string[];
    }
  | ApiError;


// students
export type AdminStudentRow = {
  studentId: string;
  role: "student" | "admin";
  name?: string;
  balanceBdt?: number;
  createdAt?: string | Date;
  updatedAt?: string | Date;
};

export type AdminListStudentsResponse = { ok: true; students: AdminStudentRow[] } | ApiError;

export type AdminCreateStudentResponse =
  | { ok: true; studentId: string; name: string; role: "student"; balanceBdt: number; createdAt?: string | Date }
  | ApiError;

export type AdminDeleteStudentResponse = { ok: true; deleted: boolean; studentId: string } | ApiError;

export type AdminInventoryRow = {
  itemId: string;
  name: string;
  quantity: number;
  priceBdt: number;
  details: string[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
};

export type AdminListItemsResponse = { ok: true; items: AdminInventoryRow[] } | ApiError;
export type AdminDeleteItemResponse = { ok: true; deleted: boolean; itemId: string } | ApiError;


export type AdminOrderRow = {
  orderId: string;
  studentId: string;
  itemId: string;
  quantity: number;
  status: string;
  idempotencyKey?: string;
  priceBdt?: number;
  amountBdt?: number;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  events?: { status: string; at: string | Date; message?: string }[];
};

export type AdminListOrdersResponse = { ok: true; orders: AdminOrderRow[] } | ApiError;


export type AdminWalletTxRow = {
  kind: "recharge" | "debit";
  studentId: string;
  amountBdt: number;
  balanceAfterBdt: number;
  idempotencyKey: string;
  createdAt: string | Date;
  source?: "admin" | "gateway";
  meta?: { orderId?: string };
};

export type AdminListWalletTxResponse = { ok: true; transactions: AdminWalletTxRow[] } | ApiError;

async function safeJson(res: Response): Promise<Json | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { code: "BAD_JSON", message: "Invalid JSON response", details: text } };
  }
}

function normalizeErrorPayload(payload: any, fallbackCode: string, fallbackMessage: string): ApiError {
  if (payload?.ok === false && payload?.error?.code && payload?.error?.message) return payload as ApiError;
  return { ok: false, error: { code: fallbackCode, message: fallbackMessage, details: payload } };
}

async function requestJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs, ...rest } = init;
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const payload = await safeJson(res);

    if (!res.ok) {
      const err = normalizeErrorPayload(payload, `HTTP_${res.status}`, `Request failed (${res.status})`);
      return err as unknown as T;
    }

    return (payload ?? ({} as any)) as T;
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "Request timeout" : e?.message ?? "Network error";
    return { ok: false, error: { code: "NETWORK_ERROR", message: msg } } as unknown as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// api
export async function login(studentId: string, password: string): Promise<LoginResponse | ApiError> {
  return requestJson<LoginResponse | ApiError>(apiUrl(config.identityUrl, "/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ studentId, password }),
    timeoutMs: 8000,
  });
}


export async function getMe(token: string): Promise<MeResponse> {
  return requestJson<MeResponse>(apiUrl(config.identityUrl, "/me"), {
    method: "GET",
    headers: { ...authHeaders(token) },
    timeoutMs: 8000,
  });
}

// stock items
export async function fetchItems(): Promise<ItemsResponse> {
  return requestJson<ItemsResponse>(apiUrl(config.services.stock, "/items"), {
    method: "GET",
    timeoutMs: 8000,
  });
}

export async function createOrder(params: {
  token: string;
  itemId: string;
  quantity: number;
  idempotencyKey: string;
}): Promise<CreateOrderResponse> {
  return requestJson<CreateOrderResponse>(apiUrl(config.gatewayUrl, "/orders"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(params.token),
      "Idempotency-Key": params.idempotencyKey,
    },
    body: JSON.stringify({ itemId: params.itemId, quantity: params.quantity }),
    timeoutMs: 8000,
  });
}

export async function getOrder(token: string, orderId: string): Promise<GetOrderResponse> {
  return requestJson<GetOrderResponse>(apiUrl(config.gatewayUrl, `/orders/${orderId}`), {
    method: "GET",
    headers: { ...authHeaders(token) },
    timeoutMs: 8000,
  });
}

export async function getHealth(serviceBaseUrl: string): Promise<HealthResponse> {
  return requestJson<HealthResponse>(apiUrl(serviceBaseUrl, "/health"), {
    method: "GET",
    timeoutMs: 3000,
  });
}

export async function getMetricsText(serviceBaseUrl: string): Promise<string | ApiError> {
  const url = apiUrl(serviceBaseUrl, "/metrics");

  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      const payload = await safeJson(res);
      return normalizeErrorPayload(payload, `HTTP_${res.status}`, `Metrics request failed (${res.status})`);
    }
    return await res.text();
  } catch (e: any) {
    return { ok: false, error: { code: "NETWORK_ERROR", message: e?.message ?? "Network error" } };
  }
}

export async function adminKillService(params: {
  serviceBaseUrl: string;
  adminSecret: string;
}): Promise<{ ok: true; message?: string } | ApiError> {
  return requestJson<{ ok: true; message?: string } | ApiError>(apiUrl(params.serviceBaseUrl, "/admin/kill"), {
    method: "POST",
    headers: { "x-admin-secret": params.adminSecret },
    timeoutMs: 4000,
  });
}

export async function walletRechargeAdmin(params: {
  adminSecret: string;
  studentId: string;
  amountBdt: number;
  idempotencyKey: string;
}): Promise<WalletRechargeResponse> {
  return requestJson<WalletRechargeResponse>(apiUrl(config.identityUrl, "/wallet/recharge"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": params.adminSecret,
      "Idempotency-Key": params.idempotencyKey,
    },
    body: JSON.stringify({ studentId: params.studentId, amountBdt: params.amountBdt }),
    timeoutMs: 8000,
  });
}


export async function adminUpsertItem(params: {
  adminSecret: string;
  itemId: string;
  quantity: number;
  name?: string;
  priceBdt?: number;
  details?: string[];
}): Promise<AdminUpsertItemResponse> {
  return requestJson<AdminUpsertItemResponse>(apiUrl(config.services.stock, "/stock/restock"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": params.adminSecret,
    },
    body: JSON.stringify({
      itemId: params.itemId,
      quantity: params.quantity,
      name: params.name,
      priceBdt: params.priceBdt,
      details: params.details,
    }),
    timeoutMs: 8000,
  });
}


export async function adminListStudents(adminSecret: string): Promise<AdminListStudentsResponse> {
  return requestJson<AdminListStudentsResponse>(apiUrl(config.identityUrl, "/admin/students"), {
    method: "GET",
    headers: { "x-admin-secret": adminSecret },
    timeoutMs: 8000,
  });
}

export async function adminCreateStudent(params: {
  adminSecret: string;
  studentId: string;
  name: string;
  password: string;
  balanceBdt?: number;
}): Promise<AdminCreateStudentResponse> {
  return requestJson<AdminCreateStudentResponse>(apiUrl(config.identityUrl, "/admin/students"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-secret": params.adminSecret },
    body: JSON.stringify({
      studentId: params.studentId,
      name: params.name,
      password: params.password,
      balanceBdt: params.balanceBdt,
    }),
    timeoutMs: 8000,
  });
}

export async function adminDeleteStudent(params: {
  adminSecret: string;
  studentId: string;
}): Promise<AdminDeleteStudentResponse> {
  return requestJson<AdminDeleteStudentResponse>(apiUrl(config.identityUrl, `/admin/students/${params.studentId}`), {
    method: "DELETE",
    headers: { "x-admin-secret": params.adminSecret },
    timeoutMs: 8000,
  });
}


export async function adminListItems(adminSecret: string): Promise<AdminListItemsResponse> {
  return requestJson<AdminListItemsResponse>(apiUrl(config.services.stock, "/admin/items"), {
    method: "GET",
    headers: { "x-admin-secret": adminSecret },
    timeoutMs: 8000,
  });
}

export async function adminDeleteItem(params: {
  adminSecret: string;
  itemId: string;
}): Promise<AdminDeleteItemResponse> {
  return requestJson<AdminDeleteItemResponse>(apiUrl(config.services.stock, `/admin/items/${params.itemId}`), {
    method: "DELETE",
    headers: { "x-admin-secret": params.adminSecret },
    timeoutMs: 8000,
  });
}


export async function adminListOrders(params: {
  adminSecret: string;
  studentId?: string;
  status?: string;
  limit?: number;
}): Promise<AdminListOrdersResponse> {
  const qp = new URLSearchParams();
  if (params.studentId) qp.set("studentId", params.studentId);
  if (params.status) qp.set("status", params.status);
  if (typeof params.limit === "number") qp.set("limit", String(params.limit));

  const path = qp.toString() ? `/admin/orders?${qp.toString()}` : "/admin/orders";

  return requestJson<AdminListOrdersResponse>(apiUrl(config.gatewayUrl, path), {
    method: "GET",
    headers: { "x-admin-secret": params.adminSecret },
    timeoutMs: 8000,
  });
}


export async function adminListWalletTransactions(params: {
  adminSecret: string;
  studentId?: string;
  kind?: "recharge" | "debit";
  limit?: number;
}): Promise<AdminListWalletTxResponse> {
  const qp = new URLSearchParams();
  if (params.studentId) qp.set("studentId", params.studentId);
  if (params.kind) qp.set("kind", params.kind);
  if (typeof params.limit === "number") qp.set("limit", String(params.limit));

  const path = qp.toString() ? `/admin/transactions?${qp.toString()}` : "/admin/transactions";

  return requestJson<AdminListWalletTxResponse>(apiUrl(config.identityUrl, path), {
    method: "GET",
    headers: { "x-admin-secret": params.adminSecret },
    timeoutMs: 8000,
  });
}