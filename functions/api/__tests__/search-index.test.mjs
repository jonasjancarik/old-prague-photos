import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSearchIndex, updateSearchMembership, searchIndex} from '../../../viewer/static/search-index.js';
const place = {id:'street-a',label:'Letenská',kind:'street',district:'Malá Strana',aliases:['Letenské','Letenskou'],source_terms:['Letenská ulice'],source:'archive'};
const photo = (id, group, description, places = [place]) => ({properties:{id,group_id:group,description,places,authors:[{id:'author-a',label:'Novák, Jan',aliases:[],source_terms:[]}]}});
test('one published XID counts once and keeps matching non-primary photo', () => {
 const a=photo('a','g','Věž',[]), b=photo('b','g','Průhled ulicí');
 const index=buildSearchIndex([a,b,b]);
 const state=updateSearchMembership(index);
 assert.equal(index.photos.size,2);
 assert.equal(searchIndex(state,'letenskou').places[0].matchedXid,'b');
 assert.equal(searchIndex(state,'pruhled').photos[0].matchedXid,'b');
 assert.equal(searchIndex(state,'novak').authors[0].photoCount,2);
 assert.equal(searchIndex(state,'novak').authors[0].groupCount,1);
});
test('membership and visible population follow merges, splits and filters',()=>{
 const index=buildSearchIndex([photo('a','g1','a'),photo('b','g2','b')]);
 assert.equal(searchIndex(updateSearchMembership(index),'letenska').places[0].groupCount,2);
 const merged=updateSearchMembership(index,new Map([['a',{id:'merged'}],['b',{id:'merged'}]]));
 assert.equal(searchIndex(merged,'letenske').places[0].groupCount,1);
 const filtered=updateSearchMembership(index,new Map(),new Set(['b']));
 assert.deepEqual(searchIndex(filtered,'letenska').places[0].xids,['b']);
 assert.equal(searchIndex(filtered,'letenska').places[0].photoCount,1);
 assert.deepEqual(searchIndex(filtered,''),{places:[],authors:[],photos:[]});
});
test('all variants from same entity participate; unrelated description does not create place',()=>{
 const variant={...place,aliases:['Související heslo']};
 const index=buildSearchIndex([photo('a','g1','a'),photo('b','g2','b',[variant]),photo('c','g3','Letenská vodárenská věž',[])]);
 const result=searchIndex(updateSearchMembership(index),'souvisejici');
 assert.equal(result.places[0].photoCount,2);
 assert.equal(searchIndex(updateSearchMembership(index),'letenska').places[0].photoCount,2);
});
test('canonical relevance wins over population and mentions search only description', async()=>{
 const {searchDescriptions} = await import('../../../viewer/static/search-index.js');
 const other={...place,id:'street-b',label:'Jiná',aliases:['Letenská']};
 const index=buildSearchIndex([photo('a','g','Průhled ulicí'),photo('b','g2','Něco',[other]),photo('c','g3','Něco',[other])]);
 const state=updateSearchMembership(index);
 assert.equal(searchIndex(state,'letenska').places[0].id,place.id);
 assert.equal(searchIndex(state,'letenska mala strana').places[0].rank,0);
 assert.deepEqual(searchDescriptions(state,'novak'),[]);
 assert.equal(searchDescriptions(state,'pruhled')[0].matchedXid,'a');
});

test('description provenance uses the same all-token rule within each source field', async()=>{
 const {searchDescriptions}=await import('../../../viewer/static/search-index.js');
 const feature=photo('source','group','Pohled z věže na Prahu.');
 feature.properties.annotation={public_text:'Upřesněná datace snímku.'};
 const state=updateSearchMembership(buildSearchIndex([feature]));
 assert.deepEqual(searchDescriptions(state,'pohled prahu').map(r=>[r.descriptionSource,r.descriptionValue]),[['archive','Pohled z věže na Prahu.']]);
 assert.deepEqual(searchDescriptions(state,'upresnena snimku').map(r=>[r.descriptionSource,r.descriptionValue]),[['annotation','Upřesněná datace snímku.']]);
 assert.deepEqual(searchDescriptions(state,'pohled datace'),[]);
 assert.equal(searchIndex(state,'pohled datace').photos.length,1);
});
