import { io, Socket } from "socket.io-client";
import { config } from "./config";

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

type SocketState = {
  socket: Socket | null;
  token: string | null;
};

const state: SocketState = { socket: null, token: null };

export function connectSocket(token: string): Socket {
  if (state.socket && state.token === token && state.socket.connected) return state.socket;

  if (state.socket) {
    try {
      state.socket.removeAllListeners();
      state.socket.disconnect();
    } catch {}
  }

  const socket = io(config.notificationUrl, {
  transports: ["polling", "websocket"],
  upgrade: true,
  auth: { token },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
  timeout: 8000,
});

  state.socket = socket;
  state.token = token;

  return socket;
}

export function subscribeToOrder(orderId: string) {
  if (!state.socket) return;
  if (!orderId) return;
  state.socket.emit("subscribe", { orderId });
}

export function unsubscribeFromOrder(orderId: string) {
  if (!state.socket) return;
  if (!orderId) return;
  state.socket.emit("unsubscribe", { orderId });
}

export function onOrderStatus(params: {
  onStatus: (evt: OrderStatusEvent) => void;
  onConnectChange?: (connected: boolean) => void;
  onError?: (message: string) => void;
}) {
  const socket = state.socket;
  if (!socket) return () => {};

  const handleConnect = () => params.onConnectChange?.(true);
  const handleDisconnect = () => params.onConnectChange?.(false);

  const handleConnectError = (err: any) => {
    params.onConnectChange?.(false);
    const msg = String(err?.message ?? "Socket connection error");
    params.onError?.(msg);
  };

  const handleOrderStatus = (evt: OrderStatusEvent) => {
    if (!evt?.orderId || !evt?.status) return;
    params.onStatus(evt);
  };

  socket.on("connect", handleConnect);
  socket.on("disconnect", handleDisconnect);
  socket.on("connect_error", handleConnectError);
  socket.on("orderStatus", handleOrderStatus);

  params.onConnectChange?.(socket.connected);

  return () => {
    try {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("orderStatus", handleOrderStatus);
    } catch {}
  };
}

export function disconnectSocket() {
  if (!state.socket) return;
  try {
    state.socket.removeAllListeners();
    state.socket.disconnect();
  } catch {}
  state.socket = null;
  state.token = null;
}