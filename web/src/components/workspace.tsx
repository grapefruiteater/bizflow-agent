"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type {
  AgentProposedAction,
  AgentResult,
  ApprovalBundle,
  BusinessTask,
  DashboardData,
  Identity,
  TaskProposal,
} from "@/lib/contracts";

const DEFAULT_PROMPT =
  "今週の問い合わせを分析し、緊急度が高く、まだ対応されていない案件を抽出してください。社内対応ルールも確認して対応案を作成してください。";

const EMPTY_PROPOSAL: TaskProposal = {
  request_id: "",
  assignee: "",
  due_date: "",
  action: "",
};

export function Workspace() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [proposal, setProposal] = useState(EMPTY_PROPOSAL);
  const [selectedActionIndex, setSelectedActionIndex] = useState(0);
  const [approval, setApproval] = useState<ApprovalBundle | null>(null);
  const [task, setTask] = useState<BusinessTask | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState("");

  useEffect(() => {
    const stored = window.localStorage.getItem("bizflow-conversation-id");
    const value = stored ?? crypto.randomUUID();
    window.localStorage.setItem("bizflow-conversation-id", value);
    setConversationId(value);
    void loadDashboard();
  }, []);

  async function loadDashboard() {
    try {
      const payload = await apiGet<{ identity: Identity; dashboard: DashboardData }>(
        "/api/dashboard",
      );
      setIdentity(payload.identity);
      setDashboard(payload.dashboard);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function analyze() {
    if (!conversationId) return;
    setBusy("agent");
    setError(null);
    try {
      const payload = await apiPost<{ result: AgentResult }>("/api/agent", {
        prompt,
        conversationId,
      });
      setAgentResult(payload.result);
      setApproval(null);
      setTask(null);
      setSelectedActionIndex(0);
      setProposal(
        payload.result.proposed_actions.length
          ? toTaskProposal(payload.result.proposed_actions[0] as AgentProposedAction)
          : EMPTY_PROPOSAL,
      );
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function createApproval() {
    setBusy("approval");
    setError(null);
    try {
      const payload = await apiPost<{ result: ApprovalBundle }>("/api/approvals", {
        proposal,
      });
      setApproval(payload.result);
      setTask(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function decide(decision: "approve" | "reject") {
    if (!approval) return;
    setBusy(decision);
    setError(null);
    try {
      const payload = await apiPost<{ result: ApprovalBundle }>(
        `/api/approvals/${approval.approval.approval_id}/decision`,
        { decision },
      );
      setApproval(payload.result);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function executeTask() {
    if (!approval) return;
    setBusy("execute");
    setError(null);
    try {
      const payload = await apiPost<{
        result: { task: BusinessTask; approval: ApprovalBundle };
      }>(`/api/approvals/${approval.approval.approval_id}/execute`, {});
      setTask(payload.result.task);
      setApproval(payload.result.approval);
      setDashboard((current) =>
        current
          ? {
              ...current,
              metrics: {
                ...current.metrics,
                registeredTasks: current.metrics.registeredTasks + 1,
              },
            }
          : current,
      );
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  const urgentRequests = useMemo(
    () =>
      dashboard?.requests
        .filter((item) => item.urgency === "high" && item.status !== "closed")
        .sort((left, right) => left.due_date.localeCompare(right.due_date)) ?? [],
    [dashboard],
  );
  const selectedAction =
    agentResult?.proposed_actions[selectedActionIndex] ?? null;
  const proposalComplete = Object.values(proposal).every(
    (value) => value.trim().length > 0,
  );

  function selectProposedAction(index: number) {
    const action = agentResult?.proposed_actions[index];
    if (!action || approval) return;
    setSelectedActionIndex(index);
    setProposal(toTaskProposal(action));
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">B</span>
          <span>BizFlow</span>
        </div>
        <nav className="nav-list" aria-label="メインナビゲーション">
          <a className="nav-item active" href="#dashboard"><span>⌂</span>ダッシュボード</a>
          <a className="nav-item" href="#agent"><span>✦</span>AIエージェント</a>
          <Link className="nav-item" href={approval ? `/history?approvalId=${approval.approval.approval_id}` : "/history"}>
            <span>↺</span>実行履歴
          </Link>
        </nav>
        <div className="sidebar-foot">
          <span className="environment-dot" />
          <div><strong>{dashboard?.source === "aws" ? "AWS環境" : "Local demo"}</strong><small>読み取り優先・承認制御</small></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">BUSINESS OPERATIONS</p>
            <h1>おはようございます</h1>
            <p>{identity?.displayName ?? "利用者"}さん、今日の優先案件を確認しましょう。</p>
          </div>
          <div className="user-pill">
            <span className="avatar">{(identity?.displayName ?? "B").slice(0, 1)}</span>
            <div><strong>{identity?.displayName ?? "読込中"}</strong><small>{identity?.isApprover ? "承認者" : "一般利用者"}</small></div>
          </div>
        </header>

        {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError(null)}>×</button></div>}

        <section id="dashboard" aria-labelledby="dashboard-title">
          <div className="section-heading">
            <div><p className="eyebrow">OVERVIEW</p><h2 id="dashboard-title">業務ダッシュボード</h2></div>
            <span className="date-badge">基準日 {dashboard?.period.asOf ?? "---- -- --"}</span>
          </div>

          <div className="metric-grid">
            <MetricCard label="未対応件数" value={dashboard?.metrics.active} tone="blue" icon="▣" />
            <MetricCard label="緊急案件" value={dashboard?.metrics.urgent} tone="red" icon="!" />
            <MetricCard label="期限超過" value={dashboard?.metrics.overdue} tone="amber" icon="◷" />
            <MetricCard label="登録済みタスク" value={dashboard?.metrics.registeredTasks} tone="green" icon="✓" />
          </div>

          <div className="dashboard-grid">
            <article className="panel category-panel">
              <div className="panel-title"><div><p className="eyebrow">BREAKDOWN</p><h3>カテゴリー別</h3></div><span>全{dashboard?.requests.length ?? 0}件</span></div>
              <CategoryChart values={dashboard?.categoryCounts ?? {}} />
            </article>
            <article className="panel priority-panel">
              <div className="panel-title"><div><p className="eyebrow">ATTENTION</p><h3>優先対応リスト</h3></div><span className="live-badge">要確認</span></div>
              <div className="request-list">
                {urgentRequests.slice(0, 4).map((item) => (
                  <button key={item.request_id} onClick={() => setProposal((current) => ({ ...current, request_id: item.request_id }))}>
                    <span className="request-id">{item.request_id}</span>
                    <span className="request-copy"><strong>{item.description}</strong><small>{item.customer} · 期限 {item.due_date}</small></span>
                    <span className="urgency-chip">HIGH</span>
                  </button>
                ))}
              </div>
            </article>
          </div>
        </section>

        <section id="agent" className="agent-section" aria-labelledby="agent-title">
          <div className="section-heading">
            <div><p className="eyebrow">AGENT WORKSPACE</p><h2 id="agent-title">AIエージェント</h2></div>
            <div className="safe-chip"><span /> READ ONLY</div>
          </div>

          <div className="agent-grid">
            <article className="panel chat-panel">
              <div className="chat-intro">
                <span className="agent-orb">✦</span>
                <div><strong>BizFlow Agent</strong><p>問い合わせ・社内ルール・Memoryを横断して対応案を作ります。</p></div>
              </div>
              <label className="prompt-box">
                <span>自然言語で依頼</span>
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} />
              </label>
              <div className="tool-row"><span>利用可能</span><b>問い合わせ取得</b><b>データ分析</b><b>ルール検索</b><b>Code Interpreter</b></div>
              <button className="primary-button" onClick={analyze} disabled={busy !== null || !conversationId}>
                {busy === "agent" ? "AgentCoreで分析中…" : "分析を開始"}<span>→</span>
              </button>
              {agentResult && (
                <div className="agent-answer">
                  <div className="answer-meta">
                    <span>分析完了</span>
                    <span>Memory {agentResult.memory?.context_turns ?? 0} turn</span>
                    <span>設定 {agentResult.memory?.preference_records ?? 0}件</span>
                  </div>
                  <pre>{agentResult.response}</pre>
                </div>
              )}
            </article>

            <article className="panel approval-panel">
              <div className="panel-title"><div><p className="eyebrow">HUMAN IN THE LOOP</p><h3>承認カード</h3></div><StatusBadge status={approval?.approval.status ?? "DRAFT"} /></div>
              <p className="approval-note">AIはここを実行できません。内容を確認した利用者だけが承認できます。</p>
              {!agentResult && (
                <p className="proposal-empty">
                  分析を実行すると、Agentの構造化された対応案がここへ反映されます。
                </p>
              )}
              {agentResult && agentResult.proposed_actions.length === 0 && (
                <p className="proposal-empty">
                  承認対象にできる根拠付きの対応案はありません。
                </p>
              )}
              {agentResult && agentResult.proposed_actions.length > 0 && (
                <div className="proposal-source">
                  <label>
                    <span>Agent提案</span>
                    <select
                      value={selectedActionIndex}
                      onChange={(event) =>
                        selectProposedAction(Number(event.target.value))
                      }
                      disabled={approval !== null}
                    >
                      {agentResult.proposed_actions.map((item, index) => (
                        <option
                          key={`${item.request_id}-${index}`}
                          value={index}
                        >
                          {index + 1}. {item.request_id} / {item.assignee}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedAction && (
                    <div className="proposal-rationale">
                      <span>提案理由</span>
                      <p>{selectedAction.rationale}</p>
                      <small>
                        参照ルール:{" "}
                        {selectedAction.rule_ids.length
                          ? selectedAction.rule_ids.join(", ")
                          : "なし"}
                      </small>
                    </div>
                  )}
                </div>
              )}
              <div className="proposal-form">
                <Field label="対象ID" value={proposal.request_id} onChange={(value) => setProposal({ ...proposal, request_id: value })} disabled={approval !== null} />
                <Field label="担当者" value={proposal.assignee} onChange={(value) => setProposal({ ...proposal, assignee: value })} disabled={approval !== null} />
                <Field label="期限" value={proposal.due_date} type="date" onChange={(value) => setProposal({ ...proposal, due_date: value })} disabled={approval !== null} />
                <label><span>対応内容</span><textarea rows={4} value={proposal.action} onChange={(event) => setProposal({ ...proposal, action: event.target.value })} disabled={approval !== null} /></label>
              </div>
              {!approval && <button className="outline-button" onClick={createApproval} disabled={busy !== null || !proposalComplete}>{busy === "approval" ? "作成中…" : "承認依頼を作成"}</button>}
              {approval?.approval.status === "PENDING" && (
                <div className="decision-row">
                  <button className="reject-button" onClick={() => decide("reject")} disabled={busy !== null}>却下</button>
                  <button className="approve-button" onClick={() => decide("approve")} disabled={busy !== null}>承認する</button>
                </div>
              )}
              {approval?.approval.status === "APPROVED" && !task && (
                <button className="execute-button" onClick={executeTask} disabled={busy !== null}>{busy === "execute" ? "登録中…" : "承認済み内容でタスク登録"}</button>
              )}
              {task && <div className="task-success"><span>✓</span><div><strong>{task.task_id}</strong><p>担当タスクを登録しました。</p></div></div>}
              {approval && <Link className="history-link" href={`/history?approvalId=${approval.approval.approval_id}`}>監査履歴を見る →</Link>}
            </article>
          </div>
        </section>
      </main>
    </div>
  );
}

function MetricCard({ label, value, tone, icon }: { label: string; value?: number; tone: string; icon: string }) {
  return <article className={`metric-card ${tone}`}><span className="metric-icon">{icon}</span><div><p>{label}</p><strong>{value ?? "–"}</strong><small>件</small></div></article>;
}

function CategoryChart({ values }: { values: Record<string, number> }) {
  const entries = Object.entries(values);
  const max = Math.max(1, ...entries.map(([, value]) => value));
  return <div className="bar-chart">{entries.map(([label, value]) => <div className="bar-row" key={label}><span>{label}</span><div><i style={{ width: `${Math.max(12, (value / max) * 100)}%` }} /></div><b>{value}</b></div>)}</div>;
}

function Field({ label, value, onChange, type = "text", disabled = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; disabled?: boolean }) {
  return <label><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} /></label>;
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge ${status.toLowerCase()}`}>{status}</span>;
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  return readApi<T>(response);
}

async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bizflow-csrf": "1" },
    body: JSON.stringify(body),
  });
  return readApi<T>(response);
}

async function readApi<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as { ok: boolean; error?: { message?: string } } & T;
  if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? "API request failed");
  return payload;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "予期しないエラーが発生しました。";
}

function toTaskProposal(action: AgentProposedAction): TaskProposal {
  return {
    request_id: action.request_id,
    assignee: action.assignee,
    due_date: action.due_date,
    action: action.action,
  };
}
