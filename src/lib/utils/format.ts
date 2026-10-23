export function truncateMiddle(value: string, left = 6, right = 6) {
  if (value.length <= left + right + 3) {
    return value;
  }
  return `${value.slice(0, left)}...${value.slice(-right)}`;
}

export function decisionVariant(
  decision: string
): "approve" | "warn" | "require" | "block" | "default" {
  if (decision === "APPROVE") return "approve";
  if (decision === "WARN") return "warn";
  if (decision === "REQUIRE_APPROVAL") return "require";
  if (decision === "BLOCK") return "block";
  return "default";
}

export function formatNumber(value: number, minDecimals = 0, maxDecimals = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: maxDecimals,
  }).format(value);
}

export function formatCurrency(value: number, currency = "USD"): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(value);
}

export function formatPct(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0.00%";
  return `${(value * 100).toFixed(2)}%`;
}
