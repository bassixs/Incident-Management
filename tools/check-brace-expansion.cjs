// Offline check after npm ci and in the production Docker image. No MAX or database calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function installedCopies(root) {
  const copies = [];
  function visit(modules) {
    if (!fs.existsSync(modules)) return;
    function pkg(directory) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest)) {
        const info = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (info.name === 'brace-expansion') copies.push({ directory, version: info.version });
      }
      visit(path.join(directory, 'node_modules'));
    }
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = path.join(modules, entry.name);
      if (entry.name.startsWith('@')) {
        for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
          if (child.isDirectory()) pkg(path.join(directory, child.name));
        }
      } else pkg(directory);
    }
  }
  visit(path.join(root, 'node_modules'));
  return copies;
}

function verify(root = process.cwd()) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const copies = installedCopies(root);
  const expected = Object.keys(lock.packages).filter(key => key.endsWith('/brace-expansion'));
  assert.equal(copies.length, expected.length, 'Installed brace-expansion copies differ from lock');
  assert.ok(copies.length > 0, 'No brace-expansion copies found');
  const result = [];
  for (const copy of copies) {
    const relative = path.relative(root, copy.directory).split(path.sep).join('/');
    assert.equal(lock.packages[relative]?.version, copy.version);
    const [major, minor, patch] = copy.version.split('.').map(Number);
    const floor = { 1: [1, 21], 2: [1, 7] }[major];
    assert.ok(floor && (minor > floor[0] || (minor === floor[0] && patch >= floor[1])), 'Unreviewed/vulnerable brace-expansion version');
    // Bound CPU and memory in a separate process, including in a unit-test run.
    const checked = spawnSync(process.execPath, ['--max-old-space-size=128', '-e', `
      const assert = require('node:assert/strict');
      const expand = require(process.argv[1]);
      assert.deepEqual(expand('report-{a,b}-{1..2}.xlsx'), ['report-a-1.xlsx','report-a-2.xlsx','report-b-1.xlsx','report-b-2.xlsx']);
      // Deep nesting and adjacent comma parts formerly exhausted the stack.
      for (const pattern of ['{'.repeat(3200)+'a,b'+'}'.repeat(3200), '{a,'.repeat(4000)+'z'+'}'.repeat(4000)]) {
        const output = expand(pattern);
        assert.ok(Array.isArray(output) && output.length > 0);
      }
      // Repeated right braces formerly triggered quadratic rewriting.
      assert.ok(Array.isArray(expand('{a}'+'}'.repeat(128000)+',z}')));
    `, copy.directory], { encoding: 'utf8', timeout: 10000 });
    assert.equal(checked.error, undefined, 'brace-expansion probe timed out or could not start');
    assert.equal(checked.status, 0, checked.stderr || 'brace-expansion probe failed');
    result.push({ path: relative, version: copy.version });
  }
  return result;
}
module.exports = { verify };
if (require.main === module) console.log(JSON.stringify(verify(path.resolve(process.argv[2] || '.')), null, 2));