"""Run the portfolio business-tool scenario without connecting to AWS."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from lambdas.business_tools import lambda_function  # noqa: E402
from lambdas.business_tools.service import (  # noqa: E402
    BusinessToolsService,
    MockWorkflowStore,
)


def gateway_context(tool_name: str) -> SimpleNamespace:
    return SimpleNamespace(
        client_context=SimpleNamespace(
            custom={
                "bedrockAgentCoreToolName": f"BizFlowMockTarget___{tool_name}",
                "bedrockAgentCoreMessageVersion": "1.0",
            }
        )
    )


def invoke(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return lambda_function.lambda_handler(arguments, gateway_context(tool_name))


def show(title: str, value: Any) -> None:
    print(f"\n[{title}]")
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main() -> None:
    workflow = MockWorkflowStore(
        now_factory=lambda: datetime(2026, 7, 13, 10, 0, tzinfo=timezone.utc)
    )
    lambda_function.SERVICE = BusinessToolsService(workflow_store=workflow)

    fetched = invoke(
        "get_business_requests",
        {"start_date": "2026-07-10", "end_date": "2026-07-13"},
    )
    show("1. 問い合わせ取得", fetched)

    analysis = invoke(
        "analyze_request_data",
        {
            "as_of": "2026-07-13",
            "requests": fetched["data"]["requests"],
        },
    )
    show("2. CSV集計", analysis)

    rules = invoke(
        "search_company_rules",
        {"query": "障害と期限超過案件の対応", "category": "障害"},
    )
    show("3. 社内ルール検索", rules)

    proposal = {
        "request_id": "REQ-002",
        "assignee": "support-lead",
        "due_date": "2026-07-13",
        "action": "障害状況を確認し、2時間以内に顧客へ一次回答する",
    }
    approval = workflow.request_approval(proposal, requested_by="portfolio-user")
    show("4. 承認カード（PENDING）", approval)

    rejected = invoke(
        "create_business_task",
        {"approval_id": approval["approval_id"], **proposal},
    )
    show("5. 未承認での登録拒否", rejected)

    approved = workflow.approve(approval["approval_id"], "team-manager")
    show("6. 利用者による承認", approved)

    created = invoke(
        "create_business_task",
        {"approval_id": approval["approval_id"], **proposal},
    )
    show("7. 承認後のタスク登録", created)

    status = invoke(
        "get_task_status",
        {"task_id": created["data"]["task"]["task_id"]},
    )
    show("8. タスク状態確認", status)


if __name__ == "__main__":
    main()
