#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { z } from 'zod';

type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
type OutputFormat = 'text' | 'json' | 'stream-json';
type InputFormat = 'text' | 'stream-json';

interface ClaudeSession {
    id: string;
    command: string;
    args: string[];
    cwd: string;
    createdAt: string;
    cols: number;
    rows: number;
    process: pty.IPty;
    output: string;
    exitCode?: number;
    exitSignal?: number;
}

const MAX_BUFFER_CHARS = 250_000;
const DEFAULT_READ_CHARS = 12_000;
const sessions = new Map<string, ClaudeSession>();
const isWindows = platform() === 'win32';

function log(msg: string): void {
    process.stderr.write(`[claude-code-terminal-mcp ${new Date().toISOString()}] ${msg}\n`);
}

function resolveCwd(cwd?: string): string {
    const resolved = path.resolve(cwd || process.cwd());
    if (!existsSync(resolved)) {
        throw new Error(`Working directory does not exist: ${resolved}`);
    }
    return resolved;
}

function claudeCommand(command?: string): string {
    const configured = command?.trim() || process.env.CLAUDE_CODE_CLI_PATH?.trim() || 'claude';
    if (configured.includes('\0')) throw new Error('Invalid Claude command path');
    return configured;
}

function appendCommonClaudeArgs(args: string[], opts: {
    cwd?: string;
    model?: string;
    agent?: string;
    effort?: string;
    permissionMode?: PermissionMode;
    addDirs?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
    tools?: string;
    mcpConfig?: string[];
    settings?: string;
    systemPrompt?: string;
    appendSystemPrompt?: string;
    maxTurns?: number;
    dangerouslySkipPermissions?: boolean;
    bare?: boolean;
    safeMode?: boolean;
    verbose?: boolean;
}): void {
    if (opts.cwd) args.push('--cwd', opts.cwd);
    if (opts.model) args.push('--model', opts.model);
    if (opts.agent) args.push('--agent', opts.agent);
    if (opts.effort) args.push('--effort', opts.effort);
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
    for (const dir of opts.addDirs || []) args.push('--add-dir', path.resolve(dir));
    for (const tool of opts.allowedTools || []) args.push('--allowedTools', tool);
    for (const tool of opts.disallowedTools || []) args.push('--disallowedTools', tool);
    if (opts.tools !== undefined) args.push('--tools', opts.tools);
    for (const cfg of opts.mcpConfig || []) args.push('--mcp-config', cfg);
    if (opts.settings) args.push('--settings', opts.settings);
    if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);
    if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
    if (opts.maxTurns !== undefined) args.push('--max-turns', String(opts.maxTurns));
    if (opts.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
    if (opts.bare) args.push('--bare');
    if (opts.safeMode) args.push('--safe-mode');
    if (opts.verbose) args.push('--verbose');
}

function trimSessionBuffer(session: ClaudeSession): void {
    if (session.output.length > MAX_BUFFER_CHARS) {
        session.output = session.output.slice(session.output.length - MAX_BUFFER_CHARS);
    }
}

function lastOutput(session: ClaudeSession, maxChars = DEFAULT_READ_CHARS, clear = false): string {
    const output = session.output.slice(-Math.max(1, maxChars));
    if (clear) session.output = '';
    return output;
}

function controlSequence(name: string): string {
    switch (name) {
        case 'enter': return '\r';
        case 'escape': return '\x1b';
        case 'tab': return '\t';
        case 'ctrl-c': return '\x03';
        case 'ctrl-d': return '\x04';
        case 'ctrl-l': return '\x0c';
        case 'up': return '\x1b[A';
        case 'down': return '\x1b[B';
        case 'right': return '\x1b[C';
        case 'left': return '\x1b[D';
        default: throw new Error(`Unsupported control key: ${name}`);
    }
}

function runProcess(command: string, args: string[], opts: {
    cwd: string;
    timeoutMs: number;
    input?: string;
}): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawnChild(command, args, {
            cwd: opts.cwd,
            shell: false,
            env: process.env,
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`Command timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);

        child.stdout?.on('data', chunk => {
            stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', chunk => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', err => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr });
        });

        if (opts.input !== undefined) {
            child.stdin?.end(opts.input);
        }
    });
}

function jsonText(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

const server = new McpServer({
    name: 'Claude Code Terminal',
    version: '1.0.0',
    title: 'Claude Code Terminal',
    description: 'Start and control Anthropic Claude Code CLI coding sessions.',
    icons: [{ src: 'https://unpkg.com/@cynosure-mcp/claude-code-terminal@1.0.1/icon.png', mimeType: 'image/png' }],
});

const permissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
const outputFormatSchema = z.enum(['text', 'json', 'stream-json']);
const inputFormatSchema = z.enum(['text', 'stream-json']);

server.registerTool(
    'check_claude_cli',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Check whether the Claude Code CLI is available and report its version and authentication status.',
        inputSchema: {
            claude_command: z.string().optional().describe('Claude executable path or command name. Defaults to CLAUDE_CODE_CLI_PATH or claude.'),
        },
    },
    async ({ claude_command }) => {
        try {
            const command = claudeCommand(claude_command);
            const version = await runProcess(command, ['--version'], {
                cwd: process.cwd(),
                timeoutMs: 10_000,
            });
            const auth = await runProcess(command, ['auth', 'status', '--text'], {
                cwd: process.cwd(),
                timeoutMs: 10_000,
            }).catch(err => ({
                code: null,
                signal: null,
                stdout: '',
                stderr: err instanceof Error ? err.message : String(err),
            }));
            return {
                content: [{ type: 'text', text: jsonText({ command, available: version.code === 0, version: version.stdout.trim() || version.stderr.trim(), authStatus: auth.stdout.trim() || auth.stderr.trim(), authExitCode: auth.code }) }],
                isError: version.code !== 0,
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Claude Code CLI check failed: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

server.registerTool(
    'claude_print',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Run Claude Code non-interactively with claude -p and return stdout/stderr. This is best for one-shot tasks or scripted automation.',
        inputSchema: {
            prompt: z.string().min(1).describe('Task prompt to pass to claude -p.'),
            cwd: z.string().optional().describe('Working directory for the Claude run. Defaults to this MCP process working directory.'),
            claude_command: z.string().optional().describe('Claude executable path or command name. Defaults to CLAUDE_CODE_CLI_PATH or claude.'),
            model: z.string().optional().describe('Optional model override, passed as --model.'),
            agent: z.string().optional().describe('Optional Claude Code agent override, passed as --agent.'),
            effort: z.string().optional().describe('Optional effort level, passed as --effort.'),
            permission_mode: permissionModeSchema.optional().describe('Permission mode, passed as --permission-mode.'),
            add_dirs: z.array(z.string()).optional().default([]).describe('Additional directories to grant access with --add-dir.'),
            allowed_tools: z.array(z.string()).optional().default([]).describe('Tools that can run without prompting, passed as --allowedTools.'),
            disallowed_tools: z.array(z.string()).optional().default([]).describe('Tool deny rules, passed as --disallowedTools.'),
            tools: z.string().optional().describe('Restrict built-in tools, passed as --tools.'),
            mcp_config: z.array(z.string()).optional().default([]).describe('MCP config JSON paths or inline strings, passed as --mcp-config.'),
            settings: z.string().optional().describe('Settings JSON path or inline string, passed as --settings.'),
            system_prompt: z.string().optional().describe('Replace the default system prompt.'),
            append_system_prompt: z.string().optional().describe('Append text to the default system prompt.'),
            output_format: outputFormatSchema.optional().default('text').describe('Print mode output format: text, json, or stream-json.'),
            input_format: inputFormatSchema.optional().default('text').describe('Input format for stdin.'),
            max_turns: z.number().int().min(1).max(100).optional().describe('Maximum agentic turns for print mode.'),
            verbose: z.boolean().optional().default(false).describe('Enable verbose output.'),
            bare: z.boolean().optional().default(false).describe('Use bare mode for faster scripted calls.'),
            safe_mode: z.boolean().optional().default(false).describe('Start with customizations disabled.'),
            dangerously_skip_permissions: z.boolean().optional().default(false).describe('Pass --dangerously-skip-permissions. Use only in isolated trusted environments.'),
            stdin: z.string().optional().describe('Optional stdin context to pipe to claude -p.'),
            timeout_ms: z.number().int().min(1_000).max(3_600_000).optional().default(600_000).describe('Maximum runtime in milliseconds.'),
        },
    },
    async ({ prompt, cwd, claude_command, model, agent, effort, permission_mode, add_dirs, allowed_tools, disallowed_tools, tools, mcp_config, settings, system_prompt, append_system_prompt, output_format, input_format, max_turns, verbose, bare, safe_mode, dangerously_skip_permissions, stdin, timeout_ms }) => {
        try {
            const resolvedCwd = resolveCwd(cwd);
            const command = claudeCommand(claude_command);
            const args = ['-p'];
            appendCommonClaudeArgs(args, {
                model,
                agent,
                effort,
                permissionMode: permission_mode,
                addDirs: add_dirs,
                allowedTools: allowed_tools,
                disallowedTools: disallowed_tools,
                tools,
                mcpConfig: mcp_config,
                settings,
                systemPrompt: system_prompt,
                appendSystemPrompt: append_system_prompt,
                maxTurns: max_turns,
                dangerouslySkipPermissions: dangerously_skip_permissions,
                bare,
                safeMode: safe_mode,
                verbose,
            });
            if (output_format) args.push('--output-format', output_format);
            if (input_format) args.push('--input-format', input_format);
            args.push(prompt);

            const result = await runProcess(command, args, { cwd: resolvedCwd, timeoutMs: timeout_ms, input: stdin });
            return {
                content: [{
                    type: 'text',
                    text: jsonText({
                        command,
                        args,
                        cwd: resolvedCwd,
                        exitCode: result.code,
                        signal: result.signal,
                        stdout: result.stdout,
                        stderr: result.stderr,
                    }),
                }],
                isError: result.code !== 0,
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `claude -p failed: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

server.registerTool(
    'start_claude_session',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Start an interactive Claude Code terminal session in a PTY. Use read_claude_session and send_claude_input to interact with it.',
        inputSchema: {
            prompt: z.string().optional().describe('Optional initial prompt to pass to claude.'),
            cwd: z.string().optional().describe('Working directory for the Claude session. Defaults to this MCP process working directory.'),
            claude_command: z.string().optional().describe('Claude executable path or command name. Defaults to CLAUDE_CODE_CLI_PATH or claude.'),
            model: z.string().optional().describe('Optional model override, passed as --model.'),
            agent: z.string().optional().describe('Optional Claude Code agent override, passed as --agent.'),
            effort: z.string().optional().describe('Optional effort level, passed as --effort.'),
            permission_mode: permissionModeSchema.optional().default('default').describe('Permission mode for the interactive session.'),
            add_dirs: z.array(z.string()).optional().default([]).describe('Additional directories to grant access with --add-dir.'),
            allowed_tools: z.array(z.string()).optional().default([]).describe('Tools that can run without prompting, passed as --allowedTools.'),
            disallowed_tools: z.array(z.string()).optional().default([]).describe('Tool deny rules, passed as --disallowedTools.'),
            tools: z.string().optional().describe('Restrict built-in tools, passed as --tools.'),
            mcp_config: z.array(z.string()).optional().default([]).describe('MCP config JSON paths or inline strings, passed as --mcp-config.'),
            settings: z.string().optional().describe('Settings JSON path or inline string, passed as --settings.'),
            system_prompt: z.string().optional().describe('Replace the default system prompt.'),
            append_system_prompt: z.string().optional().describe('Append text to the default system prompt.'),
            verbose: z.boolean().optional().default(false).describe('Enable verbose output.'),
            bare: z.boolean().optional().default(false).describe('Use bare mode.'),
            safe_mode: z.boolean().optional().default(false).describe('Start with customizations disabled.'),
            remote_control: z.boolean().optional().default(false).describe('Pass --remote-control to make the interactive session controllable from Claude.ai or the Claude app.'),
            dangerously_skip_permissions: z.boolean().optional().default(false).describe('Pass --dangerously-skip-permissions. Use only in isolated trusted environments.'),
            cols: z.number().int().min(40).max(240).optional().default(120).describe('PTY columns.'),
            rows: z.number().int().min(10).max(80).optional().default(32).describe('PTY rows.'),
            initial_read_ms: z.number().int().min(0).max(10_000).optional().default(1000).describe('Milliseconds to wait before returning initial output.'),
        },
    },
    async ({ prompt, cwd, claude_command, model, agent, effort, permission_mode, add_dirs, allowed_tools, disallowed_tools, tools, mcp_config, settings, system_prompt, append_system_prompt, verbose, bare, safe_mode, remote_control, dangerously_skip_permissions, cols, rows, initial_read_ms }) => {
        try {
            const resolvedCwd = resolveCwd(cwd);
            const command = claudeCommand(claude_command);
            const args: string[] = [];
            appendCommonClaudeArgs(args, {
                model,
                agent,
                effort,
                permissionMode: permission_mode,
                addDirs: add_dirs,
                allowedTools: allowed_tools,
                disallowedTools: disallowed_tools,
                tools,
                mcpConfig: mcp_config,
                settings,
                systemPrompt: system_prompt,
                appendSystemPrompt: append_system_prompt,
                dangerouslySkipPermissions: dangerously_skip_permissions,
                bare,
                safeMode: safe_mode,
                verbose,
            });
            if (remote_control) args.push('--remote-control');
            if (prompt) args.push(prompt);

            const term = pty.spawn(command, args, {
                name: isWindows ? 'xterm' : 'xterm-256color',
                cols,
                rows,
                cwd: resolvedCwd,
                env: process.env as Record<string, string>,
            });

            const id = randomUUID();
            const session: ClaudeSession = {
                id,
                command,
                args,
                cwd: resolvedCwd,
                createdAt: new Date().toISOString(),
                cols,
                rows,
                process: term,
                output: '',
            };
            sessions.set(id, session);

            term.onData(data => {
                session.output += data;
                trimSessionBuffer(session);
            });
            term.onExit(({ exitCode, signal }) => {
                session.exitCode = exitCode;
                session.exitSignal = signal;
                session.output += `\n[Claude Code session exited: code=${exitCode} signal=${signal}]\n`;
                trimSessionBuffer(session);
            });

            if (initial_read_ms) {
                await new Promise(resolve => setTimeout(resolve, initial_read_ms));
            }

            return {
                content: [{
                    type: 'text',
                    text: jsonText({
                        sessionId: id,
                        command,
                        args,
                        cwd: resolvedCwd,
                        running: session.exitCode === undefined,
                        output: lastOutput(session),
                    }),
                }],
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Failed to start Claude Code session: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

server.registerTool(
    'read_claude_session',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        description: 'Read buffered terminal output from a running or recently exited interactive Claude Code session.',
        inputSchema: {
            session_id: z.string().describe('Session ID returned by start_claude_session.'),
            max_chars: z.number().int().min(1).max(MAX_BUFFER_CHARS).optional().default(DEFAULT_READ_CHARS).describe('Maximum characters to return from the end of the buffer.'),
            clear: z.boolean().optional().default(false).describe('Clear the session buffer after reading.'),
        },
    },
    async ({ session_id, max_chars, clear }) => {
        const session = sessions.get(session_id);
        if (!session) {
            return { content: [{ type: 'text', text: `Unknown Claude Code session: ${session_id}` }], isError: true };
        }
        return {
            content: [{
                type: 'text',
                text: jsonText({
                    sessionId: session.id,
                    running: session.exitCode === undefined,
                    exitCode: session.exitCode,
                    exitSignal: session.exitSignal,
                    output: lastOutput(session, max_chars, clear),
                }),
            }],
        };
    },
);

server.registerTool(
    'send_claude_input',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Send text or a control key to an interactive Claude Code session.',
        inputSchema: {
            session_id: z.string().describe('Session ID returned by start_claude_session.'),
            text: z.string().optional().default('').describe('Text to send to the Claude Code terminal.'),
            submit: z.boolean().optional().default(true).describe('Append Enter after text, useful for sending a prompt from the composer.'),
            control: z.enum(['enter', 'escape', 'tab', 'ctrl-c', 'ctrl-d', 'ctrl-l', 'up', 'down', 'left', 'right']).optional().describe('Optional control key to send after text.'),
            read_after_ms: z.number().int().min(0).max(10_000).optional().default(1000).describe('Milliseconds to wait before returning new output.'),
            max_chars: z.number().int().min(1).max(MAX_BUFFER_CHARS).optional().default(DEFAULT_READ_CHARS).describe('Maximum characters of output to return.'),
        },
    },
    async ({ session_id, text, submit, control, read_after_ms, max_chars }) => {
        const session = sessions.get(session_id);
        if (!session) {
            return { content: [{ type: 'text', text: `Unknown Claude Code session: ${session_id}` }], isError: true };
        }
        if (session.exitCode !== undefined) {
            return { content: [{ type: 'text', text: `Claude Code session has exited: ${session_id}` }], isError: true };
        }

        try {
            if (text) session.process.write(text);
            if (submit) session.process.write('\r');
            if (control) session.process.write(controlSequence(control));
            if (read_after_ms) {
                await new Promise(resolve => setTimeout(resolve, read_after_ms));
            }
            return {
                content: [{
                    type: 'text',
                    text: jsonText({
                        sessionId: session.id,
                        running: session.exitCode === undefined,
                        output: lastOutput(session, max_chars),
                    }),
                }],
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Failed to send input: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

server.registerTool(
    'stop_claude_session',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        description: 'Stop an interactive Claude Code session.',
        inputSchema: {
            session_id: z.string().describe('Session ID returned by start_claude_session.'),
            force: z.boolean().optional().default(false).describe('Kill the PTY immediately instead of sending Ctrl+C first.'),
        },
    },
    async ({ session_id, force }) => {
        const session = sessions.get(session_id);
        if (!session) {
            return { content: [{ type: 'text', text: `Unknown Claude Code session: ${session_id}` }], isError: true };
        }
        try {
            if (session.exitCode === undefined) {
                if (!force) session.process.write('\x03');
                session.process.kill();
            }
            sessions.delete(session_id);
            return { content: [{ type: 'text', text: `Stopped Claude Code session ${session_id}.` }] };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Failed to stop Claude Code session: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

server.registerTool(
    'list_claude_sessions',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'List interactive Claude Code sessions currently tracked by this MCP process.',
        inputSchema: {},
    },
    async () => ({
        content: [{
            type: 'text',
            text: jsonText([...sessions.values()].map(session => ({
                sessionId: session.id,
                command: session.command,
                args: session.args,
                cwd: session.cwd,
                createdAt: session.createdAt,
                running: session.exitCode === undefined,
                exitCode: session.exitCode,
                exitSignal: session.exitSignal,
                bufferedChars: session.output.length,
            }))),
        }],
    }),
);

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('Claude Code Terminal MCP server running on stdio');
}

process.on('exit', () => {
    for (const session of sessions.values()) {
        try { session.process.kill(); } catch { /* best effort */ }
    }
});

main().catch((err) => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
});
