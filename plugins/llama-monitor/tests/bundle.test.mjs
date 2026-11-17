import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

test('release tree excludes generated Python bytecode and cache directories', () => {
 const generated=readdirSync('.',{recursive:true}).filter(path=>String(path).split(/[\\\\/]/).includes('__pycache__') || String(path).endsWith('.pyc'));
 assert.deepEqual(generated,[]);
});

test('companion archive is reproducible, matches source and has no links or credentials', () => {
 const result = spawnSync('python3',['-B','-c',`
import importlib.util, io, pathlib, tarfile
p=pathlib.Path("collector")
spec=importlib.util.spec_from_file_location("bundle",p/"build_bundle.py")
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
data=(p/"llama-monitor-collector.tar.gz").read_bytes()
assert data == module.build() == module.build()
with tarfile.open(fileobj=io.BytesIO(data),mode="r:gz") as archive:
    members=archive.getmembers()
    assert len(members)==4 and all(m.isfile() for m in members)
    for m in members:
        name=m.name.split("/")[-1]
        assert m.name==module.ROOT+"/"+name
        assert name in module.FILES
        assert archive.extractfile(m).read()==(p/name).read_bytes()
        assert m.mtime==0 and m.uid==m.gid==0
`],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
