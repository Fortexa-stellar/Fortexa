import { ActivityTimeline } from "@/components/activity-timeline";
import { getAuditPages } from "@/lib/audit";

export default async function ActivityPage() {
  const initialPages = await getAuditPages(0, 1);

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-6">Activity</h1>
      <ActivityTimeline initialPages={initialPages} />
    </div>
  );
}
