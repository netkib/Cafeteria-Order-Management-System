type AppConfig = {
  identityUrl: string;
  gatewayUrl: string;
  notificationUrl: string;

  services: {
    identity: string;
    gateway: string;
    stock: string;
    kitchen: string;
    notification: string;
  };
};

function normalizeBaseUrl(raw: string, name: string): string {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new Error(
      `[config] Missing ${name}. Set it in docker-compose frontend environment (VITE_*) or in frontend/.env`
    );
  }
  return value.replace(/\/+$/, "");
}

function getEnv(key: string): string {
  return (import.meta as any).env?.[key] ?? "";
}

export const config: AppConfig = (() => {
  const identityUrl = normalizeBaseUrl(getEnv("VITE_IDENTITY_URL"), "VITE_IDENTITY_URL");
  const gatewayUrl = normalizeBaseUrl(getEnv("VITE_GATEWAY_URL"), "VITE_GATEWAY_URL");
  const notificationUrl = normalizeBaseUrl(getEnv("VITE_NOTIFICATION_URL"), "VITE_NOTIFICATION_URL");

  const services = {
    identity: identityUrl, 
    gateway: gatewayUrl, 
    stock: "http://localhost:7003",
    kitchen: "http://localhost:7004",
    notification: notificationUrl, 
  };

  return { identityUrl, gatewayUrl, notificationUrl, services };
})();

export function apiUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}