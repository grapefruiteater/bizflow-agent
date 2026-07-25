"""Deterministic domain logic for the BizFlow mock business tools."""

from __future__ import annotations

import csv
import hashlib
from collections import Counter
from collections.abc import Callable, Iterable, Mapping
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Protocol


ACTIVE_STATUSES = frozenset({"open", "in_progress", "waiting"})
VALID_URGENCIES = frozenset({"low", "medium", "high"})
VALID_STATUSES = ACTIVE_STATUSES | {"closed"}
RULE_KEYWORDS = {
    "RULE-001": ("障害", "high", "緊急", "2時間"),
    "RULE-002": ("期限超過", "エスカレーション", "チームリーダー"),
    "RULE-003": ("請求", "金額", "経理"),
    "RULE-004": ("契約", "法務", "レビュー"),
    "RULE-005": ("個人情報", "転送", "担当者"),
}


class BusinessToolError(ValueError):
    """An expected, caller-correctable tool error."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class BusinessDataRepository(Protocol):
    def load_requests(self) -> list[dict[str, str]]: ...

    def load_rules(self) -> list[dict[str, str]]: ...


class WorkflowStore(Protocol):
    def request_approval(
        self,
        proposal: Mapping[str, str],
        requested_by: str,
    ) -> dict[str, Any]: ...

    def approve(self, approval_id: str, approved_by: str) -> dict[str, Any]: ...

    def reject(self, approval_id: str, rejected_by: str) -> dict[str, Any]: ...

    def get_approval(self, approval_id: str) -> dict[str, Any]: ...

    def create_task(
        self,
        approval_id: str,
        proposal: Mapping[str, str],
    ) -> tuple[dict[str, Any], bool]: ...

    def get_task(self, task_id: str) -> dict[str, Any]: ...

    def get_history(self, approval_id: str) -> list[dict[str, Any]]: ...

    def count_tasks(self) -> int: ...


class LocalFileDataRepository:
    """Read the synthetic portfolio data bundled with the source tree."""

    def __init__(self, data_directory: Path | None = None) -> None:
        self.data_directory = data_directory or Path(__file__).with_name("data")

    def load_requests(self) -> list[dict[str, str]]:
        path = self.data_directory / "business_requests.csv"
        with path.open("r", encoding="utf-8-sig", newline="") as csv_file:
            rows = [normalize_request(row) for row in csv.DictReader(csv_file)]
        ensure_unique_request_ids(rows)
        return rows

    def load_rules(self) -> list[dict[str, str]]:
        path = self.data_directory / "company_rules.md"
        return parse_rules_markdown(path.read_text(encoding="utf-8"))


class MockWorkflowStore:
    """In-memory approval and task store for local tests and demonstrations.

    This store intentionally models the DynamoDB boundary but is not durable
    across Lambda cold starts. The AWS deployment phase must replace it with a
    persistent adapter before write tools are enabled.
    """

    def __init__(
        self,
        now_factory: Callable[[], datetime] | None = None,
    ) -> None:
        self._now_factory = now_factory or (lambda: datetime.now(timezone.utc))
        self._approvals: dict[str, dict[str, Any]] = {}
        self._tasks: dict[str, dict[str, Any]] = {}
        self._audit_events: list[dict[str, Any]] = []

    def request_approval(
        self,
        proposal: Mapping[str, str],
        requested_by: str,
    ) -> dict[str, Any]:
        normalized = normalize_task_proposal(proposal)
        actor = require_text(requested_by, "requested_by", max_length=128)
        digest = stable_digest({**normalized, "requested_by": actor})
        approval_id = f"APR-{digest[:12].upper()}"
        approval = self._approvals.setdefault(
            approval_id,
            {
                "approval_id": approval_id,
                "status": "PENDING",
                "requested_by": actor,
                "approved_by": None,
                "proposal": normalized,
                "created_at": self._now_factory().isoformat(),
                "decided_at": None,
            },
        )
        if not any(
            event["event_type"] == "APPROVAL_REQUESTED"
            and event["approval_id"] == approval_id
            for event in self._audit_events
        ):
            self._record_event(
                event_type="APPROVAL_REQUESTED",
                actor=actor,
                approval_id=approval_id,
            )
        return dict(approval)

    def approve(self, approval_id: str, approved_by: str) -> dict[str, Any]:
        approval = self._get_approval(approval_id)
        if approval["status"] != "PENDING":
            raise BusinessToolError(
                "APPROVAL_ALREADY_DECIDED",
                f"Approval {approval_id} has already been decided.",
            )
        approval["status"] = "APPROVED"
        approval["approved_by"] = require_text(
            approved_by,
            "approved_by",
            max_length=128,
        )
        approval["decided_at"] = self._now_factory().isoformat()
        self._record_event(
            event_type="APPROVAL_APPROVED",
            actor=approval["approved_by"],
            approval_id=approval_id,
        )
        return dict(approval)

    def reject(self, approval_id: str, rejected_by: str) -> dict[str, Any]:
        approval = self._get_approval(approval_id)
        if approval["status"] != "PENDING":
            raise BusinessToolError(
                "APPROVAL_ALREADY_DECIDED",
                f"Approval {approval_id} has already been decided.",
            )
        approval["status"] = "REJECTED"
        approval["approved_by"] = require_text(
            rejected_by,
            "rejected_by",
            max_length=128,
        )
        approval["decided_at"] = self._now_factory().isoformat()
        self._record_event(
            event_type="APPROVAL_REJECTED",
            actor=approval["approved_by"],
            approval_id=approval_id,
        )
        return dict(approval)

    def get_approval(self, approval_id: str) -> dict[str, Any]:
        return dict(self._get_approval(approval_id))

    def create_task(
        self,
        approval_id: str,
        proposal: Mapping[str, str],
    ) -> tuple[dict[str, Any], bool]:
        approval = self._get_approval(approval_id)
        if approval["status"] != "APPROVED":
            self._record_event(
                event_type="TASK_REGISTRATION_REJECTED",
                actor="bizflow-agent",
                approval_id=approval_id,
                detail_code="APPROVAL_REQUIRED",
            )
            raise BusinessToolError(
                "APPROVAL_REQUIRED",
                "The task proposal has not been approved.",
            )

        normalized = normalize_task_proposal(proposal)
        if normalized != approval["proposal"]:
            self._record_event(
                event_type="TASK_REGISTRATION_REJECTED",
                actor="bizflow-agent",
                approval_id=approval_id,
                detail_code="APPROVAL_MISMATCH",
            )
            raise BusinessToolError(
                "APPROVAL_MISMATCH",
                "The task does not exactly match the approved proposal.",
            )

        task_id = f"TASK-{stable_digest({'approval_id': approval_id, **normalized})[:12].upper()}"
        if task_id in self._tasks:
            return dict(self._tasks[task_id]), False

        task = {
            "task_id": task_id,
            "status": "REGISTERED",
            "approval_id": approval_id,
            "approved_by": approval["approved_by"],
            **normalized,
            "created_at": self._now_factory().isoformat(),
        }
        self._tasks[task_id] = task
        self._record_event(
            event_type="TASK_REGISTERED",
            actor="bizflow-agent",
            approval_id=approval_id,
            task_id=task_id,
        )
        return dict(task), True

    def get_task(self, task_id: str) -> dict[str, Any]:
        normalized = require_text(task_id, "task_id", max_length=64)
        task = self._tasks.get(normalized)
        if task is None:
            raise BusinessToolError("TASK_NOT_FOUND", f"Task {normalized} was not found.")
        return dict(task)

    def get_history(self, approval_id: str) -> list[dict[str, Any]]:
        normalized = require_text(approval_id, "approval_id", max_length=64)
        return [
            dict(event)
            for event in self._audit_events
            if event["approval_id"] == normalized
        ]

    def count_tasks(self) -> int:
        return len(self._tasks)

    def _get_approval(self, approval_id: str) -> dict[str, Any]:
        normalized = require_text(approval_id, "approval_id", max_length=64)
        approval = self._approvals.get(normalized)
        if approval is None:
            raise BusinessToolError(
                "APPROVAL_NOT_FOUND",
                f"Approval {normalized} was not found.",
            )
        return approval

    def _record_event(
        self,
        event_type: str,
        actor: str,
        approval_id: str,
        task_id: str | None = None,
        detail_code: str | None = None,
    ) -> None:
        self._audit_events.append(
            {
                "event_id": f"EVT-{len(self._audit_events) + 1:06d}",
                "event_type": event_type,
                "actor": actor,
                "approval_id": approval_id,
                "task_id": task_id,
                "detail_code": detail_code,
                "recorded_at": self._now_factory().isoformat(),
            }
        )


class BusinessToolsService:
    """Execute Gateway reads and BFF-only dashboard and task operations."""

    def __init__(
        self,
        data_directory: Path | None = None,
        data_repository: BusinessDataRepository | None = None,
        workflow_store: WorkflowStore | None = None,
    ) -> None:
        if data_directory is not None and data_repository is not None:
            raise ValueError("Specify data_directory or data_repository, not both.")
        self.data_repository = data_repository or LocalFileDataRepository(data_directory)
        self.workflow_store = workflow_store or MockWorkflowStore()

    def get_business_requests(self, arguments: Mapping[str, Any]) -> dict[str, Any]:
        start_date = parse_date(arguments.get("start_date"), "start_date")
        end_date = parse_date(arguments.get("end_date"), "end_date")
        if end_date < start_date:
            raise BusinessToolError(
                "INVALID_DATE_RANGE",
                "end_date must not be earlier than start_date.",
            )

        filters = {
            name: optional_text(arguments.get(name), name, max_length=100).lower()
            for name in ("category", "urgency", "status")
        }
        requests = [
            request
            for request in self.data_repository.load_requests()
            if start_date <= parse_date(request["received_at"], "received_at") <= end_date
            and all(
                not expected or request[name].lower() == expected
                for name, expected in filters.items()
            )
        ]
        return {
            "source": "synthetic_csv",
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "count": len(requests),
            "requests": requests,
        }

    def analyze_request_data(self, arguments: Mapping[str, Any]) -> dict[str, Any]:
        as_of = parse_date(arguments.get("as_of"), "as_of")
        raw_requests = arguments.get("requests")
        if not isinstance(raw_requests, list) or not raw_requests:
            raise BusinessToolError(
                "INVALID_REQUESTS",
                "requests must be a non-empty array.",
            )
        requests = [normalize_request(item) for item in raw_requests]
        active = [item for item in requests if item["status"] in ACTIVE_STATUSES]
        overdue = [
            item["request_id"]
            for item in active
            if parse_date(item["due_date"], "due_date") < as_of
        ]
        urgent = [
            item["request_id"] for item in active if item["urgency"] == "high"
        ]
        return {
            "as_of": as_of.isoformat(),
            "total_count": len(requests),
            "active_count": len(active),
            "closed_count": len(requests) - len(active),
            "overdue_request_ids": overdue,
            "urgent_open_request_ids": urgent,
            "category_counts": sorted_counts(item["category"] for item in requests),
            "urgency_counts": sorted_counts(item["urgency"] for item in requests),
            "status_counts": sorted_counts(item["status"] for item in requests),
        }

    def search_company_rules(self, arguments: Mapping[str, Any]) -> dict[str, Any]:
        query = require_text(arguments.get("query"), "query", max_length=500)
        category = optional_text(arguments.get("category"), "category", max_length=100)
        search_text = f"{query} {category}".lower()
        rules = self.data_repository.load_rules()
        matched = [
            rule
            for rule in rules
            if any(
                keyword.lower() in search_text
                for keyword in RULE_KEYWORDS.get(rule["rule_id"], ())
            )
        ]
        return {
            "source": "synthetic_markdown",
            "query": query,
            "count": len(matched),
            "rules": matched,
        }

    def create_business_task(self, arguments: Mapping[str, Any]) -> dict[str, Any]:
        approval_id = require_text(
            arguments.get("approval_id"),
            "approval_id",
            max_length=64,
        )
        task, created = self.workflow_store.create_task(approval_id, arguments)
        return {"created": created, "task": task}

    def get_task_status(self, arguments: Mapping[str, Any]) -> dict[str, Any]:
        task = self.workflow_store.get_task(
            require_text(arguments.get("task_id"), "task_id", max_length=64)
        )
        return {
            "task": task,
            "history": self.workflow_store.get_history(task["approval_id"]),
        }

    def get_dashboard_metrics(
        self,
        _arguments: Mapping[str, Any],
    ) -> dict[str, int]:
        return {"registered_task_count": self.workflow_store.count_tasks()}


def normalize_request(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        raise BusinessToolError("INVALID_REQUEST", "Each request must be an object.")
    normalized = {
        "request_id": require_text(value.get("request_id"), "request_id", max_length=64),
        "received_at": parse_date(value.get("received_at"), "received_at").isoformat(),
        "category": require_text(value.get("category"), "category", max_length=100),
        "customer": require_text(value.get("customer"), "customer", max_length=200),
        "description": require_text(
            value.get("description"), "description", max_length=1000
        ),
        "urgency": require_text(value.get("urgency"), "urgency", max_length=20).lower(),
        "status": require_text(value.get("status"), "status", max_length=30).lower(),
        "due_date": parse_date(value.get("due_date"), "due_date").isoformat(),
    }
    if normalized["urgency"] not in VALID_URGENCIES:
        raise BusinessToolError("INVALID_URGENCY", "urgency is not supported.")
    if normalized["status"] not in VALID_STATUSES:
        raise BusinessToolError("INVALID_STATUS", "status is not supported.")
    return normalized


def normalize_task_proposal(value: Mapping[str, Any]) -> dict[str, str]:
    due_date = parse_date(value.get("due_date"), "due_date").isoformat()
    return {
        "request_id": require_text(
            value.get("request_id"), "request_id", max_length=64
        ),
        "assignee": require_text(value.get("assignee"), "assignee", max_length=128),
        "due_date": due_date,
        "action": require_text(value.get("action"), "action", max_length=1000),
    }


def require_text(value: Any, name: str, max_length: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BusinessToolError("INVALID_ARGUMENT", f"{name} must be a non-empty string.")
    normalized = value.strip()
    if len(normalized) > max_length:
        raise BusinessToolError(
            "INVALID_ARGUMENT",
            f"{name} must not exceed {max_length} characters.",
        )
    return normalized


def optional_text(value: Any, name: str, max_length: int) -> str:
    if value is None or value == "":
        return ""
    return require_text(value, name, max_length)


def parse_date(value: Any, name: str) -> date:
    text = require_text(value, name, max_length=32)
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise BusinessToolError(
            "INVALID_DATE",
            f"{name} must use YYYY-MM-DD format.",
        ) from exc


def sorted_counts(values: Iterable[str]) -> dict[str, int]:
    counts = Counter(values)
    return {key: counts[key] for key in sorted(counts)}


def stable_digest(values: Mapping[str, str]) -> str:
    canonical = "\n".join(f"{key}={values[key]}" for key in sorted(values))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def ensure_unique_request_ids(rows: list[dict[str, str]]) -> None:
    request_ids = [row["request_id"] for row in rows]
    if len(request_ids) != len(set(request_ids)):
        raise RuntimeError("Synthetic request IDs must be unique.")


def parse_rules_markdown(content: str) -> list[dict[str, str]]:
    lines = content.splitlines()
    rule_texts = [line[2:].strip() for line in lines if line.startswith("- ")]
    return [
        {"rule_id": f"RULE-{index:03d}", "text": text}
        for index, text in enumerate(rule_texts, start=1)
    ]
