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
| `claude_print` | Run `claude -p` non-interactively and return stdout/stderr |
| `start_claude_session` | Start an interactive `claude` terminal session in a PTY |
| `read_claude_session` | Read buffered output from an interactive session |
| `send_claude_input` | Send text or control keys to an interactive session |
| `stop_claude_session` | Stop one interactive session |
| `list_claude_sessions` | List currently running interactive sessions |

## Notes

This MCP assumes Claude Code is already installed and authenticated. Run `claude auth login` or open `claude` directly outside this MCP if setup is incomplete.

Use `send_claude_input` with `submit=true` to send a prompt to the Claude Code composer, or send raw control keys such as Ctrl+C and Ctrl+D.

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
