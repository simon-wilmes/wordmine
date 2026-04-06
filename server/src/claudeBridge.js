const { spawn } = require("child_process");

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
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim()
      });
    });
  });
}

module.exports = {
  runClaudePrompt
};
