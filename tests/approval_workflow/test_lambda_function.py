from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from lambdas.approval_workflow import lambda_function
from lambdas.business_tools.service import BusinessToolsService, MockWorkflowStore


FIXED_NOW = datetime(2026, 7, 13, 10, 0, tzinfo=timezone.utc)


def proposal() -> dict[str, str]:
    return {
        "request_id": "REQ-002",
        "assignee": "support-lead",
        "due_date": "2026-07-13",
        "action": "障害状況を確認して顧客へ一次回答する",
    }


@pytest.fixture
def service(monkeypatch: pytest.MonkeyPatch) -> BusinessToolsService:
    configured = BusinessToolsService(
        workflow_store=MockWorkflowStore(now_factory=lambda: FIXED_NOW),
    )
    monkeypatch.setattr(lambda_function, "SERVICE", configured)
    return configured


def invoke(event: Any) -> dict[str, Any]:
    return lambda_function.lambda_handler(event, object())


def test_request_and_get_approval(service: BusinessToolsService) -> None:
    requested = invoke(
        {
            "operation": "request_approval",
            "actor": "portfolio-user",
            "proposal": proposal(),
        }
    )

    assert requested["ok"] is True
    approval = requested["data"]["approval"]
    assert approval["status"] == "PENDING"
    assert approval["requested_by"] == "portfolio-user"
    assert requested["data"]["history"][0]["event_type"] == "APPROVAL_REQUESTED"

    status = invoke(
        {
            "operation": "get_approval",
            "actor": "portfolio-user",
            "approval_id": approval["approval_id"],
        }
    )

    assert status["ok"] is True
    assert status["data"] == requested["data"]


def test_approve_records_the_trusted_actor(service: BusinessToolsService) -> None:
    requested = invoke(
        {
            "operation": "request_approval",
            "actor": "portfolio-user",
            "proposal": proposal(),
        }
    )
    approval_id = requested["data"]["approval"]["approval_id"]

    approved = invoke(
        {
            "operation": "approve",
            "actor": "team-manager",
            "approval_id": approval_id,
        }
    )

    assert approved["ok"] is True
    assert approved["data"]["approval"]["status"] == "APPROVED"
    assert approved["data"]["approval"]["approved_by"] == "team-manager"
    assert [event["event_type"] for event in approved["data"]["history"]] == [
        "APPROVAL_REQUESTED",
        "APPROVAL_APPROVED",
    ]


def test_reject_prevents_a_later_approval(service: BusinessToolsService) -> None:
    requested = invoke(
        {
            "operation": "request_approval",
            "actor": "portfolio-user",
            "proposal": proposal(),
        }
    )
    approval_id = requested["data"]["approval"]["approval_id"]

    rejected = invoke(
        {
            "operation": "reject",
            "actor": "team-manager",
            "approval_id": approval_id,
        }
    )
    repeated = invoke(
        {
            "operation": "approve",
            "actor": "another-manager",
            "approval_id": approval_id,
        }
    )

    assert rejected["data"]["approval"]["status"] == "REJECTED"
    assert repeated["ok"] is False
    assert repeated["error"]["code"] == "APPROVAL_ALREADY_DECIDED"


@pytest.mark.parametrize(
    ("event", "expected_code"),
    [
        ([], "INVALID_EVENT"),
        ({"actor": "user"}, "INVALID_ARGUMENT"),
        ({"operation": "approve", "actor": ""}, "INVALID_ARGUMENT"),
        (
            {"operation": "unknown", "actor": "user"},
            "UNKNOWN_APPROVAL_OPERATION",
        ),
        (
            {
                "operation": "request_approval",
                "actor": "user",
                "proposal": "not-an-object",
            },
            "INVALID_PROPOSAL",
        ),
    ],
)
def test_invalid_commands_return_safe_errors(
    service: BusinessToolsService,
    event: Any,
    expected_code: str,
) -> None:
    result = invoke(event)

    assert result["ok"] is False
    assert result["error"]["code"] == expected_code


def test_unknown_approval_is_not_disclosed_as_an_internal_error(
    service: BusinessToolsService,
) -> None:
    result = invoke(
        {
            "operation": "get_approval",
            "actor": "portfolio-user",
            "approval_id": "APR-NOT-FOUND",
        }
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "APPROVAL_NOT_FOUND"
