from __future__ import annotations

import pytest

from agents.bizflow.bizflow_agent import (
    AgentConfigurationError,
    AgentSettings,
    BizFlowAnalyzer,
    ReadOnlyGatewayAgent,
)
from agents.bizflow.gateway_tools import READ_ONLY_BUSINESS_TOOL_NAMES


def test_settings_reads_explicit_model_and_region() -> None:
    settings = AgentSettings.from_environment(
        {
            "BIZFLOW_MODEL_ID": "example.model-v1:0",
            "BIZFLOW_AWS_REGION": "ap-northeast-1",
        }
    )

    assert settings.model_id == "example.model-v1:0"
    assert settings.region_name == "ap-northeast-1"


def test_settings_reads_and_validates_gateway_url() -> None:
    gateway_url = (
        "https://bizflow-tools-dev-example."
        "gateway.bedrock-agentcore.ap-northeast-1.amazonaws.com/mcp"
    )
    settings = AgentSettings.from_environment(
        {
            "BIZFLOW_MODEL_ID": "example.model-v1:0",
            "BIZFLOW_AWS_REGION": "ap-northeast-1",
            "BIZFLOW_GATEWAY_URL": gateway_url,
        }
    )

    assert settings.gateway_url == gateway_url


def test_settings_rejects_gateway_without_region() -> None:
    with pytest.raises(AgentConfigurationError, match="BIZFLOW_AWS_REGION"):
        AgentSettings.from_environment(
            {
                "BIZFLOW_MODEL_ID": "example.model-v1:0",
                "BIZFLOW_GATEWAY_URL": (
                    "https://bizflow-tools-dev-example."
                    "gateway.bedrock-agentcore.ap-northeast-1.amazonaws.com/mcp"
                ),
            }
        )


def test_settings_rejects_missing_model_id() -> None:
    with pytest.raises(AgentConfigurationError, match="BIZFLOW_MODEL_ID"):
        AgentSettings.from_environment({})


def test_local_test_provider_does_not_require_model_or_aws() -> None:
    settings = AgentSettings.from_environment(
        {"BIZFLOW_MODEL_PROVIDER": "local-test"}
    )
    analyzer = BizFlowAnalyzer(settings_factory=lambda: settings)

    assert analyzer.analyze("test prompt") == (
        "Local read-only analysis completed: test prompt"
    )


def test_analyzer_uses_injected_agent_without_aws_access() -> None:
    captured: dict[str, object] = {}
    settings = AgentSettings(
        model_id="example.model-v1:0",
        region_name="ap-northeast-1",
    )

    class FakeAgent:
        def __call__(self, prompt: str) -> str:
            captured["prompt"] = prompt
            return "read-only analysis"

    def fake_agent_factory(received_settings: AgentSettings) -> FakeAgent:
        captured["settings"] = received_settings
        return FakeAgent()

    analyzer = BizFlowAnalyzer(
        settings_factory=lambda: settings,
        agent_factory=fake_agent_factory,
    )

    assert analyzer.analyze("analyze this request") == "read-only analysis"
    assert captured == {
        "settings": settings,
        "prompt": "analyze this request",
    }


def test_analyzer_rejects_empty_model_response() -> None:
    analyzer = BizFlowAnalyzer(
        settings_factory=lambda: AgentSettings(model_id="example.model-v1:0"),
        agent_factory=lambda _settings: lambda _prompt: "   ",
    )

    with pytest.raises(RuntimeError, match="empty response"):
        analyzer.analyze("analyze this request")


def test_gateway_agent_exposes_only_complete_read_tool_set() -> None:
    events: list[str] = []

    class FakeTool:
        def __init__(self, name: str) -> None:
            self.tool_name = name

    class FakeGatewayClient:
        def __enter__(self):
            events.append("open")
            return self

        def __exit__(self, *_args) -> None:
            events.append("close")

        def list_tools_sync(self):
            return [
                *[
                    FakeTool(f"BizFlowReadTools___{name}")
                    for name in sorted(READ_ONLY_BUSINESS_TOOL_NAMES)
                ],
                FakeTool("BizFlowWriteTools___create_business_task"),
            ]

    class FakeAgent:
        def __init__(self, tools) -> None:
            self.tools = tools

        def __call__(self, prompt: str) -> str:
            events.append("invoke")
            assert prompt == "analyze this request"
            assert {tool.tool_name.rsplit("___", 1)[-1] for tool in self.tools} == (
                READ_ONLY_BUSINESS_TOOL_NAMES
            )
            return "read-only tool result"

    agent = ReadOnlyGatewayAgent(
        gateway_client_factory=FakeGatewayClient,
        agent_builder=FakeAgent,
    )

    assert agent("analyze this request") == "read-only tool result"
    assert events == ["open", "invoke", "close"]


def test_gateway_agent_rejects_partial_read_tool_set() -> None:
    class FakeGatewayClient:
        def __enter__(self):
            return self

        def __exit__(self, *_args) -> None:
            return None

        def list_tools_sync(self):
            return []

    agent = ReadOnlyGatewayAgent(
        gateway_client_factory=FakeGatewayClient,
        agent_builder=lambda _tools: lambda _prompt: "not called",
    )

    with pytest.raises(RuntimeError, match="did not expose"):
        agent("analyze this request")
