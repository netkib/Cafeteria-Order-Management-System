import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Badge } from "../ui/Badge";
import type { ServiceName } from "../../types";

export type ChaosToggleProps = {
  adminSecret: string;
  onAdminSecretChange: (v: string) => void;
  onKill: (service: ServiceName) => void;
  killingService?: ServiceName | null;
};

export function ChaosToggle({
  adminSecret,
  onAdminSecretChange,
  onKill,
  killingService,
}: ChaosToggleProps) {
  const services: ServiceName[] = ["identity", "gateway", "stock", "kitchen", "notification"];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Input
        label="x-admin-secret"
        value={adminSecret}
        onChange={(e) => onAdminSecretChange(e.target.value)}
        placeholder="dev_admin_secret_change_me"
        hint="Used only for /admin/kill demo requests."
      />
      <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-extrabold text-slate-100">Chaos actions</div>
          <Badge tone="warning">DEMO</Badge>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {services.map((s) => (
            <Button
              key={s}
              variant="danger"
              size="sm"
              loading={killingService === s}
              onClick={() => onKill(s)}
            >
              Kill {s}
            </Button>
          ))}
        </div>
        <div className="mt-3 text-xs text-slate-400">
          Use this to demonstrate failure scenarios and recovery.
        </div>
      </div>
    </div>
  );
}