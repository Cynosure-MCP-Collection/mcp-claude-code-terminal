#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import xtermHeadless from '@xterm/headless';
import type { IMarker, Terminal as HeadlessTerminal } from '@xterm/headless';
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { platform } from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { z } from 'zod';

const { Terminal } = xtermHeadless;
const pkg = createRequire(import.meta.url)('../package.json') as { name: string; version: string };

type PermissionMode = 'default' | 'manual' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
type OutputView = 'screen' | 'scrollback' | 'raw';

interface ClaudeSession {
    id: string;
    command: string;
    args: string[];
    cwd: string;
    createdAt: string;
    cols: number;
    rows: number;
    process: pty.IPty;
    terminal: HeadlessTerminal;
    // Start of the scrollback view; moved forward by read_claude_session clear=true.
    scrollbackMark?: IMarker;
    output: string;
    lastOutputAt: number;
    exitCode?: number;
    exitSignal?: number;
}

const MAX_BUFFER_CHARS = 250_000;
const DEFAULT_READ_CHARS = 12_000;
const MAX_WAIT_MS = 600_000;
const SCROLLBACK_LINES = 5_000;
const sessions = new Map<string, ClaudeSession>();
const isWindows = platform() === 'win32';

// Variables that tie a process to the Claude Code session hosting this MCP server (for example its
// messaging socket and token). Spawned sessions are independent, so they must not inherit them.
const PARENT_SESSION_ENV = [
    'CLAUDECODE',
    'CLAUDE_PID',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SSE_PORT',
];

function log(msg: string): void {
    process.stderr.write(`[claude-code-terminal-mcp ${new Date().toISOString()}] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !PARENT_SESSION_ENV.includes(key)) env[key] = value;
    }
    return env;
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
    resume?: string;
    continueConversation?: boolean;
    dangerouslySkipPermissions?: boolean;
    bare?: boolean;
    safeMode?: boolean;
    verbose?: boolean;
}): void {
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
    if (opts.resume) args.push('--resume', opts.resume);
    if (opts.continueConversation) args.push('--continue');
    if (opts.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
    if (opts.bare) args.push('--bare');
    if (opts.safeMode) args.push('--safe-mode');
    if (opts.verbose) args.push('--verbose');
}

// Variadic options such as --allowedTools and optional-value options such as --remote-control would
// otherwise consume the prompt as one of their values.
function appendPrompt(args: string[], prompt?: string): void {
    if (prompt) args.push('--', prompt);
}

function trimSessionBuffer(session: ClaudeSession): void {
    if (session.output.length > MAX_BUFFER_CHARS) {
        session.output = session.output.slice(session.output.length - MAX_BUFFER_CHARS);
    }
}

function flushTerminal(session: ClaudeSession): Promise<void> {
    return new Promise(resolve => session.terminal.write('', resolve));
}

function renderLines(session: ClaudeSession, start: number): string {
    const buffer = session.terminal.buffer.active;
    let text = '';
    for (let i = Math.max(0, start); i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (!line) continue;
        if (i > start && !line.isWrapped) text += '\n';
        text += line.translateToString(!buffer.getLine(i + 1)?.isWrapped);
    }
    return text.replace(/\s+$/, '');
}

async function sessionOutput(session: ClaudeSession, view: OutputView, maxChars = DEFAULT_READ_CHARS): Promise<string> {
    const limit = Math.max(1, maxChars);
    if (view === 'raw') return session.output.slice(-limit);
    await flushTerminal(session);
    const buffer = session.terminal.buffer.active;
    const mark = session.scrollbackMark;
    const start = view === 'screen' ? buffer.baseY : (mark && !mark.isDisposed ? mark.line : 0);
    return renderLines(session, start).slice(-limit);
}

async function clearSessionOutput(session: ClaudeSession): Promise<void> {
    session.output = '';
    await flushTerminal(session);
    // Keep the visible screen readable; only drop the history above it from the scrollback view.
    session.scrollbackMark?.dispose();
    session.scrollbackMark = session.terminal.registerMarker(-session.terminal.buffer.active.cursorY);
}

async function sessionHint(session: ClaudeSession): Promise<string | undefined> {
    if (session.exitCode !== undefined) return undefined;
    const screen = await sessionOutput(session, 'screen');
    if (/trust this folder/i.test(screen)) {
        return 'Claude Code is asking whether to trust this folder. "No, exit" is selected by default: send control "down" and then control "enter" to trust it, or "escape" to cancel.';
    }
    return undefined;
}

// Waits up to waitMs. With idleMs, returns as soon as the session has produced no output for idleMs,
// which is when Claude Code has finished a turn or is waiting for input such as a permission prompt.
async function waitForSession(session: ClaudeSession, waitMs: number, idleMs?: number): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < waitMs && session.exitCode === undefined) {
        const now = Date.now();
        if (idleMs && now - startedAt >= idleMs && now - session.lastOutputAt >= idleMs) return;
        await sleep(Math.min(100, waitMs - (now - startedAt)));
    }
}

async function sessionStatus(session: ClaudeSession, view: OutputView, maxChars?: number): Promise<Record<string, unknown>> {
    return {
        sessionId: session.id,
        running: session.exitCode === undefined,
        exitCode: session.exitCode,
        exitSignal: session.exitSignal,
        idleMs: Date.now() - session.lastOutputAt,
        hint: await sessionHint(session),
        view,
        output: await sessionOutput(session, view, maxChars),
    };
}

function killSession(session: ClaudeSession): void {
    try { session.process.kill(); } catch { /* already exited */ }
    session.terminal.dispose();
}

function controlSequence(name: string): string {
    switch (name) {
        case 'enter': return '\r';
        case 'escape': return '\x1b';
        case 'tab': return '\t';
        case 'shift-tab': return '\x1b[Z';
        case 'backspace': return '\x7f';
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
}): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
        const child = spawnChild(command, args, {
            cwd: opts.cwd,
            shell: false,
            env: childEnv(),
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        }, opts.timeoutMs);

        child.stdout?.on('data', chunk => {
            stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', chunk => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', err => {
            clearTimeout(timer);
            clearTimeout(killTimer);
            reject(err);
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            clearTimeout(killTimer);
            resolve({ code, signal, stdout, stderr, timedOut });
        });

        // Always close stdin: claude -p otherwise waits several seconds for piped input that never comes.
        child.stdin?.on('error', () => { /* child exited before reading stdin */ });
        child.stdin?.end(opts.input ?? '');
    });
}

function jsonText(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

const server = new McpServer({
    name: 'Claude Code Terminal',
    version: pkg.version,
    title: 'Claude Code Terminal',
    description: 'Start and control Anthropic Claude Code CLI coding sessions.',
    icons: [{ src: `https://unpkg.com/${pkg.name}@${pkg.version}/icon.png`, mimeType: 'image/png' }],
});

const permissionModeSchema = z.enum(['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
const outputFormatSchema = z.enum(['text', 'json', 'stream-json']);
const inputFormatSchema = z.enum(['text', 'stream-json']);
const outputViewSchema = z.enum(['screen', 'scrollback', 'raw']);
const outputViewDescription = 'How to return terminal output: "screen" renders the visible terminal as plain text, "scrollback" renders the history since the last clear as plain text, "raw" returns the unprocessed PTY stream including ANSI escape codes.';
const idleDescription = 'Return early once the session has produced no output for this many milliseconds, usually meaning Claude Code finished its turn or is waiting for input. 0 disables early return.';

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
        description: 'Run Claude Code non-interactively with claude -p and return stdout/stderr. This is best for one-shot tasks or scripted automation. Use output_format "json" to get a session_id, then pass it as resume to continue the same conversation in a later call. Print mode cannot answer permission prompts, so grant tools up front with allowed_tools or permission_mode.',
        inputSchema: {
            prompt: z.string().min(1).describe('Task prompt to pass to claude -p.'),
            cwd: z.string().optional().describe('Working directory for the Claude run. Defaults to this MCP process working directory.'),
            claude_command: z.string().optional().describe('Claude executable path or command name. Defaults to CLAUDE_CODE_CLI_PATH or claude.'),
            model: z.string().optional().describe('Optional model override, passed as --model.'),
            agent: z.string().optional().describe('Optional Claude Code agent override, passed as --agent.'),
            effort: z.string().optional().describe('Optional effort level (low, medium, high, xhigh, max), passed as --effort.'),
            permission_mode: permissionModeSchema.optional().describe('Permission mode, passed as --permission-mode.'),
            add_dirs: z.array(z.string()).optional().default([]).describe('Additional directories to grant access with --add-dir.'),
            allowed_tools: z.array(z.string()).optional().default([]).describe('Tools that can run without prompting, passed as --allowedTools.'),
            disallowed_tools: z.array(z.string()).optional().default([]).describe('Tool deny rules, passed as --disallowedTools.'),
            tools: z.string().optional().describe('Restrict built-in tools, passed as --tools.'),
            mcp_config: z.array(z.string()).optional().default([]).describe('MCP config JSON paths or inline strings, passed as --mcp-config.'),
            settings: z.string().optional().describe('Settings JSON path or inline string, passed as --settings.'),
            system_prompt: z.string().optional().describe('Replace the default system prompt.'),
            append_system_prompt: z.string().optional().describe('Append text to the default system prompt.'),
            resume: z.string().optional().describe('Session ID of an earlier run to continue, passed as --resume.'),
            continue_conversation: z.boolean().optional().default(false).describe('Continue the most recent conversation in cwd, passed as --continue.'),
            output_format: outputFormatSchema.optional().default('text').describe('Print mode output format: text, json, or stream-json.'),
            input_format: inputFormatSchema.optional().default('text').describe('Input format for stdin.'),
            json_schema: z.string().optional().describe('JSON Schema the final result must conform to, passed as --json-schema.'),
            max_turns: z.number().int().min(1).max(100).optional().describe('Maximum agentic turns for print mode.'),
            max_budget_usd: z.number().positive().optional().describe('Maximum dollar amount to spend on API calls, passed as --max-budget-usd.'),
            verbose: z.boolean().optional().default(false).describe('Enable verbose output.'),
            bare: z.boolean().optional().default(false).describe('Use bare mode for faster scripted calls.'),
            safe_mode: z.boolean().optional().default(false).describe('Start with customizations disabled.'),
            dangerously_skip_permissions: z.boolean().optional().default(false).describe('Pass --dangerously-skip-permissions. Use only in isolated trusted environments.'),
            stdin: z.string().optional().describe('Optional stdin context to pipe to claude -p.'),
            timeout_ms: z.number().int().min(1_000).max(3_600_000).optional().default(600_000).describe('Maximum runtime in milliseconds. Output produced before the timeout is still returned.'),
        },
    },
    async ({ prompt, cwd, claude_command, model, agent, effort, permission_mode, add_dirs, allowed_tools, disallowed_tools, tools, mcp_config, settings, system_prompt, append_system_prompt, resume, continue_conversation, output_format, input_format, json_schema, max_turns, max_budget_usd, verbose, bare, safe_mode, dangerously_skip_permissions, stdin, timeout_ms }) => {
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
                resume,
                continueConversation: continue_conversation,
                dangerouslySkipPermissions: dangerously_skip_permissions,
                bare,
                safeMode: safe_mode,
                verbose,
            });
            if (output_format) args.push('--output-format', output_format);
            if (input_format) args.push('--input-format', input_format);
            if (json_schema) args.push('--json-schema', json_schema);
            if (max_turns !== undefined) args.push('--max-turns', String(max_turns));
            if (max_budget_usd !== undefined) args.push('--max-budget-usd', String(max_budget_usd));
            appendPrompt(args, prompt);

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
                        timedOut: result.timedOut || undefined,
                        stdout: result.stdout,
                        stderr: result.stderr,
                    }),
                }],
                isError: result.code !== 0 || result.timedOut,
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
        description: 'Start an interactive Claude Code terminal session in a PTY. Use read_claude_session and send_claude_input to interact with it. In a folder Claude Code has not been told to trust yet, the session first shows a trust dialog; the returned hint explains how to answer it.',
        inputSchema: {
            prompt: z.string().optional().describe('Optional initial prompt to pass to claude.'),
            cwd: z.string().optional().describe('Working directory for the Claude session. Defaults to this MCP process working directory.'),
            claude_command: z.string().optional().describe('Claude executable path or command name. Defaults to CLAUDE_CODE_CLI_PATH or claude.'),
            model: z.string().optional().describe('Optional model override, passed as --model.'),
            agent: z.string().optional().describe('Optional Claude Code agent override, passed as --agent.'),
            effort: z.string().optional().describe('Optional effort level (low, medium, high, xhigh, max), passed as --effort.'),
            permission_mode: permissionModeSchema.optional().describe('Permission mode for the interactive session. Defaults to the user\'s Claude Code settings.'),
            add_dirs: z.array(z.string()).optional().default([]).describe('Additional directories to grant access with --add-dir.'),
            allowed_tools: z.array(z.string()).optional().default([]).describe('Tools that can run without prompting, passed as --allowedTools.'),
            disallowed_tools: z.array(z.string()).optional().default([]).describe('Tool deny rules, passed as --disallowedTools.'),
            tools: z.string().optional().describe('Restrict built-in tools, passed as --tools.'),
            mcp_config: z.array(z.string()).optional().default([]).describe('MCP config JSON paths or inline strings, passed as --mcp-config.'),
            settings: z.string().optional().describe('Settings JSON path or inline string, passed as --settings.'),
            system_prompt: z.string().optional().describe('Replace the default system prompt.'),
            append_system_prompt: z.string().optional().describe('Append text to the default system prompt.'),
            resume: z.string().optional().describe('Session ID of an earlier conversation to resume, passed as --resume.'),
            continue_conversation: z.boolean().optional().default(false).describe('Continue the most recent conversation in cwd, passed as --continue.'),
            verbose: z.boolean().optional().default(false).describe('Enable verbose output.'),
            bare: z.boolean().optional().default(false).describe('Use bare mode.'),
            safe_mode: z.boolean().optional().default(false).describe('Start with customizations disabled.'),
            remote_control: z.boolean().optional().default(false).describe('Pass --remote-control to make the interactive session controllable from Claude.ai or the Claude app.'),
            dangerously_skip_permissions: z.boolean().optional().default(false).describe('Pass --dangerously-skip-permissions. Use only in isolated trusted environments.'),
            cols: z.number().int().min(40).max(240).optional().default(120).describe('PTY columns.'),
            rows: z.number().int().min(10).max(80).optional().default(32).describe('PTY rows.'),
            initial_read_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional().default(3000).describe('Maximum milliseconds to wait before returning initial output.'),
            until_idle_ms: z.number().int().min(0).max(60_000).optional().default(0).describe(idleDescription),
            view: outputViewSchema.optional().default('screen').describe(outputViewDescription),
        },
    },
    async ({ prompt, cwd, claude_command, model, agent, effort, permission_mode, add_dirs, allowed_tools, disallowed_tools, tools, mcp_config, settings, system_prompt, append_system_prompt, resume, continue_conversation, verbose, bare, safe_mode, remote_control, dangerously_skip_permissions, cols, rows, initial_read_ms, until_idle_ms, view }) => {
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
                resume,
                continueConversation: continue_conversation,
                dangerouslySkipPermissions: dangerously_skip_permissions,
                bare,
                safeMode: safe_mode,
                verbose,
            });
            if (remote_control) args.push('--remote-control');
            appendPrompt(args, prompt);

            const term = pty.spawn(command, args, {
                name: isWindows ? 'xterm' : 'xterm-256color',
                cols,
                rows,
                cwd: resolvedCwd,
                env: childEnv(),
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
                terminal: new Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true }),
                output: '',
                lastOutputAt: Date.now(),
            };
            sessions.set(id, session);

            term.onData(data => {
                session.output += data;
                session.lastOutputAt = Date.now();
                session.terminal.write(data);
                trimSessionBuffer(session);
            });
            term.onExit(({ exitCode, signal }) => {
                session.exitCode = exitCode;
                session.exitSignal = signal;
                session.output += `\n[Claude Code session exited: code=${exitCode} signal=${signal}]\n`;
                session.terminal.write(`\r\n[Claude Code session exited: code=${exitCode} signal=${signal}]\r\n`);
                trimSessionBuffer(session);
            });

            await waitForSession(session, initial_read_ms, until_idle_ms);

            return {
                content: [{
                    type: 'text',
                    text: jsonText({
                        command,
                        args,
                        cwd: resolvedCwd,
                        ...await sessionStatus(session, view),
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
        description: 'Read output from a running or recently exited interactive Claude Code session, optionally waiting for Claude Code to go idle first.',
        inputSchema: {
            session_id: z.string().describe('Session ID returned by start_claude_session.'),
            max_chars: z.number().int().min(1).max(MAX_BUFFER_CHARS).optional().default(DEFAULT_READ_CHARS).describe('Maximum characters to return from the end of the output.'),
            view: outputViewSchema.optional().default('screen').describe(outputViewDescription),
            wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional().default(0).describe('Maximum milliseconds to wait before reading.'),
            until_idle_ms: z.number().int().min(0).max(60_000).optional().default(0).describe(idleDescription),
            clear: z.boolean().optional().default(false).describe('After reading, drop the raw buffer and the scrollback history above the current screen.'),
        },
    },
    async ({ session_id, max_chars, view, wait_ms, until_idle_ms, clear }) => {
        const session = sessions.get(session_id);
        if (!session) {
            return { content: [{ type: 'text', text: `Unknown Claude Code session: ${session_id}` }], isError: true };
        }
        await waitForSession(session, wait_ms, until_idle_ms);
        const status = await sessionStatus(session, view, max_chars);
        if (clear) await clearSessionOutput(session);
        return { content: [{ type: 'text', text: jsonText(status) }] };
    },
);

server.registerTool(
    'send_claude_input',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Send text and/or a control key to an interactive Claude Code session, then return its output. Text is sent first (followed by Enter when submit is true), then the control key. To wait for Claude Code to finish its turn, set until_idle_ms (for example 3000) together with a generous read_after_ms.',
        inputSchema: {
            session_id: z.string().describe('Session ID returned by start_claude_session.'),
            text: z.string().optional().default('').describe('Text to send to the Claude Code terminal. Multi-line text is sent as a bracketed paste.'),
            submit: z.boolean().optional().default(true).describe('Press Enter after text, to submit a prompt from the composer. Has no effect when text is empty.'),
            control: z.enum(['enter', 'escape', 'tab', 'shift-tab', 'backspace', 'ctrl-c', 'ctrl-d', 'ctrl-l', 'up', 'down', 'left', 'right']).optional().describe('Optional control key to send after text.'),
            read_after_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional().default(1000).describe('Maximum milliseconds to wait before returning output.'),
            until_idle_ms: z.number().int().min(0).max(60_000).optional().default(0).describe(idleDescription),
            max_chars: z.number().int().min(1).max(MAX_BUFFER_CHARS).optional().default(DEFAULT_READ_CHARS).describe('Maximum characters of output to return.'),
            view: outputViewSchema.optional().default('screen').describe(outputViewDescription),
        },
    },
    async ({ session_id, text, submit, control, read_after_ms, until_idle_ms, max_chars, view }) => {
        const session = sessions.get(session_id);
        if (!session) {
            return { content: [{ type: 'text', text: `Unknown Claude Code session: ${session_id}` }], isError: true };
        }
        if (session.exitCode !== undefined) {
            return { content: [{ type: 'text', text: `Claude Code session has exited: ${session_id}` }], isError: true };
        }

        try {
            if (text) {
                session.process.write(/[\r\n]/.test(text) ? `\x1b[200~${text}\x1b[201~` : text);
                if (submit) {
                    // Give the composer a moment to take the text in, so Enter is not treated as part of a paste.
                    await sleep(100);
                    session.process.write('\r');
                }
            }
            if (control) session.process.write(controlSequence(control));
            await waitForSession(session, read_after_ms, until_idle_ms);
            return { content: [{ type: 'text', text: jsonText(await sessionStatus(session, view, max_chars)) }] };
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
            force: z.boolean().optional().default(false).describe('Kill the PTY immediately instead of letting Claude Code exit through Ctrl+C first.'),
        },
    },
    async ({ session_id, force }) => {
        const session = sessions.get(session_id);
        if (!session) {
            return { content: [{ type: 'text', text: `Unknown Claude Code session: ${session_id}` }], isError: true };
        }
        try {
            if (session.exitCode === undefined && !force) {
                // Claude Code exits on a second Ctrl+C; the first one only interrupts or clears input.
                session.process.write('\x03');
                await sleep(200);
                session.process.write('\x03');
                await waitForSession(session, 3_000);
            }
            const exitedCleanly = session.exitCode !== undefined;
            killSession(session);
            sessions.delete(session_id);
            return { content: [{ type: 'text', text: `Stopped Claude Code session ${session_id}${exitedCleanly ? '' : ' (killed)'}.` }] };
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
                idleMs: Date.now() - session.lastOutputAt,
                bufferedChars: session.output.length,
            }))),
        }],
    }),
);

let shuttingDown = false;
function shutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Shutting down (${reason}); stopping ${sessions.size} session(s)`);
    for (const session of sessions.values()) killSession(session);
    sessions.clear();
    process.exit(0);
}

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Running PTYs keep the event loop alive, so exit explicitly when the client goes away.
    process.stdin.on('end', () => shutdown('stdin closed'));
    process.stdin.on('close', () => shutdown('stdin closed'));
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.on(signal, () => shutdown(signal));
    }
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
