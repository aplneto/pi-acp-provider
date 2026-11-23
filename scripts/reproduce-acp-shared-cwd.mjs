/**
 * Reproduce ACP cwd ownership after a child replaces a shared provider.
 * Uses the repository's fake ACP agent; no network or credentials are needed.
 * Set PI_RUNTIME_INDEX to test an installed pi-coding-agent version.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { createAcpProvider } from '../src/provider.ts';

const entry = process.env.PI_RUNTIME_INDEX ? pathToFileURL(process.env.PI_RUNTIME_INDEX).href : '@earendil-works/pi-coding-agent';
const { ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession } = await import(entry);
const root = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-repro-'));
const parentDir = join(root, 'parent');
const childDir = join(root, 'child');
mkdirSync(parentDir); mkdirSync(childDir);
const settingsManager = SettingsManager.inMemory({});
const fakePath = fileURLToPath(new URL('../test/fake-agent.mjs', import.meta.url));
const handles = [];
let parent;
let child;
try {
 const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') });
 async function makeSession(cwd) {
  const loader = new DefaultResourceLoader({cwd,agentDir:root,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi=>{
   const handle=createAcpProvider({config:{agents:[{id:'fake',name:'fake',command:process.execPath,args:[fakePath],env:{},authMethod:undefined}],autoApproveTools:false,handshakeTimeoutMs:8000,debug:false}});
   handles.push(handle);
   pi.registerProvider(handle.provider);
   pi.on('session_start',(_event,ctx)=>handle.resetSession(ctx.cwd));
   pi.on('session_shutdown',()=>handle.dispose());
  }]});
  await loader.reload();
  const {session}=await createAgentSession({cwd,agentDir:root,settingsManager,sessionManager:SessionManager.inMemory(cwd),modelRuntime:runtime,resourceLoader:loader});
  await session.bindExtensions({});
  return session;
 }
 parent=await makeSession(parentDir);
 const parentProvider=runtime.getRegisteredNativeProvider('acp');
 child=await makeSession(childDir);
 const childProvider=runtime.getRegisteredNativeProvider('acp');
 assert.notEqual(parentProvider,childProvider);
 await child.extensionRunner.emit({type:'session_shutdown',reason:'quit'});
 child.dispose(); child=undefined;
 assert.equal(runtime.getRegisteredNativeProvider('acp'),childProvider);
 const model=childProvider.getModels()[0];
 const context=normalizeContext({messages:[{role:'user',content:'CWD',timestamp:Date.now()}]});
 const result=await childProvider.streamSimple(model,context,{sessionId:parent.sessionId}).result();
 assert.equal(result.stopReason,'stop');
 const observed=result.content.filter(block=>block.type==='text').map(block=>block.text).join('');
 assert.equal(realpathSync(observed),realpathSync(childDir));
 assert.notEqual(realpathSync(observed),realpathSync(parentDir));
 console.log('A later parent-owned request ran its fake ACP process in the shut-down child extension’s directory.');
} finally {
 child?.dispose(); parent?.dispose();
 for(const handle of handles) handle.dispose();
 rmSync(root,{recursive:true,force:true});
}
