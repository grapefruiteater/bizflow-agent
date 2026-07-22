from __future__ import annotations

import io
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from lambdas.business_tools.aws_adapters import (
    DynamoWorkflowStore,
    S3BusinessDataRepository,
    build_service_from_environment,
)
from lambdas.business_tools.service import (
    BusinessToolError,
    LocalFileDataRepository,
    MockWorkflowStore,
)


FIXED_NOW = datetime(2026, 7, 13, 10, 0, tzinfo=timezone.utc)
DATA_DIRECTORY = (
    Path(__file__).parents[2] / "lambdas" / "business_tools" / "data"
)


class ConditionalCheckFailed(Exception):
    def __init__(self) -> None:
        super().__init__("conditional check failed")
        self.response = {
            "Error": {"Code": "ConditionalCheckFailedException"},
        }


class FakeS3Client:
    def __init__(self, objects: dict[tuple[str, str], bytes]) -> None:
        self.objects = objects

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}


class FakeDynamoTable:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict[str, Any]] = {}

    def put_item(
        self,
        *,
        Item: dict[str, Any],
        ConditionExpression: str,
    ) -> dict[str, Any]:
        del ConditionExpression
        key = (Item["pk"], Item["sk"])
        if key in self.items:
            raise ConditionalCheckFailed()
        self.items[key] = dict(Item)
        return {}

    def get_item(
        self,
        *,
        Key: dict[str, str],
        ConsistentRead: bool,
    ) -> dict[str, Any]:
        assert ConsistentRead is True
        item = self.items.get((Key["pk"], Key["sk"]))
        return {} if item is None else {"Item": dict(item)}

    def update_item(
        self,
        *,
        Key: dict[str, str],
        UpdateExpression: str,
        ConditionExpression: str,
        ExpressionAttributeNames: dict[str, str],
        ExpressionAttributeValues: dict[str, str],
        ReturnValues: str,
    ) -> dict[str, Any]:
        del UpdateExpression, ConditionExpression, ExpressionAttributeNames
        assert ReturnValues == "ALL_NEW"
        key = (Key["pk"], Key["sk"])
        item = self.items.get(key)
        if item is None or item["status"] != ExpressionAttributeValues[":pending"]:
            raise ConditionalCheckFailed()
        item.update(
            {
                "status": ExpressionAttributeValues[":decision"],
                "approved_by": ExpressionAttributeValues[":actor"],
                "decided_at": ExpressionAttributeValues[":now"],
            }
        )
        return {"Attributes": dict(item)}

    def query(
        self,
        *,
        KeyConditionExpression: str,
        ExpressionAttributeValues: dict[str, str],
        ConsistentRead: bool,
    ) -> dict[str, Any]:
        assert KeyConditionExpression == "pk = :pk AND begins_with(sk, :prefix)"
        assert ConsistentRead is True
        partition_key = ExpressionAttributeValues[":pk"]
        prefix = ExpressionAttributeValues[":prefix"]
        items = [
            dict(item)
            for (pk, sk), item in sorted(self.items.items())
            if pk == partition_key and sk.startswith(prefix)
        ]
        return {"Items": items}


def proposal() -> dict[str, str]:
    return {
        "request_id": "REQ-002",
        "assignee": "support-lead",
        "due_date": "2026-07-13",
        "action": "障害状況を確認して顧客へ一次回答する",
    }


def test_s3_repository_loads_the_same_synthetic_contract() -> None:
    bucket = "bizflow-data-test"
    request_key = "portfolio-data/business_requests.csv"
    rules_key = "portfolio-data/company_rules.md"
    client = FakeS3Client(
        {
            (bucket, request_key): (DATA_DIRECTORY / "business_requests.csv").read_bytes(),
            (bucket, rules_key): (DATA_DIRECTORY / "company_rules.md").read_bytes(),
        }
    )
    repository = S3BusinessDataRepository(client, bucket, request_key, rules_key)

    requests = repository.load_requests()
    rules = repository.load_rules()

    assert len(requests) == 8
    assert requests[1]["request_id"] == "REQ-002"
    assert requests[1]["urgency"] == "high"
    assert [rule["rule_id"] for rule in rules] == [
        "RULE-001",
        "RULE-002",
        "RULE-003",
        "RULE-004",
        "RULE-005",
    ]


def test_dynamo_store_enforces_approval_exact_match_and_idempotency() -> None:
    table = FakeDynamoTable()
    event_numbers = iter(range(1, 20))
    store = DynamoWorkflowStore(
        table,
        now_factory=lambda: FIXED_NOW,
        event_id_factory=lambda: f"EVT-{next(event_numbers):06d}",
    )
    task_proposal = proposal()
    approval = store.request_approval(task_proposal, "portfolio-user")

    with pytest.raises(BusinessToolError) as pending_error:
        store.create_task(approval["approval_id"], task_proposal)
    assert pending_error.value.code == "APPROVAL_REQUIRED"

    approved = store.approve(approval["approval_id"], "team-manager")
    assert approved["status"] == "APPROVED"
    assert approved["approved_by"] == "team-manager"
    assert store.get_approval(approval["approval_id"]) == approved

    with pytest.raises(BusinessToolError) as mismatch_error:
        store.create_task(
            approval["approval_id"],
            {**task_proposal, "assignee": "different-user"},
        )
    assert mismatch_error.value.code == "APPROVAL_MISMATCH"

    created, was_created = store.create_task(approval["approval_id"], task_proposal)
    repeated, was_created_again = store.create_task(
        approval["approval_id"],
        task_proposal,
    )

    assert was_created is True
    assert was_created_again is False
    assert repeated["task_id"] == created["task_id"]
    assert store.get_task(created["task_id"])["approved_by"] == "team-manager"
    assert [event["event_type"] for event in store.get_history(approval["approval_id"])] == [
        "APPROVAL_REQUESTED",
        "TASK_REGISTRATION_REJECTED",
        "APPROVAL_APPROVED",
        "TASK_REGISTRATION_REJECTED",
        "TASK_REGISTERED",
    ]


def test_dynamo_store_reuses_the_same_approval_request() -> None:
    table = FakeDynamoTable()
    event_numbers = iter(range(1, 10))
    store = DynamoWorkflowStore(
        table,
        now_factory=lambda: FIXED_NOW,
        event_id_factory=lambda: f"EVT-{next(event_numbers):06d}",
    )

    first = store.request_approval(proposal(), "portfolio-user")
    repeated = store.request_approval(proposal(), "portfolio-user")

    assert repeated == first
    assert len(store.get_history(first["approval_id"])) == 1


def test_empty_environment_keeps_local_adapters_without_importing_aws_clients() -> None:
    service = build_service_from_environment({})

    assert isinstance(service.data_repository, LocalFileDataRepository)
    assert isinstance(service.workflow_store, MockWorkflowStore)
