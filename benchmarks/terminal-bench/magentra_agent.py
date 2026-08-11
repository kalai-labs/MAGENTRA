"""Harbor installed agent for MAGENTRA — Terminal-Bench 2.0 adapter.

Uploads the pre-built bundle (bundle/engine.cjs + rg + driver.mjs — see
build-bundle.mjs), installs Node inside the task container, and runs the
UNMODIFIED MAGENTRA engine through the thin NDJSON driver. No engine code is
changed or configured beyond what any user could set: env vars for
model/key/endpoint and a global settings file that turns the interactive
clarify pre-layer off.

Usage:
    cd benchmarks/terminal-bench && node build-bundle.mjs
    export MAGENTRA_API_KEY=...   # DeepInfra key (OPENAI_API_KEY also works)
    harbor run -d terminal-bench/terminal-bench-2 \
        --agent-import-path magentra_agent:MagentraAgent \
        -m deepseek-ai/DeepSeek-V3.2 -k 1
"""

import json
import shlex
from pathlib import Path, PurePosixPath
from typing import Any, override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class MagentraAgent(BaseInstalledAgent):
    """Runs MAGENTRA's headless engine (stdio NDJSON protocol) via driver.mjs."""

    _REMOTE_DIR = PurePosixPath("/installed-agent/magentra")
    _REMOTE_INSTRUCTION = PurePosixPath("/installed-agent/magentra-instruction.txt")
    _EVENTS_FILENAME = "magentra-events.ndjson"
    _RESULT_FILENAME = "magentra-result.json"

    # Read from THIS process's env and written into the container's settings
    # file — deliberately NOT forwarded to the engine as an env var, because
    # settings.ts gives contextWindow no env override on purpose (one storage,
    # one resolver; a second write path was how a stale tiny window once
    # shadowed a model's real one). The settings file is the only way in.
    _CONTEXT_WINDOW_ENV = "MAGENTRA_TB_CONTEXT_WINDOW"

    # Env names the engine itself resolves (settings.ts): the key in
    # MAGENTRA_API_KEY / OPENAI_API_KEY / DEEPINFRA_API_KEY order, plus the
    # documented overrides for model/endpoint. Forwarded verbatim when set.
    _FORWARDED_ENV = (
        "MAGENTRA_API_KEY",
        "OPENAI_API_KEY",
        "DEEPINFRA_API_KEY",
        "MAGENTRA_BASE_URL",
        "MAGENTRA_PROVIDER",
        "MAGENTRA_MAX_ITERATIONS",
        "MAGENTRA_MAX_TOKENS_PER_TURN",
        "MAGENTRA_TB_TIMEOUT_SEC",
    )

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        bundle_dir = Path(__file__).parent / "bundle"
        version = None
        version_file = bundle_dir / "version.json"
        if version_file.is_file():
            try:
                meta = json.loads(version_file.read_text())
                version = f"{meta.get('version', '?')}+{meta.get('sha', '?')}"
            except (json.JSONDecodeError, OSError):
                pass
        kwargs.setdefault("version", version)
        super().__init__(*args, **kwargs)
        self._bundle_dir = bundle_dir
        self._validate_bundle()

    def _validate_bundle(self) -> None:
        missing = [
            name
            for name in ("engine.cjs", "rg", "driver.mjs")
            if not (self._bundle_dir / name).is_file()
        ]
        if missing:
            raise ValueError(
                f"MAGENTRA bundle incomplete ({', '.join(missing)} missing from "
                f"{self._bundle_dir}). Run `node benchmarks/terminal-bench/build-bundle.mjs` first."
            )

    @staticmethod
    @override
    def name() -> str:
        return "magentra"

    @staticmethod
    def _node_prefix() -> str:
        return 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '

    def _model_id(self) -> str | None:
        """The literal model id the OpenAI-compatible endpoint serves.

        Harbor model names are often litellm-style ("deepinfra/deepseek-ai/X");
        the engine wants the endpoint's own id ("deepseek-ai/X"), so a leading
        provider prefix is stripped when present.
        """
        if not self.model_name:
            return None
        for prefix in ("deepinfra/", "openai/deepinfra/"):
            if self.model_name.startswith(prefix):
                return self.model_name[len(prefix):]
        return self.model_name

    def _runner_env(self) -> dict[str, str]:
        env: dict[str, str] = {}
        for key in self._FORWARDED_ENV:
            value = self._get_env(key)
            if value:
                env[key] = value
        env.update(self.resolve_env_vars())
        model = self._model_id()
        if model:
            env["MAGENTRA_MODEL"] = model
        agent_dir = EnvironmentPaths.agent_dir
        env["MAGENTRA_TB_INSTRUCTION"] = self._REMOTE_INSTRUCTION.as_posix()
        env["MAGENTRA_TB_EVENTS"] = (agent_dir / self._EVENTS_FILENAME).as_posix()
        env["MAGENTRA_TB_RESULT"] = (agent_dir / self._RESULT_FILENAME).as_posix()
        return env

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # curl + certs for the nvm bootstrap; apt and apk cover TB task images.
        await self.exec_as_root(
            environment,
            command=(
                "if command -v apt-get >/dev/null 2>&1; then "
                "apt-get update && apt-get install -y curl ca-certificates; "
                "elif command -v apk >/dev/null 2>&1; then "
                "apk add --no-cache curl ca-certificates bash; "
                "fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        # Node >= 20 (the engine's floor). Reuse a suitable preinstalled node,
        # otherwise install 24 via nvm — same pattern as harbor's other
        # node-based installed agents.
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{self._node_prefix()}"
                "if command -v node >/dev/null 2>&1 && "
                "node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 20 ? 0 : 1)'; then "
                "node --version; "
                "else "
                "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash; "
                f"{self._node_prefix()}"
                "nvm install 24; nvm alias default 24; node --version; "
                "fi"
            ),
            env={"NVM_NODEJS_ORG_MIRROR": "https://nodejs.org/dist"},
        )

        remote = shlex.quote(self._REMOTE_DIR.as_posix())
        await self.exec_as_root(environment, command=f"rm -rf {remote} && mkdir -p /installed-agent")
        await environment.upload_dir(self._bundle_dir, self._REMOTE_DIR.as_posix())

        agent_user = str(environment.default_user or "root")
        quoted_user = shlex.quote(agent_user)
        await self.exec_as_root(
            environment,
            command=(
                f"chown -R {quoted_user}:{quoted_user} {remote} && "
                f"chmod +x {remote}/rg {remote}/driver.mjs"
            ),
        )

        # The config this adapter writes, via the same global settings file any
        # user could write. Two keys, both deliberate:
        #
        #   clarify=false  the clarify pre-layer interviews the USER before
        #                  open-ended work; an unattended benchmark has no user.
        #   contextWindow  optional. contextWindowFor() falls back to a
        #                  conservative 128_000 for EVERY model, because the
        #                  engine's MODEL_CONTEXT_WINDOWS table is empty — so a
        #                  200k+ model silently compacts at 128k and is measured
        #                  handicapped against baselines that used its real
        #                  window. Left unset, behaviour is stock 128k.
        settings: dict[str, Any] = {"clarify": False}
        raw_window = self._get_env(self._CONTEXT_WINDOW_ENV)
        if raw_window:
            try:
                window = int(raw_window)
            except ValueError as exc:
                raise ValueError(
                    f"{self._CONTEXT_WINDOW_ENV} must be an integer, "
                    f"got {raw_window!r}"
                ) from exc
            if window <= 0:
                raise ValueError(
                    f"{self._CONTEXT_WINDOW_ENV} must be positive, got {window}"
                )
            settings["contextWindow"] = window

        # shlex.quote over json.dumps, not hand-rolled escaping: the settings
        # body is now built, not a literal, and one unescaped quote would write
        # a corrupt file that the engine silently ignores.
        payload = shlex.quote(json.dumps(settings))
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p ~/.magentra && "
                f"printf '%s\\n' {payload} > ~/.magentra/settings.json"
            ),
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        instruction_file = self.logs_dir / "instruction.txt"
        instruction_file.write_text(instruction)
        await environment.upload_file(instruction_file, self._REMOTE_INSTRUCTION.as_posix())

        driver = shlex.quote((self._REMOTE_DIR / "driver.mjs").as_posix())
        command = f"{self._node_prefix()}node {driver}"
        result = await environment.exec(
            command=f"set -o pipefail; {command}",
            env=self._runner_env(),
        )

        await self._download_run_artifacts(environment)
        self.populate_context_post_run(context)

        if result.return_code != 0:
            raise self._classify_exec_error(command, result)

    async def _download_run_artifacts(self, environment: BaseEnvironment) -> None:
        for filename in (self._EVENTS_FILENAME, self._RESULT_FILENAME):
            try:
                await environment.download_file(
                    (EnvironmentPaths.agent_dir / filename).as_posix(),
                    self.logs_dir / filename,
                )
            except Exception as exc:  # noqa: BLE001 — logs are best-effort
                self.logger.debug(f"Failed to download MAGENTRA artifact {filename}: {exc}")

    def populate_context_post_run(self, context: AgentContext) -> None:
        result_file = self.logs_dir / self._RESULT_FILENAME
        if not result_file.is_file():
            return
        try:
            result = json.loads(result_file.read_text())
        except (json.JSONDecodeError, OSError):
            return
        usage = result.get("usage") or {}
        fresh = usage.get("inputTokens")
        cache_read = usage.get("cacheReadTokens")
        cache_write = usage.get("cacheWriteTokens")
        if any(v is not None for v in (fresh, cache_read, cache_write)):
            context.n_input_tokens = (fresh or 0) + (cache_read or 0) + (cache_write or 0)
        if cache_read is not None:
            context.n_cache_tokens = cache_read
        if usage.get("outputTokens") is not None:
            context.n_output_tokens = usage["outputTokens"]
        if result.get("costUsd") is not None:
            context.cost_usd = result["costUsd"]
        context.metadata = {
            "stopReason": result.get("stopReason"),
            "contextTokens": result.get("contextTokens"),
            "model": result.get("model"),
            "toolCalls": result.get("toolCalls"),
            "turns": result.get("turns"),
            "durationMs": result.get("durationMs"),
            "fatalError": result.get("fatalError"),
        }
