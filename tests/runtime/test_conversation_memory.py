from __future__ import annotations

import pytest
from botocore.exceptions import ClientError

from agents.bizflow.conversation_memory import (
    AgentCoreConversationMemory,
    MAX_PREFERENCE_CHARACTERS,
    MAX_STORED_MESSAGE_CHARACTERS,
    MemoryConfigurationError,
    MemoryOperationError,
    actor_id_for_session,
    render_user_preference_namespace,
    validate_runtime_user_id,
)


MEMORY_ID = "BizFlowMemory_test-abcdefghij"
SESSION_ID = "11111111-2222-3333-4444-555555555555"
RUNTIME_USER_ID = f"bizflow-user-{'a' * 64}"
USER_NAMESPACE_TEMPLATE = "/users/{actorId}/preferences/"


class FakeMemoryClient:
    def __init__(self) -> None:
        self.turns: list[list[dict[str, object]]] = []
        self.created: list[dict[str, object]] = []
        self.reads: list[dict[str, object]] = []
        self.memories: list[dict[str, object]] = []
        self.retrievals: list[dict[str, object]] = []
        self.read_error: Exception | None = None
        self.retrieval_error: Exception | None = None
        self.write_error: Exception | None = None

    def get_last_k_turns(
        self,
        memory_id: str,
        actor_id: str,
        session_id: str,
        k: int = 5,
    ) -> list[list[dict[str, object]]]:
        if self.read_error:
            raise self.read_error
        self.reads.append(
            {
                "memory_id": memory_id,
                "actor_id": actor_id,
                "session_id": session_id,
                "k": k,
            }
        )
        return self.turns

    def retrieve_memories(
        self,
        memory_id: str,
        namespace: str | None = None,
        query: str | None = None,
        actor_id: str | None = None,
        top_k: int = 3,
        namespace_path: str | None = None,
    ) -> list[dict[str, object]]:
        if self.retrieval_error:
            raise self.retrieval_error
        self.retrievals.append(
            {
                "memory_id": memory_id,
                "namespace": namespace,
                "query": query,
                "actor_id": actor_id,
                "top_k": top_k,
                "namespace_path": namespace_path,
            }
        )
        return self.memories

    def create_event(
        self,
        memory_id: str,
        actor_id: str,
        session_id: str,
        messages: list[tuple[str, str]],
        extraction_mode: str | None = None,
    ) -> dict[str, object]:
        if self.write_error:
            raise self.write_error
        self.created.append(
            {
                "memory_id": memory_id,
                "actor_id": actor_id,
                "session_id": session_id,
                "messages": messages,
                "extraction_mode": extraction_mode,
            }
        )
        return {"eventId": "event-1"}


def make_memory(
    client: FakeMemoryClient,
    *,
    long_term: bool = False,
) -> AgentCoreConversationMemory:
    return AgentCoreConversationMemory(
        MEMORY_ID,
        "ap-northeast-1",
        client,
        USER_NAMESPACE_TEMPLATE if long_term else None,
    )


def test_memory_is_disabled_when_environment_id_is_absent() -> None:
    assert AgentCoreConversationMemory.from_environment({}) is None


def test_memory_configuration_requires_region_and_resource_id() -> None:
    with pytest.raises(MemoryConfigurationError, match="BIZFLOW_AWS_REGION"):
        AgentCoreConversationMemory.from_environment(
            {"BIZFLOW_MEMORY_ID": MEMORY_ID}
        )

    with pytest.raises(MemoryConfigurationError, match="actorId"):
        AgentCoreConversationMemory(
            MEMORY_ID,
            "ap-northeast-1",
            FakeMemoryClient(),
            "/users/unscoped/preferences/",
        )

    with pytest.raises(MemoryConfigurationError, match="resource ID"):
        AgentCoreConversationMemory(
            "arn:aws:bedrock-agentcore:ap-northeast-1:111122223333:memory/example",
            "ap-northeast-1",
            FakeMemoryClient(),
        )


def test_load_context_uses_only_bounded_conversational_history() -> None:
    client = FakeMemoryClient()
    client.turns = [
        [
            {"role": "USER", "content": {"text": "担当者は田中さんです"}},
            {"role": "ASSISTANT", "content": {"text": "記憶しました"}},
            {"role": "TOOL", "content": {"text": "ignored"}},
        ]
    ]

    context = make_memory(client).load_context("担当者を教えて", SESSION_ID)

    assert context.turn_count == 1
    assert "担当者は田中さんです" in context.prompt
    assert "記憶しました" in context.prompt
    assert "ignored" not in context.prompt
    assert "untrusted conversation history" in context.prompt
    assert "<current_request>担当者を教えて</current_request>" in context.prompt
    assert client.reads[0]["actor_id"] == f"bizflow-session/{SESSION_ID}"


def test_save_turn_uses_session_scoped_actor_and_skips_extraction() -> None:
    client = FakeMemoryClient()

    make_memory(client).save_turn(SESSION_ID, "remember this", "remembered")

    assert client.created == [
        {
            "memory_id": MEMORY_ID,
            "actor_id": f"bizflow-session/{SESSION_ID}",
            "session_id": SESSION_ID,
            "messages": [("remember this", "USER"), ("remembered", "ASSISTANT")],
            "extraction_mode": "SKIP",
        }
    ]


def test_trusted_user_loads_preferences_and_enables_extraction() -> None:
    client = FakeMemoryClient()
    client.memories = [
        {"content": {"text": "回答は日本語を優先する"}},
        {"content": {"text": "期限はAsia/Tokyoで表示する"}},
    ]
    memory = make_memory(client, long_term=True)

    context = memory.load_context(
        "表示設定を確認して",
        SESSION_ID,
        RUNTIME_USER_ID,
    )
    memory.save_turn(
        SESSION_ID,
        "回答は日本語を優先して",
        "承知しました",
        RUNTIME_USER_ID,
    )

    expected_namespace = f"/users/{RUNTIME_USER_ID}/preferences/"
    assert context.user_scoped is True
    assert context.preference_count == 2
    assert "回答は日本語を優先する" in context.prompt
    assert "untrusted remembered user preferences" in context.prompt
    assert client.reads[0]["actor_id"] == RUNTIME_USER_ID
    assert client.retrievals == [
        {
            "memory_id": MEMORY_ID,
            "namespace": expected_namespace,
            "query": "表示設定を確認して",
            "actor_id": None,
            "top_k": 3,
            "namespace_path": None,
        }
    ]
    assert client.created[0]["actor_id"] == RUNTIME_USER_ID
    assert client.created[0]["extraction_mode"] is None


def test_user_namespaces_are_isolated_and_do_not_accept_untrusted_ids() -> None:
    other_user = f"bizflow-user-{'b' * 64}"
    assert render_user_preference_namespace(
        USER_NAMESPACE_TEMPLATE,
        RUNTIME_USER_ID,
    ) != render_user_preference_namespace(USER_NAMESPACE_TEMPLATE, other_user)

    with pytest.raises(MemoryOperationError, match="user ID"):
        validate_runtime_user_id("cognito:user-controlled-value")


def test_preference_context_is_bounded() -> None:
    client = FakeMemoryClient()
    client.memories = [
        {"content": {"text": str(index) * 5_000}}
        for index in range(1, 10)
    ]

    context = make_memory(client, long_term=True).load_context(
        "hello",
        SESSION_ID,
        RUNTIME_USER_ID,
    )

    assert context.preference_count <= 3
    preference_section = context.prompt.split(
        "<long_term_user_preferences>",
        maxsplit=1,
    )[1].split("</long_term_user_preferences>", maxsplit=1)[0]
    assert len(preference_section) <= MAX_PREFERENCE_CHARACTERS + 32


def test_save_turn_bounds_payload_size() -> None:
    client = FakeMemoryClient()

    make_memory(client).save_turn(SESSION_ID, "u" * 20_000, "a" * 20_000)

    messages = client.created[0]["messages"]
    assert isinstance(messages, list)
    assert len(messages[0][0]) == MAX_STORED_MESSAGE_CHARACTERS
    assert len(messages[1][0]) == MAX_STORED_MESSAGE_CHARACTERS


def test_memory_errors_are_sanitized() -> None:
    client = FakeMemoryClient()
    client.read_error = RuntimeError("sensitive read detail")
    with pytest.raises(MemoryOperationError) as read_error:
        make_memory(client).load_context("hello", SESSION_ID)
    assert "sensitive read detail" not in str(read_error.value)

    client.write_error = RuntimeError("sensitive write detail")
    with pytest.raises(MemoryOperationError) as write_error:
        make_memory(client).save_turn(SESSION_ID, "hello", "world")
    assert "sensitive write detail" not in str(write_error.value)


def test_missing_session_history_is_treated_as_empty() -> None:
    client = FakeMemoryClient()
    client.read_error = ClientError(
        {
            "Error": {
                "Code": "ResourceNotFoundException",
                "Message": "session has no events",
            }
        },
        "ListEvents",
    )

    context = make_memory(client).load_context("first turn", SESSION_ID)

    assert context.prompt == "first turn"
    assert context.turn_count == 0


def test_runtime_session_id_is_validated_before_memory_access() -> None:
    with pytest.raises(MemoryOperationError, match="session ID"):
        actor_id_for_session("invalid session id")
