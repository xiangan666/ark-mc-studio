/** Isolated executable fixture: prove real stdio survives a real management-process replacement. */
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

async function main() {
  const root = path.resolve(__dirname, "..");
  await fs.mkdir(path.join(root, "test-results"), { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ark-session-host-"));
  const runner = path.join(temp, "check.ts");
  // Import production classes from the source tree; all processes and data stay in this temp directory.
  const source = `
import fs from "node:fs/promises"; import path from "node:path"; import assert from "node:assert/strict";
import {AgentClient} from ${JSON.stringify(path.join(root, "src/main/agent-client.ts"))};
import {ProgramLifecycle} from ${JSON.stringify(path.join(root, "src/main/program-lifecycle.ts"))};
import {DirectRoutes} from ${JSON.stringify(path.join(root, "src/main/direct-routes.ts"))};
import {NetworkControl} from ${JSON.stringify(path.join(root, "src/main/network-control.ts"))};
const root=${JSON.stringify(root)}, temp=${JSON.stringify(temp)};
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const data=path.join(temp,"data"), core=path.join(temp,"隔离控制台样本"), tools=path.join(temp,"tools");
let client:AgentClient, host:any, gamePid:number|undefined;
async function bootstrap(){return await client.call<any>("bootstrap");}
async function job(value:any){for(let n=0;n<140;n++){const state=await bootstrap();const j=state.jobs.find((x:any)=>x.id===value.id);if(j?.status==='success')return;if(j&&['failed','interrupted','cancelled'].includes(j.status))throw new Error(j.detail);await wait(500);}throw new Error('隔离任务超时');}
async function ready(id:string){for(let n=0;n<80;n++){const s=await bootstrap();const snap=s.snapshots.find((v:any)=>v.id===id);if(s.samplerReady&&snap?.pid&&snap.capabilities.sessionHost)return snap;await wait(250);}throw new Error('独立宿主未被识别');}
async function gone(pid:number){for(let n=0;n<80;n++){try{process.kill(pid,0);}catch(e:any){if(e.code==='ESRCH')return;throw e;}await wait(100);}throw new Error('隔离进程未退出:'+pid);}
async function main(){try{
await fs.mkdir(core,{recursive:true});await fs.mkdir(tools,{recursive:true});
await fs.copyFile(path.join(root,'resources/runtime/node.exe'),path.join(core,'bedrock_server.exe'));
await fs.writeFile(path.join(core,'server.properties'),'server-name=隔离会话宿主测试\\nlevel-name=fixture\\nserver-port=29942\\nonline-mode=false\\n');
const fixture=path.join(temp,'fixture.cjs');await fs.writeFile(fixture,\
"if(require('node:path').basename(process.execPath).toLowerCase()==='bedrock_server.exe'){console.log('Server started.');console.log('fixture-endpoint:'+(process.env.SERVER_IP||'unset')+':'+(process.env.SERVER_PORT||'unset'));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{console.log('fixture-command:'+line);if(line==='stop')setTimeout(()=>{console.log('fixture-save-complete');process.exit(0);},30);});process.stdin.resume();}");
process.env.SERVER_IP='must-not-inherit.invalid';process.env.SERVER_PORT='29999';
process.env.NODE_OPTIONS='--require='+JSON.stringify(fixture);process.env.ARK_MC_NO_DISCOVER='1';
client=new AgentClient(data,path.join(root,'dist-agent/agent.cjs'),path.join(root,'resources/runtime/node.exe'),path.join(root,'resources'),tools);
const instance=await client.call<any>('instances.import',{root:core});
await readySampler();await job(await client.call('server.action',{id:instance.id,action:'start'}));
const before=await ready(instance.id);gamePid=before.pid;
host=JSON.parse(await fs.readFile(path.join(data,'server-hosts',instance.id,'host.json'),'utf8'));
await client.call('console.send',{id:instance.id,command:'say before-update'});await wait(500);
const old=JSON.parse(await fs.readFile(path.join(data,'.agent-state.json'),'utf8'));
await client.reloadPreservingSessions();
const after=await ready(instance.id);const next=JSON.parse(await fs.readFile(path.join(data,'.agent-state.json'),'utf8'));
assert.notEqual(next.pid,old.pid);assert.equal(after.pid,before.pid);assert.equal(after.capabilities.command,true);process.kill(host.hostPid,0);
await client.call('console.send',{id:instance.id,command:'say after-update'});
let logs:any[]=[];for(let n=0;n<30;n++){logs=await client.call<any[]>('console.logs',{id:instance.id});if(logs.some(l=>l.text.includes('fixture-command:say after-update')))break;await wait(250);}
assert(logs.some(l=>l.text.includes('fixture-command:say before-update')));assert(logs.some(l=>l.text.includes('fixture-command:say after-update')));
assert(logs.some(l=>l.text.includes('fixture-endpoint:unset:unset')),'游戏不能继承管理进程残留的线路端点');
const network=new NetworkControl(client,data,tools,path.join(root,'resources/runtime/node.exe'),path.join(root,'dist-network/worker.cjs'),path.join(root,'resources'),()=>{});
const direct=new DirectRoutes(client,tools,path.join(root,'resources/runtime/node.exe'),path.join(root,'dist-direct/host.cjs'),path.join(root,'resources/probes/route-check.exe'));
const lifecycle=new ProgramLifecycle(client,direct,network,data,${JSON.stringify(require("../package.json").version)},async()=>{});
await lifecycle.quit();await gone(before.pid);await gone(host.hostPid);await gone(next.pid);
assert((await fs.readFile(path.join(core,'logs','arkmc-server.log'),'utf8')).includes('fixture-save-complete'),'退出前必须完整保留保存日志');
await fs.writeFile(path.join(root,'test-results/session-host.json'),JSON.stringify({passed:true,checkedAt:new Date().toISOString(),fixture:'isolated stdio executable, not Minecraft login',backendPidChanged:true,gamePidUnchanged:true,sessionHostPidUnchanged:true,commandsBeforeAndAfter:true,startupEndpointIsolated:true,finalSaveLog:true,normalStop:true,completeExit:true},null,2));
console.log('独立会话宿主验收通过：真实更换管理进程，游戏样本及宿主 PID 不变，切换前后控制命令成功，完整退出正常关闭全部进程。');
}finally{client?.disconnect();for(const pid of [gamePid,host?.hostPid,await fs.readFile(path.join(data,'.agent-state.json'),'utf8').then(s=>JSON.parse(s).pid).catch(()=>null)]){if(pid)try{process.kill(pid);}catch{}}}}
async function readySampler(){for(let n=0;n<80;n++){if((await bootstrap()).samplerReady)return;await wait(250);}throw new Error('采样未就绪');}
main().catch(e=>{console.error(e);process.exitCode=1;});
`;
  await fs.writeFile(runner, source);
  try {
    execFileSync(
      process.execPath,
      [path.join(root, "node_modules/tsx/dist/cli.mjs"), runner],
      { cwd: root, stdio: "inherit", windowsHide: true },
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
