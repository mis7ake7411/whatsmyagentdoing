'use strict';

(function (root) {
  function decideNotification(s, before, first, prefs, now, needsInput, labels) {
    const pendingIds = (s.pendingRequests || []).map((request) => request.id);
    const isNeedsInput = needsInput(s);
    const newlyNeeds = isNeedsInput && (!before?.needsInput || pendingIds.some((id) => !before.pendingIds.includes(id)));
    const newlyDone = s.status === 'done' && before && before.status !== 'done';
    const newlyError = s.status === 'error' && before && before.status !== 'error';
    const flash = !first && !!before && (newlyDone || newlyNeeds || newlyError);
    const paused = Number.isFinite(prefs.notifyPausedUntil) && prefs.notifyPausedUntil > now;
    const category = !flash || paused ? null
      : newlyError && prefs.notifyErrors ? 'error'
        : newlyNeeds && prefs.notifyNeeds ? 'needs'
          : newlyDone && prefs.notifyDone ? 'done' : null;
    const canDeliver = !prefs.pip && !s.subagent && !!category;
    let message = null;
    if (canDeliver && prefs.notify) {
      const project = s.project || s.agent;
      const pendingSummary = (s.pendingRequests || []).map((request) => request.summary).filter(Boolean).join('\n');
      const title = category === 'error' ? labels.errorNote(project) : category === 'needs' ? `${project}: ${labels.waiting}` : labels.doneNote(project);
      const body = category === 'error'
        ? [s.error || s.activity || '', newlyNeeds ? pendingSummary : ''].filter(Boolean).join('\n')
        : category === 'needs' ? pendingSummary : s.reply || '';
      message = { title, body, tag: s.key };
    }
    const chime = canDeliver && prefs.sound ? category === 'done' ? 'done' : 'attention' : null;
    return {
      flash,
      category,
      message,
      chime,
      nextPrevious: { status: s.status, needsInput: isNeedsInput, pendingIds },
    };
  }

  const api = { decideNotification };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WMADNotificationRules = api;
})(typeof globalThis === 'object' ? globalThis : this);
