import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { PanelLeft } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useIsMobile } from "@/hooks/use-mobile";

const SIDEBAR_WIDTH = "16rem";
// Slightly wider than stock (3rem) so the collapsed icon rail still clears
// the button hit-area once the floating card's outer padding is subtracted.
const SIDEBAR_WIDTH_ICON = "4rem";
const SIDEBAR_COOKIE_NAME = "sidebar:state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

type SidebarContextValue = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (v: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (v: boolean) => void;
  isMobile: boolean;
  toggle: () => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export function useSidebar() {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within <SidebarProvider />");
  return ctx;
}

export const SidebarProvider = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }
>(
  (
    {
      defaultOpen = true,
      open: openProp,
      onOpenChange,
      className,
      style,
      children,
      ...props
    },
    ref,
  ) => {
    const isMobile = useIsMobile();
    const [openMobile, setOpenMobile] = React.useState(false);
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
    const open = openProp ?? internalOpen;
    const setOpen = React.useCallback(
      (v: boolean) => {
        if (onOpenChange) onOpenChange(v);
        else setInternalOpen(v);
        document.cookie = `${SIDEBAR_COOKIE_NAME}=${v}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
      },
      [onOpenChange],
    );
    const toggle = React.useCallback(() => {
      if (isMobile) setOpenMobile((v) => !v);
      else setOpen(!open);
    }, [isMobile, open, setOpen]);

    const ctx: SidebarContextValue = React.useMemo(
      () => ({
        state: open ? "expanded" : "collapsed",
        open,
        setOpen,
        openMobile,
        setOpenMobile,
        isMobile,
        toggle,
      }),
      [open, setOpen, openMobile, isMobile, toggle],
    );

    return (
      <SidebarContext.Provider value={ctx}>
        <div
          ref={ref}
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH,
              "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn(
            // Paint the app's own paper backdrop so the region behind the
            // floating sidebar matches the content and never depends on the
            // host www page's background.
            "group/sidebar-wrapper flex min-h-svh w-full bg-background",
            className,
          )}
          {...props}
        >
          {children}
        </div>
      </SidebarContext.Provider>
    );
  },
);
SidebarProvider.displayName = "SidebarProvider";

export const Sidebar = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    side?: "left" | "right";
    collapsible?: "offcanvas" | "icon" | "none";
  }
>(
  (
    { side = "left", collapsible = "icon", className, children, ...props },
    ref,
  ) => {
    const { state, isMobile, openMobile, setOpenMobile } = useSidebar();

    if (collapsible === "none") {
      return (
        <div
          ref={ref}
          className={cn(
            "flex h-svh w-[var(--sidebar-width)] flex-col bg-sidebar text-sidebar-foreground border-r",
            className,
          )}
          {...props}
        >
          {children}
        </div>
      );
    }

    if (isMobile) {
      return (
        <>
          {openMobile && (
            <div
              className="fixed inset-0 z-40 bg-black/40"
              onClick={() => setOpenMobile(false)}
            />
          )}
          <div
            ref={ref}
            data-mobile="true"
            data-state={openMobile ? "open" : "closed"}
            className={cn(
              "fixed inset-y-0 z-50 flex h-svh w-[18rem] flex-col bg-sidebar text-sidebar-foreground transition-transform duration-200",
              side === "left" ? "left-0 border-r" : "right-0 border-l",
              !openMobile &&
                (side === "left" ? "-translate-x-full" : "translate-x-full"),
              className,
            )}
            {...props}
          >
            {children}
          </div>
        </>
      );
    }

    return (
      // Detached, rounded, shadowed sidebar (reference `.side`): the outer
      // column is transparent and sticky — it only reserves width and adds
      // the margin that lets the inner card float on the paper background.
      <div
        ref={ref}
        data-state={state}
        data-collapsible={state === "collapsed" ? collapsible : ""}
        data-side={side}
        className={cn(
          "group peer hidden md:flex sticky top-0 h-svh shrink-0 flex-col p-2.5 transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]",
          state === "expanded"
            ? "w-[var(--sidebar-width)]"
            : collapsible === "icon"
              ? "w-[var(--sidebar-width-icon)]"
              : "w-0 overflow-hidden",
          className,
        )}
        {...props}
      >
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[20px] border bg-sidebar text-sidebar-foreground shadow-[var(--sd-shadow-1)]">
          {children}
        </div>
      </div>
    );
  },
);
Sidebar.displayName = "Sidebar";

export const SidebarTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof Button>
>(({ className, onClick, ...props }, ref) => {
  const { toggle } = useSidebar();
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      className={cn("h-8 w-8", className)}
      onClick={(e) => {
        onClick?.(e);
        toggle();
      }}
      {...props}
    >
      <PanelLeft />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
});
SidebarTrigger.displayName = "SidebarTrigger";

export const SidebarInset = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <main
    ref={ref}
    className={cn(
      "relative flex min-h-svh flex-1 flex-col bg-background",
      className,
    )}
    {...props}
  />
));
SidebarInset.displayName = "SidebarInset";

export const SidebarHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="header"
    className={cn(
      "flex flex-col gap-2 p-3 overflow-hidden",
      "group-data-[collapsible=icon]:p-2",
      className,
    )}
    {...props}
  />
));
SidebarHeader.displayName = "SidebarHeader";

export const SidebarFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="footer"
    className={cn(
      "mt-auto flex flex-col gap-2 p-3 overflow-hidden",
      "group-data-[collapsible=icon]:p-1",
      className,
    )}
    {...props}
  />
));
SidebarFooter.displayName = "SidebarFooter";

export const SidebarSeparator = React.forwardRef<
  React.ElementRef<typeof Separator>,
  React.ComponentPropsWithoutRef<typeof Separator>
>(({ className, ...props }, ref) => (
  <Separator
    ref={ref}
    className={cn("mx-2 w-auto bg-sidebar-border", className)}
    {...props}
  />
));
SidebarSeparator.displayName = "SidebarSeparator";

export const SidebarContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="content"
    className={cn(
      // overflow-x-hidden prevents the horizontal scrollbar that appeared
      // when collapsed buttons (32px) overflowed the inner padding box.
      "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden p-2",
      "group-data-[collapsible=icon]:p-1",
      className,
    )}
    {...props}
  />
));
SidebarContent.displayName = "SidebarContent";

export const SidebarGroup = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="group"
    className={cn(
      "relative flex w-full min-w-0 flex-col p-2",
      "group-data-[collapsible=icon]:p-0",
      className,
    )}
    {...props}
  />
));
SidebarGroup.displayName = "SidebarGroup";

export const SidebarGroupLabel = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar="group-label"
      // Mona's pattern: animate margin AND opacity together. When the parent
      // flips to data-collapsible="icon" the label fades AND pulls itself up
      // by its own h-8 so the menu items below slide up smoothly instead of
      // staying parked below an empty 32px row. CSS-driven (no React state
      // toggle) so it stays in sync with the sidebar's width transition.
      className={cn(
        "flex h-8 shrink-0 items-center px-2 text-[0.7rem] font-medium uppercase tracking-wider text-sidebar-foreground/60 whitespace-nowrap overflow-hidden transition-[margin,opacity] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
        className,
      )}
      {...props}
    />
  );
});
SidebarGroupLabel.displayName = "SidebarGroupLabel";

export const SidebarGroupContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="group-content"
    className={cn("w-full text-sm", className)}
    {...props}
  />
));
SidebarGroupContent.displayName = "SidebarGroupContent";

export const SidebarMenu = React.forwardRef<
  HTMLUListElement,
  React.HTMLAttributes<HTMLUListElement>
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    data-sidebar="menu"
    className={cn("flex w-full min-w-0 flex-col gap-0.5", className)}
    {...props}
  />
));
SidebarMenu.displayName = "SidebarMenu";

export const SidebarMenuItem = React.forwardRef<
  HTMLLIElement,
  React.HTMLAttributes<HTMLLIElement>
>(({ className, ...props }, ref) => (
  <li
    ref={ref}
    data-sidebar="menu-item"
    className={cn("group/menu-item relative", className)}
    {...props}
  />
));
SidebarMenuItem.displayName = "SidebarMenuItem";

const sidebarMenuButtonVariants = cva(
  // [&>span:last-child]:truncate keeps the label on a single line during the
  // sidebar's width animation — otherwise text wraps to two rows at narrow
  // intermediate widths and the row visibly jumps. Mirrors mona's pattern.
  "peer/menu-button group/menu-button flex w-full items-center gap-2 overflow-hidden rounded-lg group-data-[collapsible=icon]:rounded-full p-2 text-left text-sm outline-none ring-sidebar-ring transition-[width,padding,border-radius] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-primary data-[active=true]:font-medium data-[active=true]:text-sidebar-primary-foreground data-[state=open]:hover:bg-sidebar-accent group-data-[collapsible=icon]:!size-8 group-data-[collapsible=icon]:!p-2 [&>svg]:size-4 [&>svg]:shrink-0 [&>span:last-child]:truncate [&>span:last-child]:min-w-0",
  {
    variants: {
      size: {
        default: "h-8 text-sm",
        sm: "h-7 text-xs",
        lg: "h-12 group-data-[collapsible=icon]:!p-0",
      },
    },
    defaultVariants: { size: "default" },
  },
);

export const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> &
    VariantProps<typeof sidebarMenuButtonVariants> & {
      asChild?: boolean;
      isActive?: boolean;
    }
>(({ asChild, isActive, size, className, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      data-sidebar="menu-button"
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ size, className }))}
      {...props}
    />
  );
});
SidebarMenuButton.displayName = "SidebarMenuButton";
