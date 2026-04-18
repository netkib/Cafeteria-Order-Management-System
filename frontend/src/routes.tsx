import { Navigate, Route, Routes } from "react-router-dom";
import LoginPage from "./pages/student/LoginPage";
import OrderPage from "./pages/student/OrderPage";
import LiveStatusPage from "./pages/student/LiveStatusPage";
import AdminDashboardPage from "./pages/admin/AdminDashboardPage";
import NotFoundPage from "./pages/NotFoundPage";

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/student/login" replace />} />
      <Route path="/student/login" element={<LoginPage />} />
      <Route path="/student/order" element={<OrderPage />} />
      <Route path="/student/status/:orderId" element={<LiveStatusPage />} />
      <Route path="/admin" element={<AdminDashboardPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}