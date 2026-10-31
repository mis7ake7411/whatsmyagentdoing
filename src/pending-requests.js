'use strict';

function createPendingRequests(clean) {
  function pendingRequests(s) {
    if (!Array.isArray(s.pendingRequests)) s.pendingRequests = [];
    return s.pendingRequests;
  }

  function addPendingRequest(s, id, kind, summary, details = {}) {
    if (id == null || id === '') return null;
    const key = String(id);
    const list = pendingRequests(s);
    let item = list.find((request) => request.id === key);
    if (!item) {
      item = { id: key, kind, summary };
      list.push(item);
    } else {
      item.kind = kind;
      item.summary = summary;
    }
    if (Object.hasOwn(details, 'async')) item.async = details.async;
    return item;
  }

  function removePendingRequest(s, id) {
    if (id == null || !Array.isArray(s.pendingRequests)) return;
    const key = String(id);
    const previousLength = s.pendingRequests.length;
    s.pendingRequests = s.pendingRequests.filter((request) => request.id !== key);
    return s.pendingRequests.length !== previousLength;
  }

  function clearPendingRequests(s, { preserveAsync = false } = {}) {
    s.pendingRequests = preserveAsync ? pendingRequests(s).filter((request) => request.async) : [];
  }

  function codexRequestName(name, raw) {
    const normalize = (value) => String(value || '').split('.').pop().split('__').pop();
    let tool = normalize(name);
    if (tool === 'exec') {
      let code = typeof raw === 'string' ? raw : '';
      if (raw && typeof raw === 'object') {
        code = [raw.code, raw.command, raw.cmd, raw.input].find((value) => typeof value === 'string') || '';
      }
      const calls = /\btools\.([A-Za-z0-9_$]+(?:(?:\.|__)[A-Za-z0-9_$]+)*)\s*\(/g;
      let match;
      while ((match = calls.exec(code)) !== null) {
        const candidate = normalize(match[1]);
        if (candidate === 'request_user_input' || candidate === 'request_user_input_async') return candidate;
      }
    }
    return tool === 'request_user_input' || tool === 'request_user_input_async' ? tool : null;
  }

  function codexArguments(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw === 'string') {
      try {
        const value = JSON.parse(raw);
        if (value && typeof value === 'object') return value;
      } catch { /* exec wrappers are inspected as text below */ }
    }
    return {};
  }

  function codexRequestId(payload, fallback) {
    const questionId = payload.questionItemId == null ? null : questionReplyId(payload.questionItemId);
    const value = payload.call_id ?? payload.callId ?? payload.approval_id ?? payload.approvalId
      ?? payload.request_id ?? payload.requestId ?? payload.item_id ?? payload.itemId ?? questionId ?? payload.id ?? payload.item?.id;
    return value == null || value === '' ? fallback : String(value);
  }

  function codexRequestSummary(kind, raw, payload = {}) {
    const args = codexArguments(raw);
    const question = Array.isArray(args.questions) ? args.questions[0]?.question : null;
    const title = Array.isArray(args.questions) ? args.questions[0]?.title : null;
    const candidates = kind === 'question'
      ? [payload.question, payload.prompt, payload.questions?.[0]?.title, payload.questions?.[0]?.question,
        title, question, args.question, args.prompt, args.title]
      : [payload.command, payload.cmd, payload.reason, args.command, args.cmd, args.reason];
    const summary = candidates.find((value) => typeof value === 'string' && value.trim());
    if (summary) return clean(summary, 140);
    if (typeof raw === 'string') {
      const match = raw.match(/(?:question|prompt)\s*:\s*["']([^"']+)["']/i);
      if (kind === 'question' && match) return clean(match[1], 140);
    }
    return kind === 'approval' ? 'Approval requested' : 'Question requested';
  }

  function questionReplyId(value) {
    if (Array.isArray(value)) return value.length > 1 ? String(value[1]) : null;
    if (typeof value !== 'string') return null;
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.length > 1 ? String(parsed[1]) : null;
      if (parsed && typeof parsed === 'object') return parsed.call_id || parsed.id || null;
    } catch { /* keep an opaque identifier unmatched rather than guessing */ }
    return value;
  }

  function resolveCodexQuestionReplies(s, message) {
    const match = String(message || '').match(/<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/);
    if (!match) return;
    let replies;
    try { replies = JSON.parse(match[1]); } catch { return; }
    if (!Array.isArray(replies)) return;
    let resolved = false;
    for (const reply of replies) {
      if (!reply || typeof reply !== 'object' || reply.answer == null || String(reply.answer).trim() === '') continue;
      const id = questionReplyId(reply.questionItemId);
      if (id != null && removePendingRequest(s, id)) resolved = true;
    }
    return resolved;
  }

  function hasAnsweredOutput(output) {
    if (output == null) return false;
    if (typeof output === 'string') {
      const text = output.trim();
      if (!text || /^accepted$/i.test(text)) return false;
      try {
        return hasAnsweredOutput(JSON.parse(text));
      } catch { /* a nonempty textual answer is sufficient */ }
      return true;
    }
    if (Array.isArray(output)) return output.some(hasAnsweredOutput);
    if (typeof output === 'object') {
      if (output.status === 'accepted' || output.accepted === true) return false;
      if (Object.hasOwn(output, 'answer')) return hasAnsweredOutput(output.answer);
      return Object.keys(output).length > 0;
    }
    return Boolean(output);
  }

  return {
    pendingRequests,
    addPendingRequest,
    removePendingRequest,
    clearPendingRequests,
    codexRequestName,
    codexArguments,
    codexRequestId,
    codexRequestSummary,
    questionReplyId,
    resolveCodexQuestionReplies,
    hasAnsweredOutput,
  };
}

module.exports = { createPendingRequests };
