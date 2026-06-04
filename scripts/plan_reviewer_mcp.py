#!/usr/bin/env python3
"""Plan Reviewer MCP 服务。

职责说明：
本模块同时承担两个边界清晰的职责：第一，通过 MCP STDIO 协议向 Codex
暴露创建计划审阅、读取批注结果、等待用户提交等工具；第二，在本地启动一个
只绑定 localhost 的 HTTP 面板，让用户可以在浏览器中对 Markdown 计划草案做
段落级批注。

并发与线程安全决策：
MCP 工具调用和 HTTP 请求可能在同一个进程内并发发生，因此 ReviewStore 使用
RLock 保护内存状态；由于 Codex 可能在插件升级、CLI 兜底或多轮审阅时留下多个
本地面板进程，ReviewStore 还会用 reviews.lock 做跨进程文件锁，把“读-改-写”
包成一个本地事务，避免多个进程同时覆盖 reviews.json。
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
import sys
import threading
import time
import uuid
import webbrowser
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlparse

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows 不提供 fcntl。
    fcntl = None  # type: ignore[assignment]

try:
    import msvcrt
except ImportError:  # pragma: no cover - macOS/Linux 不提供 msvcrt。
    msvcrt = None  # type: ignore[assignment]


PLUGIN_VERSION_FALLBACK = "0.1.0"
DEFAULT_PORT = 47891
MAX_PORT_ATTEMPTS = 50
MAX_REQUEST_BYTES = 1_048_576
COMPLETED_STATUSES = {"needs_revision", "approved"}
CLARIFICATION_COMPLETED_STATUSES = {"answered"}
SESSION_USER_ACTION_STATUSES = {"waiting_codex", "approved"}
PANEL_APPROVED_SHUTDOWN_DELAY_SECONDS = 90.0
DEFAULT_HISTORY_KEEP_RECORDS = 50
DEFAULT_PRUNE_DAYS = 30
LOCAL_CORS_HOSTS = {"127.0.0.1", "localhost", "::1"}
DEFAULT_FREEFORM_OPTION_LABEL = "D"
DEFAULT_FREEFORM_OPTION_TITLE = "其他"
SESSION_POLL_SECONDS = 1.0


def utc_now_iso() -> str:
    """返回 UTC ISO 时间字符串，便于前端和 Codex 做稳定排序。"""
    return datetime.now(timezone.utc).isoformat()


def get_plugin_root() -> Path:
    """根据脚本位置推导插件根目录，避免依赖 Codex 启动时的工作目录。"""
    return Path(__file__).resolve().parents[1]


def get_plugin_version() -> str:
    """读取当前安装插件 manifest 版本。

    Returns:
        `.codex-plugin/plugin.json` 中的 version；读取失败时返回稳定兜底版本。

    设计意图：插件开发时会通过 cachebuster 更新 manifest 版本。MCP initialize 也返回
    这个版本，方便用户排查当前线程到底加载了哪一版插件。
    """
    manifest_path = get_plugin_root() / ".codex-plugin" / "plugin.json"
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        version = str(payload.get("version") or "").strip()
        return version or PLUGIN_VERSION_FALLBACK
    except Exception as exc:  # noqa: BLE001
        print(f"[plan-reviewer] failed to read plugin version: {exc}", file=sys.stderr)
        return PLUGIN_VERSION_FALLBACK


def get_default_state_dir() -> Path:
    """返回插件状态目录。

    优先使用 CODEX_HOME，保持和 Codex 本地状态放在一起；没有配置时使用
    ~/.codex/plan-reviewer。该目录只保存计划草案和用户批注，不保存密钥。
    """
    codex_home = os.environ.get("CODEX_HOME")
    base_dir = Path(codex_home).expanduser() if codex_home else Path.home() / ".codex"
    return base_dir / "plan-reviewer"


def safe_json_dumps(payload: Any) -> str:
    """以 UTF-8 可读形式序列化 JSON，便于 Codex 在工具结果中直接解析。"""
    return json.dumps(payload, ensure_ascii=False, indent=2)


def open_url_in_background(url: str) -> None:
    """在后台线程打开本地审阅面板 URL。

    设计意图：macOS 默认浏览器可能因为应用唤起、权限弹窗或浏览器进程响应慢而阻塞
    `webbrowser.open`。MCP 工具调用必须尽快把 reviewId 和 URL 返回给 Codex，因此这里
    使用 daemon 线程隔离打开浏览器动作；即使浏览器启动失败，也不影响审阅记录创建和
    后续等待流程。
    """

    def _open() -> None:
        """执行实际浏览器打开动作，并把异常写到 stderr 供排查。"""
        try:
            webbrowser.open(url)
        except Exception as exc:  # noqa: BLE001
            print(f"[plan-reviewer] failed to open browser: {exc}", file=sys.stderr)

    threading.Thread(target=_open, name="plan-reviewer-open-browser", daemon=True).start()


@dataclass(frozen=True)
class ReviewResult:
    """MCP 工具返回给 Codex 的审阅结果摘要。"""

    review_id: str
    status: str
    url: str
    panel_running: bool
    annotations: list[dict[str, Any]]
    general_note: str

    def to_dict(self) -> dict[str, Any]:
        """转换为普通字典，方便 JSON 序列化。"""
        return {
            "reviewId": self.review_id,
            "status": self.status,
            "url": self.url,
            "panelRunning": self.panel_running,
            "annotations": self.annotations,
            "generalNote": self.general_note,
        }


@dataclass(frozen=True)
class ClarificationResult:
    """MCP 工具返回给 Codex 的需求澄清结果摘要。"""

    clarification_id: str
    status: str
    url: str
    panel_running: bool
    question: str
    answer: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        """转换为普通字典，方便 JSON 序列化。"""
        return {
            "clarificationId": self.clarification_id,
            "status": self.status,
            "url": self.url,
            "panelRunning": self.panel_running,
            "question": self.question,
            "answer": self.answer,
        }


@dataclass(frozen=True)
class SessionResult:
    """MCP 工具返回给 Codex 的持续工作流会话摘要。"""

    session: dict[str, Any]
    url: str
    panel_running: bool

    def to_dict(self) -> dict[str, Any]:
        """转换为普通字典，方便 JSON 序列化。"""
        return {
            "session": self.session,
            "url": self.url,
            "panelRunning": self.panel_running,
            "lastUserAction": self.session.get("lastUserAction") or {},
        }


class ReviewStore:
    """计划审阅记录存储。

    存储格式是一个小型 JSON 文件，第一版用它换取零依赖和容易排查；写入时使用
    os.replace 做原子替换，降低进程崩溃导致半截 JSON 的概率。考虑到旧面板服务
    可能继续占用端口，所有对外读写都会先重载磁盘文件，确保跨进程可见性。
    """

    def __init__(self, state_dir: Path) -> None:
        """初始化存储。

        Args:
            state_dir: 保存 reviews.json 的目录。
        """
        self.state_dir = state_dir
        self.state_path = state_dir / "reviews.json"
        self.lock_path = state_dir / "reviews.lock"
        self._lock = threading.RLock()
        self._state: dict[str, Any] = {"reviews": {}, "clarifications": {}, "sessions": {}}
        self._initialize_state()

    def _initialize_state(self) -> None:
        """首次加载状态文件；缺失时在跨进程锁内创建空文件。"""
        with self._lock, self._state_file_lock():
            if not self._load_from_disk_locked():
                self._save_locked()

    @contextmanager
    def _state_file_lock(self) -> Any:
        """获取跨进程状态文件锁。

        Yields:
            已持有锁的文件句柄。

        设计意图：`os.replace` 只能保证单次替换原子，不能保护“读旧状态、修改、写回”
        这个复合操作。这里用独立 lock 文件把复合写操作串行化，防止多个面板进程互相
        覆盖用户批注。macOS/Linux 走 `fcntl.flock`，Windows 走 `msvcrt.locking`；
        极少数两者都不可用的环境才退化为进程内锁。
        """
        self.state_dir.mkdir(parents=True, exist_ok=True)
        with self.lock_path.open("a+", encoding="utf-8") as lock_file:
            self._acquire_cross_process_lock(lock_file)
            try:
                yield lock_file
            finally:
                self._release_cross_process_lock(lock_file)

    def _acquire_cross_process_lock(self, lock_file: Any) -> None:
        """获取平台相关的跨进程文件锁。

        Args:
            lock_file: `reviews.lock` 文件句柄。

        设计意图：Windows 不支持 `fcntl`，但 `msvcrt.locking` 可以锁定文件中的字节区间。
        锁定前写入一个哨兵字节，是为了保证要锁定的第一个字节存在，避免空文件在不同
        Python/Windows 组合上出现不可预期行为。
        """
        if fcntl is not None:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            return

        if msvcrt is not None:
            lock_file.seek(0, os.SEEK_END)
            if lock_file.tell() == 0:
                lock_file.write("\0")
                lock_file.flush()
            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)

    def _release_cross_process_lock(self, lock_file: Any) -> None:
        """释放平台相关的跨进程文件锁。"""
        if fcntl is not None:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            return

        if msvcrt is not None:
            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)

    def _load_from_disk_locked(self) -> bool:
        """从磁盘加载状态。

        Returns:
            文件存在且成功读取时返回 True；文件不存在时返回 False。
        """
        self.state_dir.mkdir(parents=True, exist_ok=True)
        if not self.state_path.exists():
            self._state = {"reviews": {}, "clarifications": {}, "sessions": {}}
            return False

        try:
            self._state = json.loads(self.state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Plan Reviewer 状态文件损坏: {self.state_path}") from exc

        if not isinstance(self._state.get("reviews"), dict):
            raise RuntimeError("Plan Reviewer 状态文件缺少 reviews 对象。")
        if not isinstance(self._state.get("clarifications"), dict):
            # 老版本状态文件没有 clarifications；首次加载时补空对象，保持向后兼容。
            self._state["clarifications"] = {}
        if not isinstance(self._state.get("sessions"), dict):
            # Session 模式是后续新增能力；老状态文件首次加载时补空对象。
            self._state["sessions"] = {}
        return True

    def _refresh_locked(self) -> None:
        """在每次对外读写前同步磁盘状态。

        设计意图：Plan Reviewer 的 HTTP 面板进程可能比 MCP 进程活得更久。下一轮草案
        如果由新的 MCP 进程写入 reviews.json，旧 HTTP 进程的内存状态会过期；这里强制
        重新加载磁盘，优先保证用户打开旧端口时也能看到新 reviewId。
        """
        self._load_from_disk_locked()

    def _save_locked(self) -> None:
        """在持有锁时保存状态，避免并发 HTTP 请求互相覆盖。"""
        self.state_dir.mkdir(parents=True, exist_ok=True)
        tmp_path = self.state_path.with_suffix(".json.tmp")
        tmp_path.write_text(safe_json_dumps(self._state), encoding="utf-8")
        os.replace(tmp_path, self.state_path)

    def create_review(self, title: str, plan_markdown: str, iteration: int | None) -> dict[str, Any]:
        """创建新的计划草案审阅记录。

        Args:
            title: 面板中展示的审阅标题。
            plan_markdown: Codex 生成的 Markdown 计划草案。
            iteration: 可选迭代序号，便于同一任务多轮对比。

        Returns:
            新创建的审阅记录。

        Raises:
            ValueError: 当计划草案为空时抛出，避免创建不可审阅的记录。
        """
        normalized_plan = plan_markdown.strip()
        if not normalized_plan:
            raise ValueError("plan_markdown 不能为空。")

        review_id = uuid.uuid4().hex[:12]
        now = utc_now_iso()
        review = {
            "id": review_id,
            "title": title.strip() or "Codex Plan Draft",
            "planMarkdown": normalized_plan,
            "iteration": iteration,
            "status": "pending",
            "annotations": [],
            "generalNote": "",
            "createdAt": now,
            "updatedAt": now,
        }

        with self._lock, self._state_file_lock():
            self._refresh_locked()
            self._state["reviews"][review_id] = review
            self._save_locked()
            return dict(review)

    def get_review(self, review_id: str) -> dict[str, Any]:
        """按 ID 读取审阅记录。

        Args:
            review_id: create_plan_review 返回的审阅 ID。

        Returns:
            审阅记录副本。

        Raises:
            KeyError: 当指定审阅不存在时抛出。
        """
        with self._lock:
            self._refresh_locked()
            review = self._state["reviews"].get(review_id)
            if review is None:
                raise KeyError(f"未找到审阅记录: {review_id}")
            return json.loads(json.dumps(review, ensure_ascii=False))

    def list_reviews(self, limit: int) -> list[dict[str, Any]]:
        """列出最近的审阅记录。

        Args:
            limit: 返回数量上限。

        Returns:
            按更新时间倒序排列的审阅摘要列表。
        """
        bounded_limit = max(1, min(limit, 50))
        with self._lock:
            self._refresh_locked()
            reviews = list(self._state["reviews"].values())
        reviews.sort(key=lambda item: item.get("updatedAt", ""), reverse=True)
        return [
            {
                "id": item["id"],
                "title": item.get("title", ""),
                "status": item.get("status", "pending"),
                "iteration": item.get("iteration"),
                "createdAt": item.get("createdAt"),
                "updatedAt": item.get("updatedAt"),
            }
            for item in reviews[:bounded_limit]
        ]

    def create_clarification(
        self,
        title: str,
        question: str,
        original_request: str,
        known_context: str,
        options: list[dict[str, Any]],
        allow_freeform: bool = True,
        confidence_target: int = 95,
    ) -> dict[str, Any]:
        """创建单轮需求澄清记录。

        Args:
            title: 面板标题。
            question: 本轮只向用户提出的一个问题。
            original_request: 用户原始需求摘要，帮助用户确认上下文。
            known_context: Codex 已经理解的上下文。
            options: 可选答案列表；多选场景建议只传 A/B/C，D 由面板作为“其他”输入兜底。
            allow_freeform: 是否允许用户输入自定义答案。
            confidence_target: 目标理解置信度，默认 95。

        Returns:
            新创建的需求澄清记录。

        Raises:
            ValueError: question 为空时抛出。

        并发说明：创建澄清记录会写共享状态文件，和计划审阅共用跨进程文件锁。
        """
        normalized_question = question.strip()
        if not normalized_question:
            raise ValueError("question 不能为空。")

        clarification_id = uuid.uuid4().hex[:12]
        now = utc_now_iso()
        clarification = {
            "id": clarification_id,
            "title": title.strip() or "需求澄清",
            "question": normalized_question,
            "originalRequest": str(original_request or "").strip()[:8000],
            "knownContext": str(known_context or "").strip()[:8000],
            "options": self._clean_clarification_options(options),
            "allowFreeform": bool(allow_freeform),
            "confidenceTarget": max(1, min(int(confidence_target or 95), 100)),
            "status": "pending",
            "answer": {},
            "createdAt": now,
            "updatedAt": now,
        }

        with self._lock, self._state_file_lock():
            self._refresh_locked()
            self._state["clarifications"][clarification_id] = clarification
            self._save_locked()
            return dict(clarification)

    def get_clarification(self, clarification_id: str) -> dict[str, Any]:
        """按 ID 读取需求澄清记录。

        Args:
            clarification_id: create_requirement_clarification 返回的澄清 ID。

        Returns:
            需求澄清记录副本。

        Raises:
            KeyError: 当指定记录不存在时抛出。
        """
        with self._lock:
            self._refresh_locked()
            clarification = self._state["clarifications"].get(clarification_id)
            if clarification is None:
                raise KeyError(f"未找到需求澄清记录: {clarification_id}")
            return json.loads(json.dumps(clarification, ensure_ascii=False))

    def answer_clarification(self, clarification_id: str, answer: dict[str, Any]) -> dict[str, Any]:
        """保存用户对单轮需求澄清问题的回答。

        Args:
            clarification_id: 澄清记录 ID。
            answer: 前端提交的答案，包括选项标签和自定义文本。

        Returns:
            更新后的澄清记录。

        Raises:
            KeyError: 当指定记录不存在时抛出。
            ValueError: 当答案为空时抛出。
        """
        cleaned_answer = self._clean_clarification_answer(answer)
        if not cleaned_answer.get("finalAnswer"):
            raise ValueError("请先选择一个选项或填写你的意见。")

        with self._lock, self._state_file_lock():
            self._refresh_locked()
            clarification = self._state["clarifications"].get(clarification_id)
            if clarification is None:
                raise KeyError(f"未找到需求澄清记录: {clarification_id}")
            cleaned_answer["answeredAt"] = utc_now_iso()
            clarification["answer"] = cleaned_answer
            clarification["status"] = "answered"
            clarification["updatedAt"] = utc_now_iso()
            self._save_locked()
            return dict(clarification)

    def create_session(self, title: str, original_request: str) -> dict[str, Any]:
        """创建持续工作流会话。

        Args:
            title: 面板标题。
            original_request: 用户原始需求或任务摘要。

        Returns:
            新创建的 session 记录。

        并发说明：Session 是面板和 Codex 共同读写的状态对象，创建时持有跨进程文件锁。
        """
        session_id = uuid.uuid4().hex[:12]
        now = utc_now_iso()
        session = {
            "id": session_id,
            "title": title.strip() or "Plan Reviewer Session",
            "originalRequest": str(original_request or "").strip()[:10000],
            "status": "waiting_codex",
            "activeItemId": "",
            "items": [],
            "lastUserAction": {},
            "actionSeq": 0,
            "codexSeq": 0,
            "createdAt": now,
            "updatedAt": now,
        }
        with self._lock, self._state_file_lock():
            self._refresh_locked()
            self._state["sessions"][session_id] = session
            self._save_locked()
            return json.loads(json.dumps(session, ensure_ascii=False))

    def get_session(self, session_id: str) -> dict[str, Any]:
        """按 ID 读取持续工作流会话。

        Args:
            session_id: create_plan_workflow_session 返回的会话 ID。

        Returns:
            session 记录副本。

        Raises:
            KeyError: 指定会话不存在时抛出。
        """
        with self._lock:
            self._refresh_locked()
            session = self._state["sessions"].get(session_id)
            if session is None:
                raise KeyError(f"未找到工作流会话: {session_id}")
            return json.loads(json.dumps(session, ensure_ascii=False))

    def publish_session_clarification(
        self,
        session_id: str,
        title: str,
        question: str,
        known_context: str,
        options: list[dict[str, Any]],
        allow_freeform: bool = True,
        confidence_target: int = 95,
    ) -> dict[str, Any]:
        """把下一轮需求澄清问题发布到同一个持续会话。

        Args:
            session_id: 工作流会话 ID。
            title: 本轮问题标题。
            question: 本轮只向用户提出的一个问题。
            known_context: Codex 当前理解的上下文。
            options: 可选 A/B/C 方案。
            allow_freeform: 是否允许 D: 其他输入。
            confidence_target: 目标理解置信度。

        Returns:
            更新后的 session。
        """
        normalized_question = question.strip()
        if not normalized_question:
            raise ValueError("question 不能为空。")

        now = utc_now_iso()
        item = {
            "id": uuid.uuid4().hex[:10],
            "type": "clarification",
            "title": title.strip() or "需求澄清",
            "question": normalized_question,
            "knownContext": str(known_context or "").strip()[:8000],
            "options": self._clean_clarification_options(options),
            "allowFreeform": bool(allow_freeform),
            "confidenceTarget": max(1, min(int(confidence_target or 95), 100)),
            "status": "pending",
            "answer": {},
            "createdAt": now,
            "updatedAt": now,
        }
        return self._append_session_item(session_id, item, "waiting_user_clarification")

    def publish_session_plan_review(
        self,
        session_id: str,
        title: str,
        plan_markdown: str,
        iteration: int | None,
        known_context: str,
    ) -> dict[str, Any]:
        """把下一版计划草案发布到同一个持续会话。

        Args:
            session_id: 工作流会话 ID。
            title: 草案标题。
            plan_markdown: Markdown 计划草案。
            iteration: 草案迭代轮次。
            known_context: Codex 当前理解的上下文。

        Returns:
            更新后的 session。

        Raises:
            ValueError: plan_markdown 为空时抛出。
        """
        normalized_plan = plan_markdown.strip()
        if not normalized_plan:
            raise ValueError("plan_markdown 不能为空。")

        now = utc_now_iso()
        item = {
            "id": uuid.uuid4().hex[:10],
            "type": "plan_review",
            "title": title.strip() or "计划草案审阅",
            "planMarkdown": normalized_plan,
            "iteration": iteration,
            "knownContext": str(known_context or "").strip()[:8000],
            "status": "pending",
            "annotations": [],
            "generalNote": "",
            "createdAt": now,
            "updatedAt": now,
        }
        return self._append_session_item(session_id, item, "waiting_user_review")

    def answer_session_clarification(self, session_id: str, item_id: str, answer: dict[str, Any]) -> dict[str, Any]:
        """保存持续会话中当前澄清问题的用户回答。

        Args:
            session_id: 工作流会话 ID。
            item_id: 前端看到的当前 item ID，用于避免旧页面误提交。
            answer: 用户回答。

        Returns:
            更新后的 session。
        """
        cleaned_answer = self._clean_clarification_answer(answer)
        if not cleaned_answer.get("finalAnswer"):
            raise ValueError("请先选择一个选项或填写你的意见。")

        def mutate(session: dict[str, Any], item: dict[str, Any], now: str) -> None:
            """写入回答并记录等待 Codex 处理的用户动作。"""
            item["answer"] = {**cleaned_answer, "answeredAt": now}
            item["status"] = "answered"
            item["updatedAt"] = now
            self._record_session_user_action(
                session,
                "clarification_answered",
                item["id"],
                {"answer": item["answer"], "question": item.get("question", "")},
                now,
            )

        return self._mutate_active_session_item(session_id, item_id, "clarification", mutate)

    def submit_session_feedback(
        self,
        session_id: str,
        item_id: str,
        annotations: list[dict[str, Any]],
        general_note: str,
    ) -> dict[str, Any]:
        """保存持续会话中当前计划草案的批注。

        Args:
            session_id: 工作流会话 ID。
            item_id: 前端看到的当前 item ID。
            annotations: 段落批注列表。
            general_note: 整体意见。

        Returns:
            更新后的 session。
        """
        cleaned_annotations = [self._clean_annotation(item) for item in annotations]
        cleaned_general_note = str(general_note or "").strip()[:6000]
        if not cleaned_annotations and not cleaned_general_note:
            raise ValueError("请至少添加一条批注或填写整体意见。")

        def mutate(session: dict[str, Any], item: dict[str, Any], now: str) -> None:
            """写入批注并记录等待 Codex 重写草案的用户动作。"""
            item["annotations"] = cleaned_annotations
            item["generalNote"] = cleaned_general_note
            item["status"] = "needs_revision"
            item["updatedAt"] = now
            self._record_session_user_action(
                session,
                "review_feedback_submitted",
                item["id"],
                {
                    "annotations": cleaned_annotations,
                    "generalNote": cleaned_general_note,
                    "planMarkdown": item.get("planMarkdown", ""),
                },
                now,
            )

        return self._mutate_active_session_item(session_id, item_id, "plan_review", mutate)

    def approve_session_plan(self, session_id: str, item_id: str) -> dict[str, Any]:
        """通过持续会话中的当前计划草案。

        Args:
            session_id: 工作流会话 ID。
            item_id: 前端看到的当前 item ID。

        Returns:
            更新后的 session。
        """

        def mutate(session: dict[str, Any], item: dict[str, Any], now: str) -> None:
            """标记计划通过，并记录最终用户动作。"""
            item["status"] = "approved"
            item["updatedAt"] = now
            self._record_session_user_action(
                session,
                "plan_approved",
                item["id"],
                {"planMarkdown": item.get("planMarkdown", "")},
                now,
                status="approved",
            )

        return self._mutate_active_session_item(session_id, item_id, "plan_review", mutate)

    def _append_session_item(self, session_id: str, item: dict[str, Any], status: str) -> dict[str, Any]:
        """向持续会话追加 Codex 发布的新步骤。

        Args:
            session_id: 工作流会话 ID。
            item: 本轮澄清问题或计划草案。
            status: 追加后 session 应进入的等待状态。

        Returns:
            更新后的 session 副本。

        Raises:
            KeyError: 指定 session 不存在时抛出。

        并发说明：Codex 发布下一步和用户在面板提交动作都写同一个 session，因此必须
        持有跨进程文件锁。发布新步骤时清空 `lastUserAction`，避免 Codex 误读上一轮
        用户动作；`codexSeq` 递增用于前端轮询判断是否需要重渲染。
        """
        with self._lock, self._state_file_lock():
            self._refresh_locked()
            session = self._state["sessions"].get(session_id)
            if session is None:
                raise KeyError(f"未找到工作流会话: {session_id}")

            now = utc_now_iso()
            item.setdefault("createdAt", now)
            item["updatedAt"] = now
            session.setdefault("items", []).append(item)
            session["activeItemId"] = item["id"]
            session["status"] = status
            session["lastUserAction"] = {}
            session["codexSeq"] = int(session.get("codexSeq") or 0) + 1
            session["updatedAt"] = now
            self._save_locked()
            return json.loads(json.dumps(session, ensure_ascii=False))

    def _mutate_active_session_item(
        self,
        session_id: str,
        item_id: str,
        expected_type: str,
        mutate: Callable[[dict[str, Any], dict[str, Any], str], None],
    ) -> dict[str, Any]:
        """校验并修改持续会话中的当前步骤。

        Args:
            session_id: 工作流会话 ID。
            item_id: 前端提交时看到的 item ID。
            expected_type: 当前步骤必须匹配的类型。
            mutate: 通过校验后执行的写入函数。

        Returns:
            更新后的 session 副本。

        Raises:
            KeyError: 指定 session 或当前步骤不存在时抛出。
            ValueError: 页面已过期、步骤类型错误或重复提交时抛出。

        设计意图：Session 面板会自动轮询刷新，用户可能在旧步骤刚被 Codex 替换时点到
        旧按钮。这里用 activeItemId 做乐观校验，阻止旧页面把回答写到新一轮草案里。
        """
        normalized_item_id = str(item_id or "")
        if not normalized_item_id:
            raise ValueError("缺少当前步骤 ID，请刷新面板后重试。")

        with self._lock, self._state_file_lock():
            self._refresh_locked()
            session = self._state["sessions"].get(session_id)
            if session is None:
                raise KeyError(f"未找到工作流会话: {session_id}")

            active_item_id = str(session.get("activeItemId") or "")
            if normalized_item_id != active_item_id:
                raise ValueError("当前面板内容已更新，请等待页面刷新后再提交。")

            item = self._find_session_item(session, active_item_id)
            if item is None:
                raise KeyError(f"未找到当前工作流步骤: {active_item_id}")
            if item.get("type") != expected_type:
                raise ValueError("当前工作流步骤类型不匹配，请刷新面板后重试。")
            if item.get("status") != "pending":
                raise ValueError("当前步骤已经提交，请等待 Codex 生成下一步。")

            now = utc_now_iso()
            mutate(session, item, now)
            session["updatedAt"] = now
            self._save_locked()
            return json.loads(json.dumps(session, ensure_ascii=False))

    def _find_session_item(self, session: dict[str, Any], item_id: str) -> dict[str, Any] | None:
        """在 session.items 中查找指定步骤，找不到时返回 None。"""
        for item in session.get("items") or []:
            if str(item.get("id") or "") == item_id:
                return item
        return None

    def _record_session_user_action(
        self,
        session: dict[str, Any],
        action_type: str,
        item_id: str,
        payload: dict[str, Any],
        now: str,
        status: str = "waiting_codex",
    ) -> None:
        """记录用户刚刚完成的动作，供 MCP wait 工具返回给 Codex。

        Args:
            session: 正在修改的 session 对象。
            action_type: 用户动作类型。
            item_id: 关联步骤 ID。
            payload: Codex 需要消费的动作内容。
            now: 服务端时间戳。
            status: 记录动作后的 session 状态。

        并发说明：调用方已经持有文件锁；这里只修改内存对象，不单独保存。`actionSeq`
        单调递增，Codex 可以用 `since_action_seq` 等待新动作，避免重复消费旧批注。
        """
        next_seq = int(session.get("actionSeq") or 0) + 1
        session["actionSeq"] = next_seq
        session["status"] = status
        session["lastUserAction"] = {
            "seq": next_seq,
            "type": action_type,
            "itemId": item_id,
            "payload": payload,
            "createdAt": now,
        }

    def apply_feedback(
        self,
        review_id: str,
        annotations: list[dict[str, Any]],
        general_note: str,
    ) -> dict[str, Any]:
        """保存用户批注并将审阅状态标记为需要重写。

        Args:
            review_id: 审阅 ID。
            annotations: 段落或选中文本批注列表。
            general_note: 面向整体计划的补充意见。

        Returns:
            更新后的审阅记录。

        Raises:
            KeyError: 当指定审阅不存在时抛出。
        """
        with self._lock, self._state_file_lock():
            self._refresh_locked()
            review = self._state["reviews"].get(review_id)
            if review is None:
                raise KeyError(f"未找到审阅记录: {review_id}")

            # 批注来自浏览器端，服务端只保留必要字段，避免把未知大对象写入状态文件。
            cleaned_annotations = [self._clean_annotation(item) for item in annotations]
            review["annotations"] = cleaned_annotations
            review["generalNote"] = str(general_note or "").strip()
            review["status"] = "needs_revision"
            review["updatedAt"] = utc_now_iso()
            self._save_locked()
            return dict(review)

    def approve_review(self, review_id: str) -> dict[str, Any]:
        """将审阅标记为通过，表示 Codex 可以输出正式 Plan。

        Args:
            review_id: 审阅 ID。

        Returns:
            更新后的审阅记录。

        Raises:
            KeyError: 当指定审阅不存在时抛出。
        """
        with self._lock, self._state_file_lock():
            self._refresh_locked()
            review = self._state["reviews"].get(review_id)
            if review is None:
                raise KeyError(f"未找到审阅记录: {review_id}")
            review["status"] = "approved"
            review["updatedAt"] = utc_now_iso()
            self._save_locked()
            return dict(review)

    def reopen_review(self, review_id: str) -> dict[str, Any]:
        """重新打开审阅，供用户撤销误点通过时使用。"""
        with self._lock, self._state_file_lock():
            self._refresh_locked()
            review = self._state["reviews"].get(review_id)
            if review is None:
                raise KeyError(f"未找到审阅记录: {review_id}")
            review["status"] = "pending"
            review["updatedAt"] = utc_now_iso()
            self._save_locked()
            return dict(review)

    def prune_reviews(
        self,
        keep_latest: int = DEFAULT_HISTORY_KEEP_RECORDS,
        older_than_days: int | None = DEFAULT_PRUNE_DAYS,
        include_pending: bool = False,
    ) -> dict[str, Any]:
        """修剪本地历史审阅记录。

        Args:
            keep_latest: 至少保留最近多少条记录。
            older_than_days: 删除早于该天数的记录；None 表示只按数量修剪。
            include_pending: 是否允许删除仍处于 pending 的记录。

        Returns:
            包含删除数量、保留数量和删除 ID 的摘要。

        并发说明：修剪会改变共享状态文件，因此与创建、提交、通过一样持有跨进程文件锁。
        """
        bounded_keep_latest = max(1, min(int(keep_latest), 500))
        bounded_days = None if older_than_days is None else max(1, min(int(older_than_days), 3650))
        cutoff = time.time() - bounded_days * 86400 if bounded_days is not None else None

        with self._lock, self._state_file_lock():
            self._refresh_locked()
            reviews = list(self._state["reviews"].values())
            reviews.sort(key=lambda item: item.get("updatedAt", ""), reverse=True)
            keep_ids = {item.get("id") for item in reviews[:bounded_keep_latest]}
            removed_ids: list[str] = []

            for review in reviews:
                review_id = str(review.get("id") or "")
                if not review_id or review_id in keep_ids:
                    continue
                if not include_pending and review.get("status", "pending") == "pending":
                    continue
                if cutoff is not None and self._review_timestamp(review) >= cutoff:
                    continue
                removed_ids.append(review_id)

            for review_id in removed_ids:
                self._state["reviews"].pop(review_id, None)

            if removed_ids:
                self._save_locked()

            return {
                "removed": len(removed_ids),
                "kept": len(self._state["reviews"]),
                "removedIds": removed_ids,
            }

    def clear_reviews(self, confirm: bool, include_pending: bool = False) -> dict[str, Any]:
        """清空本地审阅记录。

        Args:
            confirm: 必须显式为 True，避免误删历史批注。
            include_pending: 是否一并删除还未完成的 pending 记录。

        Returns:
            删除摘要。

        Raises:
            ValueError: confirm 不是 True 时抛出。
        """
        if not confirm:
            raise ValueError("清空审阅记录需要 confirm=true。")

        with self._lock, self._state_file_lock():
            self._refresh_locked()
            removed_ids = [
                str(review_id)
                for review_id, review in self._state["reviews"].items()
                if include_pending or review.get("status", "pending") != "pending"
            ]
            for review_id in removed_ids:
                self._state["reviews"].pop(review_id, None)
            if removed_ids:
                self._save_locked()
            return {
                "removed": len(removed_ids),
                "kept": len(self._state["reviews"]),
                "removedIds": removed_ids,
            }

    def _clean_annotation(self, annotation: dict[str, Any]) -> dict[str, Any]:
        """清洗单条批注字段，限制长度以避免状态文件被异常输入撑大。"""
        return {
            "id": str(annotation.get("id") or uuid.uuid4().hex[:10]),
            "blockId": str(annotation.get("blockId") or ""),
            "blockMarkdown": str(annotation.get("blockMarkdown") or "")[:4000],
            "selectedText": str(annotation.get("selectedText") or "")[:2000],
            "comment": str(annotation.get("comment") or "").strip()[:4000],
            "createdAt": str(annotation.get("createdAt") or utc_now_iso()),
        }

    def _clean_clarification_options(self, options: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """清洗需求澄清选项。

        Args:
            options: Codex 生成的选项列表。

        Returns:
            最多 6 个清洗后的选项。

        设计意图：选项来自模型生成而不是用户直接输入，但仍按外部输入处理，限制长度并
        统一 label/title/description/recommended/reason 字段，避免前端渲染复杂对象。
        """
        cleaned_options: list[dict[str, Any]] = []
        default_labels = ["A", "B", "C", "D", "E", "F"]
        for index, option in enumerate(options[:6]):
            label = str(option.get("label") or default_labels[index]).strip().upper()[:4]
            title = str(option.get("title") or option.get("name") or option.get("label") or "").strip()[:120]
            description = str(option.get("description") or option.get("content") or "").strip()[:2000]
            reason = str(option.get("recommendationReason") or option.get("reason") or "").strip()[:1000]
            if not title and not description:
                continue
            cleaned_options.append(
                {
                    "label": label,
                    "title": title or f"方案 {label}",
                    "description": description,
                    "recommended": bool(option.get("recommended")),
                    "recommendationReason": reason,
                }
            )
        return cleaned_options

    def _clean_clarification_answer(self, answer: dict[str, Any]) -> dict[str, Any]:
        """清洗用户需求澄清答案。

        Args:
            answer: 前端提交的答案对象。

        Returns:
            清洗后的答案对象。
        """
        selected_label = str(answer.get("selectedLabel") or "").strip()[:12]
        selected_title = str(answer.get("selectedTitle") or "").strip()[:240]
        selected_description = str(answer.get("selectedDescription") or "").strip()[:2000]
        freeform_answer = str(answer.get("freeformAnswer") or "").strip()[:4000]
        final_answer = str(answer.get("finalAnswer") or "").strip()[:6000]
        if not final_answer:
            final_answer = freeform_answer or selected_description or selected_title
        return {
            "selectedLabel": selected_label,
            "selectedTitle": selected_title,
            "selectedDescription": selected_description,
            "freeformAnswer": freeform_answer,
            "finalAnswer": final_answer,
        }

    def _review_timestamp(self, review: dict[str, Any]) -> float:
        """把审阅更新时间转换为 Unix 时间戳，解析失败时按最老记录处理。"""
        value = str(review.get("updatedAt") or review.get("createdAt") or "")
        try:
            return datetime.fromisoformat(value).timestamp()
        except ValueError:
            return 0.0


class ReviewHttpHandler(BaseHTTPRequestHandler):
    """本地批注面板 HTTP 处理器。

    处理器只服务静态前端和少量 JSON API。安全上只绑定 localhost，同时静态文件路径
    做白名单映射，不接受任意文件路径，避免路径穿越。
    """

    store: ReviewStore
    assets_dir: Path
    panel_manager: Any

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        """将 HTTP 访问日志写到 stderr，避免污染 MCP stdout 协议流。"""
        print(f"[plan-reviewer] {format % args}", file=sys.stderr)

    def do_GET(self) -> None:
        """处理面板页面、静态资源和审阅详情查询。"""
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
            return

        if path.startswith("/api/reviews/"):
            self._handle_get_review(path)
            return

        if path.startswith("/api/clarifications/"):
            self._handle_get_clarification(path)
            return

        if path.startswith("/api/sessions/"):
            self._handle_get_session(path)
            return

        if path in {"/", "/index.html"} or path.startswith("/review/"):
            self._serve_static("index.html", "text/html; charset=utf-8")
            return

        if path.startswith("/clarify/"):
            self._serve_static("clarify.html", "text/html; charset=utf-8")
            return

        if path.startswith("/session/"):
            self._serve_static("session.html", "text/html; charset=utf-8")
            return

        static_map = {
            "/styles.css": ("styles.css", "text/css; charset=utf-8"),
            "/app.js": ("app.js", "application/javascript; charset=utf-8"),
            "/clarify.js": ("clarify.js", "application/javascript; charset=utf-8"),
            "/session.js": ("session.js", "application/javascript; charset=utf-8"),
        }
        if path in static_map:
            filename, content_type = static_map[path]
            self._serve_static(filename, content_type)
            return

        self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        """处理提交批注、通过审阅和重新打开审阅。"""
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        try:
            if path.startswith("/api/sessions/"):
                self._handle_session_post(path)
                return

            if path.endswith("/feedback") and path.startswith("/api/reviews/"):
                review_id = path.split("/")[3]
                payload = self._read_json_body()
                review = self.store.apply_feedback(
                    review_id,
                    payload.get("annotations") or [],
                    payload.get("generalNote") or "",
                )
                # 需要重写时保持面板打开，方便用户在 Codex 生成下一版前继续核对已提交内容。
                self.panel_manager.cancel_shutdown()
                self._send_json({"review": review, "panelShutdownSeconds": None})
                return

            if path.endswith("/approve") and path.startswith("/api/reviews/"):
                review_id = path.split("/")[3]
                review = self.store.approve_review(review_id)
                self._send_json({"review": review, "panelShutdownSeconds": PANEL_APPROVED_SHUTDOWN_DELAY_SECONDS})
                self.panel_manager.schedule_shutdown(
                    "review-approved",
                    PANEL_APPROVED_SHUTDOWN_DELAY_SECONDS,
                )
                return

            if path.endswith("/reopen") and path.startswith("/api/reviews/"):
                review_id = path.split("/")[3]
                review = self.store.reopen_review(review_id)
                self._send_json({"review": review})
                return

            if path.endswith("/answer") and path.startswith("/api/clarifications/"):
                clarification_id = path.split("/")[3]
                payload = self._read_json_body()
                clarification = self.store.answer_clarification(clarification_id, payload.get("answer") or {})
                self.panel_manager.cancel_shutdown()
                self._send_json({"clarification": clarification})
                return

            self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        except (KeyError, ValueError) as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def do_OPTIONS(self) -> None:
        """处理本地跨源预检请求。

        本面板通常同源访问，不依赖 CORS；这里仅允许 localhost/127.0.0.1/::1，作为
        用户手动用不同本地域名访问时的兼容兜底。
        """
        self.send_response(HTTPStatus.NO_CONTENT)
        self._send_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _handle_get_review(self, path: str) -> None:
        """读取单个审阅记录并返回给前端。"""
        review_id = path.split("/")[3]
        try:
            review = self.store.get_review(review_id)
            self._send_json({"review": review})
        except KeyError as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)

    def _handle_get_clarification(self, path: str) -> None:
        """读取单个需求澄清记录并返回给前端。"""
        clarification_id = path.split("/")[3]
        try:
            clarification = self.store.get_clarification(clarification_id)
            self._send_json({"clarification": clarification})
        except KeyError as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)

    def _handle_get_session(self, path: str) -> None:
        """读取持续工作流会话并返回给统一面板。"""
        parts = path.strip("/").split("/")
        if len(parts) < 3:
            self._send_json({"error": "缺少工作流会话 ID。"}, HTTPStatus.BAD_REQUEST)
            return

        session_id = parts[2]
        try:
            session = self.store.get_session(session_id)
            self._send_json({"session": session})
        except KeyError as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)

    def _handle_session_post(self, path: str) -> None:
        """处理统一 Session 面板提交的回答、批注和通过动作。

        Raises:
            KeyError: session 不存在时由上层统一转换为 400。
            ValueError: 请求路径或请求体不合法时由上层统一转换为 400。
        """
        parts = path.strip("/").split("/")
        if len(parts) != 4:
            raise ValueError("Session 请求路径不合法。")

        session_id = parts[2]
        action = parts[3]
        payload = self._read_json_body()
        item_id = str(payload.get("itemId") or "")

        if action == "clarification-answer":
            session = self.store.answer_session_clarification(session_id, item_id, payload.get("answer") or {})
            self.panel_manager.cancel_shutdown()
            self._send_json({"session": session})
            return

        if action == "review-feedback":
            session = self.store.submit_session_feedback(
                session_id,
                item_id,
                payload.get("annotations") or [],
                payload.get("generalNote") or "",
            )
            self.panel_manager.cancel_shutdown()
            self._send_json({"session": session, "panelShutdownSeconds": None})
            return

        if action == "approve":
            session = self.store.approve_session_plan(session_id, item_id)
            self._send_json({"session": session, "panelShutdownSeconds": PANEL_APPROVED_SHUTDOWN_DELAY_SECONDS})
            self.panel_manager.schedule_shutdown(
                "session-plan-approved",
                PANEL_APPROVED_SHUTDOWN_DELAY_SECONDS,
            )
            return

        raise ValueError(f"不支持的 Session 操作: {action}")

    def _serve_static(self, filename: str, content_type: str) -> None:
        """按白名单文件名返回静态资源。"""
        file_path = self.assets_dir / filename
        if not file_path.exists():
            self._send_json({"error": f"Missing static asset: {filename}"}, HTTPStatus.NOT_FOUND)
            return

        data = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json_body(self) -> dict[str, Any]:
        """读取并解析 JSON 请求体，限制大小以避免异常大请求占用内存。"""
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length > MAX_REQUEST_BYTES:
            raise ValueError("请求体过大。")
        raw_body = self.rfile.read(content_length)
        if not raw_body:
            return {}
        return json.loads(raw_body.decode("utf-8"))

    def _send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        """发送 JSON 响应，并允许本地面板 fetch 调用。"""
        data = safe_json_dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def _send_cors_headers(self) -> None:
        """仅对本机来源返回 CORS 头，避免误把面板 API 暴露给远程网页。"""
        origin = self.headers.get("Origin")
        if not origin:
            return
        parsed = urlparse(origin)
        if parsed.hostname in LOCAL_CORS_HOSTS:
            self.send_header("Access-Control-Allow-Origin", origin)


class PanelServerManager:
    """管理本地 HTTP 面板生命周期。

    MCP 服务进程存活期间复用同一个 HTTP server，避免每次创建审阅都占用新端口。
    """

    def __init__(self, store: ReviewStore, assets_dir: Path, preferred_port: int) -> None:
        """初始化面板服务管理器。

        Args:
            store: 审阅记录存储。
            assets_dir: 静态面板资源目录。
            preferred_port: 首选监听端口，冲突时会自动顺延。
        """
        self.store = store
        self.assets_dir = assets_dir
        self.preferred_port = preferred_port
        self._lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._shutdown_timer: threading.Timer | None = None
        self._port: int | None = None

    def ensure_started(self) -> int:
        """确保 HTTP 面板已启动，并返回实际监听端口。"""
        with self._lock:
            if self._server is not None and self._port is not None:
                return self._port

            for offset in range(MAX_PORT_ATTEMPTS):
                port = self.preferred_port + offset
                try:
                    handler = self._build_handler()
                    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
                except OSError:
                    continue

                self._server = server
                self._port = port
                self._thread = threading.Thread(
                    target=server.serve_forever,
                    name="plan-reviewer-panel",
                    daemon=True,
                )
                self._thread.start()
                print(f"[plan-reviewer] panel listening on 127.0.0.1:{port}", file=sys.stderr)
                return port

            raise RuntimeError("无法启动 Plan Reviewer 面板：本地端口被占用。")

    def cancel_shutdown(self) -> None:
        """取消待执行的面板关闭任务。

        新一轮审阅创建时调用该方法。这样用户提交上一轮批注后，如果 Codex 很快创建
        下一轮草案，旧的延迟关闭任务不会误关正在使用的新面板。
        """
        with self._lock:
            if self._shutdown_timer is not None:
                self._shutdown_timer.cancel()
                self._shutdown_timer = None

    def schedule_shutdown(self, reason: str, delay_seconds: float = PANEL_APPROVED_SHUTDOWN_DELAY_SECONDS) -> None:
        """安排本地 HTTP 面板在空闲后关闭。

        Args:
            reason: 关闭原因，用于 stderr 排查。
            delay_seconds: 延迟秒数；留出时间让前端收到响应、Codex 读取状态。
        """
        with self._lock:
            if self._shutdown_timer is not None:
                self._shutdown_timer.cancel()
            self._shutdown_timer = threading.Timer(delay_seconds, self._shutdown_server, args=(reason,))
            self._shutdown_timer.daemon = True
            self._shutdown_timer.start()

    def _shutdown_server(self, reason: str) -> None:
        """关闭本地 HTTP 面板服务，但不退出 MCP 进程。"""
        with self._lock:
            server = self._server
            port = self._port
            self._shutdown_timer = None

        if server is None:
            return

        print(f"[plan-reviewer] shutting down panel on 127.0.0.1:{port} ({reason})", file=sys.stderr)
        server.shutdown()
        server.server_close()

        with self._lock:
            if self._server is server:
                self._server = None
                self._thread = None
                self._port = None

    def current_port(self) -> int | None:
        """返回当前监听端口；面板未启动时返回 None。"""
        with self._lock:
            return self._port if self._server is not None else None

    def review_url(self, review_id: str, start_server: bool = True) -> str:
        """返回指定审阅记录的本地面板 URL。

        Args:
            review_id: 审阅 ID。
            start_server: True 时会按需启动面板；False 只在面板已运行时返回 URL。

        Returns:
            可打开的本地 URL；当 start_server=False 且面板未运行时返回空字符串。

        设计意图：`get_plan_review_result` 和 `wait_for_plan_review` 只是读取状态，不应该
        因为拼接 URL 而重新启动已经关闭的 HTTP 面板。
        """
        port = self.ensure_started() if start_server else self.current_port()
        if port is None:
            return ""
        return f"http://127.0.0.1:{port}/review/{review_id}"

    def clarification_url(self, clarification_id: str, start_server: bool = True) -> str:
        """返回指定需求澄清记录的本地面板 URL。

        Args:
            clarification_id: 需求澄清记录 ID。
            start_server: True 时按需启动面板；False 只在面板已运行时返回 URL。

        Returns:
            可打开的本地 URL；当 start_server=False 且面板未运行时返回空字符串。
        """
        port = self.ensure_started() if start_server else self.current_port()
        if port is None:
            return ""
        return f"http://127.0.0.1:{port}/clarify/{clarification_id}"

    def session_url(self, session_id: str, start_server: bool = True) -> str:
        """返回持续工作流统一面板 URL。

        Args:
            session_id: create_plan_workflow_session 返回的工作流会话 ID。
            start_server: True 时按需启动面板；False 只在面板已运行时返回 URL。

        Returns:
            可打开的本地 URL；当 start_server=False 且面板未运行时返回空字符串。

        设计意图：Session 面板是澄清、审阅、等待 Codex 回写的统一入口，所以用户只需
        打开一次该 URL，后续内容通过轮询同一 session 自动刷新。
        """
        port = self.ensure_started() if start_server else self.current_port()
        if port is None:
            return ""
        return f"http://127.0.0.1:{port}/session/{session_id}"

    def _build_handler(self) -> type[ReviewHttpHandler]:
        """创建带有当前 store/assets 依赖的 HTTP handler 类型。"""
        store = self.store
        assets_dir = self.assets_dir

        class BoundReviewHttpHandler(ReviewHttpHandler):
            pass

        BoundReviewHttpHandler.store = store
        BoundReviewHttpHandler.assets_dir = assets_dir
        BoundReviewHttpHandler.panel_manager = self
        return BoundReviewHttpHandler


class PlanReviewerMcpServer:
    """Plan Reviewer 的 MCP STDIO 协议实现。"""

    def __init__(self, store: ReviewStore, panel: PanelServerManager) -> None:
        """初始化 MCP 服务。

        Args:
            store: 审阅记录存储。
            panel: 本地面板服务管理器。
        """
        self.store = store
        self.panel = panel

    def run(self) -> None:
        """持续读取 stdin JSON-RPC 消息并写回 stdout 响应。"""
        for line in sys.stdin:
            if not line.strip():
                continue

            try:
                message = json.loads(line)
                response = self._handle_message(message)
                if response is not None:
                    self._write_response(response)
            except Exception as exc:  # noqa: BLE001
                # MCP 协议不能让异常逃逸到 stdout；错误统一包装成 JSON-RPC error。
                message_id = self._safe_message_id(line)
                self._write_response(
                    {
                        "jsonrpc": "2.0",
                        "id": message_id,
                        "error": {"code": -32000, "message": str(exc)},
                    }
                )

    def _handle_message(self, message: dict[str, Any]) -> dict[str, Any] | None:
        """分发 MCP 请求和通知。

        Args:
            message: JSON-RPC 消息。

        Returns:
            请求响应；通知不需要响应时返回 None。
        """
        method = message.get("method")
        message_id = message.get("id")

        if message_id is None:
            # initialized/exit 等通知无需响应。
            return None

        if method == "initialize":
            return self._response(message_id, self._initialize_result(message.get("params") or {}))

        if method == "tools/list":
            return self._response(message_id, {"tools": self._tool_definitions()})

        if method == "tools/call":
            params = message.get("params") or {}
            result = self._call_tool(str(params.get("name") or ""), params.get("arguments") or {})
            return self._response(message_id, result)

        if method == "shutdown":
            return self._response(message_id, None)

        return {
            "jsonrpc": "2.0",
            "id": message_id,
            "error": {"code": -32601, "message": f"Unsupported method: {method}"},
        }

    def _initialize_result(self, params: dict[str, Any]) -> dict[str, Any]:
        """返回 MCP 初始化能力声明。"""
        return {
            "protocolVersion": params.get("protocolVersion") or "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "plan-reviewer", "version": get_plugin_version()},
        }

    def _tool_definitions(self) -> list[dict[str, Any]]:
        """声明 Codex 可以调用的工具及参数 schema。"""
        return [
            {
                "name": "create_plan_workflow_session",
                "description": "Create one persistent local workbench for requirement clarification and plan review loops.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "Short title displayed in the persistent workbench.",
                        },
                        "original_request": {
                            "type": "string",
                            "description": "User's original request or task summary.",
                        },
                        "open_browser": {
                            "type": "boolean",
                            "description": "Open the persistent workbench in the default browser.",
                            "default": False,
                        },
                    },
                },
            },
            {
                "name": "get_plan_workflow_session",
                "description": "Read a persistent Plan Reviewer workflow session without starting the panel.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "session_id": {
                            "type": "string",
                            "description": "Session id returned by create_plan_workflow_session.",
                        }
                    },
                    "required": ["session_id"],
                },
            },
            {
                "name": "open_plan_workflow_session_panel",
                "description": "Return and optionally open the persistent workbench URL for an existing session.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "session_id": {
                            "type": "string",
                            "description": "Session id returned by create_plan_workflow_session.",
                        },
                        "open_browser": {
                            "type": "boolean",
                            "description": "Open the URL in the default browser.",
                            "default": True,
                        },
                    },
                    "required": ["session_id"],
                },
            },
            {
                "name": "publish_requirement_clarification_to_session",
                "description": "Publish the next single requirement-clarification question into an existing persistent workbench.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "session_id": {
                            "type": "string",
                            "description": "Session id returned by create_plan_workflow_session.",
                        },
                        "question": {
                            "type": "string",
                            "description": "The single question to ask the user in this clarification round.",
                        },
                        "title": {
                            "type": "string",
                            "description": "Short title for this clarification step.",
                        },
                        "known_context": {
                            "type": "string",
                            "description": "What Codex already understands before asking this question.",
                        },
                        "options": {
                            "type": "array",
                            "description": "Optional A/B/C choices. The panel can add D: Other when allow_freeform is true.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "label": {"type": "string"},
                                    "title": {"type": "string"},
                                    "description": {"type": "string"},
                                    "recommended": {"type": "boolean"},
                                    "recommendationReason": {"type": "string"},
                                },
                            },
                        },
                        "allow_freeform": {
                            "type": "boolean",
                            "description": "Allow the user to provide a custom answer.",
                            "default": True,
                        },
                        "confidence_target": {
                            "type": "integer",
                            "description": "Target understanding confidence before drafting the plan.",
                            "default": 95,
                        },
                    },
                    "required": ["session_id", "question"],
                },
            },
            {
                "name": "publish_plan_review_to_session",
                "description": "Publish the next Markdown plan draft into an existing persistent workbench.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "session_id": {
                            "type": "string",
                            "description": "Session id returned by create_plan_workflow_session.",
                        },
                        "plan_markdown": {
                            "type": "string",
                            "description": "Markdown plan draft that needs user annotation.",
                        },
                        "title": {
                            "type": "string",
                            "description": "Short title for this plan review step.",
                        },
                        "iteration": {
                            "type": "integer",
                            "description": "Optional draft iteration number.",
                        },
                        "known_context": {
                            "type": "string",
                            "description": "Codex's current understanding used to produce this draft.",
                        },
                    },
                    "required": ["session_id", "plan_markdown"],
                },
            },
            {
                "name": "wait_for_session_user_action",
                "description": "Poll a persistent workbench until the user submits an answer, submits feedback, or approves the plan.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "session_id": {
                            "type": "string",
                            "description": "Session id returned by create_plan_workflow_session.",
                        },
                        "since_action_seq": {
                            "type": "integer",
                            "description": "Return only when session.actionSeq becomes greater than this value.",
                            "default": 0,
                        },
                        "timeout_seconds": {
                            "type": "number",
                            "description": "Maximum wait time. Use 0 for a non-blocking check.",
                            "default": 0,
                        },
                    },
                    "required": ["session_id"],
                },
            },
            {
                "name": "create_requirement_clarification",
                "description": "Create a local panel for one requirement clarification question before drafting a plan.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "question": {
                            "type": "string",
                            "description": "The single question to ask the user in this clarification round.",
                        },
                        "title": {
                            "type": "string",
                            "description": "Short title displayed in the clarification panel.",
                        },
                        "original_request": {
                            "type": "string",
                            "description": "User's original request or concise task summary.",
                        },
                        "known_context": {
                            "type": "string",
                            "description": "What Codex already understands before asking this question.",
                        },
                        "options": {
                            "type": "array",
                            "description": "Optional A/B/C choices. The panel can add D: Other when allow_freeform is true.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "label": {"type": "string"},
                                    "title": {"type": "string"},
                                    "description": {"type": "string"},
                                    "recommended": {"type": "boolean"},
                                    "recommendationReason": {"type": "string"},
                                },
                            },
                        },
                        "allow_freeform": {
                            "type": "boolean",
                            "description": "Allow the user to provide a custom answer.",
                            "default": True,
                        },
                        "confidence_target": {
                            "type": "integer",
                            "description": "Target understanding confidence before drafting the plan.",
                            "default": 95,
                        },
                        "open_browser": {
                            "type": "boolean",
                            "description": "Open the clarification panel in the default browser.",
                            "default": False,
                        },
                    },
                    "required": ["question"],
                },
            },
            {
                "name": "get_requirement_clarification_result",
                "description": "Read the current clarification status and user's answer.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "clarification_id": {
                            "type": "string",
                            "description": "Clarification id returned by create_requirement_clarification.",
                        }
                    },
                    "required": ["clarification_id"],
                },
            },
            {
                "name": "wait_for_requirement_clarification",
                "description": "Poll a clarification until the user submits an answer.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "clarification_id": {
                            "type": "string",
                            "description": "Clarification id returned by create_requirement_clarification.",
                        },
                        "timeout_seconds": {
                            "type": "number",
                            "description": "Maximum wait time. Use 0 for a non-blocking check.",
                            "default": 0,
                        },
                    },
                    "required": ["clarification_id"],
                },
            },
            {
                "name": "open_requirement_clarification_panel",
                "description": "Return and optionally open the local URL for an existing clarification.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "clarification_id": {
                            "type": "string",
                            "description": "Clarification id returned by create_requirement_clarification.",
                        },
                        "open_browser": {
                            "type": "boolean",
                            "description": "Open the URL in the default browser.",
                            "default": True,
                        },
                    },
                    "required": ["clarification_id"],
                },
            },
            {
                "name": "create_plan_review",
                "description": "Create a local review panel for a Codex plan draft.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "plan_markdown": {
                            "type": "string",
                            "description": "Markdown plan draft that needs user annotation.",
                        },
                        "title": {
                            "type": "string",
                            "description": "Short title displayed in the review panel.",
                        },
                        "iteration": {
                            "type": "integer",
                            "description": "Optional draft iteration number.",
                        },
                        "open_browser": {
                            "type": "boolean",
                            "description": "Open the review panel in the default browser.",
                            "default": False,
                        },
                    },
                    "required": ["plan_markdown"],
                },
            },
            {
                "name": "get_plan_review_result",
                "description": "Read the current review status, annotations, and approval decision.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "review_id": {
                            "type": "string",
                            "description": "Review id returned by create_plan_review.",
                        }
                    },
                    "required": ["review_id"],
                },
            },
            {
                "name": "wait_for_plan_review",
                "description": "Poll a review until the user submits feedback or approves it.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "review_id": {
                            "type": "string",
                            "description": "Review id returned by create_plan_review.",
                        },
                        "timeout_seconds": {
                            "type": "number",
                            "description": "Maximum wait time. Use 0 for a non-blocking check.",
                            "default": 0,
                        },
                    },
                    "required": ["review_id"],
                },
            },
            {
                "name": "open_plan_review_panel",
                "description": "Return and optionally open the local URL for an existing plan review.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "review_id": {
                            "type": "string",
                            "description": "Review id returned by create_plan_review.",
                        },
                        "open_browser": {
                            "type": "boolean",
                            "description": "Open the URL in the default browser.",
                            "default": True,
                        },
                    },
                    "required": ["review_id"],
                },
            },
            {
                "name": "list_plan_reviews",
                "description": "List recent plan review records for troubleshooting.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of records to return.",
                            "default": 10,
                        }
                    },
                },
            },
            {
                "name": "shutdown_plan_review_panel",
                "description": "Close the local HTTP review panel without stopping the MCP server.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "delay_seconds": {
                            "type": "number",
                            "description": "Delay before shutdown so browser responses can finish.",
                            "default": 1,
                        }
                    },
                },
            },
            {
                "name": "prune_plan_reviews",
                "description": "Remove old completed local review records while keeping recent history.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "keep_latest": {
                            "type": "integer",
                            "description": "Always keep this many newest records.",
                            "default": DEFAULT_HISTORY_KEEP_RECORDS,
                        },
                        "older_than_days": {
                            "type": "integer",
                            "description": "Only delete records older than this many days.",
                            "default": DEFAULT_PRUNE_DAYS,
                        },
                        "include_pending": {
                            "type": "boolean",
                            "description": "Also allow removing pending records.",
                            "default": False,
                        },
                    },
                },
            },
            {
                "name": "clear_plan_reviews",
                "description": "Clear local review records. Requires confirm=true to avoid accidental deletion.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "confirm": {
                            "type": "boolean",
                            "description": "Must be true to clear records.",
                            "default": False,
                        },
                        "include_pending": {
                            "type": "boolean",
                            "description": "Also delete pending records.",
                            "default": False,
                        },
                    },
                    "required": ["confirm"],
                },
            },
        ]

    def _call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """执行 MCP 工具调用。

        Args:
            name: 工具名称。
            arguments: 已解析的工具参数。

        Returns:
            MCP tool result。

        Raises:
            ValueError: 当工具名称或参数不合法时抛出。
        """
        if name == "create_plan_workflow_session":
            session = self.store.create_session(
                title=str(arguments.get("title") or "Plan Reviewer 工作流"),
                original_request=str(arguments.get("original_request") or ""),
            )
            self.panel.cancel_shutdown()
            url = self.panel.session_url(session["id"])
            if bool(arguments.get("open_browser")):
                open_url_in_background(url)
            return self._tool_result({"session": session, "url": url})

        if name == "get_plan_workflow_session":
            return self._tool_result(self._session_result(str(arguments.get("session_id") or "")).to_dict())

        if name == "open_plan_workflow_session_panel":
            session_id = str(arguments.get("session_id") or "")
            self.store.get_session(session_id)
            url = self.panel.session_url(session_id)
            if bool(arguments.get("open_browser", True)):
                open_url_in_background(url)
            return self._tool_result({"sessionId": session_id, "url": url})

        if name == "publish_requirement_clarification_to_session":
            session_id = str(arguments.get("session_id") or "")
            self.store.publish_session_clarification(
                session_id=session_id,
                title=str(arguments.get("title") or "需求澄清"),
                question=str(arguments.get("question") or ""),
                known_context=str(arguments.get("known_context") or ""),
                options=arguments.get("options") if isinstance(arguments.get("options"), list) else [],
                allow_freeform=bool(arguments.get("allow_freeform", True)),
                confidence_target=int(arguments.get("confidence_target") or 95),
            )
            self.panel.cancel_shutdown()
            self.panel.session_url(session_id)
            return self._tool_result(self._session_result(session_id).to_dict())

        if name == "publish_plan_review_to_session":
            session_id = str(arguments.get("session_id") or "")
            iteration = arguments.get("iteration")
            self.store.publish_session_plan_review(
                session_id=session_id,
                title=str(arguments.get("title") or "计划草案审阅"),
                plan_markdown=str(arguments.get("plan_markdown") or ""),
                iteration=iteration if isinstance(iteration, int) else None,
                known_context=str(arguments.get("known_context") or ""),
            )
            self.panel.cancel_shutdown()
            self.panel.session_url(session_id)
            return self._tool_result(self._session_result(session_id).to_dict())

        if name == "wait_for_session_user_action":
            session_id = str(arguments.get("session_id") or "")
            since_action_seq = int(arguments.get("since_action_seq") or 0)
            timeout_seconds = float(arguments.get("timeout_seconds") or 0)
            return self._tool_result(
                self._wait_for_session_user_action(session_id, since_action_seq, timeout_seconds).to_dict()
            )

        if name == "create_requirement_clarification":
            title = str(arguments.get("title") or "需求澄清")
            clarification = self.store.create_clarification(
                title=title,
                question=str(arguments.get("question") or ""),
                original_request=str(arguments.get("original_request") or ""),
                known_context=str(arguments.get("known_context") or ""),
                options=arguments.get("options") if isinstance(arguments.get("options"), list) else [],
                allow_freeform=bool(arguments.get("allow_freeform", True)),
                confidence_target=int(arguments.get("confidence_target") or 95),
            )
            self.panel.cancel_shutdown()
            url = self.panel.clarification_url(clarification["id"])
            if bool(arguments.get("open_browser")):
                open_url_in_background(url)
            return self._tool_result({"clarification": clarification, "url": url})

        if name == "get_requirement_clarification_result":
            return self._tool_result(
                self._clarification_result(str(arguments.get("clarification_id") or "")).to_dict()
            )

        if name == "wait_for_requirement_clarification":
            clarification_id = str(arguments.get("clarification_id") or "")
            timeout_seconds = float(arguments.get("timeout_seconds") or 0)
            return self._tool_result(self._wait_for_clarification(clarification_id, timeout_seconds).to_dict())

        if name == "open_requirement_clarification_panel":
            clarification_id = str(arguments.get("clarification_id") or "")
            self.store.get_clarification(clarification_id)
            url = self.panel.clarification_url(clarification_id)
            if bool(arguments.get("open_browser", True)):
                open_url_in_background(url)
            return self._tool_result({"clarificationId": clarification_id, "url": url})

        if name == "create_plan_review":
            title = str(arguments.get("title") or "Codex Plan Draft")
            plan_markdown = str(arguments.get("plan_markdown") or "")
            iteration = arguments.get("iteration")
            review = self.store.create_review(title, plan_markdown, iteration if isinstance(iteration, int) else None)
            self.panel.cancel_shutdown()
            url = self.panel.review_url(review["id"])
            if bool(arguments.get("open_browser")):
                open_url_in_background(url)
            return self._tool_result({"review": review, "url": url})

        if name == "get_plan_review_result":
            return self._tool_result(self._review_result(str(arguments.get("review_id") or "")).to_dict())

        if name == "wait_for_plan_review":
            review_id = str(arguments.get("review_id") or "")
            timeout_seconds = float(arguments.get("timeout_seconds") or 0)
            return self._tool_result(self._wait_for_review(review_id, timeout_seconds).to_dict())

        if name == "open_plan_review_panel":
            review_id = str(arguments.get("review_id") or "")
            # 先读取一次，确保返回的 URL 对应真实审阅记录。
            self.store.get_review(review_id)
            url = self.panel.review_url(review_id)
            if bool(arguments.get("open_browser", True)):
                open_url_in_background(url)
            return self._tool_result({"reviewId": review_id, "url": url})

        if name == "list_plan_reviews":
            limit = int(arguments.get("limit") or 10)
            return self._tool_result({"reviews": self.store.list_reviews(limit)})

        if name == "shutdown_plan_review_panel":
            delay_seconds = float(arguments.get("delay_seconds") or 1)
            bounded_delay = max(0.1, min(delay_seconds, 300.0))
            self.panel.schedule_shutdown("tool-requested", bounded_delay)
            return self._tool_result({"scheduled": True, "delaySeconds": bounded_delay})

        if name == "prune_plan_reviews":
            older_than_days = arguments.get("older_than_days", DEFAULT_PRUNE_DAYS)
            return self._tool_result(
                self.store.prune_reviews(
                    keep_latest=int(arguments.get("keep_latest") or DEFAULT_HISTORY_KEEP_RECORDS),
                    older_than_days=int(older_than_days) if older_than_days is not None else None,
                    include_pending=bool(arguments.get("include_pending")),
                )
            )

        if name == "clear_plan_reviews":
            return self._tool_result(
                self.store.clear_reviews(
                    confirm=bool(arguments.get("confirm")),
                    include_pending=bool(arguments.get("include_pending")),
                )
            )

        raise ValueError(f"Unsupported tool: {name}")

    def _wait_for_session_user_action(
        self,
        session_id: str,
        since_action_seq: int,
        timeout_seconds: float,
    ) -> SessionResult:
        """轮询持续工作流会话，直到用户完成新的可消费动作或超时。

        Args:
            session_id: 工作流会话 ID。
            since_action_seq: Codex 已处理到的动作序号。
            timeout_seconds: 最大等待秒数。

        Returns:
            当前 session 摘要。若用户已经提交新回答、批注或通过计划，`lastUserAction`
            会包含可直接吸收的结构化内容。
        """
        bounded_timeout = max(0.0, min(timeout_seconds, 900.0))
        deadline = time.monotonic() + bounded_timeout
        while True:
            result = self._session_result(session_id)
            action = result.session.get("lastUserAction") or {}
            action_seq = int(action.get("seq") or 0)
            session_status = result.session.get("status")
            if action_seq > since_action_seq or (session_status in SESSION_USER_ACTION_STATUSES and action_seq > 0):
                return result
            if timeout_seconds <= 0 or time.monotonic() >= deadline:
                return result
            time.sleep(SESSION_POLL_SECONDS)

    def _wait_for_clarification(self, clarification_id: str, timeout_seconds: float) -> ClarificationResult:
        """轮询需求澄清状态，直到用户提交回答或超时。"""
        deadline = time.monotonic() + max(0.0, min(timeout_seconds, 900.0))
        while True:
            result = self._clarification_result(clarification_id)
            if result.status in CLARIFICATION_COMPLETED_STATUSES:
                return result
            if timeout_seconds <= 0 or time.monotonic() >= deadline:
                return result
            time.sleep(1.0)

    def _wait_for_review(self, review_id: str, timeout_seconds: float) -> ReviewResult:
        """轮询审阅状态，直到用户提交批注/通过或超时。"""
        deadline = time.monotonic() + max(0.0, min(timeout_seconds, 900.0))
        while True:
            result = self._review_result(review_id)
            if result.status in COMPLETED_STATUSES:
                return result
            if timeout_seconds <= 0 or time.monotonic() >= deadline:
                return result
            time.sleep(1.0)

    def _session_result(self, session_id: str) -> SessionResult:
        """把持续工作流会话转换成 Codex 易消费的结果对象。"""
        session = self.store.get_session(session_id)
        url = self.panel.session_url(session["id"], start_server=False)
        return SessionResult(
            session=session,
            url=url,
            panel_running=bool(url),
        )

    def _clarification_result(self, clarification_id: str) -> ClarificationResult:
        """把需求澄清记录转换成 Codex 易消费的结果对象。"""
        clarification = self.store.get_clarification(clarification_id)
        url = self.panel.clarification_url(clarification["id"], start_server=False)
        return ClarificationResult(
            clarification_id=clarification["id"],
            status=clarification.get("status", "pending"),
            url=url,
            panel_running=bool(url),
            question=clarification.get("question") or "",
            answer=clarification.get("answer") or {},
        )

    def _review_result(self, review_id: str) -> ReviewResult:
        """把存储记录转换成 Codex 易消费的结果对象。"""
        review = self.store.get_review(review_id)
        url = self.panel.review_url(review["id"], start_server=False)
        return ReviewResult(
            review_id=review["id"],
            status=review.get("status", "pending"),
            url=url,
            panel_running=bool(url),
            annotations=review.get("annotations") or [],
            general_note=review.get("generalNote") or "",
        )

    def _tool_result(self, payload: dict[str, Any]) -> dict[str, Any]:
        """包装 MCP tool result，同时提供文本 JSON 和结构化内容。"""
        return {
            "content": [{"type": "text", "text": safe_json_dumps(payload)}],
            "structuredContent": payload,
        }

    def _response(self, message_id: Any, result: Any) -> dict[str, Any]:
        """创建 JSON-RPC 成功响应。"""
        return {"jsonrpc": "2.0", "id": message_id, "result": result}

    def _write_response(self, response: dict[str, Any]) -> None:
        """写出一行 JSON-RPC 响应并立即 flush。"""
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    def _safe_message_id(self, raw_line: str) -> Any:
        """异常路径下尽量从原始消息提取 id，便于客户端匹配错误响应。"""
        try:
            return json.loads(raw_line).get("id")
        except Exception:  # noqa: BLE001
            return None


def build_runtime(preferred_port: int | None = None) -> tuple[ReviewStore, PanelServerManager]:
    """构建 MCP 和面板共用的运行时对象。"""
    store = ReviewStore(get_default_state_dir())
    port = preferred_port or int(os.environ.get("PLAN_REVIEWER_PORT", str(DEFAULT_PORT)))
    assets_dir = get_plugin_root() / "assets" / "panel"
    panel = PanelServerManager(store, assets_dir, port)
    return store, panel


def run_serve_only(args: argparse.Namespace) -> None:
    """以独立 HTTP 面板模式启动，主要用于本地开发和验收。"""
    store, panel = build_runtime(args.port)
    review_id = args.review_id
    clarification_id = args.clarification_id
    session_id = args.session_id
    if args.session_demo:
        demo_session = store.create_session(
            title="Plan Reviewer Session Demo",
            original_request="使用 HTML + Three.js 实现一个可直接打开的 3D 圆球上下跳动场景。",
        )
        store.publish_session_clarification(
            session_id=demo_session["id"],
            title="交付方式确认",
            question="这个 3D 圆球页面的交付方式你更希望采用哪一种？",
            known_context=(
                "目标是让用户留在同一个 Plan Reviewer 面板中完成需求澄清、计划批注和最终通过。"
            ),
            options=[
                {
                    "label": "A",
                    "title": "单个 HTML 文件",
                    "description": "生成 index.html，通过 CDN 引入 Three.js，双击或浏览器打开即可查看。",
                    "recommended": True,
                    "recommendationReason": "最符合“可直接打开”的目标，交付最轻量。",
                },
                {
                    "label": "B",
                    "title": "本地离线依赖",
                    "description": "把 Three.js 放到本地 vendor 目录，文件更多，但可以离线打开。",
                },
                {
                    "label": "C",
                    "title": "npm 项目",
                    "description": "用 Vite/Three.js 项目结构实现，适合继续扩展，但需要安装依赖和启动服务。",
                },
            ],
            allow_freeform=True,
            confidence_target=95,
        )
        session_id = demo_session["id"]
    if args.clarify_demo:
        demo_clarification = store.create_clarification(
            title="需求澄清 Demo",
            question="你希望这个功能优先覆盖哪类使用场景？",
            original_request="添加一个需求澄清面板，让 Codex 在生成计划草案前先问问题。",
            known_context="目标是每次只问一个问题，选项里给出推荐方案和推荐理由，并允许用户选择其他。",
            options=[
                {
                    "label": "A",
                    "title": "先做轻量 MVP",
                    "description": "只覆盖单轮问题、A/B/C 选项、D 其他输入和提交回答。",
                    "recommended": True,
                    "recommendationReason": "实现成本低，并且能最快验证需求澄清循环是否真的顺手。",
                },
                {
                    "label": "B",
                    "title": "一次做完整向导",
                    "description": "增加多轮历史、进度条、问题模板和结论汇总。",
                },
                {
                    "label": "C",
                    "title": "只保留聊天追问",
                    "description": "不做面板，只把追问规则写进 Skill。",
                },
            ],
            allow_freeform=True,
            confidence_target=95,
        )
        clarification_id = demo_clarification["id"]
    if args.demo:
        demo_review = store.create_review(
            "Plan Reviewer Demo",
            "## Demo Plan\n\n1. Confirm the scope.\n2. Implement the smallest useful loop.\n3. Verify the panel.",
            1,
        )
        review_id = demo_review["id"]

    if session_id:
        url = panel.session_url(session_id)
        print(url)
    elif clarification_id:
        url = panel.clarification_url(clarification_id)
        print(url)
    elif review_id:
        url = panel.review_url(review_id)
        print(url)
    else:
        print("Panel started. Create a review through MCP or pass --demo.", file=sys.stderr)
        panel.ensure_started()

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("[plan-reviewer] stopped", file=sys.stderr)


def run_review_from_stdin(args: argparse.Namespace) -> None:
    """从 stdin 读取计划草案，创建审阅面板，并可阻塞等待用户决策。

    这个模式是 MCP 工具未加载时的兜底通道。Codex 可以通过 shell 把 Markdown 草案
    传入 stdin，脚本会输出一行 `PANEL_URL=...` 到 stderr，方便用户立即打开；等待
    结束后再向 stdout 输出结构化 JSON，供 Codex 解析批注结果。
    """
    plan_markdown = sys.stdin.read().strip()
    if not plan_markdown:
        raise ValueError("stdin 中没有计划草案。")

    store, panel = build_runtime(args.port)
    review = store.create_review(args.title or "Codex Plan Draft", plan_markdown, args.iteration)

    if args.wait_seconds <= 0:
        if args.open_browser:
            raise ValueError("--open-browser 需要同时设置 --wait-seconds > 0，否则脚本退出后面板 URL 会失效。")
        print(
            safe_json_dumps(
                {
                    "review": review,
                    "url": "",
                    "message": "已创建审阅记录但未启动持久面板；需要浏览器面板时请使用 --wait-seconds 900。",
                }
            )
        )
        return

    url = panel.review_url(review["id"])

    if args.open_browser:
        open_url_in_background(url)

    # stderr 会在多数终端里更早可见，不会破坏 stdout 的最终 JSON 结果。
    print(f"PANEL_URL={url}", file=sys.stderr, flush=True)

    deadline = time.monotonic() + min(args.wait_seconds, 900)
    while time.monotonic() < deadline:
        current = store.get_review(review["id"])
        if current.get("status") in COMPLETED_STATUSES:
            print(
                safe_json_dumps(
                    {
                        "reviewId": current["id"],
                        "status": current.get("status", "pending"),
                        "url": url,
                        "annotations": current.get("annotations") or [],
                        "generalNote": current.get("generalNote") or "",
                    }
                )
            )
            return
        time.sleep(1)

    current = store.get_review(review["id"])
    print(
        safe_json_dumps(
            {
                "reviewId": current["id"],
                "status": current.get("status", "pending"),
                "url": url,
                "annotations": current.get("annotations") or [],
                "generalNote": current.get("generalNote") or "",
            }
        )
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    """解析脚本参数；默认不带参数时运行 MCP STDIO 服务。"""
    parser = argparse.ArgumentParser(description="Plan Reviewer MCP server")
    parser.add_argument("--serve-only", action="store_true", help="Run only the local HTTP panel.")
    parser.add_argument("--demo", action="store_true", help="Create a demo review for panel testing.")
    parser.add_argument("--clarify-demo", action="store_true", help="Create a demo clarification for panel testing.")
    parser.add_argument("--session-demo", action="store_true", help="Create a demo persistent workflow session.")
    parser.add_argument("--review-id", help="Open an existing review id in serve-only mode.")
    parser.add_argument("--clarification-id", help="Open an existing clarification id in serve-only mode.")
    parser.add_argument("--session-id", help="Open an existing persistent workflow session id in serve-only mode.")
    parser.add_argument("--port", type=int, help="Preferred local panel port.")
    parser.add_argument("--review-from-stdin", action="store_true", help="Create a plan review from stdin and optionally wait.")
    parser.add_argument("--title", help="Review title for --review-from-stdin.")
    parser.add_argument("--iteration", type=int, help="Draft iteration for --review-from-stdin.")
    parser.add_argument("--open-browser", action="store_true", help="Open the local panel URL.")
    parser.add_argument(
        "--wait-seconds",
        type=int,
        default=0,
        help="Seconds to keep the review panel alive and wait for feedback in stdin review mode.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    """程序入口。"""
    args = parse_args(argv or sys.argv[1:])
    if args.review_from_stdin:
        run_review_from_stdin(args)
        return

    if args.serve_only:
        run_serve_only(args)
        return

    store, panel = build_runtime(args.port)
    PlanReviewerMcpServer(store, panel).run()


if __name__ == "__main__":
    main()
