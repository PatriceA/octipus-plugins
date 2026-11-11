// Permissions objects in the CLI's exact shape (`octi plugin permissions
// --json`, Octipus at the pinned OCTIPUS_REF), for the unit tests: an index and published.json
// carry them as they are (scripts/lib/permissions.mjs).
//
// The pinned CLI prints `secrets` and `settings` after `network`, and the
// per-user store right after `settings`. `withStore` sets the store.

/** What the pinned CLI prints for tests/fixtures/plugins/reader, at `version`. */
export const readerPermissions = (version = '1.0.0') => ({
  name: 'reader', version, apiVersion: '1.0.0', runtime: 'package',
  host: ['model:complete', 'notes:write', 'tasks:write', 'web:read'], network: [], secrets: [], settings: [], store: null,
  tools: [{ name: 'create_tasks', effect: 'write' }, { name: 'read_url', effect: 'read' }, { name: 'reader_action', effect: 'read' }, { name: 'save_note', effect: 'write' }],
  effects: { read: 2, write: 2, external: 0 },
  contributions: { commands: [], schedules: [], events: [], prompt: null, context: null },
  pages: [{ path: 'read', title: 'Reader', entry: 'index.html' }],
  ui: { dir: 'ui', sha256: 'be6a9400341b5851b0091846224ea4262fdbd496bc22645e2135b9c38488dbfd' },
  trustedInput: false, maxProtection: 1,
});

/** A small package's permissions: one read tool, `host`, `store` (`{ quotaBytes }` or null), nothing else. */
export const smallPermissions = ({ name = 'x', version = '1.0.0', host = [], tools = [{ name: 't', effect: 'read' }], store = null } = {}) => {
  const effects = { read: 0, write: 0, external: 0 };
  for (const t of tools) effects[t.effect] += 1;
  return {
    name, version, apiVersion: '1.0.0', runtime: 'package', host: [...host].sort(), network: [],
    secrets: [], settings: [], store,
    tools, effects,
    contributions: { commands: [], schedules: [], events: [], prompt: null, context: null },
    pages: [], ui: null, trustedInput: false, maxProtection: 1,
  };
};

/** `p` with `store` set (`{ quotaBytes }` or null), keeping the key order. */
export const withStore = (p, store) => ({ ...p, store });
