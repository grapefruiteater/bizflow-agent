from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from lambdas.business_tools import lambda_function
from lambdas.business_tools.service import (
    BusinessToolError,
    BusinessToolsService,
    MockWorkflowStore,
)


FIXED_NOW = datetime(2026, 7, 13, 10, 0, tzinfo=timezone.utc)


def gateway_context(tool_name: str) -> SimpleNamespace:
    return SimpleNamespace(
        client_context=SimpleNamespace(
            custom={
                "bedrockAgentCoreToolName": f"BizFlowMockTarget___{tool_name}",
                "bedrockAgentCoreMessageVersion": "1.0",
            }
        )
    )


@pytest.fixture()
def service(monkeypatch) -> BusinessToolsService:
    workflow = MockWorkflowStore(now_factory=lambda: FIXED_NOW)
    instance = BusinessToolsService(workflow_store=workflow)
    monkeypatch.setattr(lambda_function, "SERVICE", instance)
    monkeypatch.setenv(
        "BIZFLOW_ALLOWED_TOOLS",
        (
            "get_business_requests,analyze_request_data,search_company_rules,"
            "create_business_task,get_task_status"
        ),
    )
    monkeypatch.setenv("BIZFLOW_ALLOW_GATEWAY_CONTEXT", "true")
    return instance


def invoke(tool_name: str, arguments: dict) -> dict:
    return lambda_function.lambda_handler(arguments, gateway_context(tool_name))


def invoke_from_bff(tool_name: str, arguments: dict) -> dict:
    return lambda_function.lambda_handler(
        {
            "source": "bizflow-web-bff",
            "operation": tool_name,
            "arguments": arguments,
        },
        SimpleNamespace(),
    )


def test_tool_schema_defines_the_five_portfolio_tools() -> None:
    schema_path = (
        Path(__file__).parents[2]
        / "lambdas"
        / "business_tools"
        / "tool-schema.json"
    )
    definitions = json.loads(schema_path.read_text(encoding="utf-8"))

    assert [definition["name"] for definition in definitions] == [
        "get_business_requests",
        "analyze_request_data",
        "search_company_rules",
        "create_business_task",
        "get_task_status",
    ]
    assert all(
        definition["inputSchema"]["type"] == "object"
        for definition in definitions
    )


def test_get_and_analyze_synthetic_requests(service: BusinessToolsService) -> None:
    fetched = invoke(
        "get_business_requests",
        {"start_date": "2026-07-10", "end_date": "2026-07-13"},
    )

    assert fetched["ok"] is True
    assert fetched["data"]["source"] == "synthetic_csv"
    assert fetched["data"]["count"] == 7

    analysis = invoke(
        "analyze_request_data",
        {"as_of": "2026-07-13", "requests": fetched["data"]["requests"]},
    )

    assert analysis["ok"] is True
    assert analysis["data"]["total_count"] == 7
    assert analysis["data"]["active_count"] == 6
    assert analysis["data"]["overdue_request_ids"] == ["REQ-002"]
    assert analysis["data"]["urgent_open_request_ids"] == [
        "REQ-002",
        "REQ-003",
        "REQ-005",
        "REQ-008",
    ]


def test_search_company_rules_returns_relevant_evidence(
    service: BusinessToolsService,
) -> None:
    result = invoke(
        "search_company_rules",
        {"query": "期限超過案件をエスカレーション", "category": "障害"},
    )

    assert result["ok"] is True
    assert [rule["rule_id"] for rule in result["data"]["rules"]] == [
        "RULE-001",
        "RULE-002",
    ]


def test_create_task_rejects_unapproved_proposal(
    service: BusinessToolsService,
) -> None:
    proposal = {
        "request_id": "REQ-002",
        "assignee": "support-lead",
        "due_date": "2026-07-13",
        "action": "障害状況を確認して顧客へ一次回答する",
    }
    approval = service.workflow_store.request_approval(
        proposal,
        requested_by="portfolio-user",
    )

    result = invoke_from_bff(
        "create_business_task",
        {"approval_id": approval["approval_id"], **proposal},
    )

    assert result == {
        "ok": False,
        "error": {
            "code": "APPROVAL_REQUIRED",
            "message": "The task proposal has not been approved.",
        },
    }
    assert service.workflow_store.get_history(approval["approval_id"])[-1][
        "detail_code"
    ] == "APPROVAL_REQUIRED"


def test_create_task_rejects_changes_after_approval(
    service: BusinessToolsService,
) -> None:
    proposal = {
        "request_id": "REQ-002",
        "assignee": "support-lead",
        "due_date": "2026-07-13",
        "action": "障害状況を確認して顧客へ一次回答する",
    }
    approval = service.workflow_store.request_approval(
        proposal,
        requested_by="portfolio-user",
    )
    service.workflow_store.approve(approval["approval_id"], "team-manager")

    result = invoke_from_bff(
        "create_business_task",
        {
            "approval_id": approval["approval_id"],
            **proposal,
            "assignee": "different-user",
        },
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "APPROVAL_MISMATCH"


def test_approved_task_is_idempotent_and_status_is_available(
    service: BusinessToolsService,
) -> None:
    proposal = {
        "request_id": "REQ-002",
        "assignee": "support-lead",
        "due_date": "2026-07-13",
        "action": "障害状況を確認して顧客へ一次回答する",
    }
    approval = service.workflow_store.request_approval(
        proposal,
        requested_by="portfolio-user",
    )
    service.workflow_store.approve(approval["approval_id"], "team-manager")
    arguments = {"approval_id": approval["approval_id"], **proposal}

    created = invoke_from_bff("create_business_task", arguments)
    repeated = invoke_from_bff("create_business_task", arguments)

    assert created["ok"] is True
    assert created["data"]["created"] is True
    assert repeated["data"]["created"] is False
    assert repeated["data"]["task"]["task_id"] == created["data"]["task"]["task_id"]

    status = invoke(
        "get_task_status",
        {"task_id": created["data"]["task"]["task_id"]},
    )
    assert status["ok"] is True
    assert status["data"]["task"]["status"] == "REGISTERED"
    assert status["data"]["task"]["approved_by"] == "team-manager"
    assert [event["event_type"] for event in status["data"]["history"]] == [
        "APPROVAL_REQUESTED",
        "APPROVAL_APPROVED",
        "TASK_REGISTERED",
    ]
    assert status["data"]["history"][-1]["actor"] == "bizflow-agent"


def test_lambda_returns_safe_error_for_missing_gateway_context(
    service: BusinessToolsService,
) -> None:
    result = lambda_function.lambda_handler({}, SimpleNamespace())

    assert result["ok"] is False
    assert result["error"]["code"] == "INVALID_CONTEXT"


def test_trusted_bff_envelope_uses_the_same_read_tool_contract(
    service: BusinessToolsService,
) -> None:
    result = invoke_from_bff(
        "get_business_requests",
        {"start_date": "2026-07-10", "end_date": "2026-07-13"},
    )

    assert result["ok"] is True
    assert result["tool"] == "get_business_requests"
    assert result["data"]["count"] == 7


def test_direct_invocation_without_the_bff_source_is_rejected(
    service: BusinessToolsService,
) -> None:
    result = lambda_function.lambda_handler(
        {
            "operation": "get_business_requests",
            "arguments": {"start_date": "2026-07-10", "end_date": "2026-07-13"},
        },
        SimpleNamespace(),
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "INVALID_CONTEXT"


def test_lambda_enforces_the_configured_read_write_tool_boundary(
    service: BusinessToolsService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "BIZFLOW_ALLOWED_TOOLS",
        "get_business_requests,analyze_request_data,search_company_rules,get_task_status",
    )

    result = invoke(
        "create_business_task",
        {
            "approval_id": "APR-NOT-REACHABLE",
            "request_id": "REQ-002",
            "assignee": "support-lead",
            "due_date": "2026-07-13",
            "action": "一次回答する",
        },
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "TOOL_NOT_ALLOWED"


def test_write_lambda_rejects_gateway_context_even_for_an_allowed_tool(
    service: BusinessToolsService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BIZFLOW_ALLOWED_TOOLS", "create_business_task")
    monkeypatch.setenv("BIZFLOW_ALLOW_GATEWAY_CONTEXT", "false")

    result = invoke(
        "create_business_task",
        {
            "approval_id": "APR-NOT-REACHABLE",
            "request_id": "REQ-002",
            "assignee": "support-lead",
            "due_date": "2026-07-13",
            "action": "一次回答する",
        },
    )

    assert result == {
        "ok": False,
        "error": {
            "code": "GATEWAY_WRITE_DISABLED",
            "message": (
                "Write operations are available only through the trusted "
                "BizFlow Web BFF."
            ),
        },
    }


def test_missing_allowed_tools_configuration_fails_closed(
    service: BusinessToolsService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BIZFLOW_ALLOWED_TOOLS")

    result = invoke(
        "get_business_requests",
        {"start_date": "2026-07-10", "end_date": "2026-07-13"},
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "TOOL_NOT_ALLOWED"


def test_invalid_date_range_is_rejected(service: BusinessToolsService) -> None:
    result = invoke(
        "get_business_requests",
        {"start_date": "2026-07-14", "end_date": "2026-07-13"},
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "INVALID_DATE_RANGE"


def test_workflow_store_rejects_unknown_approval() -> None:
    store = MockWorkflowStore(now_factory=lambda: FIXED_NOW)

    with pytest.raises(BusinessToolError, match="was not found"):
        store.approve("APR-NOT-FOUND", "team-manager")
