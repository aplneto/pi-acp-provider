import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { AcpClient } from '../src/acp-client.ts';
import { ToolHandoff } from '../src/tool-handoff.ts';

const model = { id:'test', name:'test', api:'test', provider:'test', baseUrl:'', reasoning:false, input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:10000, maxTokens:1000 };
const fakePath = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

async function exercise(allowTool, input = 'payload') {
 const handoff = new ToolHandoff();
 const client = new AcpClient({agent:{name:'test',command:process.execPath,args:[fakePath],env:{},authMethod:undefined},cwd:process.cwd(),handshakeTimeoutMs:8000,onServerRequest:({method,params,signal})=>{
  assert.equal(method,'probe/tool');
  return handoff.request({id:'acp-request',name:'probe_tool',arguments:{input:params.input}}, signal);
 }});
 const sessionId = await client.ensureSession();
 let prompt, output = '', executions = 0;
 const streamFn = (_model,context,options) => {
  const events=createAssistantMessageEventStream();
  const msg={role:'assistant',content:[],api:'test',provider:'test',model:'test',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'pending',timestamp:Date.now()};
  void (async()=>{
   events.push({type:'start',partial:msg});
   const last=context.messages.at(-1);
   if (last?.role==='toolResult') {
    handoff.complete(last.toolCallId,{output:last.isError?'denied':last.content.map(c=>c.type==='text'?c.text:'').join('')});
    await prompt;
    msg.content.push({type:'text',text:output});
    events.push({type:'text_start',contentIndex:0,partial:msg});
    events.push({type:'text_delta',contentIndex:0,delta:output,partial:msg});
    events.push({type:'text_end',contentIndex:0,content:output,partial:msg});
    msg.stopReason='stop'; events.push({type:'done',reason:'stop',message:msg}); events.end(msg);
   } else {
    prompt=client.prompt({sessionId,payload:{sessionId,prompt:[{type:'text',text:`BRIDGE ${input}`}]},signal:options?.signal,onUpdate:u=>{if(u.type==='agent_message_chunk')output+=u.text}});
    const call=await handoff.next();
    assert.ok(call);
    const toolCall={type:'toolCall',id:call.id,name:call.name,arguments:call.arguments};
    msg.content.push(toolCall);
    events.push({type:'toolcall_start',contentIndex:0,partial:msg});
    events.push({type:'toolcall_end',contentIndex:0,toolCall,partial:msg});
    msg.stopReason='toolUse';events.push({type:'done',reason:'toolUse',message:msg});events.end(msg);
   }
  })().catch(error=>{msg.stopReason='error';msg.errorMessage=String(error);events.push({type:'error',reason:'error',error:msg});events.end(msg)});
  return events;
 };
 const tools=allowTool?[{name:'probe_tool',label:'Probe',description:'Return the input',parameters:Type.Object({input:Type.String()}),execute:async(_id,args)=>{executions++;return {content:[{type:'text',text:`result:${args.input}`}],details:{}}}}]:[];
 const agent = new Agent({initialState:{model,tools},sessionId:'test-session',streamFn});
 try {await agent.prompt('run');return {output,executions,messages:agent.state.messages};}
 finally {handoff.close();client.dispose()}
}

test('ACP request waits while Pi executes the tool and returns its result',async()=>{
 const result=await exercise(true);
 assert.equal(result.output,'result:payload');
 assert.equal(result.executions,1);
 assert.ok(result.messages.some(message=>message.role==='toolResult' && !message.isError));
});

test('Pi rejects an unavailable tool and the ACP request receives denial',async()=>{
 const result=await exercise(false);
 assert.equal(result.output,'denied');
 assert.equal(result.executions,0);
 assert.ok(result.messages.some(message=>message.role==='toolResult' && message.isError));
});

test('separate agent turns can hand off requests independently',async()=>{
 const [allowed,denied]=await Promise.all([exercise(true,'left'),exercise(false,'right')]);
 assert.equal(allowed.output,'result:left');
 assert.equal(denied.output,'denied');
 assert.equal(allowed.executions,1);
 assert.equal(denied.executions,0);
});
