#!/usr/bin/env node
/* global process */

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

function jsonFromOutput(output) {
  const trimmed = output.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
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

function replyArguments(args) {
  const read = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0 || args[index + 1] === undefined) return null;
    return args[index + 1].trim();
  };
  const eventId = read('--event-id');
  const senderUserId = read('--sender-user-id');
  const conversationId = read('--conversation-id');
  const message = read('--message');
  const trustedSenderUserId = process.env.ATL_DINGTALK_TRUSTED_SENDER_USER_ID?.trim();
  const trustedConversationId = process.env.ATL_DINGTALK_TRUSTED_CONVERSATION_ID?.trim();
  if (!trustedSenderUserId || !trustedConversationId) {
    throw new Error('DingTalk trusted sender and conversation must be configured');
  }
  if (eventId === null || eventId === '') throw new Error('--event-id is required');
  if (senderUserId === null || senderUserId === '') throw new Error('--sender-user-id is required');
  if (conversationId === null || conversationId === '') throw new Error('--conversation-id is required');
  if (message === null || message === '') throw new Error('--message is required');
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
  if (typeof decision.responseText === 'string') {
    args.push('--response-text', decision.responseText);
  }
  args.push('--driver', driver, '--json');
  const result = await run(nodeExecutable, runnerArgs(...args));
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
  if (review.decision !== 'approve') args.push('--feedback', review.feedback);
  args.push('--json');
  const result = await run(nodeExecutable, runnerArgs(...args));
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
  } = replyArguments(process.argv.slice(3));
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
