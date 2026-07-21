from __future__ import annotations

import pytest

from agents.bizflow.bizflow_agent import (
    AgentConfigurationError,
    AgentSettings,
    BizFlowAnalyzer,
)


def test_settings_reads_explicit_model_and_region() -> None:
    settings = AgentSettings.from_environment(
        {
            "BIZFLOW_MODEL_ID": "example.model-v1:0",
            "BIZFLOW_AWS_REGION": "ap-northeast-1",
        }
    )

    assert settings.model_id == "example.model-v1:0"
    assert settings.region_name == "ap-northeast-1"


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
