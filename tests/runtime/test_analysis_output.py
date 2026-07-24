from __future__ import annotations

import pytest
from pydantic import ValidationError

from agents.bizflow.analysis_output import AgentAnalysis, ProposedAction


def proposal(request_id: str = "REQ-002") -> ProposedAction:
    return ProposedAction(
        request_id=request_id,
        assignee="support-lead",
        due_date="2026-07-14",
        action="顧客へ一次回答する",
        rationale="期限超過かつ緊急度highのため",
        rule_ids=["RULE-001", "RULE-002"],
    )


def test_structured_analysis_serializes_web_contract() -> None:
    analysis = AgentAnalysis(
        response="REQ-002を最優先で対応してください。",
        proposed_actions=[proposal()],
    )

    assert analysis.model_dump(mode="json") == {
        "response": "REQ-002を最優先で対応してください。",
        "proposed_actions": [
            {
                "request_id": "REQ-002",
                "assignee": "support-lead",
                "due_date": "2026-07-14",
                "action": "顧客へ一次回答する",
                "rationale": "期限超過かつ緊急度highのため",
                "rule_ids": ["RULE-001", "RULE-002"],
            }
        ],
    }


def test_structured_analysis_rejects_duplicate_request_ids() -> None:
    with pytest.raises(ValidationError, match="must not repeat"):
        AgentAnalysis(
            response="重複した提案",
            proposed_actions=[proposal(), proposal()],
        )


def test_proposed_action_accepts_normalized_business_data_id() -> None:
    assert proposal("INQ:APAC.001").request_id == "INQ:APAC.001"


def test_proposed_action_rejects_unknown_fields_and_invalid_rules() -> None:
    with pytest.raises(ValidationError):
        ProposedAction.model_validate(
            {
                **proposal().model_dump(mode="json"),
                "rule_ids": ["internal-rule"],
                "approved": True,
            }
        )
