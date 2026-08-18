import {
  Activity,
  ArrowRightLeft,
  Beaker,
  Bell,
  CalendarClock,
  CheckSquare,
  ClipboardList,
  Crosshair,
  Droplets,
  FileText,
  Flame,
  History,
  Layers,
  LayoutDashboard,
  LineChart,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  QrCode,
  Scale,
  Search,
  Settings,
  Sprout,
  Truck,
  Warehouse,
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
import { useUnreadNotifications } from "@/hooks/use-notifications";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
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

const STORE_KEEPER_ROLE = "SCP Chemical Store Keeper";

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
        requireRoles: ["SCP Spray Plan Creator"],
      },
      {
        kind: "view",
        view: "chemical-loaning",
        label: "Chemical Loaning",
        icon: ArrowRightLeft,
        requireRoles: ["SCP Spray Plan Creator", "SCP General Manager"],
      },
      {
        // The store keeper is included: the general store's pool, and who is owed
        // it, is their view of this page.
        kind: "view",
        view: "procurement",
        label: "Procurement",
        icon: Scale,
        requireRoles: [
          "SCP Spray Plan Creator",
          "SCP General Manager",
          STORE_KEEPER_ROLE,
        ],
      },
      {
        kind: "view",
        view: "approvals",
        label: "Approvals",
        icon: CheckSquare,
        requireRoles: ["SCP General Manager", "SCP Spray Plan Approver"],
      },
      {
        // Supervisors declare here and approvers decide, so both see it.
        kind: "view",
        view: "postponements",
        label: "Postponements",
        icon: CalendarClock,
        requireRoles: [
          "SCP Spray Supervisor",
          "SCP Spray Plan Approver",
          "SCP General Manager",
        ],
      },
      {
        kind: "view",
        view: "settings",
        label: "Settings",
        icon: Settings,
        requireRoles: ["SCP General Manager", "System Manager", "Administrator"],
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
      // Varieties is hidden until the page is finished. The route and the page are
      // still here, so restoring it is one line — reachable meanwhile by URL for
      // whoever is working on it.
    ],
  },
];

// Avocado is its own app: a parallel sidebar reached via the crop switcher.
// It reuses the rose page components forced to crop = Avocado, so avocado
// gets its own dashboards/trends/scouting scoped to avocado farms.
// It reuses the rose page components forced to the crop in the route, so the
// crop gets its own dashboards/trends/scouting scoped to its farms.
const AVOCADO_NAV: NavSection[] = [
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
      { kind: "view", view: "traps", label: "Traps", icon: Crosshair },
    ],
  },
  {
    label: "Crop Protection",
    items: [
      { kind: "view", view: "heatmaps", label: "Heat maps", icon: Flame },
    ],
  },
];

// Coffee — minimal nav for the triad tessellation test: Dashboard + the
// (triad) Scouting map only.
const COFFEE_NAV: NavSection[] = [
  {
    label: "Overview",
    items: [
      { kind: "view", view: "dashboard", label: "Dashboards", icon: LayoutDashboard },
    ],
  },
  {
    label: "Scouting",
    items: [
      { kind: "view", view: "scouting-map", label: "Scouting Map", icon: Sprout },
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
  if (crop === "avocado") return AVOCADO_NAV;
  if (crop === "coffee") return COFFEE_NAV;
  return DEFAULT_CROP_NAV;
}

function userHasAnyRole(required: string[] | undefined, userRoles: string[]): boolean {
  if (!required || required.length === 0) return true;
  return required.some((r) => userRoles.includes(r));
}

// Roles that override Store-Keeper-only lockdown — a person who's BOTH a
// Store Keeper AND a System Manager / Administrator / General Manager
// stays a full user; only somebody whose elevated access is exclusively
// "SCP Chemical Store Keeper" gets the trimmed two-page sidebar.
const ELEVATED_ROLES = ["System Manager", "Administrator", "SCP General Manager"];

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
  const { state, toggle } = useSidebar();
  const collapsed = state === "collapsed";
  const { unread: unreadNotifications } = useUnreadNotifications();
  const roles = bootstrap().roles || [];

  const nav = navForCrop(crop);

  // Show the footer "pocket" shadow only while nav items remain hidden below
  // the fold; hide it once the list is scrolled to the end (or fully fits).
  const navRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  useEffect(() => {
    const vp = navRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!vp) return;
    const update = () =>
      setMoreBelow(vp.scrollHeight - vp.scrollTop - vp.clientHeight > 1);
    update();
    vp.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(vp);
    if (vp.firstElementChild) ro.observe(vp.firstElementChild);
    return () => {
      vp.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [crop, collapsed]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        {/* Brand — reference `.topbar__brand`: prominent logo, thin divider,
            product name with an uppercase let-spaced eyebrow subtitle. */}
        <div className="flex items-center gap-2.5 py-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:py-0">
          {/* Logo links back to the Frappe desk (/app). */}
          <a
            href="/app"
            title="Open Frappe Desk"
            className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-background ring-1 ring-border/60 transition hover:ring-2 hover:ring-border group-data-[collapsible=icon]:size-7"
          >
            <img
              src={upandeLogo}
              alt="Upande"
              className="size-full object-contain"
            />
          </a>
          {/* Thin divider, reference `.topbar__divider`. */}
          <div className="h-6 w-px shrink-0 bg-border group-data-[collapsible=icon]:hidden" />
          {/* Always rendered, hidden via CSS so the width animation plays
              around it without React inserting/removing nodes mid-transition. */}
          <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
              Upande SCP
            </span>
            <span className="mt-0.5 truncate text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--sd-quiet)]">
              Scouting &amp; Crop Protection
            </span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent
        ref={navRef}
        className="overflow-hidden p-0 group-data-[collapsible=icon]:p-0"
      >
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
      {/* Boundary "pocket" cue — a subtle top shadow shown ONLY while nav
          items remain hidden below the fold (moreBelow); it fades out once
          the list is scrolled to the end or fully fits. Works collapsed too. */}
      <SidebarFooter
        className={cn(
          "transition-shadow duration-200",
          moreBelow &&
            "border-t border-sidebar-border shadow-[0_-6px_14px_-10px_rgba(10,10,10,0.16)]",
        )}
      >
        {/* Notifications — a normal sidebar item, pinned to the footer rather
            than the crop nav above: they are not crop-scoped, so listing them
            per crop would imply they were. */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={view === "notifications"}
              onClick={() => onNavigate("notifications")}
              title={
                unreadNotifications
                  ? `${unreadNotifications} unread notification${unreadNotifications === 1 ? "" : "s"}`
                  : "Notifications"
              }
            >
              <Bell className="h-4 w-4" />
              <span>Notifications</span>
              {unreadNotifications > 0 && (
                <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--sd-data-red)] px-1 text-[0.6rem] font-semibold leading-none text-white">
                  {unreadNotifications > 99 ? "99+" : unreadNotifications}
                </span>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator />

        {/* Collapse — a normal sidebar item (icon + label), pinned here. */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={toggle}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
              <span>{collapsed ? "Expand" : "Collapse"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator />
        <SidebarUser />
      </SidebarFooter>
    </Sidebar>
  );
}
