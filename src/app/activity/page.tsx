import { redirect } from "next/navigation";

export default function ActivityRedirect() {
  redirect("/settings?tab=activity");
}
