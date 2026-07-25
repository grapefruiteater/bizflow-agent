"""HTTP entry point for the BizFlow AgentCore Runtime container."""

from __future__ import annotations

import logging
from typing import Any, Callable

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

try:
    from .bizflow_agent import AgentConfigurationError, BizFlowAnalyzer
    from .business_data import prepare_business_analysis
    from .conversation_memory import (
        AgentCoreConversationMemory,
        MemoryConfigurationError,
        MemoryOperationError,
        validate_runtime_user_id,
    )
except ImportError:  # The container starts this module directly from /app.
    from bizflow_agent import AgentConfigurationError, BizFlowAnalyzer
    from business_data import prepare_business_analysis
    from conversation_memory import (
        AgentCoreConversationMemory,
        MemoryConfigurationError,
        MemoryOperationError,
        validate_runtime_user_id,
    )

LOGGER = logging.getLogger("bizflow.runtime")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

app = FastAPI(
    title="BizFlow Agent Runtime",
    version="0.6.0",
    docs_url=None,
    redoc_url=None,
)

_ANALYZER = BizFlowAnalyzer()
_MEMORY_PROVIDER: Callable[[], AgentCoreConversationMemory | None] = (
    AgentCoreConversationMemory.from_environment
)


def get_analyzer() -> BizFlowAnalyzer:
    """Return the analyzer; kept replaceable for AWS-free local tests."""

    return _ANALYZER


def get_conversation_memory() -> AgentCoreConversationMemory | None:
    """Return optional session memory; kept replaceable for AWS-free tests."""

    try:
        return _MEMORY_PROVIDER()
    except MemoryConfigurationError as exc:
        raise AgentConfigurationError("Runtime memory configuration is invalid.") from exc


def handle_invocation(
    payload: dict[str, Any],
    session_id: str | None,
    runtime_user_id: str | None = None,
) -> dict[str, Any]:
    """Validate and run one read-only BizFlow analysis request."""

    trusted_runtime_user_id: str | None = None
    if runtime_user_id:
        try:
            trusted_runtime_user_id = validate_runtime_user_id(runtime_user_id)
        except MemoryOperationError as exc:
            raise HTTPException(
                status_code=422,
                detail="The Runtime user ID has an invalid format.",
            ) from exc

    nested_input = payload.get("input")
    prompt = payload.get("prompt")
    if prompt is None and isinstance(nested_input, dict):
        prompt = nested_input.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise HTTPException(
            status_code=422,
            detail="The request body must contain a non-empty string field named 'prompt'.",
        )

    top_level_business_data_present = "business_data" in payload
    nested_business_data_present = (
        isinstance(nested_input, dict) and "business_data" in nested_input
    )
    if top_level_business_data_present and nested_business_data_present:
        raise HTTPException(
            status_code=422,
            detail="Specify 'business_data' either at the top level or inside 'input', not both.",
        )

    prepared_analysis = None
    if top_level_business_data_present or nested_business_data_present:
        raw_business_data = (
            payload["business_data"]
            if top_level_business_data_present
            else nested_input["business_data"]
        )
        try:
            prepared_analysis = prepare_business_analysis(
                prompt.strip(),
                raw_business_data,
            )
        except ValidationError as exc:
            sanitized_errors = [
                {
                    "field": ".".join(str(part) for part in error["loc"]),
                    "message": error["msg"],
                }
                for error in exc.errors(include_url=False, include_input=False)
            ]
            raise HTTPException(
                status_code=422,
                detail={
                    "message": "business_data is invalid.",
                    "errors": sanitized_errors,
                },
            ) from exc

    analysis_prompt = (
        prepared_analysis.model_prompt if prepared_analysis else prompt.strip()
    )
    memory = get_conversation_memory()
    memory_status: dict[str, Any] | None = None
    if memory is not None:
        memory_status = {
            "enabled": True,
            "session_available": bool(session_id),
            "user_scoped": bool(trusted_runtime_user_id),
            "context_turns": 0,
            "preference_records": 0,
            "long_term_extraction_enabled": bool(
                session_id
                and trusted_runtime_user_id
                and memory.user_preference_namespace_template
            ),
            "event_stored": False,
            "degraded": False,
        }
        if session_id:
            try:
                memory_context = memory.load_context(
                    analysis_prompt,
                    session_id,
                    trusted_runtime_user_id,
                )
                analysis_prompt = memory_context.prompt
                memory_status["context_turns"] = memory_context.turn_count
                memory_status["preference_records"] = (
                    memory_context.preference_count
                )
            except MemoryOperationError:
                LOGGER.exception("Continuing without Memory context")
                memory_status["degraded"] = True

    analysis = get_analyzer().analyze(analysis_prompt)
    response_text = analysis.response
    if memory is not None and session_id:
        try:
            memory.save_turn(
                session_id,
                prompt.strip(),
                response_text,
                trusted_runtime_user_id,
            )
            if memory_status is not None:
                memory_status["event_stored"] = True
        except MemoryOperationError:
            LOGGER.exception("Response succeeded but short-term memory was not stored")
            if memory_status is not None:
                memory_status["degraded"] = True

    result: dict[str, Any] = {
        "response": response_text,
        "output_contract_version": "1.0",
        "proposed_actions": [
            action.model_dump(mode="json") for action in analysis.proposed_actions
        ],
        "status": "success",
        "execution_mode": "READ_ONLY",
        "write_operations_performed": False,
    }
    if prepared_analysis:
        result["analysis_context"] = prepared_analysis.response_context
    if memory_status is not None:
        result["memory"] = memory_status
    if session_id:
        result["session_id"] = session_id
    return result


@app.get("/ping")
def ping() -> dict[str, str]:
    """Return the health response required by AgentCore Runtime."""

    return {"status": "Healthy"}


@app.post("/invocations")
async def invocations(
    request: Request,
    runtime_session_id: str | None = Header(
        default=None,
        alias="X-Amzn-Bedrock-AgentCore-Runtime-Session-Id",
    ),
    runtime_user_id: str | None = Header(
        default=None,
        alias="X-Amzn-Bedrock-AgentCore-Runtime-User-Id",
    ),
) -> JSONResponse:
    """Accept an AgentCore invocation and return a JSON response."""

    try:
        payload = await request.json()
    except Exception as exc:  # FastAPI exposes different JSON errors by backend.
        raise HTTPException(status_code=400, detail="Request body must be valid JSON.") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=422, detail="Request body must be a JSON object.")

    LOGGER.info(
        "Invocation received session_id=%s user_scoped=%s",
        runtime_session_id or "not-provided",
        bool(runtime_user_id),
    )
    try:
        result = await run_in_threadpool(
            handle_invocation,
            payload,
            runtime_session_id,
            runtime_user_id,
        )
    except AgentConfigurationError:
        LOGGER.error("Runtime model configuration is missing or invalid.")
        return JSONResponse(
            status_code=503,
            content={
                "status": "error",
                "message": "Runtime model configuration is unavailable.",
            },
        )
    return JSONResponse(result)


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Avoid returning internal exception details to callers."""

    LOGGER.exception("Unhandled invocation error", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"status": "error", "message": "Internal runtime error."},
    )
