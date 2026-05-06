import { TooltipProvider } from "@/components/ui/tooltip"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { AppSidebar } from "@/components/AppSidebar"
import { ApplicationFloorPlan } from "@/pages/ApplicationFloorPlan"
import { Dashboard } from "@/pages/Dashboard"
import { useView } from "@/lib/router"

function App() {
  const [view, navigate] = useView()
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar view={view} onNavigate={navigate} />
        <SidebarInset>
          {view === "dashboard" ? <Dashboard /> : <ApplicationFloorPlan />}
        </SidebarInset>
        <Toaster richColors position="top-right" />
      </SidebarProvider>
    </TooltipProvider>
  )
}

export default App
