"""IAM-authenticated AgentCore Gateway MCP client helpers."""

from __future__ import annotations

from collections.abc import Callable, Collection, Generator, Iterable
from typing import Any
from urllib.parse import urlparse

import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


GATEWAY_URL_ENVIRONMENT_VARIABLE = "BIZFLOW_GATEWAY_URL"
GATEWAY_SERVICE_NAME = "bedrock-agentcore"
TOOL_NAME_DELIMITER = "___"

READ_ONLY_BUSINESS_TOOL_NAMES = frozenset(
    {
        "get_business_requests",
        "analyze_request_data",
        "search_company_rules",
        "get_task_status",
    }
)


class GatewayConfigurationError(ValueError):
    """Raised when Gateway configuration is invalid or unsafe."""


class SigV4HttpAuth(httpx.Auth):
    """Sign every MCP HTTP request with the Runtime's refreshable credentials."""

    requires_request_body = True

    def __init__(
        self,
        region_name: str,
        credentials_provider: Callable[[], Any],
    ) -> None:
        self._region_name = region_name
        self._credentials_provider = credentials_provider

    def auth_flow(
        self,
        request: httpx.Request,
    ) -> Generator[httpx.Request, None, None]:
        credentials = self._credentials_provider()
        if credentials is None:
            raise GatewayConfigurationError(
                "AWS credentials are unavailable for AgentCore Gateway authentication."
            )
        if hasattr(credentials, "get_frozen_credentials"):
            credentials = credentials.get_frozen_credentials()

        aws_request = AWSRequest(
            method=request.method,
            url=str(request.url),
            data=request.content,
            headers=dict(request.headers),
        )
        SigV4Auth(
            credentials,
            GATEWAY_SERVICE_NAME,
            self._region_name,
        ).add_auth(aws_request)
        request.headers.update(dict(aws_request.headers.items()))
        yield request


def validate_gateway_url(gateway_url: str, region_name: str) -> str:
    """Allow only the regional HTTPS AgentCore Gateway MCP endpoint."""

    normalized_url = gateway_url.strip()
    parsed = urlparse(normalized_url)
    hostname = parsed.hostname or ""
    expected_suffixes = (
        f".gateway.bedrock-agentcore.{region_name}.amazonaws.com",
        f".gateway.bedrock-agentcore.{region_name}.amazonaws.com.cn",
    )
    if (
        parsed.scheme != "https"
        or not any(hostname.endswith(suffix) for suffix in expected_suffixes)
        or hostname.startswith(".")
        or parsed.port is not None
        or parsed.path.rstrip("/") != "/mcp"
        or parsed.params
        or parsed.query
        or parsed.fragment
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise GatewayConfigurationError(
            "BIZFLOW_GATEWAY_URL must be the regional HTTPS AgentCore Gateway /mcp endpoint."
        )
    return normalized_url.rstrip("/")


def business_tool_name(gateway_tool_name: str) -> str:
    """Remove the Gateway target prefix from an MCP tool name."""

    return gateway_tool_name.rsplit(TOOL_NAME_DELIMITER, maxsplit=1)[-1]


def is_allowed_business_tool(
    gateway_tool_name: str,
    allowed_tool_names: Collection[str],
) -> bool:
    """Return whether a Gateway tool maps to the explicit business allow-list."""

    return business_tool_name(gateway_tool_name) in allowed_tool_names


def select_read_only_gateway_tools(tools: Iterable[Any]) -> list[Any]:
    """Defensively remove every tool that is not in the read-only allow-list."""

    return [
        tool
        for tool in tools
        if is_allowed_business_tool(tool.tool_name, READ_ONLY_BUSINESS_TOOL_NAMES)
    ]


def create_gateway_mcp_client(
    gateway_url: str,
    region_name: str,
    *,
    credentials_provider: Callable[[], Any] | None = None,
    allowed_tool_names: Collection[str] = READ_ONLY_BUSINESS_TOOL_NAMES,
) -> Any:
    """Build a Strands MCP client using SigV4 and an explicit tool allow-list."""

    unknown_names = set(allowed_tool_names) - READ_ONLY_BUSINESS_TOOL_NAMES
    if not allowed_tool_names or unknown_names:
        raise GatewayConfigurationError(
            "Gateway tool allow-list is empty or contains unknown business tools."
        )
    validated_url = validate_gateway_url(gateway_url, region_name)

    if credentials_provider is None:
        import boto3

        session = boto3.Session(region_name=region_name)
        credentials_provider = session.get_credentials

    from mcp.client.streamable_http import streamablehttp_client
    from strands.tools.mcp import MCPClient

    auth = SigV4HttpAuth(region_name, credentials_provider)

    def allowed_filter(tool: Any, **_kwargs: Any) -> bool:
        return is_allowed_business_tool(tool.mcp_tool.name, allowed_tool_names)

    return MCPClient(
        lambda: streamablehttp_client(validated_url, auth=auth),
        tool_filters={"allowed": [allowed_filter]},
        application_name="bizflow-agent-runtime",
    )
