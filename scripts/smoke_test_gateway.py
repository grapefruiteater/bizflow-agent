"""Direct AgentCore Gateway smoke test invoked by smoke-test-gateway.ps1."""

from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from agents.bizflow.gateway_tools import (  # noqa: E402
    READ_ONLY_BUSINESS_TOOL_NAMES,
    SigV4HttpAuth,
    business_tool_name,
    validate_gateway_url,
)


ROOT_ARN_PATTERN = re.compile(r"^arn:aws(?:-[a-z]+)*:iam::\d{12}:root$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--gateway-url", required=True)
    parser.add_argument("--start-date", default="2026-07-10")
    parser.add_argument("--end-date", default="2026-07-13")
    parser.add_argument("--as-of", default="2026-07-13")
    return parser.parse_args()


def extract_json_payload(result: Mapping[str, Any], tool_name: str) -> dict[str, Any]:
    if result.get("status") != "success" or result.get("isError") is True:
        raise RuntimeError(f"Gateway tool {tool_name} failed: {result}")

    candidates: list[Any] = []
    structured_content = result.get("structuredContent")
    if structured_content is not None:
        candidates.append(structured_content)
    for content in result.get("content", []):
        if not isinstance(content, Mapping):
            continue
        if "json" in content:
            candidates.append(content["json"])
        text = content.get("text")
        if isinstance(text, str):
            try:
                candidates.append(json.loads(text))
            except json.JSONDecodeError:
                continue

    for candidate in candidates:
        if isinstance(candidate, Mapping):
            return dict(candidate)
    raise RuntimeError(f"Gateway tool {tool_name} returned no JSON object: {result}")


def require_success_payload(result: Mapping[str, Any], tool_name: str) -> dict[str, Any]:
    payload = extract_json_payload(result, tool_name)
    if payload.get("ok") is False:
        raise RuntimeError(f"Gateway tool {tool_name} was rejected: {payload}")
    return payload


def invoke_tool(client: Any, actual_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    result = client.call_tool_sync(
        tool_use_id=str(uuid.uuid4()),
        name=actual_name,
        arguments=arguments,
    )
    return require_success_payload(result, business_tool_name(actual_name))


def main() -> int:
    args = parse_args()

    import boto3

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    identity = session.client("sts", region_name=args.region).get_caller_identity()
    caller_arn = str(identity["Arn"])
    print(f"Gateway smoke-test caller: {caller_arn}")
    if ROOT_ARN_PATTERN.fullmatch(caller_arn):
        raise RuntimeError("Smoke testing as the AWS account root user is prohibited.")

    from mcp.client.streamable_http import streamablehttp_client
    from strands.tools.mcp import MCPClient

    gateway_url = validate_gateway_url(args.gateway_url, args.region)
    auth = SigV4HttpAuth(args.region, session.get_credentials)
    client = MCPClient(
        lambda: streamablehttp_client(gateway_url, auth=auth),
        application_name="bizflow-agent-gateway-smoke-test",
    )
    with client:
        tools = list(client.list_tools_sync())
        tools_by_business_name = {
            business_tool_name(tool.tool_name): tool.tool_name for tool in tools
        }
        actual_tool_names = set(tools_by_business_name)
        missing = READ_ONLY_BUSINESS_TOOL_NAMES - actual_tool_names
        if missing:
            raise RuntimeError(
                "Gateway did not list the expected tools: " + ", ".join(sorted(missing))
            )
        unexpected = actual_tool_names - READ_ONLY_BUSINESS_TOOL_NAMES
        if unexpected:
            raise RuntimeError(
                "Gateway listed unexpected tools: " + ", ".join(sorted(unexpected))
            )
        print("Gateway tools/list: Passed (4 read-only tools)")

        requests_result = invoke_tool(
            client,
            tools_by_business_name["get_business_requests"],
            {"start_date": args.start_date, "end_date": args.end_date},
        )
        requests_data = requests_result.get("data")
        if not isinstance(requests_data, Mapping) or not requests_data.get("requests"):
            raise RuntimeError("get_business_requests returned no requests.")
        print(
            "get_business_requests: Passed "
            f"(count={requests_data.get('count', 'not-reported')})"
        )

        analysis_result = invoke_tool(
            client,
            tools_by_business_name["analyze_request_data"],
            {
                "as_of": args.as_of,
                "requests": requests_data["requests"],
            },
        )
        analysis_data = analysis_result.get("data")
        if not isinstance(analysis_data, Mapping):
            raise RuntimeError("analyze_request_data returned no analysis data.")
        print(
            "analyze_request_data: Passed "
            f"(overdue={analysis_data.get('overdue_request_ids', [])})"
        )

        rules_result = invoke_tool(
            client,
            tools_by_business_name["search_company_rules"],
            {"query": "障害 high 期限超過 請求", "category": "障害"},
        )
        rules_data = rules_result.get("data")
        if not isinstance(rules_data, Mapping) or not rules_data.get("rules"):
            raise RuntimeError("search_company_rules returned no matching rules.")
        print(
            "search_company_rules: Passed "
            f"(count={rules_data.get('count', 'not-reported')})"
        )

    print("Gateway read-tool smoke test succeeded.")
    print("get_task_status was not invoked because this smoke test creates no task.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Gateway smoke test failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
