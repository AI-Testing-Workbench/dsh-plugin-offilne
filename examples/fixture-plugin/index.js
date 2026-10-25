/**
 * dsh-offline-fixture — a disposable profile bundle used by dsh-plugin-offline's
 * end-to-end test.
 *
 * It imports `semver` (a dependency that is deliberately NOT installed under the
 * profile's root node_modules) and registers one tool. If the fixture's tool
 * appears after an offline import and answers with a parsed version, then the
 * imported bundle loaded from the artifact AND resolved its bundled dependency
 * from the artifact's nested `node_modules`.
 */
import semver from 'semver';

export const name = 'dsh-offline-fixture';

/** The tool registry is the only required service. */
export const inject = ['tools'];

/**
 * Register the self-test tool for the lifetime of the row.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.tools.register({
      name: 'offline_fixture_ping',
      description: 'Self-test tool registered by dsh-offline-fixture; proves an offline-imported Host plugin loaded with its bundled dependency.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        const parsed = semver.parse('1.2.3-beta.1');
        return {
          ok: true,
          fixture: 'dsh-offline-fixture@0.1.0',
          semverVersion: semver.valid('1.2.3'),
          parsedPrerelease: parsed === null ? null : parsed.prerelease,
        };
      },
    }),
    'dsh-offline-fixture: offline_fixture_ping tool',
  );
}
