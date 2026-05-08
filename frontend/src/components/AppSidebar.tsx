import {
  LayoutDashboard,
  LineChart,
  Leaf,
  Flower,
  Sprout,
  Search,
  Flame,
  Crosshair,
  ClipboardList,
  CheckSquare,
  History,
  Layers,
  FileText,
  GitFork,
  LogOut,
} from "lucide-react";
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
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { viewHash, type View } from "@/lib/router";

type IconType = React.ComponentType<{ className?: string }>;

type InAppItem = {
  kind: "view";
  view: View;
  label: string;
  icon: IconType;
  hint?: string;
};

type ExternalItem = {
  kind: "link";
  href: string;
  label: string;
  icon: IconType;
  hint?: string;
};

type NavItem = InAppItem | ExternalItem;

interface NavSection {
  label: string;
  items: NavItem[];
}

const NAV: NavSection[] = [
  {
    label: "Overview",
    items: [
      { kind: "view", view: "dashboard", label: "Dashboards", icon: LayoutDashboard },
      { kind: "view", view: "trends", label: "Trends", icon: LineChart },
    ],
  },
  {
    label: "Scouting",
    items: [
      { kind: "view", view: "rose", label: "Rose Scouting", icon: Flower },
      { kind: "view", view: "avocado", label: "Avocado", icon: Sprout },
      { kind: "view", view: "observations", label: "Observations", icon: Search },
      { kind: "view", view: "heatmaps", label: "Heatmaps", icon: Flame },
      { kind: "view", view: "traps", label: "Traps", icon: Crosshair },
    ],
  },
  {
    label: "Crop Protection",
    items: [
      {
        kind: "view",
        view: "application-plan",
        label: "Application Plan",
        icon: ClipboardList,
      },
      {
        kind: "view",
        view: "approvals",
        label: "Approvals",
        icon: CheckSquare,
      },
      {
        kind: "view",
        view: "historical",
        label: "Historical",
        icon: History,
      },
      { kind: "view", view: "tank-mixes", label: "Tank Mixes", icon: Layers },
    ],
  },
  {
    label: "Reports",
    items: [
      { kind: "view", view: "reports", label: "Reports", icon: FileText },
      { kind: "view", view: "varieties", label: "Varieties", icon: GitFork },
    ],
  },
];

export function AppSidebar({
  view,
  onNavigate,
}: {
  view: View;
  onNavigate: (next: View) => void;
}) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-1.5 py-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--sd-accent)] text-white">
            <Leaf className="h-3.5 w-3.5" />
          </div>
          {!collapsed && (
            <div className="flex flex-col leading-tight">
              <span className="text-[0.78rem] font-semibold tracking-tight text-foreground">
                Scouting &amp; CP
              </span>
              <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                Field intelligence
              </span>
            </div>
          )}
        </div>
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent>
        {NAV.map((section) => (
          <SidebarGroup key={section.label}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const active =
                    item.kind === "view" ? view === item.view : false;
                  return (
                    <SidebarMenuItem key={`${item.kind}:${item.label}`}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        title={item.hint || item.label}
                      >
                        {item.kind === "view" ? (
                          <a
                            href={viewHash(item.view)}
                            onClick={(e) => {
                              e.preventDefault();
                              onNavigate(item.view);
                            }}
                          >
                            <Icon className="h-4 w-4" />
                            <span>{item.label}</span>
                          </a>
                        ) : (
                          <a href={item.href}>
                            <Icon className="h-4 w-4" />
                            <span>{item.label}</span>
                          </a>
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild title="Exit to workspace">
              <a href="/app/scouting-&-crop-protection">
                <LogOut className="h-4 w-4" />
                <span>Exit</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
