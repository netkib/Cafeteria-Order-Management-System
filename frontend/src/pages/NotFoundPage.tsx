import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";

export default function NotFoundPage() {
  return (
    <div className="mx-auto mt-10 max-w-2xl">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>404 - Page not found</CardTitle>
              <CardDescription>
                The page you are looking for does not exist or was moved.
              </CardDescription>
            </div>
            <Badge tone="warning">NOT FOUND</Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 text-sm text-slate-300">
            Try navigating from the main pages:
            <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-300">
              <li>Student login</li>
              <li>Student order</li>
              <li>Live status</li>
              <li>Admin dashboard (admin only)</li>
            </ul>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link to="/student/login">
              <Button variant="primary">Go to Login</Button>
            </Link>
            <Link to="/student/order">
              <Button variant="secondary">Go to Order</Button>
            </Link>
            <Link to="/admin">
              <Button variant="ghost">Go to Admin</Button>
            </Link>
          </div>

          <div className="text-xs text-slate-500">
            Tip: If you were redirected here after logout, sign in again.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}