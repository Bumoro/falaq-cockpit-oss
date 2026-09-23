'use strict';

function normalizeProviderSession(s) {
  return {
    sessionId: s.id,
    provider: s.provider,
    // Ollama models sit loaded ('idle') unless a mediated chat is generating on them right now.
    state: s.provider === 'ollama' ? (s.generating ? 'running' : 'idle') : 'running',
    live: true,
    cwd: s.cwd || '',
    client: s.client || '',
    lastActivityAt: s.lastActivity,
    ...(s.context ? { context: s.context, model: s.context.model } : {}),
  };
}

module.exports = { normalizeProviderSession };
