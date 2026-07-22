from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import pytest

from agents.bizflow.code_interpreter_tools import (
    MAX_CODE_LENGTH,
    CodeInterpreterConfigurationError,
    CodeInterpreterExecutionError,
    create_code_interpreter_analysis_tool,
    extract_code_interpreter_result,
    validate_code_interpreter_id,
)


class FakeCodeInterpreterClient:
    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.invocations: list[tuple[str, dict[str, Any]]] = []

    def invoke(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.invocations.append((method, params))
        return self.response


def successful_response(text: str = "urgent_count=2") -> dict[str, Any]:
    return {
        "stream": iter(
            [
                {
                    "result": {
                        "content": [{"type": "text", "text": text}],
                        "structuredContent": {"stdout": text, "exitCode": 0},
                        "isError": False,
                    }
                }
            ]
        )
    }


def test_managed_code_interpreter_id_is_the_only_allowed_resource() -> None:
    assert validate_code_interpreter_id(" aws.codeinterpreter.v1 ") == (
        "aws.codeinterpreter.v1"
    )

    with pytest.raises(CodeInterpreterConfigurationError, match="must be"):
        validate_code_interpreter_id("custom-interpreter")


def test_analysis_tool_starts_and_stops_one_managed_session() -> None:
    client = FakeCodeInterpreterClient(successful_response())
    sessions: list[tuple[str, str]] = []

    @contextmanager
    def fake_session(region: str, *, identifier: str):
        sessions.append((region, identifier))
        yield client
        sessions.append(("stopped", identifier))

    analysis_tool = create_code_interpreter_analysis_tool(
        "ap-northeast-1",
        session_factory=fake_session,
    )

    result = analysis_tool(
        "print('urgent_count=2')",
        "緊急案件数を検算する",
    )

    assert result == "urgent_count=2"
    assert sessions == [
        ("ap-northeast-1", "aws.codeinterpreter.v1"),
        ("stopped", "aws.codeinterpreter.v1"),
    ]
    assert client.invocations == [
        (
            "executeCode",
            {
                "language": "python",
                "code": "print('urgent_count=2')",
                "clearContext": True,
            },
        )
    ]


def test_analysis_tool_rejects_oversized_code_without_starting_session() -> None:
    started = False

    @contextmanager
    def fake_session(_region: str, *, identifier: str):
        nonlocal started
        del identifier
        started = True
        yield FakeCodeInterpreterClient(successful_response())

    analysis_tool = create_code_interpreter_analysis_tool(
        "ap-northeast-1",
        session_factory=fake_session,
    )

    with pytest.raises(CodeInterpreterExecutionError, match="must not exceed"):
        analysis_tool("x" * (MAX_CODE_LENGTH + 1))

    assert started is False


def test_result_parser_rejects_service_and_execution_errors() -> None:
    with pytest.raises(CodeInterpreterExecutionError, match="rejected"):
        extract_code_interpreter_result(
            {"stream": iter([{"accessDeniedException": {"message": "denied"}}])}
        )

    with pytest.raises(CodeInterpreterExecutionError, match="execution failed"):
        extract_code_interpreter_result(
            {
                "stream": iter(
                    [
                        {
                            "result": {
                                "content": [
                                    {"type": "text", "text": "private detail"}
                                ],
                                "isError": True,
                            }
                        }
                    ]
                )
            }
        )


def test_result_parser_requires_textual_evidence() -> None:
    with pytest.raises(CodeInterpreterExecutionError, match="no text output"):
        extract_code_interpreter_result(
            {
                "stream": iter(
                    [
                        {
                            "result": {
                                "content": [],
                                "structuredContent": {"exitCode": 0},
                                "isError": False,
                            }
                        }
                    ]
                )
            }
        )
