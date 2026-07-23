import { HistoryView } from "@/components/history-view";

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ approvalId?: string }>;
}) {
  const { approvalId = "" } = await searchParams;
  return <HistoryView initialApprovalId={approvalId} />;
}
