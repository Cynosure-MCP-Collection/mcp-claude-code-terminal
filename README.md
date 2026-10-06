# @cynosure-mcp/claude-code-terminal

MCP server for starting and controlling Anthropic Claude Code CLI coding sessions from another agent.

It exposes the documented Claude Code CLI workflows:

- Interactive terminal mode with `claude`, backed by a PTY so the agent can read output and send follow-up input.
- One-shot print mode with `claude -p "query"`, useful for scripted tasks and final answers.

## Installation

```bash
npx @cynosure-mcp/claude-code-terminal
```

Or install globally:

```bash
npm install -g @cynosure-mcp/claude-code-terminal
claude-code-terminal
```

## Tools

| Tool | Description |
| ---- | ----------- |
| `check_claude_cli` | Check whether the Claude Code CLI is available and report its version/auth status |
| `claude_print` | Run `claude -p` non-interactively and return stdout/stderr; supports `resume` for multi-turn runs |
| `start_claude_session` | Start an interactive `claude` terminal session in a PTY |
| `read_claude_session` | Read output from an interactive session, optionally waiting until it is idle |
| `send_claude_input` | Send text or control keys to an interactive session |
| `stop_claude_session` | Stop one interactive session |
| `list_claude_sessions` | List currently running interactive sessions |

## Notes

This MCP assumes Claude Code is already installed and authenticated. Run `claude auth login` or open `claude` directly outside this MCP if setup is incomplete.

Use `send_claude_input` with `submit=true` to send a prompt to the Claude Code composer, or send raw control keys such as Ctrl+C, Shift+Tab and the arrow keys. Multi-line text is sent as a bracketed paste, so it is submitted as one prompt.

Interactive output is rendered through a headless terminal emulator. By default tools return `view: "screen"`, the visible terminal as plain text; `"scrollback"` returns the rendered history and `"raw"` the unprocessed PTY stream with ANSI codes. Set `until_idle_ms` (for example `3000`) with a generous `read_after_ms` or `wait_ms` to return as soon as Claude Code has finished its turn or is waiting for input.

The first time Claude Code runs in a folder it asks whether to trust it, with "No, exit" selected. The tool result then includes a `hint`; send control `down` and then `enter` to trust the folder.

For multi-turn print mode, call `claude_print` with `output_format: "json"`, read `session_id` from the result, and pass it as `resume` in the next call.

Spawned sessions do not inherit the environment variables that tie a process to the Claude Code session hosting this server, such as its session ID and messaging socket.

On Linux, `node-pty` is compiled during installation and needs Python, `make` and a C++ compiler.

## MCP Config

```json
{
  "mcpServers": {
    "claude-code-terminal": {
      "command": "npx",
      "args": ["@cynosure-mcp/claude-code-terminal"]
    }
  }
}
```

## License

MIT
