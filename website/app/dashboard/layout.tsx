import DashboardSidebar from "./dashboard-sidebar";

export default function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="dashboard-shell">
      <DashboardSidebar />
      {children}
    </main>
  );
}
