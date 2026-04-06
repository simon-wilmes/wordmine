const { spawn } = require("child_process");

function summarizeOutput(text, maxLen = 800) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "(empty)";
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen)}...`;
}

function parseArgsFromEnv() {
  const json = process.env.CLAUDE_CLI_ARGS_JSON;
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch {
      // Fall back below.
    }
  }
  return ["-p", "{prompt}"];
}

async function runClaudePrompt(promptText, options = {}) {
  const command = process.env.CLAUDE_CLI_COMMAND || "claude";
  const timeoutMs = Number(options.timeoutMs || process.env.CLAUDE_CLI_TIMEOUT_MS || 20000);
  const rawArgs = parseArgsFromEnv();
  const hasPromptPlaceholder = rawArgs.includes("{prompt}");
  const args = hasPromptPlaceholder
    ? rawArgs.map((arg) => (arg === "{prompt}" ? promptText : arg))
    : [...rawArgs, promptText];

  return new Promise((resolve, reject) => {
    const cliMeta = {
      command,
      argsTemplate: rawArgs,
      hasPromptPlaceholder,
      promptLength: String(promptText || "").length,
      timeoutMs: Math.max(1000, timeoutMs)
    };

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      const error = new Error(`Claude CLI timed out after ${timeoutMs}ms.`);
      error.code = "CLI_TIMEOUT";
      error.cli = cliMeta;
      error.stdoutSnippet = summarizeOutput(stdout, 300);
      error.stderrSnippet = summarizeOutput(stderr, 300);
      reject(error);
    }, Math.max(1000, timeoutMs));

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error.cli = cliMeta;
      error.stdoutSnippet = summarizeOutput(stdout, 300);
      error.stderrSnippet = summarizeOutput(stderr, 300);
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const trimmedStdout = String(stdout || "").trim();
      const trimmedStderr = String(stderr || "").trim();

      if (code !== 0) {
        const error = new Error(
          `Claude CLI exited with code ${code}${signal ? ` (signal: ${signal})` : ""}. stderr: ${summarizeOutput(trimmedStderr)}; stdout: ${summarizeOutput(trimmedStdout)}`
        );
        error.code = "CLI_EXIT_NONZERO";
        error.cli = cliMeta;
        error.exitCode = code;
        error.signal = signal || null;
        error.stdout = trimmedStdout;
        error.stderr = trimmedStderr;
        error.stdoutSnippet = summarizeOutput(trimmedStdout, 300);
        error.stderrSnippet = summarizeOutput(trimmedStderr, 300);
        reject(error);
        return;
      }

      if (!trimmedStdout && !trimmedStderr) {
        const error = new Error("Claude CLI returned no output on stdout or stderr.");
        error.code = "CLI_EMPTY_OUTPUT";
        error.cli = cliMeta;
        error.exitCode = code;
        error.stdoutSnippet = "(empty)";
        error.stderrSnippet = "(empty)";
        reject(error);
        return;
      }

      resolve({
        code,
        stdout: trimmedStdout,
        stderr: trimmedStderr
      });
    });
  });
}

module.exports = {
  runClaudePrompt
};
