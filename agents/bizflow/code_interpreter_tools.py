"""Restricted AgentCore Code Interpreter tool for business-data analysis."""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable, Mapping
from contextlib import AbstractContextManager
from typing import Any


LOGGER = logging.getLogger("bizflow.code_interpreter")

CODE_INTERPRETER_ID_ENVIRONMENT_VARIABLE = "BIZFLOW_CODE_INTERPRETER_ID"
MANAGED_CODE_INTERPRETER_ID = "aws.codeinterpreter.v1"
MAX_CODE_LENGTH = 16_000
MAX_DESCRIPTION_LENGTH = 500
MAX_RESULT_LENGTH = 20_000


class CodeInterpreterConfigurationError(ValueError):
    """Raised when an unsupported Code Interpreter resource is requested."""


class CodeInterpreterExecutionError(RuntimeError):
    """Raised when the isolated code execution does not produce a valid result."""


def validate_code_interpreter_id(identifier: str) -> str:
    """Allow only the AWS-managed sandbox selected for this portfolio."""

    normalized = identifier.strip()
    if normalized != MANAGED_CODE_INTERPRETER_ID:
        raise CodeInterpreterConfigurationError(
            f"{CODE_INTERPRETER_ID_ENVIRONMENT_VARIABLE} must be "
            f"'{MANAGED_CODE_INTERPRETER_ID}'."
        )
    return normalized


def create_code_interpreter_analysis_tool(
    region_name: str,
    identifier: str = MANAGED_CODE_INTERPRETER_ID,
    session_factory: Callable[..., AbstractContextManager[Any]] | None = None,
) -> Any:
    """Create one Strands tool that executes focused Python in an isolated session."""

    from strands import tool

    region = region_name.strip()
    if not region:
        raise CodeInterpreterConfigurationError("AWS Region must not be empty.")
    interpreter_id = validate_code_interpreter_id(identifier)
    if session_factory is None:
        from bedrock_agentcore.tools.code_interpreter_client import code_session

        session_factory = code_session

    @tool(
        name="analyze_business_data_with_code_interpreter",
        description=(
            "Run concise Python in the isolated AgentCore Code Interpreter to calculate, "
            "validate, or summarize business data already present in the conversation. "
            "Do not use it to access AWS services, networks, credentials, or business systems."
        ),
    )
    def analyze_business_data_with_code_interpreter(
        code: str,
        description: str = "",
    ) -> str:
        """Execute Python over data already supplied by the user or read-only tools.

        Args:
            code: Focused Python source that prints the calculated evidence.
            description: Short explanation of the calculation being performed.

        Returns:
            Text output produced by the isolated Code Interpreter session.
        """

        prepared_code = require_bounded_text(code, "code", MAX_CODE_LENGTH)
        prepared_description = optional_bounded_text(
            description,
            "description",
            MAX_DESCRIPTION_LENGTH,
        )
        LOGGER.info(
            "Starting Code Interpreter analysis description=%s",
            prepared_description or "not-provided",
        )
        try:
            with session_factory(
                region,
                identifier=interpreter_id,
            ) as code_client:
                response = code_client.invoke(
                    "executeCode",
                    {
                        "language": "python",
                        "code": prepared_code,
                        "clearContext": True,
                    },
                )
                result = extract_code_interpreter_result(response)
        except CodeInterpreterExecutionError:
            raise
        except Exception as exc:
            LOGGER.exception("Code Interpreter invocation failed")
            raise CodeInterpreterExecutionError(
                "AgentCore Code Interpreter could not complete the analysis."
            ) from exc
        LOGGER.info("Code Interpreter analysis completed")
        return result

    return analyze_business_data_with_code_interpreter


def extract_code_interpreter_result(response: Any) -> str:
    """Collect text and structured stdout from the Code Interpreter event stream."""

    if not isinstance(response, Mapping):
        raise CodeInterpreterExecutionError(
            "AgentCore Code Interpreter returned an invalid response."
        )
    stream = response.get("stream")
    if stream is None or isinstance(stream, (str, bytes, Mapping)):
        raise CodeInterpreterExecutionError(
            "AgentCore Code Interpreter returned no result stream."
        )

    output_parts: list[str] = []
    saw_result = False
    for event in ensure_iterable(stream):
        if not isinstance(event, Mapping):
            raise CodeInterpreterExecutionError(
                "AgentCore Code Interpreter returned an invalid stream event."
            )
        error_names = [name for name in event if name != "result"]
        if error_names:
            raise CodeInterpreterExecutionError(
                "AgentCore Code Interpreter rejected the execution."
            )
        result = event.get("result")
        if not isinstance(result, Mapping):
            continue
        saw_result = True
        output_parts.extend(extract_text_content(result.get("content")))
        structured = result.get("structuredContent")
        if isinstance(structured, Mapping):
            for name in ("stdout", "stderr"):
                value = structured.get(name)
                if isinstance(value, str) and value.strip():
                    output_parts.append(value.strip())
        if result.get("isError") is True:
            raise CodeInterpreterExecutionError(
                "Python execution failed inside AgentCore Code Interpreter."
            )

    combined = "\n".join(dict.fromkeys(output_parts)).strip()
    if not saw_result or not combined:
        raise CodeInterpreterExecutionError(
            "AgentCore Code Interpreter returned no text output."
        )
    if len(combined) > MAX_RESULT_LENGTH:
        return combined[:MAX_RESULT_LENGTH] + "\n[output truncated]"
    return combined


def extract_text_content(content: Any) -> list[str]:
    if not isinstance(content, list):
        return []
    parts: list[str] = []
    for item in content:
        if not isinstance(item, Mapping):
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
        elif item.get("type") in {"image", "resource"}:
            parts.append("[Code Interpreter generated a non-text artifact]")
    return parts


def ensure_iterable(value: Any) -> Iterable[Any]:
    try:
        return iter(value)
    except TypeError as exc:
        raise CodeInterpreterExecutionError(
            "AgentCore Code Interpreter returned a non-iterable stream."
        ) from exc


def require_bounded_text(value: Any, name: str, max_length: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CodeInterpreterExecutionError(f"{name} must be a non-empty string.")
    normalized = value.strip()
    if len(normalized) > max_length:
        raise CodeInterpreterExecutionError(
            f"{name} must not exceed {max_length} characters."
        )
    return normalized


def optional_bounded_text(value: Any, name: str, max_length: int) -> str:
    if value is None or value == "":
        return ""
    return require_bounded_text(value, name, max_length)
