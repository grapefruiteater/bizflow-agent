from __future__ import annotations

from fastapi.testclient import TestClient

from agents.bizflow import app as runtime_module


client = TestClient(runtime_module.app)


class FakeAnalyzer:
    def analyze(self, prompt: str) -> str:
        return f"Analysis result: {prompt}"


def setup_function() -> None:
    runtime_module._ANALYZER = FakeAnalyzer()
    runtime_module._MEMORY_PROVIDER = lambda: None


def test_ping_returns_agentcore_health_contract() -> None:
    response = client.get("/ping")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"status": "Healthy"}


def test_invocations_accepts_prompt() -> None:
    response = client.post("/invocations", json={"prompt": "Analyze this process"})

    assert response.status_code == 200
    assert response.json() == {
        "response": "Analysis result: Analyze this process",
        "status": "success",
        "execution_mode": "READ_ONLY",
        "write_operations_performed": False,
    }


def test_invocations_accepts_input_wrapped_prompt() -> None:
    response = client.post(
        "/invocations",
        json={"input": {"prompt": "Analyze this process"}},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert response.json()["execution_mode"] == "READ_ONLY"
    assert response.json()["write_operations_performed"] is False


def test_invocations_propagates_runtime_session_id() -> None:
    session_id = "11111111-2222-3333-4444-555555555555"
    response = client.post(
        "/invocations",
        json={"prompt": "Hello"},
        headers={"X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session_id},
    )

    assert response.status_code == 200
    assert response.json()["session_id"] == session_id


def test_invocations_loads_and_saves_optional_session_memory() -> None:
    class FakeMemoryContext:
        prompt = "Memory-enriched prompt"
        turn_count = 2

    class FakeMemory:
        def __init__(self) -> None:
            self.loaded: list[tuple[str, str]] = []
            self.saved: list[tuple[str, str, str]] = []

        def load_context(self, prompt: str, session_id: str) -> FakeMemoryContext:
            self.loaded.append((prompt, session_id))
            return FakeMemoryContext()

        def save_turn(
            self,
            session_id: str,
            prompt: str,
            response: str,
        ) -> None:
            self.saved.append((session_id, prompt, response))

    class CapturingAnalyzer:
        def __init__(self) -> None:
            self.prompt = ""

        def analyze(self, prompt: str) -> str:
            self.prompt = prompt
            return "remembered response"

    session_id = "11111111-2222-3333-4444-555555555555"
    memory = FakeMemory()
    analyzer = CapturingAnalyzer()
    runtime_module._ANALYZER = analyzer
    runtime_module._MEMORY_PROVIDER = lambda: memory

    response = client.post(
        "/invocations",
        json={"prompt": "remember this"},
        headers={"X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session_id},
    )

    assert response.status_code == 200
    assert analyzer.prompt == "Memory-enriched prompt"
    assert memory.loaded == [("remember this", session_id)]
    assert memory.saved == [(session_id, "remember this", "remembered response")]
    assert response.json()["memory"] == {
        "enabled": True,
        "session_available": True,
        "context_turns": 2,
        "event_stored": True,
        "degraded": False,
    }
    assert response.json()["write_operations_performed"] is False


def test_invocations_reports_enabled_memory_without_runtime_session() -> None:
    class UnusedMemory:
        def load_context(self, _prompt: str, _session_id: str) -> None:
            raise AssertionError("memory must not be read without a session")

        def save_turn(self, _session_id: str, _prompt: str, _response: str) -> None:
            raise AssertionError("memory must not be written without a session")

    runtime_module._MEMORY_PROVIDER = lambda: UnusedMemory()

    response = client.post("/invocations", json={"prompt": "hello"})

    assert response.status_code == 200
    assert response.json()["memory"] == {
        "enabled": True,
        "session_available": False,
        "context_turns": 0,
        "event_stored": False,
        "degraded": False,
    }


def test_invocations_fail_open_when_memory_is_unavailable() -> None:
    class BrokenMemory:
        def load_context(self, _prompt: str, _session_id: str) -> None:
            raise runtime_module.MemoryOperationError("sanitized")

        def save_turn(self, _session_id: str, _prompt: str, _response: str) -> None:
            raise runtime_module.MemoryOperationError("sanitized")

    runtime_module._MEMORY_PROVIDER = lambda: BrokenMemory()
    response = client.post(
        "/invocations",
        json={"prompt": "hello"},
        headers={
            "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": (
                "11111111-2222-3333-4444-555555555555"
            )
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert response.json()["memory"] == {
        "enabled": True,
        "session_available": True,
        "context_turns": 0,
        "event_stored": False,
        "degraded": True,
    }


def test_invocations_analyzes_structured_business_data() -> None:
    class CapturingAnalyzer:
        def __init__(self) -> None:
            self.prompt = ""

        def analyze(self, prompt: str) -> str:
            self.prompt = prompt
            return "期限超過のINQ-001を最優先にしてください。"

    analyzer = CapturingAnalyzer()
    runtime_module._ANALYZER = analyzer
    response = client.post(
        "/invocations",
        json={
            "prompt": "問い合わせを分析してください。",
            "business_data": {
                "as_of": "2026-07-21T10:00:00+09:00",
                "inquiries": [
                    {
                        "inquiry_id": "INQ-001",
                        "summary": "期限超過",
                        "received_at": "2026-07-20T09:00:00+09:00",
                        "due_at": "2026-07-21T09:00:00+09:00",
                        "priority": "URGENT",
                        "status": "OPEN",
                    }
                ],
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["response"] == "期限超過のINQ-001を最優先にしてください。"
    assert response.json()["analysis_context"] == {
        "as_of": "2026-07-21T10:00:00+09:00",
        "total_inquiries": 1,
        "active_inquiries": 1,
        "overdue_inquiry_ids": ["INQ-001"],
        "urgent_inquiry_ids": ["INQ-001"],
        "due_within_24_hours_inquiry_ids": [],
    }
    assert '"inquiry_id":"INQ-001"' in analyzer.prompt
    assert '"overdue":true' in analyzer.prompt


def test_invocations_accepts_business_data_inside_input() -> None:
    response = client.post(
        "/invocations",
        json={
            "input": {
                "prompt": "問い合わせを分析してください。",
                "business_data": {
                    "as_of": "2026-07-21T10:00:00+09:00",
                    "inquiries": [
                        {
                            "inquiry_id": "INQ-001",
                            "summary": "通常問い合わせ",
                            "received_at": "2026-07-21T09:00:00+09:00",
                        }
                    ],
                },
            }
        },
    )

    assert response.status_code == 200
    assert response.json()["analysis_context"]["total_inquiries"] == 1


def test_invocations_rejects_invalid_business_data_without_echoing_input() -> None:
    sensitive_summary = "customer-sensitive-value"
    response = client.post(
        "/invocations",
        json={
            "prompt": "問い合わせを分析してください。",
            "business_data": {
                "as_of": "2026-07-21T10:00:00",
                "inquiries": [
                    {
                        "inquiry_id": "INQ-001",
                        "summary": sensitive_summary,
                        "received_at": "2026-07-21T09:00:00+09:00",
                    }
                ],
            },
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["message"] == "business_data is invalid."
    assert sensitive_summary not in response.text


def test_invocations_rejects_duplicate_business_data_locations() -> None:
    response = client.post(
        "/invocations",
        json={
            "prompt": "分析してください。",
            "business_data": {},
            "input": {"business_data": {}},
        },
    )

    assert response.status_code == 422
    assert "not both" in response.json()["detail"]


def test_invocations_rejects_invalid_json() -> None:
    response = client.post(
        "/invocations",
        content="{not-json",
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Request body must be valid JSON."


def test_invocations_rejects_non_object_json() -> None:
    response = client.post("/invocations", json=["not", "an", "object"])

    assert response.status_code == 422
    assert response.json()["detail"] == "Request body must be a JSON object."


def test_invocations_rejects_missing_prompt() -> None:
    response = client.post("/invocations", json={"unknown": "value"})

    assert response.status_code == 422
    assert "non-empty string" in response.json()["detail"]


def test_invocations_returns_503_when_model_configuration_is_missing() -> None:
    class MissingConfigurationAnalyzer:
        def analyze(self, _prompt: str) -> str:
            raise runtime_module.AgentConfigurationError("secret configuration detail")

    runtime_module._ANALYZER = MissingConfigurationAnalyzer()

    response = client.post("/invocations", json={"prompt": "Hello"})

    assert response.status_code == 503
    assert response.json() == {
        "status": "error",
        "message": "Runtime model configuration is unavailable.",
    }
    assert "secret configuration detail" not in response.text


def test_invocations_hides_unhandled_errors(monkeypatch) -> None:
    def raise_unexpected_error(_payload, _session_id):
        raise RuntimeError("sensitive internal detail")

    monkeypatch.setattr(runtime_module, "handle_invocation", raise_unexpected_error)
    isolated_client = TestClient(runtime_module.app, raise_server_exceptions=False)

    response = isolated_client.post("/invocations", json={"prompt": "Hello"})

    assert response.status_code == 500
    assert response.json() == {
        "status": "error",
        "message": "Internal runtime error.",
    }
    assert "sensitive internal detail" not in response.text
