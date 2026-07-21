"""Spray-flow Stock Entry Type names. Renaming these + the patch is the ONLY
place type wording lives. `purpose` (unchanged) is derived by ERPNext from the
type, so all purpose-based dispatch is unaffected."""

SE_TYPE_TRANSFER = "CSU Chemical Transfer"          # purpose: Material Transfer for Manufacture
SE_TYPE_MIX = "Chemical Mixing"                     # purpose: Manufacture
SE_TYPE_SPRAY = "Chemical Spray"                    # purpose: Material Issue
SE_TYPE_LOAN = "Chemical Loaning"                   # purpose: Material Transfer

# type name -> purpose (for the migrate patch)
SPRAY_STOCK_ENTRY_TYPES = {
    SE_TYPE_TRANSFER: "Material Transfer for Manufacture",
    SE_TYPE_MIX: "Manufacture",
    SE_TYPE_SPRAY: "Material Issue",
    SE_TYPE_LOAN: "Material Transfer",
}
