import { createClient } from "@/lib/supabase/server";
import DashboardSidebar from "./dashboard-sidebar";

export default async function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  let isAdmin = false;
  if (user) {
    const { data: workspace } = await supabase
      .from("workspaces")
      .select("plan")
      .eq("owner_id", user.id)
      .maybeSingle();
    isAdmin = workspace?.plan === "admin";
  }

  return (
    <main className="dashboard-shell">
      <DashboardSidebar isAdmin={isAdmin} />
      {children}
    </main>
  );
}
