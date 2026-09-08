#!/usr/bin/env node
/* global process */

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridgeDirectory = dirname(fileURLToPath(import.meta.url));
const nodeExecutable = process.env.ATL_NODE_EXECUTABLE || process.execPath;
const configuredRunnerEntry = process.env.ATL_RUNNER_ENTRY?.trim() || '';
const runnerEntry = configuredRunnerEntry || join(bridgeDirectory, 'atl-runner.mjs');
const driver = process.env.ATL_AGENT_DRIVER || 'claude';
const mode = process.argv[2] || 'run-once';
const MAX_REPLY_INPUT_BYTES = 64 * 1024;

function jsonFromOutput(output) {
  const trimmed = output.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.on('error', reject);
      child.stdin.end(input);
    }
  });
}

function runnerArgs(...args) {
  if (!existsSync(runnerEntry)) {
    const hint = configuredRunnerEntry === ''
      ? 'Set ATL_RUNNER_ENTRY if the runner is installed elsewhere.'
      : 'Check ATL_RUNNER_ENTRY.';
    throw new Error(`ATL runner not found at ${runnerEntry}. ${hint}`);
  }
  return [runnerEntry, ...args];
}

function successfulJson(result, fallback) {
  const parsed = jsonFromOutput(result.stdout);
  if (result.code !== 0 || parsed === null || parsed.ok === false) {
    const message = parsed?.error?.message;
    throw new Error(
      typeof message === 'string' && message.trim() !== ''
        ? message
        : result.stderr.trim() || fallback,
    );
  }
  return parsed;
}

function optionLines(task) {
  const options = task?.pendingDecision?.options;
  if (!Array.isArray(options)) return '';
  return options.map((option, index) => (
    `${index + 1}. ${option.id}: ${option.label}`
  )).join('\n');
}

function findTask(tasks, message) {
  const explicitTaskId = message.match(/task-[a-z0-9-]+/i)?.[0];
  if (explicitTaskId !== undefined) {
    return tasks.find((task) => task.taskId === explicitTaskId) ?? null;
  }
  return tasks.length === 1 ? tasks[0] : null;
}

function selectOption(task, message) {
  const options = task?.pendingDecision?.options;
  if (!Array.isArray(options)) return null;
  const withoutTaskId = message.replace(/task-[a-z0-9-]+/ig, ' ').trim();
  const normalized = withoutTaskId.toLowerCase();
  const ordinal = /^(?:选?项?\s*)?([a-z]|\d+)$/i.exec(normalized)?.[1];
  if (ordinal !== undefined) {
    const index = /^\d+$/.test(ordinal)
      ? Number(ordinal) - 1
      : ordinal.charCodeAt(0) - 97;
    if (Number.isInteger(index) && options[index] !== undefined) return options[index];
  }
  return options.find((option) => option.id.toLowerCase() === normalized)
    ?? options.find((option) => option.label.toLowerCase() === normalized)
    ?? null;
}

function artifactReviewArguments(message) {
  const match = /^(接受|要求修改|阻塞|取消)\s+(task-[a-z0-9-]+)\s+v(\d+)(?:[：:]\s*(.*))?$/iu.exec(message.trim());
  if (match === null) return null;
  const [, command, taskId, versionText, feedbackText] = match;
  const decision = {
    接受: 'approve',
    要求修改: 'request_changes',
    阻塞: 'block',
    取消: 'cancel',
  }[command];
  if (decision === undefined) return null;
  const version = Number(versionText);
  if (!Number.isInteger(version) || version <= 0) return null;
  const feedback = feedbackText?.trim() || '';
  if (decision !== 'approve' && feedback === '') {
    throw new Error('Artifact 要求修改、阻塞或取消必须包含反馈');
  }
  return { decision, taskId, version, feedback };
}

function multicaActionArguments(message) {
  const match = /^(select:[A-Za-z0-9][A-Za-z0-9._-]{0,199}|approve|rework|block|cancel) (task-[A-Za-z0-9][A-Za-z0-9._-]{0,194})$/u
    .exec(message.trim());
  if (match === null) return null;
  const [, action, taskId] = match;
  return { action, taskId };
}

function replyInputError() {
  return new Error('DingTalk reply stdin JSON has invalid fields');
}

function hasInputControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

async function readReplyInput() {
  let bytes = 0;
  let input = '';
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_REPLY_INPUT_BYTES) {
      throw new Error('DingTalk reply stdin JSON exceeds 64 KiB');
    }
    input += chunk;
  }
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error('DingTalk reply stdin must contain valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw replyInputError();
  }
  const fields = ['eventId', 'senderUserId', 'conversationId', 'message'];
  if (Object.keys(value).some((field) => !fields.includes(field))) {
    throw replyInputError();
  }
  const identifier = (field) => {
    const candidate = value[field];
    if (
      typeof candidate !== 'string'
      || !/^[A-Za-z0-9_:+./=-]{1,256}$/u.test(candidate)
    ) throw replyInputError();
    return candidate;
  };
  const message = value.message;
  if (
    typeof message !== 'string'
    || message.trim() === ''
    || message.length > 2_000
    || hasInputControlCharacters(message)
  ) throw replyInputError();
  return {
    eventId: identifier('eventId'),
    senderUserId: identifier('senderUserId'),
    conversationId: identifier('conversationId'),
    message,
  };
}

async function replyArguments(args) {
  if (args.length !== 1 || args[0] !== '--stdin-json') {
    throw new Error('DingTalk reply must use --stdin-json');
  }
  const { eventId, senderUserId, conversationId, message } = await readReplyInput();
  const trustedSenderId = process.env.ATL_DINGTALK_TRUSTED_SENDER_ID?.trim();
  const trustedStreamSenderId = process.env.ATL_DINGTALK_TRUSTED_SENDER_USER_ID?.trim();
  if (
    trustedSenderId
    && trustedStreamSenderId
    && trustedSenderId !== trustedStreamSenderId
  ) {
    throw new Error('DingTalk trusted sender environment values conflict');
  }
  const trustedSenderUserId = trustedStreamSenderId || trustedSenderId;
  const trustedConversationId = process.env.ATL_DINGTALK_TRUSTED_CONVERSATION_ID?.trim();
  if (!trustedSenderUserId || !trustedConversationId) {
    throw new Error('DingTalk trusted sender and conversation must be configured');
  }
  if (senderUserId !== trustedSenderUserId || conversationId !== trustedConversationId) {
    throw new Error('DingTalk reply source is not trusted');
  }
  return { eventId, senderUserId, conversationId, message };
}

async function listPendingDecisions() {
  const result = await run(nodeExecutable, runnerArgs(
    'task', 'list', '--status', 'waiting_for_decision', '--json',
  ));
  const parsed = successfulJson(result, 'Task list failed');
  return Array.isArray(parsed) ? parsed : [];
}

async function listTasksForActionRouting() {
  const result = await run(nodeExecutable, runnerArgs('task', 'list', '--json'));
  const parsed = successfulJson(result, 'Task list failed');
  return Array.isArray(parsed) ? parsed : [];
}

async function findRecordedDecision(eventId, senderUserId, conversationId) {
  const result = await run(nodeExecutable, runnerArgs(
    'task', 'list', '--status', 'agent_executable', '--json',
  ));
  const parsed = successfulJson(result, 'Task list failed');
  const matches = (Array.isArray(parsed) ? parsed : []).filter((task) => (
    task?.lastDecision?.responseEventId === eventId
    && task.lastDecision.continuationRunId === null
  ));
  if (matches.length > 1) {
    throw new Error('Decision event is recorded for multiple ATL tasks');
  }
  const task = matches[0] ?? null;
  if (
    task !== null
    && (
      task.lastDecision.senderUserId !== senderUserId
      || task.lastDecision.conversationId !== conversationId
    )
  ) {
    throw new Error('Recorded decision source does not match the Stream event');
  }
  return task;
}

async function continueDecision(task, decision) {
  const args = [
    'runner', 'continue-decision',
    '--task-id', task.taskId,
    '--decision-request-id', decision.requestId,
    '--response-event-id', decision.responseEventId,
    '--sender-user-id', decision.senderUserId,
    '--conversation-id', decision.conversationId,
    '--selected-option-id', decision.selectedOptionId,
  ];
  let input;
  if (typeof decision.responseText === 'string') {
    args.push('--private-input-stdin-json');
    input = JSON.stringify({ responseText: decision.responseText });
  }
  args.push('--driver', driver, '--json');
  const result = await run(nodeExecutable, runnerArgs(...args), input);
  return formatRunnerResult(successfulJson(
    result,
    'Decision continuation returned invalid JSON',
  ));
}

async function reviewExternalArtifact(review, event) {
  const args = [
    'task', 'review-external',
    '--task-id', review.taskId,
    '--artifact-version', String(review.version),
    '--response-event-id', event.eventId,
    '--sender-user-id', event.senderUserId,
    '--conversation-id', event.conversationId,
    `--${review.decision.replace('_', '-')}`,
  ];
  const input = review.decision === 'approve'
    ? undefined
    : JSON.stringify({ feedback: review.feedback });
  if (input !== undefined) args.push('--private-input-stdin-json');
  args.push('--json');
  const result = await run(nodeExecutable, runnerArgs(...args), input);
  const parsed = successfulJson(result, 'External Artifact review returned invalid JSON');
  if (
    review.decision === 'request_changes'
    && parsed?.task?.status === 'agent_executable'
  ) {
    const runResult = await run(nodeExecutable, runnerArgs(
      'runner', 'run-task',
      '--task-id', review.taskId,
      '--driver', driver,
      '--json',
    ));
    return formatRunnerResult(successfulJson(
      runResult,
      'Artifact rework returned invalid JSON',
    ));
  }
  if (parsed?.accepted === false) {
    return `Artifact ${review.taskId} v${review.version} 已处理过该回复。`;
  }
  const status = parsed?.task?.status || '未知结果';
  return `Artifact ${review.taskId} v${review.version} 验收结果：${status}。`;
}

async function processMulticaAction(action, event) {
  const input = JSON.stringify(event);
  const result = await run(nodeExecutable, runnerArgs(
    'multica', 'reply', '--stdin-json', '--json',
  ), input);
  const parsed = successfulJson(result, 'Multica reply returned invalid JSON');
  const taskId = parsed?.record?.taskId || action.taskId;
  const detail = parsed?.step || parsed?.reason || 'unknown';
  return `Multica 回复 ${taskId}：${parsed?.status || 'unknown'}（${detail}）。`;
}

function formatRunnerResult(result) {
  if (result?.status === 'submitted') {
    return `任务 ${result.taskId} 已进入 Review：${result.artifactRef}`;
  }
  if (result?.status === 'waiting_for_decision') {
    return `任务 ${result.taskId} 仍在等待决策：${result.decisionRequestId}`;
  }
  if (result?.status === 'duplicate_decision') {
    return `任务 ${result.taskId} 已处理过该回复。`;
  }
  if (result?.status === 'blocked') {
    return `任务 ${result.taskId} 已阻塞（${result.errorCode}）。`;
  }
  if (result?.status === 'requeued') {
    return `任务 ${result.taskId} 已回到 Agent 可执行（${result.errorCode}）。`;
  }
  return `Agent Task Loop：${result?.status || '未知结果'}`;
}

async function handleReply() {
  const {
    eventId,
    senderUserId,
    conversationId,
    message,
  } = await replyArguments(process.argv.slice(3));
  const artifactReview = artifactReviewArguments(message);
  if (artifactReview !== null) {
    return reviewExternalArtifact(artifactReview, {
      eventId,
      senderUserId,
      conversationId,
    });
  }
  const recordedTask = await findRecordedDecision(eventId, senderUserId, conversationId);
  if (recordedTask !== null) {
    return continueDecision(recordedTask, recordedTask.lastDecision);
  }
  const multicaAction = multicaActionArguments(message);
  if (multicaAction !== null) {
    const tasks = await listTasksForActionRouting();
    const task = tasks.find((candidate) => candidate?.taskId === multicaAction.taskId) ?? null;
    const legacyDecision = task === null ? null : selectOption(task, message);
    if (legacyDecision !== null) {
      return continueDecision(task, {
        requestId: task.pendingDecision.requestId,
        responseEventId: eventId,
        senderUserId,
        conversationId,
        selectedOptionId: legacyDecision.id,
        responseText: message.slice(0, 500),
      });
    }
    if (task?.actionRequest !== null && task?.actionRequest !== undefined) {
      return processMulticaAction(multicaAction, {
        eventId,
        senderUserId,
        conversationId,
        message,
      });
    }
  }
  const tasks = await listPendingDecisions();
  if (tasks.length === 0) return '当前没有等待决策的 ATL 任务。';
  const task = findTask(tasks, message);
  if (task === null) {
    return `当前有 ${tasks.length} 个任务等待决策，请在回复中包含任务 ID。`;
  }
  const decision = selectOption(task, message);
  if (decision === null) {
    return `无法识别选项。请回复编号、A/B 或选项 ID。\n${task.pendingDecision.question}\n\n${optionLines(task)}`;
  }
  return continueDecision(task, {
    requestId: task.pendingDecision.requestId,
    responseEventId: eventId,
    senderUserId,
    conversationId,
    selectedOptionId: decision.id,
    responseText: message.slice(0, 500),
  });
}

async function runOnce() {
  const result = await run(nodeExecutable, runnerArgs(
    'runner', 'run-once', '--driver', driver, '--json',
  ));
  return successfulJson(result, 'Runner returned invalid JSON');
}

try {
  let result;
  if (mode === 'reply') {
    result = await handleReply();
  } else if (mode === 'run-once') {
    result = await runOnce();
  } else {
    throw new Error(
      `Unsupported DingTalk bridge mode: ${mode}. Inbound replies require DingTalk Stream push.`,
    );
  }
  process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
