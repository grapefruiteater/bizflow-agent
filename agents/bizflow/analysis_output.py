"""Validated structured output contract for BizFlow analysis results."""

from __future__ import annotations

from datetime import date
from typing import Annotated

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)


RequestId = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    ),
]
Assignee = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=128),
]
ActionText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=1000),
]
RationaleText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=1000),
]
RuleId = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=64,
        pattern=r"^RULE-[A-Za-z0-9-]+$",
    ),
]
ResponseText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=12000),
]


class ProposedAction(BaseModel):
    """One read-only task proposal that still requires human approval."""

    model_config = ConfigDict(extra="forbid")

    request_id: RequestId = Field(
        description=(
            "Exact request_id returned by a business tool or supplied in "
            "normalized business_data."
        ),
    )
    assignee: Assignee = Field(
        description="Suggested role or team responsible for the request.",
    )
    due_date: date = Field(
        description="Suggested completion date in YYYY-MM-DD format.",
    )
    action: ActionText = Field(
        description="Concrete task content that can be reviewed by a human.",
    )
    rationale: RationaleText = Field(
        description="Why this task, assignee, and due date are recommended.",
    )
    rule_ids: list[RuleId] = Field(
        default_factory=list,
        max_length=10,
        description="Rule IDs actually returned by search_company_rules.",
    )


class AgentAnalysis(BaseModel):
    """Human-readable analysis plus zero or more approval candidates."""

    model_config = ConfigDict(extra="forbid")

    response: ResponseText = Field(
        description=(
            "Concise Japanese analysis with summary, evidence, proposal, "
            "missing information, and pending approval sections as applicable."
        ),
    )
    proposed_actions: list[ProposedAction] = Field(
        default_factory=list,
        max_length=5,
        description=(
            "Prioritized task proposals. Use an empty list when no grounded "
            "action can be proposed."
        ),
    )

    @model_validator(mode="after")
    def request_ids_must_be_unique(self) -> "AgentAnalysis":
        request_ids = [item.request_id for item in self.proposed_actions]
        if len(request_ids) != len(set(request_ids)):
            raise ValueError("proposed_actions must not repeat a request_id")
        return self
