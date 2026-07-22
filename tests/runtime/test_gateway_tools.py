from __future__ import annotations

from dataclasses import dataclass

import httpx
import pytest
from botocore.credentials import Credentials

from agents.bizflow.gateway_tools import (
    READ_ONLY_BUSINESS_TOOL_NAMES,
    GatewayConfigurationError,
    SigV4HttpAuth,
    business_tool_name,
    is_allowed_business_tool,
    select_read_only_gateway_tools,
    validate_gateway_url,
)


GATEWAY_URL = (
    "https://bizflow-tools-dev-example."
    "gateway.bedrock-agentcore.ap-northeast-1.amazonaws.com/mcp"
)


@dataclass
class FakeTool:
    tool_name: str


def test_validate_gateway_url_accepts_matching_regional_mcp_endpoint() -> None:
    assert validate_gateway_url(GATEWAY_URL, "ap-northeast-1") == GATEWAY_URL


@pytest.mark.parametrize(
    "url",
    [
        GATEWAY_URL.replace("https://", "http://"),
        GATEWAY_URL.replace("ap-northeast-1", "us-east-1"),
        GATEWAY_URL.replace("/mcp", "/other"),
        f"{GATEWAY_URL}?token=not-allowed",
        "https://example.com/mcp",
    ],
)
def test_validate_gateway_url_rejects_non_gateway_destinations(url: str) -> None:
    with pytest.raises(GatewayConfigurationError, match="AgentCore Gateway"):
        validate_gateway_url(url, "ap-northeast-1")


def test_sigv4_auth_signs_with_agentcore_service_and_session_token() -> None:
    auth = SigV4HttpAuth(
        "ap-northeast-1",
        lambda: Credentials("AKIDEXAMPLE", "secret", "session-token"),
    )
    request = httpx.Request(
        "POST",
        GATEWAY_URL,
        headers={"content-type": "application/json"},
        content=b'{"jsonrpc":"2.0"}',
    )

    signed_request = next(auth.auth_flow(request))

    assert signed_request.headers["authorization"].startswith("AWS4-HMAC-SHA256 ")
    assert "/ap-northeast-1/bedrock-agentcore/aws4_request" in (
        signed_request.headers["authorization"]
    )
    assert signed_request.headers["x-amz-security-token"] == "session-token"
    assert "x-amz-date" in signed_request.headers


def test_read_only_selection_removes_write_tool_even_with_gateway_prefix() -> None:
    tools = [
        FakeTool(f"BizFlowReadTools___{name}")
        for name in sorted(READ_ONLY_BUSINESS_TOOL_NAMES)
    ] + [FakeTool("BizFlowWriteTools___create_business_task")]

    selected = select_read_only_gateway_tools(tools)

    assert {business_tool_name(tool.tool_name) for tool in selected} == (
        READ_ONLY_BUSINESS_TOOL_NAMES
    )
    assert not is_allowed_business_tool(
        "BizFlowWriteTools___create_business_task",
        READ_ONLY_BUSINESS_TOOL_NAMES,
    )
