"""AWS Lambda entry point for the BizFlow AgentCore Gateway target."""

from __future__ import annotations

import logging
import os
from collections.abc import Callable, Mapping
from typing import Any

from .aws_adapters import build_service_from_environment
from .service import BusinessToolError, BusinessToolsService


LOGGER = logging.getLogger("bizflow.business_tools")
LOGGER.setLevel(logging.INFO)

SERVICE = build_service_from_environment()
TOOL_DELIMITER = "___"
ALLOWED_TOOLS_ENV = "BIZFLOW_ALLOWED_TOOLS"


def lambda_handler(event: Any, context: Any) -> dict[str, Any]:
    """Dispatch a Gateway Lambda target invocation to one of five tools."""

    try:
        arguments = require_arguments(event)
        tool_name = get_gateway_tool_name(context)
        if tool_name not in get_allowed_tools():
            raise BusinessToolError(
                "TOOL_NOT_ALLOWED",
                f"Tool {tool_name} is not enabled for this Lambda function.",
            )
        handler = get_tool_handlers().get(tool_name)
        if handler is None:
            raise BusinessToolError(
                "UNKNOWN_TOOL",
                f"Tool {tool_name} is not implemented.",
            )
        data = handler(arguments)
        LOGGER.info("Tool invocation succeeded tool=%s", tool_name)
        return {"ok": True, "tool": tool_name, "data": data}
    except BusinessToolError as exc:
        LOGGER.warning("Tool invocation rejected code=%s", exc.code)
        return {
            "ok": False,
            "error": {"code": exc.code, "message": str(exc)},
        }
    except Exception:
        LOGGER.exception("Unhandled business tool error")
        return {
            "ok": False,
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "The business tool could not complete the request.",
            },
        }


def get_tool_handlers() -> dict[str, Callable[[Mapping[str, Any]], dict[str, Any]]]:
    return {
        "get_business_requests": SERVICE.get_business_requests,
        "analyze_request_data": SERVICE.analyze_request_data,
        "search_company_rules": SERVICE.search_company_rules,
        "create_business_task": SERVICE.create_business_task,
        "get_task_status": SERVICE.get_task_status,
    }


def get_allowed_tools() -> set[str]:
    configured = os.environ.get(ALLOWED_TOOLS_ENV, "").strip()
    if not configured:
        return set(get_tool_handlers())
    return {name.strip() for name in configured.split(",") if name.strip()}


def require_arguments(event: Any) -> Mapping[str, Any]:
    if not isinstance(event, Mapping):
        raise BusinessToolError("INVALID_EVENT", "The Lambda event must be an object.")
    return event


def get_gateway_tool_name(context: Any) -> str:
    client_context = getattr(context, "client_context", None)
    custom = getattr(client_context, "custom", None)
    if not isinstance(custom, Mapping):
        raise BusinessToolError(
            "INVALID_CONTEXT",
            "AgentCore Gateway tool context is missing.",
        )
    original_name = custom.get("bedrockAgentCoreToolName")
    if not isinstance(original_name, str) or not original_name.strip():
        raise BusinessToolError(
            "INVALID_CONTEXT",
            "AgentCore Gateway tool name is missing.",
        )
    return original_name.rsplit(TOOL_DELIMITER, maxsplit=1)[-1]
