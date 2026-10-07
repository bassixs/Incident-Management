'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const helper=process.env.WAIT_HELPER||path.resolve('output/update-main-377b8b7-r2/Na-svyazi-region40/config/wait-ready.sh');
const source=fs.readFileSync(helper,'utf8');
const probe=source.match(/app node -e '([\s\S]+?)' >/)[1];
for(const [health,ready,expected] of [[200,200,0],[503,200,1],[200,503,1],[404,404,1]])test(`probe health=${health} ready=${ready}`,()=>{
 const mock=`global.fetch=async url=>({status:url.endsWith('/health')?${health}:${ready}});`;
 assert.equal(spawnSync(process.execPath,['-e',mock+probe]).status,expected);
});
test('probe rejects network failures',()=>{
 assert.equal(spawnSync(process.execPath,['-e',`global.fetch=async()=>{throw Error('unavailable')};`+probe]).status,1);
});
