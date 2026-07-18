"""HTTP entry point for the BizFlow AgentCore Runtime container."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

LOGGER = logging.getLogger("bizflow.runtime")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

app = FastAPI(
    title="BizFlow Agent Runtime",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
)


def handle_invocation(payload: dict[str, Any], session_id: str | None) -> dict[str, Any]:
    """Run one BizFlow request.

    This is the narrow adapter where the business agent implementation will be
    connected. Keeping the AgentCore HTTP contract outside that implementation
    lets the transport be tested without AWS access.
    """

    prompt = payload.get("prompt")
    if prompt is None and isinstance(payload.get("input"), dict):
        prompt = payload["input"].get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise HTTPException(
            status_code=422,
            detail="The request body must contain a non-empty string field named 'prompt'.",
        )

    result: dict[str, Any] = {
        "response": f"BizFlow Agent received: {prompt.strip()}",
        "status": "success",
    }
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
    return JSONResponse(handle_invocation(payload, runtime_session_id))


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Avoid returning internal exception details to callers."""

    LOGGER.exception("Unhandled invocation error", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"status": "error", "message": "Internal runtime error."},
    )
