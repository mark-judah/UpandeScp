import {
  LayoutDashboard,
  LineChart,
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
  Settings,
  Beaker,
  Truck,
  QrCode,
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
import { SidebarUser } from "@/components/SidebarUser";
import { viewHash, type View } from "@/lib/router";
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

const NAV: NavSection[] = [
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
      { kind: "view", view: "rose", label: "Rose Scouting", icon: Flower },
      { kind: "view", view: "avocado", label: "Avocado", icon: Sprout },
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
        view: "approvals",
        label: "Approvals",
        icon: CheckSquare,
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
  view,
  onNavigate,
}: {
  view: View;
  onNavigate: (next: View) => void;
}) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const roles = bootstrap().roles || [];

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
      <SidebarContent>
        {NAV.map((section) => {
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
          );
        })}
      </SidebarContent>
      <SidebarFooter>
        <SidebarUser />
      </SidebarFooter>
    </Sidebar>
  );
}
