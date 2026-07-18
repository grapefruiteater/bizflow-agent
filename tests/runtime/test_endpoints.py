from __future__ import annotations

from fastapi.testclient import TestClient

from agents.bizflow import app as runtime_module


client = TestClient(runtime_module.app)


def test_ping_returns_agentcore_health_contract() -> None:
    response = client.get("/ping")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"status": "Healthy"}


def test_invocations_accepts_prompt() -> None:
    response = client.post("/invocations", json={"prompt": "Analyze this process"})

    assert response.status_code == 200
    assert response.json() == {
        "response": "BizFlow Agent received: Analyze this process",
        "status": "success",
    }


def test_invocations_accepts_input_wrapped_prompt() -> None:
    response = client.post(
        "/invocations",
        json={"input": {"prompt": "Analyze this process"}},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "success"


def test_invocations_propagates_runtime_session_id() -> None:
    session_id = "11111111-2222-3333-4444-555555555555"
    response = client.post(
        "/invocations",
        json={"prompt": "Hello"},
        headers={"X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session_id},
    )

    assert response.status_code == 200
    assert response.json()["session_id"] == session_id


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
