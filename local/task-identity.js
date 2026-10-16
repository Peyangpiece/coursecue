export function taskIdentity(url, course) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/content\/(\d+)\/(quiz|report|board)\//);
    return m ? `${course}:${m[1]}:${m[2]}` : null;
  } catch {
    return null;
  }
}
export function mergeTasks(tasks) {
  const out = [],
    seen = new Map(),
    archived = [];
  for (const t of tasks) {
    const id = taskIdentity(t.url, t.course);
    if (!id || !seen.has(id)) {
      out.push(t);
      if (id) seen.set(id, t);
      continue;
    }
    const prior = seen.get(id);
    archived.push(structuredClone(t));
    for (const field of ['answer', 'supplement', 'generation', 'generationKey', 'draftPath'])
      if (!prior[field] && t[field]) prior[field] = t[field];
    if (t.status === 'done') {
      prior.status = 'done';
      prior.submittedAt = prior.submittedAt || t.submittedAt;
      prior.action = '';
      prior.submissionIntent = null;
    }
    if (t.checkedAt > (prior.checkedAt || '')) {
      prior.url = t.url;
      prior.checkedAt = t.checkedAt;
    }
  }
  return {tasks: out, archived};
}
