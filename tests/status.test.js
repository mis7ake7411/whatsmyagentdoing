'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { newSession, applyCodex, applyClaude, applyGemini, applyGeminiDocument, applyAntigravity } = require('../src/parsers');
const { snapshot } = require('../src/server');

const OPTIONS = { demo: true, privacy: false };
const BASE_TIME = Date.parse('2026-10-25T00:00:00.000Z');

function at(now, fn) {
  const original = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = original;
  }
}

function session(agent = 'codex') {
  return newSession(agent, 'session-1', 'session.jsonl');
}

function requests(s) {
  assert.ok(Array.isArray(s.pendingRequests), 'session exposes pendingRequests');
  return s.pendingRequests;
}

function codex(s, type, payload, timestamp = new Date(BASE_TIME).toISOString()) {
  applyCodex(s, { type, payload, timestamp });
}

function claude(s, type, fields = {}, timestamp = new Date(BASE_TIME).toISOString()) {
  applyClaude(s, { type, ...fields, timestamp });
}

function gemini(s, event, timestamp = new Date(BASE_TIME).toISOString()) {
  applyGemini(s, { ...event, timestamp });
}

function viewed(s, now = BASE_TIME, options = OPTIONS) {
  return at(now, () => snapshot({ sessions: () => [s] }, options).sessions[0]);
}

test('new sessions start unknown and snapshot exposes freshness and pending fields', () => {
  const s = session();
  const out = viewed(s);

  assert.equal(s.status, 'unknown');
  assert.equal(out.status, 'unknown');
  assert.deepEqual(out.pendingRequests, []);
  assert.equal(out.needsInput, false);
  assert.equal(out.quietMs, null);
  assert.equal(out.stale, false);
  assert.equal(out.staleAfterMs, 600_000);
});

test('status evidence follows each real status assignment and keeps the event timestamp', () => {
  const s = session();
  const metadataAt = BASE_TIME + 60_000;
  codex(s, 'session_meta', { cwd: '/private/project' }, new Date(metadataAt).toISOString());
  assert.equal(s.statusEvidence, null, 'metadata timestamps do not establish status evidence');

  const firstAt = BASE_TIME + 1_000;
  codex(s, 'event_msg', { type: 'task_started' }, new Date(firstAt).toISOString());
  assert.deepEqual(s.statusEvidence, { kind: 'turn_started', at: firstAt });

  const repeatedAt = firstAt + 5_000;
  codex(s, 'event_msg', { type: 'task_started' }, new Date(repeatedAt).toISOString());
  assert.deepEqual(s.statusEvidence, { kind: 'turn_started', at: repeatedAt }, 'a repeated same-status event refreshes evidence');
  assert.equal(viewed(s).statusEvidence.at, repeatedAt);
  assert.equal(JSON.stringify(viewed(s).statusEvidence).includes('/private/project'), false, 'status evidence does not expose paths');

  const waiting = session();
  const askedAt = BASE_TIME + 9_000;
  codex(waiting, 'event_msg', { type: 'request_user_input', call_id: 'question-1', arguments: { question: 'Continue?' } }, new Date(askedAt).toISOString());
  assert.deepEqual(waiting.statusEvidence, { kind: 'question_request', at: askedAt });
  assert.equal(waiting.pendingRequests.length, 1, 'evidence does not clear the real pending request');
});

test('Gemini document status evidence uses the nested message time instead of document metadata', () => {
  const s = session('gemini');
  const messageAt = BASE_TIME + 2_000;
  const metadataAt = messageAt + 60_000;
  applyGeminiDocument(s, {
    startTime: new Date(metadataAt).toISOString(),
    messages: [{ type: 'user', timestamp: new Date(messageAt).toISOString(), content: 'Read the file' }],
  });
  assert.deepEqual(s.statusEvidence, { kind: 'user_message', at: messageAt });

  const noTime = session('gemini');
  applyGemini(noTime, { type: 'user', content: 'No timestamp available' });
  assert.deepEqual(noTime.statusEvidence, { kind: 'user_message', at: null }, 'missing event time is not fabricated');
});

test('Antigravity status evidence describes source events without treating assistant text as completion evidence', () => {
  const s = session('antigravity');
  const userAt = BASE_TIME + 1_000;
  applyAntigravity(s, {
    type: 'USER_INPUT',
    created_at: new Date(userAt).toISOString(),
    timestamp: new Date(userAt + 5_000).toISOString(),
    content: 'Start the task',
  });
  assert.deepEqual(s.statusEvidence, { kind: 'user_message', at: userAt });

  const toolAt = userAt + 1_000;
  applyAntigravity(s, {
    type: 'PLANNER_RESPONSE',
    timestamp: new Date(toolAt).toISOString(),
    tool_calls: [{ name: 'run_command' }],
  });
  assert.deepEqual(s.statusEvidence, { kind: 'tool_call', at: toolAt });

  const questionAt = toolAt + 1_000;
  applyAntigravity(s, {
    type: 'PLANNER_RESPONSE',
    created_at: new Date(questionAt).toISOString(),
    tool_calls: [{ name: 'ask_question' }],
  });
  assert.deepEqual(s.statusEvidence, { kind: 'question_request', at: questionAt });

  const errorAt = questionAt + 1_000;
  applyAntigravity(s, {
    type: 'PLANNER_RESPONSE', status: 'ERROR',
    timestamp: new Date(errorAt).toISOString(), content: 'Request failed',
  });
  assert.deepEqual(s.statusEvidence, { kind: 'turn_error', at: errorAt });

  const assistantAt = errorAt + 1_000;
  applyAntigravity(s, {
    type: 'PLANNER_RESPONSE', status: 'DONE',
    created_at: new Date(assistantAt).toISOString(), content: 'The task is complete.',
  });
  assert.equal(s.status, 'done', 'upstream parser completion state remains unchanged');
  assert.deepEqual(s.statusEvidence, { kind: 'assistant_message', at: assistantAt });

  const started = session('antigravity');
  applyAntigravity(started, {
    type: 'SYSTEM_MESSAGE', step_index: 0, created_at: new Date(userAt).toISOString(),
    content: 'sender=c8c622b2-7934-4507-a879-9dbd9b06925b content=Subagent task',
  });
  assert.deepEqual(started.statusEvidence, { kind: 'turn_started', at: userAt });

  const uppercaseSender = session('antigravity');
  applyAntigravity(uppercaseSender, {
    type: 'SYSTEM_MESSAGE', step_index: 0, created_at: new Date(userAt).toISOString(),
    content: 'sender=C8C622B2-7934-4507-A879-9DBD9B06925B content=Subagent task',
  });
  assert.equal(uppercaseSender.subagent, false);
  assert.deepEqual(uppercaseSender.statusEvidence, { kind: 'status_event', at: userAt });

  const generic = session('antigravity');
  applyAntigravity(generic, {
    type: 'PLANNER_RESPONSE', timestamp: new Date(assistantAt).toISOString(),
    tool_calls: [{ name: 'run_command' }],
  });
  applyAntigravity(generic, { type: 'GENERIC', timestamp: new Date(assistantAt + 1_000).toISOString() });
  assert.equal(generic.status, 'thinking');
  assert.deepEqual(generic.statusEvidence, { kind: 'status_event', at: assistantAt + 1_000 });
});

test('silence marks nonterminal status stale without changing the observed status', () => {
  for (const status of ['thinking', 'tool', 'typing', 'waiting', 'unknown']) {
    const s = session();
    s.status = status;
    s.lastEventAt = BASE_TIME - 600_000;

    const out = viewed(s);

    assert.equal(out.status, status);
    assert.equal(out.quietMs, 600_000);
    assert.equal(out.stale, true);
    if (status === 'waiting') assert.equal(out.needsInput, true);
  }

  const recent = session();
  recent.status = 'tool';
  recent.lastEventAt = BASE_TIME - 599_999;
  assert.equal(viewed(recent).stale, false);
});

test('silence never overwrites terminal statuses', () => {
  for (const status of ['done', 'interrupted', 'error']) {
    const s = session();
    s.status = status;
    s.lastEventAt = BASE_TIME - 10_000_000;

    const out = viewed(s);

    assert.equal(out.status, status);
    assert.equal(out.stale, false);
  }
});

test('Codex desktop sessions are not classified as subagents without explicit metadata', () => {
  const desktop = session();
  codex(desktop, 'session_meta', { source: 'vscode', thread_source: 'agent_created_thread' });
  assert.equal(desktop.subagent, false);

  const child = session();
  codex(child, 'session_meta', { thread_source: 'desktop', parent_thread_id: 'parent-1' });
  assert.equal(child.subagent, true);
  assert.equal(child.parentId, 'parent-1');
});

test('Codex subagent metadata object preserves its nested parent thread id', () => {
  const child = session();
  codex(child, 'session_meta', {
    source: { subagent: { thread_spawn: { parent_thread_id: 'parent-nested' } } },
  });

  assert.equal(child.subagent, true);
  assert.equal(child.parentId, 'parent-nested');
});

test('Codex pending questions survive unrelated tools and resolve only by matching answers', () => {
  const s = session();
  codex(s, 'response_item', {
    type: 'function_call',
    name: 'mcp__codex__request_user_input',
    call_id: 'call_a',
    arguments: JSON.stringify({ question: 'Should I deploy?' }),
  });
  codex(s, 'response_item', {
    type: 'function_call',
    name: 'request_user_input_async',
    call_id: 'call_b',
    arguments: JSON.stringify({ question: 'Which region?' }),
  });

  assert.deepEqual(requests(s).map((item) => item.id), ['call_a', 'call_b']);
  assert.equal(viewed(s).needsInput, true);

  codex(s, 'response_item', { type: 'function_call_output', call_id: 'call_other', output: 'done' });
  codex(s, 'response_item', { type: 'function_call_output', call_id: 'call_b', output: 'accepted' });
  codex(s, 'response_item', { type: 'function_call_output', call_id: 'call_a', output: '' });
  assert.deepEqual(requests(s).map((item) => item.id), ['call_a', 'call_b']);
  assert.equal(s.status, 'thinking');
  assert.equal(viewed(s).needsInput, true);

  const questionItemId = JSON.stringify(['request_user_input_async', 'call_b', 0]);
  codex(s, 'response_item', {
    type: 'message',
    role: 'user',
    content: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId, answer: 'west' }])}</send_user_message_question_reply>`,
  });
  assert.deepEqual(requests(s).map((item) => item.id), ['call_a']);

  codex(s, 'response_item', { type: 'function_call_output', call_id: 'call_a', output: '{"answer":"yes"}' });
  assert.deepEqual(s.pendingRequests, []);
});

test('Codex exec wrappers are recognized without evaluating their code', () => {
  const s = session();
  const marker = '__codex_status_test_marker__';
  codex(s, 'response_item', {
    type: 'custom_tool_call',
    name: 'exec',
    call_id: 'call_exec',
    input: `globalThis.${marker} = true; const result = await tools.mcp__codex__request_user_input_async({ question: "Proceed?" });`,
  });

  const pending = requests(s);
  assert.equal(globalThis[marker], undefined);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'call_exec');
  assert.equal(pending[0].kind, 'question');
  assert.match(pending[0].summary, /Proceed\?/);
});

test('Codex recognizes dot-namespaced request tool names', () => {
  const s = session();
  codex(s, 'response_item', {
    type: 'function_call',
    name: 'functions.request_user_input_async',
    call_id: 'call-dot-namespace',
    arguments: JSON.stringify({ question: 'Proceed?' }),
  });

  assert.equal(requests(s).length, 1);
  assert.equal(requests(s)[0].id, 'call-dot-namespace');
});

test('Codex exec wrappers find request tools after unrelated tool calls', () => {
  const s = session();
  codex(s, 'response_item', {
    type: 'custom_tool_call',
    name: 'functions.exec',
    call_id: 'call-exec-dot-namespace',
    input: 'await tools.search({ query: "first" }); const result = await tools.functions.request_user_input_async({ question: "After search?" });',
  });

  assert.equal(requests(s).length, 1);
  assert.equal(requests(s)[0].id, 'call-exec-dot-namespace');
});

test('Codex async request summaries use a question title when available', () => {
  const s = session();
  codex(s, 'response_item', {
    type: 'function_call',
    name: 'request_user_input_async',
    call_id: 'call-title-question',
    arguments: JSON.stringify({ questions: [{ title: 'Remove the old backup?' }] }),
  });

  assert.equal(requests(s)[0].summary, 'Remove the old backup?');
});

test('Codex async request events remain pending after accepted tool output', () => {
  const s = session();
  const questionItemId = JSON.stringify(['request_user_input_async', 'call-event-async', 0]);
  codex(s, 'event_msg', {
    type: 'request_user_input_async',
    questionItemId,
    question: 'Continue with the change?',
  });

  codex(s, 'response_item', {
    type: 'function_call_output',
    call_id: 'call-event-async',
    output: 'accepted',
  });

  assert.equal(requests(s).length, 1);
  assert.equal(requests(s)[0].id, 'call-event-async');
  assert.equal(requests(s)[0].kind, 'question');

  codex(s, 'event_msg', { type: 'task_complete' });
  assert.equal(s.status, 'done');
  assert.equal(requests(s).length, 1);
  assert.equal(viewed(s).needsInput, true);

  codex(s, 'event_msg', { type: 'task_started' });
  assert.equal(s.status, 'thinking');
  assert.equal(requests(s).length, 1);

  codex(s, 'response_item', {
    type: 'message',
    role: 'user',
    content: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId, answer: 'continue' }])}</send_user_message_question_reply>`,
  });
  assert.deepEqual(requests(s), []);
  assert.equal(viewed(s).needsInput, false);
});

test('Codex approvals and questions remain pending through ordinary messages and clear at turn end', () => {
  const s = session();
  codex(s, 'event_msg', { type: 'exec_approval_request', id: 'approval-1', command: 'deploy' });
  assert.equal(requests(s)[0].id, 'approval-1');
  assert.equal(requests(s)[0].kind, 'approval');

  codex(s, 'response_item', { type: 'message', role: 'user', content: 'Thanks' });
  codex(s, 'response_item', { type: 'function_call', name: 'search', call_id: 'call-search', arguments: '{}' });
  assert.equal(requests(s).length, 1);

  codex(s, 'event_msg', { type: 'task_complete' });
  assert.deepEqual(s.pendingRequests, []);
});

test('Codex approval results resolve only by their matching call identifier', () => {
  const s = session();
  codex(s, 'event_msg', { type: 'exec_approval_request', id: 'approval-match', command: 'deploy' });

  codex(s, 'response_item', { type: 'function_call_output', call_id: 'approval-other', output: 'approved' });
  assert.equal(requests(s).length, 1);

  codex(s, 'response_item', { type: 'function_call_output', call_id: 'approval-match', output: 'approved' });
  assert.deepEqual(requests(s), []);
});

test('Codex explicit turn abort invalidates pending async questions', () => {
  const s = session();
  codex(s, 'response_item', {
    type: 'function_call',
    name: 'request_user_input_async',
    call_id: 'call-aborted',
    arguments: JSON.stringify({ question: 'Continue?' }),
  });

  codex(s, 'event_msg', { type: 'turn_aborted' });

  assert.deepEqual(requests(s), []);
  assert.equal(s.status, 'interrupted');
});

test('Claude question tool results clear only the matching tool_use id', () => {
  const s = session('claude');
  claude(s, 'assistant', { message: { content: [
    { type: 'tool_use', id: 'tool-a', name: 'AskUserQuestion', input: { question: 'Continue?' } },
    { type: 'tool_use', id: 'tool-b', name: 'ExitPlanMode', input: {} },
  ] } });

  assert.deepEqual(requests(s).map((item) => item.id), ['tool-a', 'tool-b']);
  claude(s, 'user', { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'yes' }] } });
  assert.deepEqual(requests(s).map((item) => item.id), ['tool-b']);
});

test('Claude completed turns invalidate unanswered question tools', () => {
  const s = session('claude');
  claude(s, 'assistant', { message: { content: [
    { type: 'tool_use', id: 'tool-end', name: 'AskUserQuestion', input: { question: 'Continue?' } },
  ] } });

  claude(s, 'assistant', { message: { content: [{ type: 'text', text: 'Finished' }], stop_reason: 'end_turn' } });

  assert.deepEqual(requests(s), []);
  assert.equal(s.status, 'done');
});

test('Gemini tool status changes clear only the matching approval id', () => {
  const s = session('gemini');
  gemini(s, { type: 'gemini', toolCalls: [
    { id: 'gem-a', name: 'shell', status: 'awaiting_approval' },
    { id: 'gem-b', name: 'write', status: 'awaiting_approval' },
  ] });

  gemini(s, { type: 'gemini', toolCalls: [{ id: 'gem-b', name: 'write', status: 'success' }] });
  assert.deepEqual(requests(s).map((item) => item.id), ['gem-a']);

  gemini(s, { type: 'gemini', toolCalls: [{ id: 'gem-a', name: 'shell', status: 'success' }] });
  assert.deepEqual(s.pendingRequests, []);
});

test('Gemini cancellation invalidates unanswered approval requests', () => {
  const s = session('gemini');
  gemini(s, { type: 'gemini', toolCalls: [{ id: 'gem-cancel', name: 'shell', status: 'awaiting_approval' }] });

  gemini(s, { type: 'info', content: 'operation cancelled' });

  assert.deepEqual(requests(s), []);
  assert.equal(s.status, 'interrupted');
});

test('private snapshots hide pending question text while preserving its identifier and kind', () => {
  const s = session();
  codex(s, 'response_item', {
    type: 'function_call',
    name: 'request_user_input',
    call_id: 'call-private',
    arguments: JSON.stringify({ question: 'Secret customer name?' }),
  });

  const out = viewed(s, BASE_TIME, { ...OPTIONS, privacy: true });

  assert.equal(JSON.stringify(out).includes('Secret customer name?'), false);
  assert.ok(Array.isArray(out.pendingRequests), 'snapshot exposes pendingRequests');
  assert.equal(out.pendingRequests[0].id, 'call-private');
  assert.equal(out.pendingRequests[0].kind, 'question');
  assert.equal(out.needsInput, true);
});
