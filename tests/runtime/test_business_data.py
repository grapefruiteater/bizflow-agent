from __future__ import annotations

import pytest
from pydantic import ValidationError

from agents.bizflow.business_data import prepare_business_analysis


def make_business_data() -> dict:
    return {
        "as_of": "2026-07-21T10:00:00+09:00",
        "inquiries": [
            {
                "inquiry_id": "INQ-001",
                "summary": "納期を超過している問い合わせ",
                "received_at": "2026-07-19T09:00:00+09:00",
                "due_at": "2026-07-21T09:00:00+09:00",
                "priority": "URGENT",
                "status": "OPEN",
            },
            {
                "inquiry_id": "INQ-002",
                "summary": "24時間以内に期限を迎える問い合わせ",
                "received_at": "2026-07-20T09:00:00+09:00",
                "due_at": "2026-07-22T09:00:00+09:00",
                "priority": "HIGH",
                "status": "IN_PROGRESS",
            },
            {
                "inquiry_id": "INQ-003",
                "summary": "完了済みの問い合わせ",
                "received_at": "2026-07-18T09:00:00+09:00",
                "due_at": "2026-07-19T09:00:00+09:00",
                "priority": "URGENT",
                "status": "CLOSED",
            },
        ],
        "rules": ["期限超過を最優先にする"],
    }


def test_prepares_deterministic_inquiry_flags() -> None:
    prepared = prepare_business_analysis(
        "問い合わせを優先順位順に分析してください。",
        make_business_data(),
    )

    assert prepared.response_context == {
        "as_of": "2026-07-21T10:00:00+09:00",
        "total_inquiries": 3,
        "active_inquiries": 2,
        "overdue_inquiry_ids": ["INQ-001"],
        "urgent_inquiry_ids": ["INQ-001"],
        "due_within_24_hours_inquiry_ids": ["INQ-002"],
    }
    assert "INQ-001" in prepared.model_prompt
    assert '"overdue":true' in prepared.model_prompt
    assert '"due_within_24_hours":true' in prepared.model_prompt
    assert "期限超過を最優先にする" in prepared.model_prompt


def test_rejects_timezone_naive_snapshot() -> None:
    data = make_business_data()
    data["as_of"] = "2026-07-21T10:00:00"

    with pytest.raises(ValidationError, match="UTC offset"):
        prepare_business_analysis("分析してください。", data)


def test_rejects_duplicate_inquiry_ids() -> None:
    data = make_business_data()
    data["inquiries"][1]["inquiry_id"] = "INQ-001"

    with pytest.raises(ValidationError, match="must be unique"):
        prepare_business_analysis("分析してください。", data)


def test_rejects_due_at_before_received_at() -> None:
    data = make_business_data()
    data["inquiries"][0]["due_at"] = "2026-07-18T09:00:00+09:00"

    with pytest.raises(ValidationError, match="must not be earlier"):
        prepare_business_analysis("分析してください。", data)
