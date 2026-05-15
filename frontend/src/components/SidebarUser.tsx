import { LogOut } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { bootstrap } from "@/lib/frappe";

function initialsOf(name: string): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const single = parts[0];
    // Emails fall back to the first character of the local-part.
    const local = single.includes("@") ? single.split("@")[0] : single;
    return (local[0] || "?").toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Bottom-of-sidebar profile chip. Renders the user's avatar (or initials
 * fallback) alongside their name and email, plus a small Exit icon that
 * matches the original "Exit to workspace" link. In collapsed sidebar
 * state name and email hide; avatar and exit icon remain stacked.
 */
export function SidebarUser() {
  const { user, full_name, user_image } = bootstrap();
  const displayName = full_name || user || "User";
  const initials = initialsOf(displayName);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div
          className={
            "flex items-center gap-2 px-2 py-1.5 " +
            "group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1 " +
            "group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0"
          }
        >
          <Avatar className="h-8 w-8 shrink-0">
            {user_image ? <AvatarImage src={user_image} alt={displayName} /> : null}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div
            className={
              "grid min-w-0 flex-1 text-left text-xs leading-tight " +
              "group-data-[collapsible=icon]:hidden"
            }
          >
            <span className="truncate font-medium">{displayName}</span>
            <span className="truncate text-[0.7rem] text-muted-foreground">
              {user}
            </span>
          </div>
          <SidebarMenuButton
            asChild
            title="Exit to workspace"
            className={
              "size-8 shrink-0 p-0 justify-center " +
              "group-data-[collapsible=icon]:size-6"
            }
          >
            <a href="/app/scouting-&-crop-protection" aria-label="Exit to workspace">
              <LogOut className="h-4 w-4" />
            </a>
          </SidebarMenuButton>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
