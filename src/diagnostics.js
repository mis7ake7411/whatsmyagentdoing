'use strict';

const STATUS_EVIDENCE_KINDS = new Set([
  'user_message', 'assistant_message', 'tool_call', 'tool_result', 'turn_started',
  'turn_completed', 'turn_interrupted', 'turn_error', 'approval_request',
  'question_request', 'permission_hook', 'status_event',
]);

const SOURCE_STATES = new Set(['ok', 'missing', 'empty', 'read_error', 'parse_error', 'unavailable']);
const SOURCE_REASONS = new Set([
  'not_found', 'no_recent_logs', 'reading_denied', 'read_failed', 'invalid_json',
  'parser_failed', 'decode_failed', 'not_instrumented',
]);

function eventTime(value, multiplier = 1) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value * multiplier : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((part) => part?.type === 'text').map((part) => part.text || '').join('');
  return '';
}

function statusKind(agent, d) {
  if (!d || typeof d !== 'object') return 'status_event';
  const payload = d.payload || {};
  switch (agent) {
    case 'claude': {
      if (d.type === 'system') {
        if (d.subtype === 'stop_hook_summary') return 'turn_completed';
        if (d.subtype === 'api_error') return 'turn_error';
      }
      if (d.type === 'user') {
        const content = d.message?.content;
        if (Array.isArray(content) && content.some((part) => part?.type === 'tool_result')) return 'tool_result';
        const text = textValue(content);
        if (text.startsWith('[Request interrupted')) return 'turn_interrupted';
        return 'user_message';
      }
      if (d.type === 'assistant') {
        if (d.isApiErrorMessage) return 'turn_error';
        const blocks = Array.isArray(d.message?.content) ? d.message.content : [];
        const calls = blocks.filter((part) => part?.type === 'tool_use');
        if (calls.length) {
          const name = String(calls[calls.length - 1].name || '').split('__').pop();
          if (name === 'AskUserQuestion') return 'question_request';
          if (name === 'ExitPlanMode') return 'approval_request';
          return 'tool_call';
        }
        if (['end_turn', 'stop_sequence'].includes(d.message?.stop_reason)) return 'turn_completed';
        if (d.message?.stop_reason === 'error') return 'turn_error';
        return 'assistant_message';
      }
      return 'status_event';
    }
    case 'codex':
      if (d.type !== 'event_msg') return 'status_event';
      switch (payload.type) {
        case 'task_started': return 'turn_started';
        case 'task_complete': return 'turn_completed';
        case 'turn_aborted': return 'turn_interrupted';
        case 'error': return 'turn_error';
        case 'user_message': return 'user_message';
        case 'agent_message': return 'assistant_message';
        case 'exec_approval_request':
        case 'apply_patch_approval_request': return 'approval_request';
        case 'request_user_input':
        case 'request_user_input_async': return 'question_request';
        case 'item_started':
        case 'item_completed': {
          const item = payload.item || {};
          if (item.type === 'UserMessage') return 'user_message';
          if (item.type === 'AgentMessage') return 'assistant_message';
          if (['CommandExecution', 'McpToolCall', 'FileChange', 'Extension'].includes(item.type)) {
            return payload.type === 'item_started' ? 'tool_call' : 'tool_result';
          }
          return 'status_event';
        }
        default: return 'status_event';
      }
    case 'gemini': {
      if (d.$set || (d.sessionId && !d.type) || d.$patch || d.$rewindTo || !d.type) return null;
      if (d.type === 'user') return 'user_message';
      if (d.type === 'error') return 'turn_error';
      if (d.type === 'info' || d.type === 'warning') {
        return /cancel|interrupt/i.test(textValue(d.content)) ? 'turn_interrupted' : 'status_event';
      }
      if (d.type === 'gemini') {
        const calls = Array.isArray(d.toolCalls) ? d.toolCalls : [];
        if (calls.some((call) => call?.status === 'awaiting_approval')) return 'approval_request';
        if (calls.some((call) => ['validating', 'scheduled', 'executing'].includes(call?.status))) return 'tool_call';
        if (textValue(d.content)) return 'assistant_message';
        if (calls.length) return 'tool_result';
      }
      return 'status_event';
    }
    case 'copilot':
      switch (d.type) {
        case 'user.message': return 'user_message';
        case 'assistant.message': return 'assistant_message';
        case 'tool.execution_start': return 'tool_call';
        case 'tool.execution_complete': return 'tool_result';
        case 'tool.execution_error': return 'turn_error';
        case 'session.end': return 'turn_completed';
        default: return 'status_event';
      }
    case 'kimi':
      switch (d.type) {
        case 'turn.prompt': return 'user_message';
        case 'agent.turn.started': return 'turn_started';
        case 'interaction.request': return d.kind === 'question' ? 'question_request' : 'approval_request';
        case 'context.append_loop_event':
          if (d.event?.type === 'tool.call') return 'tool_call';
          if (d.event?.type === 'tool.result') return 'tool_result';
          if (d.event?.type === 'content.part' && d.event?.part?.type === 'text') return 'assistant_message';
          return 'status_event';
        case 'turn.cancel':
        case 'prompt.aborted': return 'turn_interrupted';
        case 'turn.ended':
        case 'agent.turn.ended':
          return ['error', 'failed'].includes(d.reason || d.outcome) ? 'turn_error'
            : ['completed', 'done', 'end_turn'].includes(d.reason || d.outcome) ? 'turn_completed'
              : 'turn_interrupted';
        default: return 'status_event';
      }
    case 'dsh':
      switch (d.type) {
        case 'turn/start': return 'turn_started';
        case 'user/message': return 'user_message';
        case 'assistant/message': return 'assistant_message';
        case 'tool/call': return 'tool_call';
        case 'tool/result': return 'tool_result';
        case 'approval/asked': return 'approval_request';
        case 'turn/end':
          return d.data?.reason?.kind === 'completed' ? 'turn_completed'
            : ['error', 'failed'].includes(d.data?.reason?.kind) ? 'turn_error'
              : ['cancelled', 'canceled', 'aborted', 'interrupted'].includes(d.data?.reason?.kind) ? 'turn_interrupted'
                : 'status_event';
        default: return 'status_event';
      }
    case 'grok': {
      const update = d.params?.update || {};
      switch (update.sessionUpdate) {
        case 'user_message_chunk': return 'user_message';
        case 'agent_message_chunk': return 'assistant_message';
        case 'tool_call': return 'tool_call';
        case 'tool_call_update':
          return ['completed', 'complete', 'failed'].includes(String(update.status || d.params?._meta?.updateParams?.status || '').toLowerCase())
            ? 'tool_result' : 'tool_call';
        case 'turn_completed':
          return update.stop_reason === 'rate_limit' ? 'turn_error'
            : ['max_tokens', 'refusal'].includes(update.stop_reason) ? 'turn_interrupted'
              : ['end_turn', 'completed', 'stop'].includes(update.stop_reason) ? 'turn_completed'
                : 'status_event';
        default: return 'status_event';
      }
    }
    case 'omp': {
      if (d.type === 'custom') {
        if (d.customType === 'tool_execution_start') return 'tool_call';
        if (d.customType === 'session_exit') {
          return d.data?.kind === 'fatal' ? 'turn_error'
            : d.data?.kind && d.data.kind !== 'normal' ? 'turn_interrupted'
              : 'status_event';
        }
      }
      if (d.type === 'message') {
        const message = d.message || {};
        if (message.role === 'user') return 'user_message';
        if (message.role === 'toolResult') return 'tool_result';
        if (message.role === 'assistant') {
          if (message.stopReason === 'error') return 'turn_error';
          if (message.stopReason === 'aborted') return 'turn_interrupted';
          if (Array.isArray(message.content) && message.content.some((part) => part?.type === 'toolCall')) return 'tool_call';
          if (['stop', 'length'].includes(message.stopReason)) return 'turn_completed';
          return 'assistant_message';
        }
      }
      return 'status_event';
    }
    case 'antigravity': {
      if (d.type === 'USER_INPUT') return 'user_message';
      if (d.type === 'SYSTEM_MESSAGE') {
        const startsSubagent = d.step_index === 0
          && typeof d.content === 'string'
          && /sender=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(d.content);
        return startsSubagent ? 'turn_started' : 'status_event';
      }
      if (d.type === 'PLANNER_RESPONSE') {
        if (d.status === 'ERROR') return 'turn_error';
        const calls = Array.isArray(d.tool_calls) ? d.tool_calls : [];
        if (calls.some((call) => call?.name === 'ask_question')) return 'question_request';
        if (calls.length) return 'tool_call';
        return textValue(d.content) ? 'assistant_message' : 'status_event';
      }
      return 'status_event';
    }
    default: return 'status_event';
  }
}

function statusEventTime(agent, d) {
  if (!d || typeof d !== 'object') return null;
  if (agent === 'kimi' || agent === 'dsh') return eventTime(d.time);
  if (agent === 'grok') return eventTime(d.timestamp, typeof d.timestamp === 'number' ? 1000 : 1);
  if (agent === 'omp') {
    const customTime = d.customType === 'tool_execution_start' ? d.data?.startedAt
      : d.customType === 'session_exit' ? d.data?.recordedAt : null;
    return eventTime(d.timestamp || d.message?.timestamp || customTime);
  }
  if (agent === 'antigravity') return eventTime(d.created_at || d.timestamp);
  return eventTime(d.timestamp);
}

function withStatusEvidence(s, agent, d, apply) {
  const previous = s._statusEvidenceContext;
  const kind = statusKind(agent, d);
  s._statusEvidenceContext = STATUS_EVIDENCE_KINDS.has(kind)
    ? { kind, at: statusEventTime(agent, d) }
    : null;
  try {
    return apply();
  } finally {
    if (previous === undefined) delete s._statusEvidenceContext;
    else s._statusEvidenceContext = previous;
  }
}

function recordStatusEvidence(s) {
  const context = s._statusEvidenceContext;
  if (!context || !STATUS_EVIDENCE_KINDS.has(context.kind)) return;
  const kind = ['turn_completed', 'turn_interrupted', 'turn_error'].includes(context.kind)
    && ({ turn_completed: 'done', turn_interrupted: 'interrupted', turn_error: 'error' })[context.kind] !== s.status
    ? 'status_event' : context.kind;
  s.statusEvidence = { kind, at: Number.isFinite(context.at) ? context.at : null };
}

function safeStatusEvidence(value) {
  if (!value || !STATUS_EVIDENCE_KINDS.has(value.kind)) return null;
  return { kind: value.kind, at: Number.isFinite(value.at) ? value.at : null };
}

function safeSourceHealth(value) {
  if (!value || !SOURCE_STATES.has(value.state)) return null;
  const reason = value.reason == null ? null : SOURCE_REASONS.has(value.reason) ? value.reason : null;
  return {
    state: value.state,
    lastSuccessAt: Number.isFinite(value.lastSuccessAt) ? value.lastSuccessAt : null,
    reason,
  };
}

function errorReason(error, phase = 'read') {
  if (phase === 'json') return 'invalid_json';
  if (phase === 'parser') return 'parser_failed';
  if (phase === 'decode') return 'decode_failed';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'reading_denied';
  return 'read_failed';
}

module.exports = {
  STATUS_EVIDENCE_KINDS,
  SOURCE_STATES,
  SOURCE_REASONS,
  withStatusEvidence,
  recordStatusEvidence,
  safeStatusEvidence,
  safeSourceHealth,
  errorReason,
};
