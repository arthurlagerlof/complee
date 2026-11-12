// Project file: the engineer's work on a project (findings register with manual-check confirmations, and class
// comments) as one JSON file, so it can be backed up, handed to a colleague or opened in another browser. The
// design model itself is not in it: the project file goes with whatever revision is opened.
export const PROJECT_FORMAT = 'complee-project/1';

export function projectFile({ project, model, revision, register = {}, comments = [], revisions = [] }, now = new Date()) {
  return { format: PROJECT_FORMAT, project, model, revision, saved: now.toISOString(), revisions, register, comments };
}

/** Parses and checks a project file. Throws with a message for the engineer when it is not one. */
export function readProjectFile(text, currentProject) {
  let data;
  try { data = JSON.parse(String(text).replace(/^﻿/, '')); } catch { throw new Error('The file is not a Complee project file (not JSON).'); }
  if (data?.format !== PROJECT_FORMAT) throw new Error(`The file is not a Complee project file (format "${data?.format ?? 'missing'}", expected "${PROJECT_FORMAT}").`);
  const register = data.register && typeof data.register === 'object' && !Array.isArray(data.register) ? data.register : {};
  const comments = Array.isArray(data.comments) ? data.comments.filter((c) => c && typeof c.id === 'string' && typeof c.text === 'string') : [];
  return {
    register, comments,
    project: data.project ?? null, model: data.model ?? null, revision: data.revision ?? null, saved: data.saved ?? null,
    revisions: Array.isArray(data.revisions) ? data.revisions : [],
    // Another project's file can still be opened (renamed ship, new model name), but the engineer is told.
    other_project: !!data.project && data.project !== currentProject,
  };
}
