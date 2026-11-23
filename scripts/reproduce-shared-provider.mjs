/**
 * Read-only reproduction of provider replacement in a shared Pi model runtime.
 * Run with `node scripts/reproduce-shared-provider.mjs` to use this checkout's
 * dependencies, or set PI_RUNTIME_INDEX to an installed pi-coding-agent index.
 * This reproduces current behavior; it is not a compatibility requirement.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.env.PI_RUNTIME_INDEX
	? pathToFileURL(process.env.PI_RUNTIME_INDEX).href
	: '@earendil-works/pi-coding-agent';
const { ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession } = await import(entry);
const cwd = mkdtempSync(join(tmpdir(), 'pi-shared-provider-'));
const settingsManager = SettingsManager.inMemory({});
let parent;
let child;
try {
	const runtime = await ModelRuntime.create({ authPath: join(cwd, 'auth.json'), modelsPath: join(cwd, 'models.json') });
	const provider = () => ({
		id: 'shared-runtime-probe', name: 'probe',
		shutDown: false,
		auth: { apiKey: { name: 'probe', resolve: async () => ({ auth: {}, source: 'probe' }) } },
		getModels: () => [], stream() { throw new Error('unused'); }, streamSimple() { throw new Error('unused'); },
	});
	const parentProvider = provider();
	const childProvider = provider();
	async function makeSession(registration) {
		const loader = new DefaultResourceLoader({
			cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => {
				pi.registerProvider(registration);
				pi.on('session_shutdown', () => { registration.shutDown = true; });
			}],
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd, agentDir: cwd, settingsManager, sessionManager: SessionManager.inMemory(cwd),
			modelRuntime: runtime, resourceLoader: loader,
		});
		await session.bindExtensions({});
		return session;
	}
	parent = await makeSession(parentProvider);
	assert.equal(runtime.getRegisteredNativeProvider('shared-runtime-probe'), parentProvider);
	child = await makeSession(childProvider);
	assert.equal(runtime.getRegisteredNativeProvider('shared-runtime-probe'), childProvider);
	// pi-subagents emits session_shutdown before disposing a child session.
	await child.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
	child.dispose();
	child = undefined;
	assert.equal(runtime.getRegisteredNativeProvider('shared-runtime-probe'), childProvider);
	assert.equal(childProvider.shutDown, true);
	assert.equal(parentProvider.shutDown, false);
	console.log('Child bind replaced the parent provider; after child shutdown, the shared runtime still references the shut-down child provider.');
} finally {
	child?.dispose();
	parent?.dispose();
	rmSync(cwd, { recursive: true, force: true });
}
