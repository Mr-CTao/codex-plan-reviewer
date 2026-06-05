#!/usr/bin/env python3
"""Plan Reviewer surrogate 清洗回归验证脚本。

职责说明：
本脚本只用于本地 targeted verification，不参与 MCP 服务运行。它用临时状态目录构造
包含中文、emoji 和孤立 surrogate 的输入，验证状态持久化、HTTP JSON 响应、MCP tool
result 与 JSON-RPC stdout 都不会再触发 UTF-8 surrogate 编码错误。
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
from http import HTTPStatus
from pathlib import Path
from typing import Any

from plan_reviewer_mcp import (
    PlanReviewerMcpServer,
    ReviewHttpHandler,
    ReviewStore,
    safe_json_dumps,
    sanitize_for_json,
)


DIRTY_TEXT = "中文保留 emoji😀 surrogate:\udc8e 完成"
EXPECTED_TEXT = "中文保留 emoji😀 surrogate:\ufffd 完成"


def assert_no_surrogate(value: Any) -> None:
    """递归断言数据中不存在 U+D800 到 U+DFFF 范围内的非法 surrogate。"""
    if isinstance(value, str):
        if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
            raise AssertionError(f"found surrogate in {value!r}")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            assert_no_surrogate(key)
            assert_no_surrogate(item)
        return
    if isinstance(value, list):
        for item in value:
            assert_no_surrogate(item)


def assert_json_round_trips(value: Any) -> Any:
    """确认数据可以安全编码为 UTF-8 JSON，并能被 json.loads 重新读取。"""
    dumped = safe_json_dumps(value)
    dumped.encode("utf-8")
    loaded = json.loads(dumped)
    assert_no_surrogate(loaded)
    return loaded


def verify_store_workflow() -> None:
    """验证 session、clarification 和 plan review 持久化路径会清洗非法 surrogate。"""
    with tempfile.TemporaryDirectory(prefix="plan-reviewer-surrogate-") as temp_dir:
        state_dir = Path(temp_dir)
        store = ReviewStore(state_dir)

        session = store.create_session(
            title=f"标题 {DIRTY_TEXT}",
            original_request=f"原始需求 {DIRTY_TEXT}",
        )
        assert session["title"] == f"标题 {EXPECTED_TEXT}"
        assert session["originalRequest"] == f"原始需求 {EXPECTED_TEXT}"

        session = store.publish_session_clarification(
            session_id=session["id"],
            title=f"澄清 {DIRTY_TEXT}",
            question=f"问题 {DIRTY_TEXT}",
            known_context=f"上下文 {DIRTY_TEXT}",
            options=[
                {
                    "label": "A",
                    "title": f"选项 {DIRTY_TEXT}",
                    "description": f"说明 {DIRTY_TEXT}",
                    "recommended": True,
                    "recommendationReason": f"理由 {DIRTY_TEXT}",
                }
            ],
            allow_freeform=True,
            confidence_target=95,
        )
        clarification_item_id = session["activeItemId"]

        store.answer_session_clarification(
            session_id=session["id"],
            item_id=clarification_item_id,
            answer={"finalAnswer": f"回答 {DIRTY_TEXT}"},
        )
        session = store.publish_session_plan_review(
            session_id=session["id"],
            title=f"计划 {DIRTY_TEXT}",
            plan_markdown=f"# 计划 {DIRTY_TEXT}\n\n- 正常中文必须保留。",
            iteration=1,
            known_context=f"计划上下文 {DIRTY_TEXT}",
        )

        assert_json_round_trips(session)
        state_text = (state_dir / "reviews.json").read_text(encoding="utf-8")
        state_text.encode("utf-8")
        loaded_state = json.loads(state_text)
        assert_no_surrogate(loaded_state)
        if "中文保留" not in state_text or "emoji😀" not in state_text:
            raise AssertionError("normal Chinese or emoji text was not preserved")
        if "\\udc8e" in state_text.lower() or "\udc8e" in loaded_state["sessions"][session["id"]]["title"]:
            raise AssertionError("surrogate was not replaced in persisted state")
        if "\ufffd" not in state_text:
            raise AssertionError("replacement character was not persisted")


def verify_existing_state_repair() -> None:
    """验证启动加载历史 reviews.json 时会备份并修复已转义的 surrogate。"""
    with tempfile.TemporaryDirectory(prefix="plan-reviewer-repair-") as temp_dir:
        state_dir = Path(temp_dir)
        state_dir.mkdir(parents=True, exist_ok=True)
        state_path = state_dir / "reviews.json"
        state_path.write_text(
            (
                '{"reviews":{"old":{"id":"old","title":"历史中文 \\udc8e"}},'
                '"clarifications":{},"sessions":{}}'
            ),
            encoding="utf-8",
        )

        store = ReviewStore(state_dir)
        repaired = store.get_review("old")
        if repaired["title"] != "历史中文 \ufffd":
            raise AssertionError("existing escaped surrogate state was not repaired")
        backups = list(state_dir.glob("reviews.json.surrogate-sanitized.*.bak"))
        if not backups:
            raise AssertionError("state repair did not create a backup file")


class DummyHttpHandler:
    """最小 HTTP handler 替身，用于直接验证 ReviewHttpHandler._send_json。"""

    _send_json = ReviewHttpHandler._send_json

    def __init__(self) -> None:
        """初始化响应捕获缓冲区。"""
        self.headers: dict[str, str] = {}
        self.sent_headers: list[tuple[str, str]] = []
        self.status: HTTPStatus | None = None
        self.ended = False
        self.wfile = io.BytesIO()

    def send_response(self, status: HTTPStatus) -> None:
        """记录 HTTP 状态码。"""
        self.status = status

    def send_header(self, name: str, value: str) -> None:
        """记录 HTTP 响应头。"""
        self.sent_headers.append((name, value))

    def end_headers(self) -> None:
        """标记响应头已经结束。"""
        self.ended = True

    def _send_cors_headers(self) -> None:
        """测试替身不模拟跨域来源，因此无需写 CORS 头。"""


def verify_http_json_boundary() -> None:
    """验证 HTTP JSON 响应体在 UTF-8 编码前已经清洗非法 surrogate。"""
    handler = DummyHttpHandler()
    handler._send_json({"message": DIRTY_TEXT}, HTTPStatus.OK)
    loaded = json.loads(handler.wfile.getvalue().decode("utf-8"))
    assert_no_surrogate(loaded)
    if loaded["message"] != EXPECTED_TEXT:
        raise AssertionError("HTTP JSON response did not replace the surrogate")


class FakePanel:
    """MCP server 测试替身；本验证只触发响应包装，不启动真实面板。"""


def verify_mcp_response_boundaries() -> None:
    """验证 MCP structuredContent/content 和 JSON-RPC stdout 都能安全编码。"""
    with tempfile.TemporaryDirectory(prefix="plan-reviewer-mcp-") as temp_dir:
        server = PlanReviewerMcpServer(ReviewStore(Path(temp_dir)), FakePanel())  # type: ignore[arg-type]

        utf8_message = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"arguments": {"title": "中文输入 emoji😀"}},
        }
        utf8_line = (json.dumps(utf8_message, ensure_ascii=False) + "\n").encode("utf-8")
        decoded_message = json.loads(server._decode_stdin_line(utf8_line))
        if decoded_message["params"]["arguments"]["title"] != "中文输入 emoji😀":
            raise AssertionError("MCP stdin UTF-8 input was decoded incorrectly")

        escaped_surrogate_line = (json.dumps({"text": DIRTY_TEXT}, ensure_ascii=True) + "\n").encode("utf-8")
        sanitized_message = sanitize_for_json(json.loads(server._decode_stdin_line(escaped_surrogate_line)))
        if sanitized_message["text"] != EXPECTED_TEXT:
            raise AssertionError("MCP stdin escaped surrogate was not sanitized")

        tool_result = server._tool_result({"message": DIRTY_TEXT})
        assert_no_surrogate(tool_result)
        loaded_text_content = json.loads(tool_result["content"][0]["text"])
        assert_no_surrogate(loaded_text_content)
        if tool_result["structuredContent"]["message"] != EXPECTED_TEXT:
            raise AssertionError("MCP structuredContent did not replace the surrogate")

        buffer = io.BytesIO()
        writer = io.TextIOWrapper(buffer, encoding="utf-8", newline="\n")
        original_stdout = sys.stdout
        try:
            sys.stdout = writer
            server._write_response(
                {
                    "jsonrpc": "2.0",
                    "id": DIRTY_TEXT,
                    "result": {"content": [{"type": "text", "text": DIRTY_TEXT}]},
                }
            )
            writer.flush()
        finally:
            sys.stdout = original_stdout
        decoded_response = buffer.getvalue().decode("utf-8")
        loaded_response = json.loads(decoded_response)
        assert_no_surrogate(loaded_response)
        if loaded_response["id"] != EXPECTED_TEXT:
            raise AssertionError("JSON-RPC stdout response did not replace the surrogate")


def main() -> None:
    """执行全部 surrogate 清洗回归验证。"""
    verify_store_workflow()
    verify_existing_state_repair()
    verify_http_json_boundary()
    verify_mcp_response_boundaries()
    print("surrogate sanitization verification passed")


if __name__ == "__main__":
    main()
