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
  status: string;
  execution_mode?: string;
  write_operations_performed?: boolean;
  memory?: {
    enabled?: boolean;
    context_turns?: number;
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
