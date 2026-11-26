/**
 * Client for the spray ticket (MOLFM27 layout) endpoint
 * (``upande_scp.serverscripts.spray_plan_ops.spray_ticket``). The ticket is worked
 * out from the plan's existing records on every call; nothing is stored.
 */
import { call } from "./frappe";

export type TicketGroup = "details" | "signoff" | "spray";

export interface TicketLine {
  key: string;
  label: string;
  group: TicketGroup;
  value: string | null;
  filled: boolean;
  hint: string | null;
}

export interface SprayTicket {
  work_order: string;
  percent: number;
  printable: boolean;
  stopped: boolean;
  missing: string[];
  lines: TicketLine[];
}

const NS = "upande_scp.serverscripts.spray_plan_ops.spray_ticket";

export function getSprayTicket(workOrder: string): Promise<SprayTicket> {
  return call<SprayTicket>(`${NS}.get_spray_ticket`, { work_order: workOrder });
}

export const TICKET_FORMAT = "SCP Spray Ticket";

/** The Work Order print view of the ticket (the server refuses it without access). */
export function sprayTicketPrintUrl(workOrder: string): string {
  return (
    `/printview?doctype=Work%20Order&name=${encodeURIComponent(workOrder)}` +
    `&format=${encodeURIComponent(TICKET_FORMAT)}&no_letterhead=1`
  );
}
