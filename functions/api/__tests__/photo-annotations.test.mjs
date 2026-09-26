import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { onRequest as admin } from '../admin/photo-annotations.js';
import { onRequest as publicRead } from '../photo-annotations.js';

function setup() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE catalog_photos(xid TEXT PRIMARY KEY,base_group_id TEXT,source_lon REAL,source_lat REAL,feature_json TEXT);
    CREATE TABLE group_membership_overrides(xid TEXT,group_id TEXT);
    INSERT INTO catalog_photos VALUES('X1','G1',14.4,50.1,'{"id":"X1","description":"Archivní originál"}');`);
  sqlite.exec(readFileSync(new URL('../../../migrations/0017_photo_annotations.sql',import.meta.url),'utf8'));
  const db={prepare(sql){return {bind(...args){this.args=args;return this;},first(){return sqlite.prepare(sql).get(...this.args||[])||null;},all(){return {results:sqlite.prepare(sql).all(...this.args||[])};},run(){return {meta:sqlite.prepare(sql).run(...this.args||[])};}};}};
  return {env:{CORRECTIONS_DB:db,ADMIN_API_TOKEN:'test-admin'},sqlite};
}
function request(body,auth=true,origin='https://example.com') {
  return new Request('https://example.com/api/admin/photo-annotations?xid=X1',{method:body?'POST':'GET',headers:{...(auth?{Authorization:'Bearer test-admin'}:{}),Origin:origin,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
}
const base={xid:'X1',expected_revision:0,action:'draft',public_text:'Ověřené vysvětlení',evidence_note:'Soukromý doklad reader@example.com',place_mode:'keep',place_ids:[],disputed_place_ids:[]};
async function read(env){return (await publicRead({request:new Request('https://example.com/api/photo-annotations'),env})).json();}

test('draft, publication, new draft and withdrawal are private, revisioned and audited',async()=>{
  const {env,sqlite}=setup();
  assert.equal((await admin({request:request(null,false),env})).status,401);
  assert.equal((await admin({request:request(base),env})).status,200);
  assert.deepEqual(await read(env),{metadata_revision:0,items:[]});
  assert.equal((await admin({request:request({...base,action:'publish',expected_revision:1}),env})).status,200);
  let snapshot=await read(env);
  assert.equal(snapshot.metadata_revision,1);
  const unchanged = await publicRead({request:new Request('https://example.com/api/photo-annotations?revision=1'),env});
  assert.deepEqual(await unchanged.json(),{metadata_revision:1,unchanged:true});
  assert.equal(snapshot.items[0].public_text,base.public_text);
  assert.equal(JSON.stringify(snapshot).includes('reader@example.com'),false);
  assert.equal(JSON.stringify(snapshot).includes('actor'),false);
  assert.equal((await admin({request:request({...base,expected_revision:2,public_text:'Nový rozpracovaný text'}),env})).status,200);
  assert.deepEqual(await read(env),snapshot);
  assert.equal((await admin({request:request({...base,expected_revision:2}),env})).status,409);
  assert.equal((await admin({request:request({xid:'X1',expected_revision:3,action:'withdraw'}),env})).status,200);
  assert.deepEqual(await read(env),{metadata_revision:2,items:[]});
  const result=await admin({request:request(),env});
  const payload=await result.json();
  assert.equal(payload.history.length,4);
  assert.equal(payload.history[0].state,'withdrawn');
  assert.equal(payload.photo.description,'Archivní originál');
  assert.deepEqual({...sqlite.prepare('SELECT source_lon,source_lat FROM catalog_photos').get()},{source_lon:14.4,source_lat:50.1});
  sqlite.exec("UPDATE group_membership_overrides SET group_id='G2'; INSERT INTO group_membership_overrides VALUES('X1','G2');");
  assert.equal((await admin({request:request(),env})).status,200);
  sqlite.close();
});

test('validation rejects unsafe or ambiguous writes and stale create races',async()=>{
  const {env,sqlite}=setup();
  for(const change of [{public_text:''},{public_text:'x'.repeat(2001)},{place_mode:'replace'},{place_mode:''},{place_ids:['P1']},{expected_revision:-1},{action:'erase'}]) {
    assert.equal((await admin({request:request({...base,...change}),env})).status,400);
  }
  assert.equal((await admin({request:request({...base,action:'publish',evidence_note:''}),env})).status,400);
  assert.equal((await admin({request:request(base,true,'https://evil.example'),env})).status,403);
  assert.equal((await admin({request:request({...base,xid:'MISSING'}),env})).status,400);
  assert.equal((await admin({request:request(base),env})).status,200);
  assert.equal((await admin({request:request(base),env})).status,409);
  // SQL CAS is authoritative even if another writer acts after the API read.
  const statement=sqlite.prepare("UPDATE photo_annotations SET revision=2,updated_at='later' WHERE xid='X1' AND revision=1");
  assert.equal(statement.run().changes,1);
  assert.equal(statement.run().changes,0);
  sqlite.close();
});

test('indexed catalog place validation and replacement carry public provenance',async()=>{
  const {env,sqlite}=setup();
  sqlite.prepare('UPDATE catalog_photos SET feature_json=? WHERE xid=?').run(JSON.stringify({id:'X1',places:[{id:'street:one',label:'Testovací ulice',kind:'street',source:'archive',aliases:[],source_terms:['Testovací ulice']}]}),'X1');
  assert.equal((await admin({request:request({...base,action:'publish',place_mode:'replace',place_ids:['missing']}),env})).status,400);
  assert.equal((await admin({request:request({...base,action:'publish',place_mode:'replace',place_ids:['street:one']}),env})).status,200);
  const snapshot=await read(env);
  assert.equal(snapshot.items[0].places[0].label,'Testovací ulice');
  assert.equal(snapshot.items[0].places[0].source,'curator');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM catalog_place_members WHERE place_id=?').get('street:one').count,1);
  sqlite.close();
});

test('a writer between read and SQL CAS cannot overwrite the newer revision',async()=>{
  const {env,sqlite}=setup();
  await admin({request:request(base),env});
  const prepare=env.CORRECTIONS_DB.prepare.bind(env.CORRECTIONS_DB);
  env.CORRECTIONS_DB.prepare=sql=>{
    const statement=prepare(sql);
    if(sql.startsWith('INSERT INTO photo_annotations')) {
      const run=statement.run.bind(statement);
      statement.run=()=>{sqlite.exec("UPDATE photo_annotations SET revision=2,updated_at='concurrent' WHERE xid='X1'");return run();};
    }
    return statement;
  };
  assert.equal((await admin({request:request({...base,expected_revision:1,action:'publish'}),env})).status,409);
  assert.deepEqual(await read(env),{metadata_revision:0,items:[]});
  assert.equal(sqlite.prepare('SELECT revision FROM photo_annotations').get().revision,2);
  sqlite.close();
});
