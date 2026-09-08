// Synthetic host integration: no real Codex data, no network, no VS Code process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'extension.js'));
const store = require('./shared/codexStore.js');
const { buildHandoffDigest, HEADINGS } = require('./shared/handoff.js');

export function loadHost(vscode, overrides = {}) {
  const module = { exports: {} };
  const localRequire = (name) => name === 'vscode' ? vscode :
    Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : require(name);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension.js'), 'utf8') + `
    module.exports.test = { CodexDbReader, OfficeViewProvider, handoffCommand,
      setWorkspace: (dir) => { workspaceRoot = () => dir; computeGuidelinePlan = () => ({sync:'in-sync'}); },
      simpleSnapshot: () => { collectSnapshot = (live, codex) => ({events: codex ? codex.recent() : []}); }
    };`, { require: localRequire, module, __dirname: root, process, Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval, console, URL });
  return module.exports.test;
}

export async function runCodexStoreChecks(check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentyard-codex-'));
  const init = require('./webview/vendor/sql-wasm.js');
  const SQL = await init({ locateFile: (n) => path.join(root, 'webview/vendor', n) });
  const state = new SQL.Database();
  const history = new SQL.Database();
  const now = Math.floor(Date.now() / 1000) * 1000;
  let agents = ['claude-code', 'codex'];
  const vscode = { workspace: { getConfiguration: () => ({get: (k, d) => k === 'agents' ? agents : d}) },
    window: {showInformationMessage: async () => undefined, showWarningMessage: async () => undefined} };
  try {
    state.run('CREATE TABLE threads(id TEXT,cwd TEXT,model TEXT,title TEXT,first_user_message TEXT,updated_at_ms INTEGER,created_at_ms INTEGER,archived INTEGER)');
    state.run('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)', ['t1', "\\\\?\\C:\\Users\\x\\proj\\", 'fixture-model', 'fixture', 'fix fixture', now, now - 10000, 0]);
    state.run('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)', ['archived', '/archived', 'm', '', '', now, now, 1]);
    history.run('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_type TEXT,item_json TEXT,updated_at_ordinal INTEGER)');
    history.run('CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT,started_at INTEGER,completed_at INTEGER)');
    history.run('INSERT INTO thread_turns VALUES (?,?,?,?,?,?)', ['t1', 'turn1', 1, 'completed', now / 1000 - 10, now / 1000]);
    const payloads = [
      {type:'userMessage',content:[{type:'text',text:'Fix the fixture'}]},
      {type:'reasoning',summary:['private reasoning excluded']},
      {type:'commandExecution',command:'npm run build',aggregatedOutput:'private output excluded'},
      {type:'fileChange',changes:[{path:'src/fixture.js',kind:{type:'add'},diff:'private diff excluded'}]},
      {type:'agentMessage',text:'Fixture fixed.\nNext steps\n- run the app'},
    ];
    payloads.forEach((p, i) => history.run('INSERT INTO thread_items VALUES (?,?,?,?,?,?,?,?)',
      ['t1', 'turn1', 'item'+i, i+2, now - 500 + i*100, p.type, JSON.stringify(p), i+2]));
    history.run('INSERT INTO thread_items VALUES (?,?,?,?,?,?,?,?)', ['t1','turn1','bad',8,now+250,'agentMessage','{bad',8]);
    const save = () => {fs.writeFileSync(path.join(dir,'state_5.sqlite'),state.export());fs.writeFileSync(path.join(dir,'thread_history_1.sqlite'),history.export());};
    save();
    fs.writeFileSync(path.join(dir,'state_4.sqlite'),Buffer.from('not the selected DB'));
    const host = loadHost(vscode);
    const reader = new host.CodexDbReader(dir);
    const dbRows = await reader.snapshot((db) => reader.threadRows(db));
    const normalized = store.normalizeThreads(dbRows);
    check('SQLite: highest version selected, archived excluded, identity preserved', normalized.length === 1 && normalized[0].session_id === 't1' && normalized[0].model === 'fixture-model');
    check('SQLite: version tie uses newest mtime', store.pickDatabase([{name:'state_5.sqlite',mtime:1},{name:'state_5.sqlite',mtime:2}], 'state').mtime === 2);
    check('SQLite: Windows extended drive/UNC + case/trailing slash normalized; POSIX case preserved',
      store.normalizePath(normalized[0].cwd) === store.normalizePath('C:/Users/X/proj') &&
      store.normalizePath("\\\\?\\UNC\\Server\\Share\\") === store.normalizePath('//server/share') && store.normalizePath('/A') !== store.normalizePath('/a'));
    const entries = await reader.handoff('C:/Users/X/proj', 20);
    check('SQLite: event contract + user digest role, bad JSON skipped', entries.length === 5 && entries[0].role === 'user' &&
      entries.every((e) => ['ts','source','session_id','cwd','model','kind','doing','ended'].every((k) => k in e)) &&
      entries.every((e) => ['meta','activity','ended','blocked'].includes(e.kind)) && entries[2].doing === 'shell: npm run build');
    const opts = {source:'codex',entries,maxTurns:20};
    const digest = buildHandoffDigest(opts);
    check('SQLite: one deterministic digest with all headings, command, file, final assistant text',
      digest === buildHandoffDigest(opts) && Object.values(HEADINGS).every((h) => digest.includes(h)) &&
      digest.includes('npm run build') && digest.includes('src/fixture.js') && digest.includes('Fixture fixed.') &&
      !digest.includes('private'));
    check('SQLite: malformed/missing fields never throw', store.normalizeItems([null, {}, {thread_id:'t',item_json:'null'}, {thread_id:'t',item_json:'{}'}]).length === 0 &&
      store.normalizeThreads([null, {}, {id:'minimal'}]).length === 1);
    await reader.poll();
    check('SQLite: completed turn uses seconds precision; user rows absent from scene', reader.recent().some((e) => e.ended) && !reader.recent().some((e) => e.role === 'user') && !reader.hasLiveThreads());
    const count = reader.recent().length;
    await reader.poll();
    check('SQLite: repeated polls do not duplicate events', reader.recent().length === count);
    history.run("UPDATE thread_turns SET status='inProgress',completed_at=NULL");
    history.run('UPDATE thread_items SET item_json=?,updated_at_ordinal=50 WHERE item_id=?',
      [JSON.stringify({type:'agentMessage',text:'Updated in place'}),'item4']);
    save(); await reader.poll();
    check('SQLite: updates to existing item picked up without new rollout ordinal; live turn reopens', reader.hasLiveThreads() &&
      reader.recent().some((e) => e.text === 'Updated in place') && !reader.recent().some((e) => e.text && e.text.includes('Fixture fixed')) && !reader.recent().some((e) => e.ended));
    const retained = JSON.stringify(reader.recent());
    fs.writeFileSync(path.join(dir,'thread_history_1.sqlite'),Buffer.from('mid-write'));
    await reader.poll();
    check('SQLite: unreadable snapshot retains last successful scene', JSON.stringify(reader.recent()) === retained);
    save();
    host.simpleSnapshot();
    const provider = new host.OfficeViewProvider({});
    const posts=[];provider.view={webview:{postMessage:(m)=>posts.push(m)}};
    provider.codexDb=reader;
    let jsonlPolls=0;
    provider.codexLive={poll:()=>jsonlPolls++,recent:()=>[{source:'codex',session_id:'t1',kind:'activity',doing:'legacy duplicate'},
      {source:'codex',session_id:'jsonl-only',kind:'activity',doing:'legacy current'}]};
    await provider.pushData();
    check('SQLite: live DB takes precedence over JSONL and no duplicate session', jsonlPolls === 0 && posts.at(-1).events.every((e)=>e.session_id==='t1') && !JSON.stringify(posts.at(-1)).includes('legacy duplicate'));
    history.run("UPDATE thread_turns SET status='completed',completed_at=?",[now/1000]);save();
    await provider.pushData();
    check('SQLite: historical completed DB does not hide live JSONL; migrated id still deduped',
      jsonlPolls === 1 && posts.at(-1).events.length === 1 && posts.at(-1).events[0].session_id === 'jsonl-only');
    host.setWorkspace(dir);
    state.run('UPDATE threads SET cwd=? WHERE id=?',[dir,'t1']);save();
    await host.handoffCommand(provider,{to:'claude-code'});
    const written=fs.readFileSync(path.join(dir,'.agentyard','HANDOFF.md'),'utf8');
    check('SQLite: real handoff command writes digest and prefill event via DB path', written.includes('Updated in place') && written.includes('npm run build') &&
      posts.some((m)=>m.event==='prefillInput'));
    history.run('INSERT INTO thread_turns VALUES (?,?,?,?,?,?)',['t1','turn2',60,'inProgress',now/1000,null]);
    history.run('INSERT INTO thread_items VALUES (?,?,?,?,?,?,?,?)',['t1','turn2','u2',61,now+500,'userMessage',JSON.stringify({type:'userMessage',content:[{type:'text',text:'Only latest turn'}]}),61]);save();
    const last=await reader.handoff(dir,1);
    check('SQLite: handoff limits actual turns, not just rendered user lines', last.length===1 && last[0].text==='Only latest turn');
    check('SQLite: unmatched workspace falls back', await reader.handoff('/missing-workspace') === null);
    const missing=new host.CodexDbReader(path.join(dir,'missing'));
    await missing.poll();check('SQLite: missing stores are inert fallback', missing.recent().length===0 && await missing.handoff(dir)===null);
    // Optional columns absent in earlier state stores must not abort the poll.
    state.run('ALTER TABLE threads DROP COLUMN model');
    state.run('ALTER TABLE threads DROP COLUMN updated_at_ms');
    state.run('ALTER TABLE threads DROP COLUMN created_at_ms');
    history.run('ALTER TABLE thread_items DROP COLUMN updated_at_ordinal');save();
    const older = new host.CodexDbReader(dir);
    await older.poll();
    check('SQLite: older optional columns absent; last-turn fallback updates items', older.recent().some((e)=>e.session_id==='t1') &&
      older.recent().find((e)=>e.kind==='meta').model===null);
    history.run('UPDATE thread_items SET item_json=? WHERE item_id=?',
      [JSON.stringify({type:'userMessage',content:[{type:'text',text:'Older schema update'}]}),'u2']);save();
    await older.poll();
    const olderDigest = await older.handoff(dir,1);
    check('SQLite: older schema handoff remains usable',olderDigest[0].text==='Older schema update');
    // The provider must not construct the reader, load WASM, or touch ~/.codex.
    agents=['claude-code']; let codexReads=0;
    const fsSpy=new Proxy(fs,{get:(obj,k)=>typeof obj[k]==='function' ? (...args)=>{
      if (typeof args[0]==='string' && /[\\/]\.codex(?:[\\/]|$)/.test(args[0])) {codexReads++;throw new Error('unexpected Codex read');}
      return obj[k](...args);
    }:obj[k]});
    const claudeHost=loadHost(vscode,{'fs':fsSpy});claudeHost.simpleSnapshot();
    const claude=new claudeHost.OfficeViewProvider({});claude.view={webview:{postMessage:()=>{}}};
    await claude.pushData();
    check('SQLite: Claude-only provider never constructs DB reader or reads Codex home', claude.codexDb===null && codexReads===0);
    const args=require('./shared/claudeArgs.js').buildHeadlessCodexArgs({prompt:'--literal',resumeId:'thread-id',model:'fixture'}).args;
    check('SQLite/CLI: leading-dash prompt protected by separator on resume',args.at(-1)==='--literal' && args.at(-3)==='--' && args.at(-2)==='thread-id');
  } finally {
    state.close();history.close();
    // mkdtemp owns this verified temporary subtree only.
    if (path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith('agentyard-codex-')) fs.rmSync(dir,{recursive:true,force:true});
  }
}
