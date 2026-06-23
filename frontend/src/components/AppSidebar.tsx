import {
  LayoutDashboard,
  LineChart,
  MapPin,
  Sprout,
  Search,
  Flame,
  Crosshair,
  Droplets,
  ClipboardList,
  CheckSquare,
  History,
  Layers,
  FileText,
  GitFork,
  Settings,
  Beaker,
  Truck,
  QrCode,
  Warehouse,
  Activity,
  ArrowRightLeft,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarUser } from "@/components/SidebarUser";
import { routeHash, type View } from "@/lib/router";
import { bootstrap } from "@/lib/frappe";
import upandeLogo from "@/assets/Upande_logo.png";

type IconType = React.ComponentType<{ className?: string }>;

type InAppItem = {
  kind: "view";
  view: View;
  label: string;
  icon: IconType;
  hint?: string;
  requireRoles?: string[];
  /** Inverse of ``requireRoles``: hide this item when the user holds any
   *  of these roles. Used to keep store-keeper-only pages hidden from
   *  everyone else. */
  hideForRoles?: string[];
};

type ExternalItem = {
  kind: "link";
  href: string;
  label: string;
  icon: IconType;
  hint?: string;
  requireRoles?: string[];
  hideForRoles?: string[];
};

type NavItem = InAppItem | ExternalItem;

interface NavSection {
  label: string;
  items: NavItem[];
  /** Hide the whole section when the user holds one of these roles —
   *  used to give Store Keepers an exclusive, two-item sidebar
   *  regardless of their other Frappe permissions. */
  hideForRoles?: string[];
}

const STORE_KEEPER_ROLE = "Store Keeper";

const ROSE_NAV: NavSection[] = [
  // Store-Keeper exclusive section — only role that sees it, and the
  // ONLY section visible when the user holds the Store Keeper role
  // (every other section sets hideForRoles=[STORE_KEEPER_ROLE]).
  {
    label: "Stores",
    items: [
      {
        kind: "view",
        view: "spray-plan-transfers",
        label: "Spray Plan Transfers",
        icon: Truck,
        requireRoles: [STORE_KEEPER_ROLE],
      },
      {
        kind: "view",
        view: "chemical-dashboard",
        label: "Chemical Dashboard",
        icon: Beaker,
        requireRoles: [STORE_KEEPER_ROLE],
      },
      {
        kind: "view",
        view: "labels",
        label: "Labels",
        icon: QrCode,
        requireRoles: [STORE_KEEPER_ROLE],
      },
      {
        kind: "view",
        view: "chemical-progress",
        label: "Chemical Progress",
        icon: Activity,
        requireRoles: [STORE_KEEPER_ROLE],
      },
    ],
  },
  {
    label: "Overview",
    hideForRoles: [STORE_KEEPER_ROLE],
    items: [
      { kind: "view", view: "dashboard", label: "Dashboards", icon: LayoutDashboard },
      { kind: "view", view: "trends", label: "Trends", icon: LineChart },
    ],
  },
  {
    label: "Scouting",
    hideForRoles: [STORE_KEEPER_ROLE],
    items: [
      { kind: "view", view: "scouting-map", label: "Scouting", icon: MapPin },
      { kind: "view", view: "spraying", label: "Spraying", icon: Droplets },
      { kind: "view", view: "observations", label: "Observations", icon: Search },
      { kind: "view", view: "heatmaps", label: "Heatmaps", icon: Flame },
      { kind: "view", view: "traps", label: "Traps", icon: Crosshair },
    ],
  },
  {
    label: "Crop Protection",
    hideForRoles: [STORE_KEEPER_ROLE],
    items: [
      {
        kind: "view",
        view: "application-plan",
        label: "Application Plan",
        icon: ClipboardList,
      },
      {
        kind: "view",
        view: "creator-stock",
        label: "Chemical Stock",
        icon: Warehouse,
        requireRoles: ["Spray Plan Creator"],
      },
      {
        kind: "view",
        view: "chemical-loaning",
        label: "Chemical Loaning",
        icon: ArrowRightLeft,
        requireRoles: ["Spray Plan Creator", "General Manager"],
      },
      {
        kind: "view",
        view: "approvals",
        label: "Approvals",
        icon: CheckSquare,
        requireRoles: ["General Manager", "Spray Plan Approver"],
      },
      {
        kind: "view",
        view: "settings",
        label: "Settings",
        icon: Settings,
        requireRoles: ["General Manager", "System Manager", "Administrator"],
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
    hideForRoles: [STORE_KEEPER_ROLE],
    items: [
      { kind: "view", view: "reports", label: "Reports", icon: FileText },
      { kind: "view", view: "varieties", label: "Varieties", icon: GitFork },
    ],
  },
];

// Generic scouting nav for any crop that isn't rose and has no bespoke nav
// yet — so a newly-scouted crop appears with a working sidebar automatically.
const DEFAULT_CROP_NAV: NavSection[] = [
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
      { kind: "view", view: "scouting-map", label: "Scouting Map", icon: Sprout },
      { kind: "view", view: "observations", label: "Observations", icon: Search },
      { kind: "view", view: "heatmaps", label: "Heatmaps", icon: Flame },
      { kind: "view", view: "traps", label: "Traps", icon: Crosshair },
    ],
  },
];

function navForCrop(crop: string): NavSection[] {
  if (crop === "rose") return ROSE_NAV;
  return DEFAULT_CROP_NAV;
}

function userHasAnyRole(required: string[] | undefined, userRoles: string[]): boolean {
  if (!required || required.length === 0) return true;
  return required.some((r) => userRoles.includes(r));
}

// Roles that override Store-Keeper-only lockdown — a person who's BOTH a
// Store Keeper AND a System Manager / Administrator / General Manager
// stays a full user; only somebody whose elevated access is exclusively
// "Store Keeper" gets the trimmed two-page sidebar.
const ELEVATED_ROLES = ["System Manager", "Administrator", "General Manager"];

function isStoreKeeperExclusive(userRoles: string[]): boolean {
  if (!userRoles.includes(STORE_KEEPER_ROLE)) return false;
  return !ELEVATED_ROLES.some((r) => userRoles.includes(r));
}

function isHiddenForUser(
  hideForRoles: string[] | undefined,
  userRoles: string[],
): boolean {
  if (!hideForRoles || hideForRoles.length === 0) return false;
  // ``hideForRoles: [Store Keeper]`` is special — it only kicks in when
  // the user holds Store Keeper *exclusively* (no elevated override
  // role). That way a System Manager who also has Store Keeper still
  // sees every section.
  if (
    hideForRoles.length === 1 &&
    hideForRoles[0] === STORE_KEEPER_ROLE
  ) {
    return isStoreKeeperExclusive(userRoles);
  }
  return hideForRoles.some((r) => userRoles.includes(r));
}

export function AppSidebar({
  crop,
  view,
  onNavigate,
}: {
  crop: string;
  view: View;
  onNavigate: (next: View) => void;
}) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const roles = bootstrap().roles || [];

  const nav = navForCrop(crop);

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
          {/* Always rendered, hidden via CSS so the width animation plays
              around it without React inserting/removing nodes mid-transition. */}
          <div className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate font-semibold">Upande SCP</span>
            <span className="truncate text-xs text-muted-foreground">
              Scouting &amp; Crop Protection
            </span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent className="overflow-hidden p-0 group-data-[collapsible=icon]:p-0">
        <ScrollArea className="h-full w-full">
          <div className="flex flex-col gap-1 p-2 group-data-[collapsible=icon]:p-1">
            {nav.map((section) => {
              if (isHiddenForUser(section.hideForRoles, roles)) return null;
              const visibleItems = section.items.filter(
                (item) =>
                  userHasAnyRole(item.requireRoles, roles) &&
                  !isHiddenForUser(item.hideForRoles, roles),
              );
              if (visibleItems.length === 0) return null;
              return (
                <SidebarGroup key={section.label}>
                  <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {visibleItems.map((item) => {
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
                                  href={routeHash({ crop, view: item.view })}
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
              );
            })}
          </div>
        </ScrollArea>
      </SidebarContent>
      <SidebarFooter>
        <SidebarUser />
      </SidebarFooter>
    </Sidebar>
  );
}
