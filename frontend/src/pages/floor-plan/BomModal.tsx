import { useState } from "react"
import { Trash2, Plus } from "lucide-react"
import { toast } from "sonner"

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { scpApi, type ChemicalOption } from "@/lib/scp-api"
import { FrappeError } from "@/lib/frappe"
import { ChemicalCombo } from "./ChemicalCombo"

interface BomModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  greenhouse: string
  chemicals: ChemicalOption[]
  uomCache: Record<string, string>
  setUomCache: (next: Record<string, string>) => void
  onCreated: (bomName: string) => void
}

interface DraftRow {
  itemCode: string
  itemName: string
  rate: string
  uom: string
}

const blankRow = (): DraftRow => ({ itemCode: "", itemName: "", rate: "", uom: "" })

export function BomModal({
  open,
  onOpenChange,
  greenhouse,
  chemicals,
  uomCache,
  setUomCache,
  onCreated,
}: BomModalProps) {
  const [name, setName] = useState("")
  const [waterPh, setWaterPh] = useState("")
  const [waterHardness, setWaterHardness] = useState("")
  const [rows, setRows] = useState<DraftRow[]>([blankRow()])
  const [submitting, setSubmitting] = useState(false)

  const reset = () => {
    setName("")
    setWaterPh("")
    setWaterHardness("")
    setRows([blankRow()])
  }

  const updateRow = (i: number, patch: Partial<DraftRow>) => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  const handleSelectChemical = async (i: number, c: ChemicalOption) => {
    const cachedUom = uomCache[c.item_code] ?? c.uom ?? ""
    updateRow(i, { itemCode: c.item_code, itemName: c.item_name, uom: cachedUom })
    if (!cachedUom) {
      try {
        const r = await scpApi.getChemicalUom(c.item_code)
        if (r?.uom) {
          setUomCache({ ...uomCache, [c.item_code]: r.uom })
          updateRow(i, { uom: r.uom })
        }
      } catch {
        // ignore
      }
    }
  }

  const submit = async () => {
    if (!name.trim()) return toast.error("Please enter a BOM name")
    const ph = Number.parseFloat(waterPh)
    const hard = Number.parseFloat(waterHardness)
    if (!ph || ph <= 0) return toast.error("Please enter a valid water pH")
    if (!hard || hard <= 0) return toast.error("Please enter a valid water hardness")
    if (!greenhouse) return toast.error("Please select a greenhouse before creating a BOM")

    const items = rows
      .map((r) => ({
        item_code: r.itemCode.trim(),
        item_name: r.itemName.trim(),
        custom_application_rate: Number.parseFloat(r.rate) || 0,
        uom: r.uom,
      }))
      .filter((r) => r.item_code && r.custom_application_rate > 0)

    if (items.length === 0) return toast.error("Please add at least one chemical")
    if (items.some((r) => !r.uom)) return toast.error("All chemicals must have a UoM")

    setSubmitting(true)
    try {
      const res = await scpApi.createBOM({
        item: name.trim(),
        greenhouse,
        custom_water_ph: ph,
        custom_water_hardness: hard,
        items,
      })
      if (res?.status === "success" && res.bom_name) {
        toast.success(`BOM "${res.bom_name}" created successfully!`)
        reset()
        onCreated(res.bom_name)
      } else {
        toast.error(`Error creating BOM: ${res?.message || "Unknown error"}`)
      }
    } catch (e) {
      toast.error(e instanceof FrappeError ? e.message : "An error occurred while creating the BOM")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create New BOM</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">BOM Name *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., bot/rsm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Water PH *</Label>
              <Input
                type="number"
                step="0.1"
                value={waterPh}
                onChange={(e) => setWaterPh(e.target.value)}
                placeholder="6.5"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Water Hardness *</Label>
              <Input
                type="number"
                step="0.1"
                value={waterHardness}
                onChange={(e) => setWaterHardness(e.target.value)}
                placeholder="150"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Chemicals</Label>
            <div className="space-y-2 rounded-md border p-2">
              {rows.map((row, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[2fr_1fr_1fr_auto] items-center gap-2"
                >
                  <ChemicalCombo
                    value={row.itemName}
                    itemCode={row.itemCode}
                    options={chemicals}
                    onSelect={(c) => handleSelectChemical(i, c)}
                  />
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Rate/1000 L"
                    value={row.rate}
                    onChange={(e) => updateRow(i, { rate: e.target.value })}
                  />
                  <Input value={row.uom} readOnly placeholder="UOM" />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
                    aria-label="Remove chemical"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setRows((rs) => [...rs, blankRow()])}
              >
                <Plus className="mr-1 size-3.5" />
                Add Chemical
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Creating…" : "Create BOM"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
