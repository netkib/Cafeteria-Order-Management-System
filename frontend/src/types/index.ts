export type UserRole = "student" | "admin";

export type OrderStatus =
  | "PENDING"
  | "STOCK_VERIFIED"
  | "IN_KITCHEN"
  | "READY"
  | "FAILED";

export type OrderStatusEvent = {
  orderId: string;
  studentId: string;
  status: OrderStatus;
  message?: string | null;
  at?: string;
  source?: string;
};

export type LoginSuccess = {
  ok: true;
  accessToken: string;
  role: UserRole;
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

export type MeResponse =
  | {
      ok: true;
      studentId: string;
      role: UserRole;
      balanceBdt?: number;
    }
  | ApiError;

export type WalletRechargeResponse =
  | {
      ok: true;
      studentId: string;
      amountBdt: number;
      balanceBdt: number;
      idempotentReplay: boolean;
    }
  | ApiError;

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

export type OrderTimelineEvent = {
  status: OrderStatus;
  at: string | Date;
  message?: string;
};

export type GetOrderResponse =
  | {
      ok: true;
      orderId: string;
      status: OrderStatus | string;
      events?: OrderTimelineEvent[];
      itemId?: string;
      quantity?: number;
      createdAt?: string | Date;
      updatedAt?: string | Date;
      priceBdt?: number;
      amountBdt?: number;
    }
  | ApiError;

export type PrintTokenData = {
  orderId: string;
  idempotencyKey?: string;
  itemName: string;
  details?: string[];
  quantity: number;
  priceBdt: number;
  totalBdt: number;
  printedAt?: string;
};
export type AdminStudentRow = {
  studentId: string;
  role: UserRole;
  name?: string;
  balanceBdt?: number;
  createdAt?: string | Date;
  updatedAt?: string | Date;
};

export type AdminListStudentsResponse = { ok: true; students: AdminStudentRow[] } | ApiError;

export type AdminCreateStudentResponse =
  | {
      ok: true;
      studentId: string;
      name: string;
      role: "student";
      balanceBdt: number;
      createdAt?: string | Date;
    }
  | ApiError;

export type AdminDeleteStudentResponse =
  | {
      ok: true;
      deleted: boolean;
      studentId: string;
    }
  | ApiError;

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

export type AdminDeleteItemResponse =
  | {
      ok: true;
      deleted: boolean;
      itemId: string;
    }
  | ApiError;

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

export type HealthResponse =
  | {
      service: string;
      ok: boolean;
      dependencies?: any;
    }
  | ApiError;

export type ServiceName = "identity" | "gateway" | "stock" | "kitchen" | "notification";

export type ServiceHealth = {
  name: ServiceName;
  baseUrl: string;
  ok: boolean;
  lastCheckedAt?: string;
  details?: any;
};

export type MetricsSnapshot = {
  service: ServiceName;
  fetchedAt: string;
  httpRequestsTotal?: number;
  avgLatencyMs?: number;
  ordersCreatedTotal?: number;
  ordersFailedTotal?: number;
  stockDecrementSuccessTotal?: number;
  stockDecrementFailTotal?: number;
  kitchenJobsProcessedTotal?: number;
  kitchenJobsFailedTotal?: number;
  rawText?: string; 
};