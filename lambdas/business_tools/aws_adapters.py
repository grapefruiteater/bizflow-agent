"""AWS-backed adapters selected only inside the deployed Lambda environment."""

from __future__ import annotations

import csv
import io
import os
import uuid
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from typing import Any

from .service import (
    BusinessDataRepository,
    BusinessToolError,
    BusinessToolsService,
    LocalFileDataRepository,
    MockWorkflowStore,
    WorkflowStore,
    ensure_unique_request_ids,
    normalize_request,
    normalize_task_proposal,
    parse_rules_markdown,
    require_text,
    stable_digest,
)


DATA_BUCKET_ENV = "BIZFLOW_DATA_BUCKET"
REQUESTS_KEY_ENV = "BIZFLOW_REQUESTS_KEY"
RULES_KEY_ENV = "BIZFLOW_RULES_KEY"
WORKFLOW_TABLE_ENV = "BIZFLOW_WORKFLOW_TABLE"


class S3BusinessDataRepository:
    """Read synthetic CSV and Markdown objects from an injected S3 client."""

    def __init__(
        self,
        client: Any,
        bucket_name: str,
        requests_key: str,
        rules_key: str,
    ) -> None:
        self.client = client
        self.bucket_name = require_text(bucket_name, "bucket_name", 255)
        self.requests_key = require_text(requests_key, "requests_key", 1024)
        self.rules_key = require_text(rules_key, "rules_key", 1024)

    def load_requests(self) -> list[dict[str, str]]:
        content = self._read_text(self.requests_key)
        rows = [
            normalize_request(row)
            for row in csv.DictReader(io.StringIO(content, newline=""))
        ]
        ensure_unique_request_ids(rows)
        return rows

    def load_rules(self) -> list[dict[str, str]]:
        return parse_rules_markdown(self._read_text(self.rules_key))

    def _read_text(self, key: str) -> str:
        response = self.client.get_object(Bucket=self.bucket_name, Key=key)
        body = response.get("Body")
        if body is None or not hasattr(body, "read"):
            raise RuntimeError("S3 get_object did not return a readable Body.")
        raw = body.read()
        if not isinstance(raw, bytes):
            raise RuntimeError("S3 object body must be bytes.")
        return raw.decode("utf-8-sig")


class DynamoWorkflowStore:
    """Persist approvals, tasks, and audit events in one DynamoDB table."""

    def __init__(
        self,
        table: Any,
        now_factory: Callable[[], datetime] | None = None,
        event_id_factory: Callable[[], str] | None = None,
    ) -> None:
        self.table = table
        self._now_factory = now_factory or (lambda: datetime.now(timezone.utc))
        self._event_id_factory = event_id_factory or (
            lambda: "EVT-" + uuid.uuid4().hex.upper()
        )

    def request_approval(
        self,
        proposal: Mapping[str, str],
        requested_by: str,
    ) -> dict[str, Any]:
        normalized = normalize_task_proposal(proposal)
        actor = require_text(requested_by, "requested_by", 128)
        digest = stable_digest({**normalized, "requested_by": actor})
        approval_id = f"APR-{digest[:12].upper()}"
        now = self._now_factory().isoformat()
        approval = {
            "approval_id": approval_id,
            "status": "PENDING",
            "requested_by": actor,
            "approved_by": None,
            "proposal": normalized,
            "proposal_hash": stable_digest(normalized),
            "created_at": now,
            "decided_at": None,
        }
        try:
            self.table.put_item(
                Item={
                    "pk": approval_partition_key(approval_id),
                    "sk": "APPROVAL",
                    "entity_type": "APPROVAL",
                    **approval,
                },
                ConditionExpression="attribute_not_exists(pk)",
            )
            self._record_event("APPROVAL_REQUESTED", actor, approval_id)
            return self._public_approval(approval)
        except Exception as exc:
            if not is_conditional_check_failure(exc):
                raise
            return self._public_approval(self._get_approval_item(approval_id))

    def approve(self, approval_id: str, approved_by: str) -> dict[str, Any]:
        return self._decide(approval_id, approved_by, "APPROVED")

    def reject(self, approval_id: str, rejected_by: str) -> dict[str, Any]:
        return self._decide(approval_id, rejected_by, "REJECTED")

    def get_approval(self, approval_id: str) -> dict[str, Any]:
        normalized_id = require_text(approval_id, "approval_id", 64)
        return self._public_approval(self._get_approval_item(normalized_id))

    def create_task(
        self,
        approval_id: str,
        proposal: Mapping[str, str],
    ) -> tuple[dict[str, Any], bool]:
        normalized_id = require_text(approval_id, "approval_id", 64)
        approval = self._get_approval_item(normalized_id)
        if approval["status"] != "APPROVED":
            self._record_event(
                "TASK_REGISTRATION_REJECTED",
                "bizflow-agent",
                normalized_id,
                detail_code="APPROVAL_REQUIRED",
            )
            raise BusinessToolError(
                "APPROVAL_REQUIRED",
                "The task proposal has not been approved.",
            )

        normalized = normalize_task_proposal(proposal)
        if stable_digest(normalized) != approval.get("proposal_hash"):
            self._record_event(
                "TASK_REGISTRATION_REJECTED",
                "bizflow-agent",
                normalized_id,
                detail_code="APPROVAL_MISMATCH",
            )
            raise BusinessToolError(
                "APPROVAL_MISMATCH",
                "The task does not exactly match the approved proposal.",
            )

        task_id = f"TASK-{stable_digest({'approval_id': normalized_id, **normalized})[:12].upper()}"
        task = {
            "task_id": task_id,
            "status": "REGISTERED",
            "approval_id": normalized_id,
            "approved_by": approval["approved_by"],
            **normalized,
            "created_at": self._now_factory().isoformat(),
        }
        try:
            self.table.put_item(
                Item={
                    "pk": task_partition_key(task_id),
                    "sk": "TASK",
                    "entity_type": "TASK",
                    **task,
                },
                ConditionExpression="attribute_not_exists(pk)",
            )
        except Exception as exc:
            if not is_conditional_check_failure(exc):
                raise
            return self.get_task(task_id), False

        self._record_event(
            "TASK_REGISTERED",
            "bizflow-agent",
            normalized_id,
            task_id=task_id,
        )
        return task, True

    def get_task(self, task_id: str) -> dict[str, Any]:
        normalized = require_text(task_id, "task_id", 64)
        response = self.table.get_item(
            Key={"pk": task_partition_key(normalized), "sk": "TASK"},
            ConsistentRead=True,
        )
        item = response.get("Item")
        if not isinstance(item, Mapping):
            raise BusinessToolError("TASK_NOT_FOUND", f"Task {normalized} was not found.")
        return strip_storage_fields(item)

    def get_history(self, approval_id: str) -> list[dict[str, Any]]:
        normalized = require_text(approval_id, "approval_id", 64)
        response = self.table.query(
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={
                ":pk": approval_partition_key(normalized),
                ":prefix": "EVENT#",
            },
            ConsistentRead=True,
        )
        items = response.get("Items", [])
        if not isinstance(items, list):
            raise RuntimeError("DynamoDB query returned an invalid Items value.")
        return [strip_storage_fields(item) for item in items]

    def _decide(
        self,
        approval_id: str,
        decided_by: str,
        decision: str,
    ) -> dict[str, Any]:
        normalized_id = require_text(approval_id, "approval_id", 64)
        actor = require_text(decided_by, "decided_by", 128)
        now = self._now_factory().isoformat()
        try:
            response = self.table.update_item(
                Key={"pk": approval_partition_key(normalized_id), "sk": "APPROVAL"},
                UpdateExpression=(
                    "SET #status = :decision, approved_by = :actor, decided_at = :now"
                ),
                ConditionExpression="attribute_exists(pk) AND #status = :pending",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={
                    ":decision": decision,
                    ":actor": actor,
                    ":now": now,
                    ":pending": "PENDING",
                },
                ReturnValues="ALL_NEW",
            )
        except Exception as exc:
            if not is_conditional_check_failure(exc):
                raise
            current = self._get_approval_item(normalized_id)
            raise BusinessToolError(
                "APPROVAL_ALREADY_DECIDED",
                f"Approval {normalized_id} has already been decided as {current['status']}.",
            ) from exc

        attributes = response.get("Attributes")
        if not isinstance(attributes, Mapping):
            raise RuntimeError("DynamoDB update_item did not return approval attributes.")
        self._record_event(
            f"APPROVAL_{decision}",
            actor,
            normalized_id,
        )
        return self._public_approval(attributes)

    def _get_approval_item(self, approval_id: str) -> Mapping[str, Any]:
        response = self.table.get_item(
            Key={"pk": approval_partition_key(approval_id), "sk": "APPROVAL"},
            ConsistentRead=True,
        )
        item = response.get("Item")
        if not isinstance(item, Mapping):
            raise BusinessToolError(
                "APPROVAL_NOT_FOUND",
                f"Approval {approval_id} was not found.",
            )
        return item

    def _record_event(
        self,
        event_type: str,
        actor: str,
        approval_id: str,
        task_id: str | None = None,
        detail_code: str | None = None,
    ) -> None:
        now = self._now_factory().isoformat()
        event_id = self._event_id_factory()
        self.table.put_item(
            Item={
                "pk": approval_partition_key(approval_id),
                "sk": f"EVENT#{now}#{event_id}",
                "entity_type": "AUDIT_EVENT",
                "event_id": event_id,
                "event_type": event_type,
                "actor": actor,
                "approval_id": approval_id,
                "task_id": task_id,
                "detail_code": detail_code,
                "recorded_at": now,
            },
            ConditionExpression="attribute_not_exists(pk) AND attribute_not_exists(sk)",
        )

    @staticmethod
    def _public_approval(item: Mapping[str, Any]) -> dict[str, Any]:
        result = strip_storage_fields(item)
        result.pop("proposal_hash", None)
        return result


def build_service_from_environment(
    environment: Mapping[str, str] | None = None,
) -> BusinessToolsService:
    values = os.environ if environment is None else environment
    data_repository: BusinessDataRepository = LocalFileDataRepository()
    workflow_store: WorkflowStore = MockWorkflowStore()

    bucket_name = values.get(DATA_BUCKET_ENV, "").strip()
    table_name = values.get(WORKFLOW_TABLE_ENV, "").strip()
    if bucket_name or table_name:
        import boto3

        if bucket_name:
            data_repository = S3BusinessDataRepository(
                client=boto3.client("s3"),
                bucket_name=bucket_name,
                requests_key=values.get(
                    REQUESTS_KEY_ENV,
                    "portfolio-data/business_requests.csv",
                ),
                rules_key=values.get(
                    RULES_KEY_ENV,
                    "portfolio-data/company_rules.md",
                ),
            )
        if table_name:
            table = boto3.resource("dynamodb").Table(table_name)
            workflow_store = DynamoWorkflowStore(table)

    return BusinessToolsService(
        data_repository=data_repository,
        workflow_store=workflow_store,
    )


def approval_partition_key(approval_id: str) -> str:
    return f"APPROVAL#{approval_id}"


def task_partition_key(task_id: str) -> str:
    return f"TASK#{task_id}"


def strip_storage_fields(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in item.items()
        if key not in {"pk", "sk", "entity_type"}
    }


def is_conditional_check_failure(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    if not isinstance(response, Mapping):
        return False
    error = response.get("Error")
    return isinstance(error, Mapping) and error.get("Code") in {
        "ConditionalCheckFailedException",
        "TransactionCanceledException",
    }
