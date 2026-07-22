"""HTTP entry point for the BizFlow AgentCore Runtime container."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

try:
    from .bizflow_agent import AgentConfigurationError, BizFlowAnalyzer
    from .business_data import prepare_business_analysis
except ImportError:  # The container starts this module directly from /app.
    from bizflow_agent import AgentConfigurationError, BizFlowAnalyzer
    from business_data import prepare_business_analysis

LOGGER = logging.getLogger("bizflow.runtime")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

app = FastAPI(
    title="BizFlow Agent Runtime",
    version="0.4.0",
    docs_url=None,
    redoc_url=None,
)

_ANALYZER = BizFlowAnalyzer()


def get_analyzer() -> BizFlowAnalyzer:
    """Return the analyzer; kept replaceable for AWS-free local tests."""

    return _ANALYZER


def handle_invocation(payload: dict[str, Any], session_id: str | None) -> dict[str, Any]:
    """Validate and run one read-only BizFlow analysis request."""

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
    response_text = get_analyzer().analyze(analysis_prompt)
    result: dict[str, Any] = {
        "response": response_text,
        "status": "success",
        "execution_mode": "READ_ONLY",
        "write_operations_performed": False,
    }
    if prepared_analysis:
        result["analysis_context"] = prepared_analysis.response_context
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
) -> JSONResponse:
    """Accept an AgentCore invocation and return a JSON response."""

    try:
        payload = await request.json()
    except Exception as exc:  # FastAPI exposes different JSON errors by backend.
        raise HTTPException(status_code=400, detail="Request body must be valid JSON.") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=422, detail="Request body must be a JSON object.")

    LOGGER.info(
        "Invocation received session_id=%s",
        runtime_session_id or "not-provided",
    )
    try:
        result = await run_in_threadpool(handle_invocation, payload, runtime_session_id)
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
