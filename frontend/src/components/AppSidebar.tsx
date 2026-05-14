import {
  Sprout,
  Map as MapIcon,
  Grid2x2,
  Bug,
  Crosshair,
  ClipboardList,
  CheckCircle2,
  LayoutDashboard,
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { currentUser } from "@/lib/frappe"
import { type ViewId, viewHash } from "@/lib/router"
import upandeLogo from "@/assets/Upande_logo.png"

interface InAppItem {
  kind: "in-app"
  title: string
  view: ViewId
  icon: React.ComponentType<{ className?: string }>
}
interface ExternalItem {
  kind: "external"
  title: string
  url: string
  icon: React.ComponentType<{ className?: string }>
}
type NavItem = InAppItem | ExternalItem

const planning: NavItem[] = [
  { kind: "in-app", title: "Application Floor Plan", view: "floor-plan", icon: ClipboardList },
  { kind: "in-app", title: "Spray Plan Approval", view: "spray-plan", icon: CheckCircle2 },
]

const insight: NavItem[] = [
  { kind: "in-app", title: "Scouting Dashboard", view: "dashboard", icon: LayoutDashboard },
  {
    kind: "external",
    title: "Scouting Heatmaps",
    url: "/scouting-heatmaps",
    icon: Grid2x2,
  },
]

const maps: NavItem[] = [
  { kind: "external", title: "Scouts Map", url: "/scouts-map", icon: MapIcon },
  { kind: "external", title: "Observations Map", url: "/observations-map", icon: Crosshair },
  { kind: "external", title: "Variety Map", url: "/variety-map", icon: Sprout },
  { kind: "external", title: "Traps Map", url: "/traps-map", icon: Bug },
]

interface Props {
  view: ViewId
  onNavigate: (v: ViewId) => void
}

export function AppSidebar({ view, onNavigate }: Props) {
  const renderItem = (item: NavItem) => {
    const Icon = item.icon
    if (item.kind === "in-app") {
      const isActive = view === item.view
      return (
        <SidebarMenuItem key={item.view}>
          <SidebarMenuButton
            render={
              <a
                href={viewHash(item.view)}
                onClick={(e) => {
                  e.preventDefault()
                  onNavigate(item.view)
                }}
              >
                <Icon className="size-4" />
                <span>{item.title}</span>
              </a>
            }
            isActive={isActive}
            tooltip={item.title}
          />
        </SidebarMenuItem>
      )
    }
    return (
      <SidebarMenuItem key={item.url}>
        <SidebarMenuButton
          render={
            <a href={item.url}>
              <Icon className="size-4" />
              <span>{item.title}</span>
            </a>
          }
          tooltip={item.title}
        />
      </SidebarMenuItem>
    )
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0">
          <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-background ring-1 ring-border/60 group-data-[collapsible=icon]:size-6">
            <img
              src={upandeLogo}
              alt="Upande"
              className="size-full object-contain"
            />
          </div>
          <div className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate font-semibold">Upande SCP</span>
            <span className="truncate text-xs text-muted-foreground">
              Scouting &amp; Crop Protection
            </span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Planning</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{planning.map(renderItem)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Insight</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{insight.map(renderItem)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Maps</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{maps.map(renderItem)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          {currentUser()}
        </div>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
