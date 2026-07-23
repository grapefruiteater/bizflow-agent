"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ApprovalBundle, Identity } from "@/lib/contracts";

export function HistoryView({ initialApprovalId }: { initialApprovalId: string }) {
  const [approvalId, setApprovalId] = useState(initialApprovalId);
  const [result, setResult] = useState<ApprovalBundle | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (initialApprovalId) void load(initialApprovalId);
  }, [initialApprovalId]);

  async function load(value = approvalId) {
    if (!value.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/approvals/${encodeURIComponent(value.trim())}`, { cache: "no-store" });
      const payload = (await response.json()) as { ok: boolean; identity?: Identity; result?: ApprovalBundle; error?: { message?: string } };
      if (!response.ok || !payload.ok || !payload.result) throw new Error(payload.error?.message ?? "履歴を取得できませんでした。");
      setResult(payload.result);
      setIdentity(payload.identity ?? null);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : "履歴を取得できませんでした。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="history-page">
      <div className="history-wrap">
        <Link href="/" className="back-link">← ダッシュボードへ戻る</Link>
        <div className="history-hero">
          <div><p className="eyebrow">AUDIT TRAIL</p><h1>実行履歴</h1><p>承認とタスク登録の記録をDynamoDBの監査イベントから確認します。</p></div>
          <div className="history-actor"><span>{(identity?.displayName ?? "B").slice(0, 1)}</span>{identity?.displayName ?? "認証済み利用者"}</div>
        </div>
        <div className="history-search panel">
          <label><span>承認ID</span><input value={approvalId} onChange={(event) => setApprovalId(event.target.value)} placeholder="APR-..." /></label>
          <button className="primary-button" onClick={() => load()} disabled={loading}>{loading ? "検索中…" : "履歴を表示"}</button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {result && (
          <div className="history-grid">
            <article className="panel approval-summary">
              <div className="panel-title"><h2>{result.approval.approval_id}</h2><span className={`status-badge ${result.approval.status.toLowerCase()}`}>{result.approval.status}</span></div>
              <dl><dt>依頼者</dt><dd>{result.approval.requested_by}</dd><dt>承認者</dt><dd>{result.approval.approved_by ?? "未決定"}</dd><dt>対象</dt><dd>{result.approval.proposal.request_id}</dd><dt>担当</dt><dd>{result.approval.proposal.assignee}</dd><dt>期限</dt><dd>{result.approval.proposal.due_date}</dd></dl>
              <div className="action-copy"><span>対応内容</span><p>{result.approval.proposal.action}</p></div>
            </article>
            <article className="panel timeline-panel">
              <div className="panel-title"><h2>監査イベント</h2><span>{result.history.length} events</span></div>
              <ol className="timeline">
                {result.history.map((event) => (
                  <li key={event.event_id}><span className="timeline-dot" /><div><strong>{eventLabel(event.event_type)}</strong><p>{event.actor}</p><time>{formatDate(event.recorded_at)}</time>{event.task_id && <b>{event.task_id}</b>}</div></li>
                ))}
              </ol>
            </article>
          </div>
        )}
      </div>
    </main>
  );
}

function eventLabel(value: string): string {
  return ({ APPROVAL_REQUESTED: "承認依頼を作成", APPROVAL_APPROVED: "対応案を承認", APPROVAL_REJECTED: "対応案を却下", TASK_REGISTERED: "担当タスクを登録", TASK_REGISTRATION_REJECTED: "未承認の登録を拒否" } as Record<string, string>)[value] ?? value;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
