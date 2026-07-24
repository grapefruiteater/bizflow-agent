from __future__ import annotations

import pytest
import strands
import strands.models

import agents.bizflow.bizflow_agent as bizflow_agent_module
from agents.bizflow.analysis_output import AgentAnalysis, ProposedAction
from agents.bizflow.bizflow_agent import (
    AgentConfigurationError,
    AgentSettings,
    BizFlowAnalyzer,
    ReadOnlyGatewayAgent,
    create_strands_agent,
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


def test_settings_enables_managed_code_interpreter() -> None:
    settings = AgentSettings.from_environment(
        {
            "BIZFLOW_MODEL_ID": "example.model-v1:0",
            "BIZFLOW_AWS_REGION": "ap-northeast-1",
            "BIZFLOW_CODE_INTERPRETER_ID": "aws.codeinterpreter.v1",
        }
    )

    assert settings.code_interpreter_id == "aws.codeinterpreter.v1"


def test_settings_rejects_unsupported_code_interpreter() -> None:
    with pytest.raises(AgentConfigurationError, match="must be"):
        AgentSettings.from_environment(
            {
                "BIZFLOW_MODEL_ID": "example.model-v1:0",
                "BIZFLOW_AWS_REGION": "ap-northeast-1",
                "BIZFLOW_CODE_INTERPRETER_ID": "custom-interpreter",
            }
        )


def test_settings_rejects_code_interpreter_without_region() -> None:
    with pytest.raises(AgentConfigurationError, match="BIZFLOW_AWS_REGION"):
        AgentSettings.from_environment(
            {
                "BIZFLOW_MODEL_ID": "example.model-v1:0",
                "BIZFLOW_CODE_INTERPRETER_ID": "aws.codeinterpreter.v1",
            }
        )


def test_strands_agent_exposes_code_interpreter_only_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    code_tool = object()

    class FakeBedrockModel:
        def __init__(self, **kwargs) -> None:
            captured["model"] = kwargs

    class FakeAgent:
        def __init__(self, **kwargs) -> None:
            captured["agent"] = kwargs

        def __call__(self, _prompt: str) -> str:
            return "ok"

    monkeypatch.setattr(strands.models, "BedrockModel", FakeBedrockModel)
    monkeypatch.setattr(strands, "Agent", FakeAgent)
    monkeypatch.setattr(
        bizflow_agent_module,
        "create_code_interpreter_analysis_tool",
        lambda region, identifier: (
            captured.update(
                {"code_interpreter": (region, identifier)}
            )
            or code_tool
        ),
    )

    agent = create_strands_agent(
        AgentSettings(
            model_id="example.model-v1:0",
            region_name="ap-northeast-1",
            code_interpreter_id="aws.codeinterpreter.v1",
        )
    )

    assert isinstance(agent, FakeAgent)
    assert captured["code_interpreter"] == (
        "ap-northeast-1",
        "aws.codeinterpreter.v1",
    )
    agent_options = captured["agent"]
    assert isinstance(agent_options, dict)
    assert agent_options["tools"] == [code_tool]
    assert agent_options["structured_output_model"] is AgentAnalysis
    assert "AgentCore Code Interpreter" in agent_options["system_prompt"]


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

    result = analyzer.analyze("test prompt")

    assert result.response == "Local read-only analysis completed: test prompt"
    assert result.proposed_actions[0].request_id == "REQ-LOCAL"


def test_analyzer_uses_injected_agent_without_aws_access() -> None:
    captured: dict[str, object] = {}
    settings = AgentSettings(
        model_id="example.model-v1:0",
        region_name="ap-northeast-1",
    )

    class FakeAgent:
        def __call__(self, prompt: str):
            captured["prompt"] = prompt
            return type(
                "FakeResult",
                (),
                {
                    "structured_output": AgentAnalysis(
                        response="read-only analysis",
                        proposed_actions=[
                            ProposedAction(
                                request_id="REQ-002",
                                assignee="support-lead",
                                due_date="2026-07-14",
                                action="顧客へ一次回答する",
                                rationale="期限超過かつ緊急度highのため",
                                rule_ids=["RULE-001"],
                            )
                        ],
                    )
                },
            )()

    def fake_agent_factory(received_settings: AgentSettings) -> FakeAgent:
        captured["settings"] = received_settings
        return FakeAgent()

    analyzer = BizFlowAnalyzer(
        settings_factory=lambda: settings,
        agent_factory=fake_agent_factory,
    )

    analysis = analyzer.analyze("analyze this request")

    assert analysis.response == "read-only analysis"
    assert analysis.proposed_actions[0].request_id == "REQ-002"
    assert captured == {
        "settings": settings,
        "prompt": "analyze this request",
    }


def test_analyzer_rejects_invalid_structured_model_response() -> None:
    analyzer = BizFlowAnalyzer(
        settings_factory=lambda: AgentSettings(model_id="example.model-v1:0"),
        agent_factory=lambda _settings: lambda _prompt: "   ",
    )

    with pytest.raises(RuntimeError, match="invalid structured response"):
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
