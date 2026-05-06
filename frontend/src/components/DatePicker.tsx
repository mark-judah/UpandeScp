import { format } from "date-fns"
import { Calendar as CalendarIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

interface DatePickerProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}

const toDate = (iso: string): Date | undefined => {
  if (!iso) return undefined
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export function DatePicker({
  value,
  onChange,
  placeholder = "Pick a date",
  disabled,
}: DatePickerProps) {
  const date = toDate(value)

  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            variant="outline"
            className={cn(
              "w-full justify-start text-left font-normal",
              !date && "text-muted-foreground",
            )}
          >
            <CalendarIcon className="mr-2 size-4" />
            {date ? format(date, "PPP") : placeholder}
          </Button>
        }
      />
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => onChange(d ? format(d, "yyyy-MM-dd") : "")}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  )
}
