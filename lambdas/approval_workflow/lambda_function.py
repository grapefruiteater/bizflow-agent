"""AWS Lambda entry point for the trusted BizFlow approval workflow boundary."""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from typing import Any

try:
    from business_tools.aws_adapters import build_service_from_environment
    from business_tools.service import BusinessToolError, require_text
except ImportError:  # Local tests import through the repository-level package.
    from lambdas.business_tools.aws_adapters import build_service_from_environment
    from lambdas.business_tools.service import BusinessToolError, require_text


LOGGER = logging.getLogger("bizflow.approval_workflow")
LOGGER.setLevel(logging.INFO)

SERVICE = build_service_from_environment()


def lambda_handler(event: Any, context: Any) -> dict[str, Any]:
    """Process one trusted BFF approval command without exposing it to the model."""

    del context
    try:
        request = require_request(event)
        operation = require_text(request.get("operation"), "operation", 64)
        actor = require_text(request.get("actor"), "actor", 128)
        handler = get_operation_handlers().get(operation)
        if handler is None:
            raise BusinessToolError(
                "UNKNOWN_APPROVAL_OPERATION",
                f"Approval operation {operation} is not implemented.",
            )
        data = handler(request, actor)
        LOGGER.info(
            "Approval operation succeeded operation=%s actor=%s approval_id=%s",
            operation,
            actor,
            approval_id_for_log(data),
        )
        return {"ok": True, "operation": operation, "data": data}
    except BusinessToolError as exc:
        LOGGER.warning("Approval operation rejected code=%s", exc.code)
        return {
            "ok": False,
            "error": {"code": exc.code, "message": str(exc)},
        }
    except Exception:
        LOGGER.exception("Unhandled approval workflow error")
        return {
            "ok": False,
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "The approval workflow could not complete the request.",
            },
        }


def get_operation_handlers() -> dict[
    str,
    Callable[[Mapping[str, Any], str], dict[str, Any]],
]:
    return {
        "request_approval": request_approval,
        "approve": approve,
        "reject": reject,
        "get_approval": get_approval,
    }


def request_approval(request: Mapping[str, Any], actor: str) -> dict[str, Any]:
    proposal = request.get("proposal")
    if not isinstance(proposal, Mapping):
        raise BusinessToolError(
            "INVALID_PROPOSAL",
            "proposal must be an object.",
        )
    approval = SERVICE.workflow_store.request_approval(proposal, actor)
    return {
        "approval": approval,
        "history": SERVICE.workflow_store.get_history(approval["approval_id"]),
    }


def approve(request: Mapping[str, Any], actor: str) -> dict[str, Any]:
    approval_id = require_approval_id(request)
    approval = SERVICE.workflow_store.approve(approval_id, actor)
    return {
        "approval": approval,
        "history": SERVICE.workflow_store.get_history(approval_id),
    }


def reject(request: Mapping[str, Any], actor: str) -> dict[str, Any]:
    approval_id = require_approval_id(request)
    approval = SERVICE.workflow_store.reject(approval_id, actor)
    return {
        "approval": approval,
        "history": SERVICE.workflow_store.get_history(approval_id),
    }


def get_approval(request: Mapping[str, Any], actor: str) -> dict[str, Any]:
    del actor
    approval_id = require_approval_id(request)
    return {
        "approval": SERVICE.workflow_store.get_approval(approval_id),
        "history": SERVICE.workflow_store.get_history(approval_id),
    }


def require_request(event: Any) -> Mapping[str, Any]:
    if not isinstance(event, Mapping):
        raise BusinessToolError(
            "INVALID_EVENT",
            "The approval Lambda event must be an object.",
        )
    return event


def require_approval_id(request: Mapping[str, Any]) -> str:
    return require_text(request.get("approval_id"), "approval_id", 64)


def approval_id_for_log(data: Mapping[str, Any]) -> str:
    approval = data.get("approval")
    if isinstance(approval, Mapping):
        approval_id = approval.get("approval_id")
        if isinstance(approval_id, str):
            return approval_id
    return "not-available"
