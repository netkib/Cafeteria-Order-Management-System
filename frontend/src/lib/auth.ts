export type UserRole = "student" | "admin";
export type AuthUser = {
  studentId: string;
  role: UserRole;
  exp?: number;
};

const TOKEN_KEY = "prototype2.accessToken";

export function getToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    return t && t.trim().length > 0 ? t : null;
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {}
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

function base64UrlDecode(input: string): string {
  const pad = (str: string) => str + "=".repeat((4 - (str.length % 4)) % 4);
  const normalized = pad(input.replace(/-/g, "+").replace(/_/g, "/"));
  // atob expects standard base64
  return decodeURIComponent(
    Array.prototype.map
      .call(atob(normalized), (c: string) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("")
  );
}

function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

type JwtPayloadLike = {
  sub?: string;
  role?: string;
  exp?: number;
};

export function decodeUserFromToken(token: string | null): AuthUser | null {

  if (!token) return null;

  const parts = token.split(".");

  if (parts.length !== 3) return null;

  const payloadStr = base64UrlDecode(parts[1]);
  const payload = safeJsonParse<JwtPayloadLike>(payloadStr);

  if (!payload) return null;

  const studentId = String(payload.sub ?? "").trim();
  const roleRaw = String(payload.role ?? "").trim();

  if (!studentId) return null;
  if (roleRaw !== "student" && roleRaw !== "admin") return null;

  return {
    studentId,
    role: roleRaw as UserRole,
    exp: typeof payload.exp === "number" ? payload.exp : undefined,
  };
}

export function getCurrentUser(): AuthUser | null {
  return decodeUserFromToken(getToken());
}

export function isTokenExpired(token: string | null): boolean {
  const user = decodeUserFromToken(token);
  if (!user?.exp) return false; // if exp missing, treat as non-expired (backend will decide)
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec >= user.exp;
}

export function requireValidSession(): AuthUser | null {
  const token = getToken();
  if (!token) return null;

  if (isTokenExpired(token)) {
    clearToken();
    return null;
  }
  return decodeUserFromToken(token);
}