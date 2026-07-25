export type RequestStatus = "open" | "in_progress" | "waiting" | "closed";
export type Urgency = "low" | "medium" | "high";

export interface BusinessRequest {
  request_id: string;
  received_at: string;
  category: string;
  customer: string;
  description: string;
  urgency: Urgency;
  status: RequestStatus;
  due_date: string;
}

export interface DashboardData {
  source: "local-demo" | "aws";
  period: { start: string; end: string; asOf: string };
  metrics: {
    active: number;
    urgent: number;
    overdue: number;
    registeredTasks: number;
  };
  categoryCounts: Record<string, number>;
  requests: BusinessRequest[];
}

export interface AgentResult {
  response: string;
  output_contract_version: "1.0";
  proposed_actions: AgentProposedAction[];
  status: "success";
  execution_mode: "READ_ONLY";
  write_operations_performed: false;
  memory?: {
    enabled?: boolean;
    user_scoped?: boolean;
    context_turns?: number;
    preference_records?: number;
    long_term_extraction_enabled?: boolean;
    event_stored?: boolean;
    degraded?: boolean;
  };
}

export interface TaskProposal {
  request_id: string;
  assignee: string;
  due_date: string;
  action: string;
}

export interface AgentProposedAction extends TaskProposal {
  rationale: string;
  rule_ids: string[];
}

export interface Approval {
  approval_id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  requested_by: string;
  approved_by: string | null;
  proposal: TaskProposal;
  created_at: string;
  decided_at: string | null;
}

export interface AuditEvent {
  event_id: string;
  event_type: string;
  actor: string;
  approval_id: string;
  task_id: string | null;
  detail_code: string | null;
  recorded_at: string;
}

export interface ApprovalBundle {
  approval: Approval;
  history: AuditEvent[];
}

export interface BusinessTask {
  task_id: string;
  status: "REGISTERED";
  approval_id: string;
  approved_by: string;
  request_id: string;
  assignee: string;
  due_date: string;
  action: string;
  created_at: string;
}

export interface Identity {
  actor: string;
  displayName: string;
  email?: string;
  groups: string[];
  isApprover: boolean;
}
