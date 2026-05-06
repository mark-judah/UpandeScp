import { useMemo, useState } from "react"
import { RefreshCcw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { SidebarTrigger } from "@/components/ui/sidebar"

import { currentUser } from "@/lib/frappe"
import { useScouting } from "./dashboard/use-scouting"
import { aggregate, farmFromGreenhouse } from "./dashboard/aggregate"
import { OverviewTab } from "./dashboard/OverviewTab"
import { PestsTab } from "./dashboard/PestsTab"
import { DiseasesTab } from "./dashboard/DiseasesTab"
import { TrapsTab } from "./dashboard/TrapsTab"
import { FcmTab } from "./dashboard/FcmTab"

export function Dashboard() {
  const { filters, setFilters, payload, loading, error, refresh, greenhouses } = useScouting()
  const [farm, setFarm] = useState<string>("All")

  const filteredPayload = useMemo(() => {
    if (!payload || farm === "All") return payload
    return {
      ...payload,
      entries: (payload.entries ?? []).filter(
        (e) => farmFromGreenhouse(e.greenhouse ?? "") === farm,
      ),
    }
  }, [payload, farm])

  const data = useMemo(() => aggregate(filteredPayload), [filteredPayload])

  const farms = useMemo(() => {
    const set = new Set<string>()
    for (const gh of greenhouses) {
      const f = farmFromGreenhouse(gh)
      if (f) set.add(f)
    }
    return ["All", ...Array.from(set).sort()]
  }, [greenhouses])

  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b bg-background px-4 py-3 sm:px-6">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-5" />
        <div className="flex flex-1 items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Scouting Dashboard</h1>
          <Badge variant="secondary">
            {loading ? "Loading…" : `${data.totalEntries} entries`}
          </Badge>
        </div>
        <div className="hidden text-sm text-muted-foreground sm:block">
          {currentUser()}
        </div>
      </header>

      {/* Filter strip */}
      <div className="flex flex-wrap items-end gap-3 border-b bg-background px-4 py-3 sm:px-6">
        <div className="space-y-1">
          <Label className="text-xs">Week from</Label>
          <Input
            type="week"
            value={filters.weekFrom}
            onChange={(e) => setFilters({ weekFrom: e.target.value })}
            className="w-[170px]"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Week to</Label>
          <Input
            type="week"
            value={filters.weekTo}
            onChange={(e) => setFilters({ weekTo: e.target.value })}
            className="w-[170px]"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Farm</Label>
          <Select value={farm} onValueChange={(v) => setFarm(v ?? "All")}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {farms.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Greenhouse</Label>
          <Select
            value={filters.greenhouse ?? "__all__"}
            onValueChange={(v) =>
              setFilters({ greenhouse: !v || v === "__all__" ? null : v })
            }
            disabled={greenhouses.length === 0}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="All greenhouses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All greenhouses</SelectItem>
              {greenhouses
                .filter((g) => farm === "All" || farmFromGreenhouse(g) === farm)
                .map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCcw className={"mr-1 size-3.5 " + (loading ? "animate-spin" : "")} />
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {error && (
        <div className="mx-4 my-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive sm:mx-6">
          {error}
        </div>
      )}

      <main className="flex-1 p-4 sm:p-6">
        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList className="grid w-full max-w-2xl grid-cols-5">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="pests">Pests</TabsTrigger>
            <TabsTrigger value="diseases">Diseases</TabsTrigger>
            <TabsTrigger value="traps">Traps</TabsTrigger>
            <TabsTrigger value="fcm">FCM</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="m-0">
            <OverviewTab data={data} loading={loading} />
          </TabsContent>
          <TabsContent value="pests" className="m-0">
            <PestsTab data={data} loading={loading} />
          </TabsContent>
          <TabsContent value="diseases" className="m-0">
            <DiseasesTab data={data} loading={loading} />
          </TabsContent>
          <TabsContent value="traps" className="m-0">
            <TrapsTab data={data} loading={loading} />
          </TabsContent>
          <TabsContent value="fcm" className="m-0">
            <FcmTab data={data} payload={filteredPayload ?? null} loading={loading} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
