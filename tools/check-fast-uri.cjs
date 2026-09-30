// Offline regression check, usable after npm ci and inside the runtime image.
// No application workers, MAX calls or external requests are started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function installedCopies(root) {
  const copies = [];
  function visit(modules) {
    if (!fs.existsSync(modules)) return;
    function pkg(directory) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest)) {
        const info = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (info.name === 'fast-uri') copies.push({ directory, version: info.version });
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

async function verify(root = process.cwd()) {
  const req = createRequire(path.join(root, 'package.json'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const copies = installedCopies(root);
  const expected = Object.entries(lock.packages).filter(([key]) => key.endsWith('/fast-uri'));
  assert.equal(copies.length, expected.length, 'Installed fast-uri copies differ from lock');
  assert.ok(copies.length > 0, 'No installed fast-uri found');
  const result = [];
  for (const copy of copies) {
    const relative = path.relative(root, copy.directory).split(path.sep).join('/');
    assert.equal(lock.packages[relative]?.version, copy.version, 'Installed version differs from lock');
    const [major, minor, patch] = copy.version.split('.').map(Number);
    const floor = { 2: [4, 7], 3: [1, 8], 4: [1, 5] }[major];
    assert.ok(floor && (minor > floor[0] || (minor === floor[0] && patch >= floor[1])), 'Unreviewed/vulnerable fast-uri version');
    const uri = req(copy.directory);
    // GHSA-qw65-cvwx-89v3: a port must not replace the intended authority.
    const invalid = { scheme: 'http', host: 'trusted.example', port: '@127.0.0.1:8124', path: '/app' };
    assert.throws(() => uri.serialize({ ...invalid }));
    assert.throws(() => uri.normalize({ ...invalid }));
    assert.equal(uri.equal({ ...invalid }, 'http://127.0.0.1:8124/app'), false);
    // GHSA-58mr-gqgx-xq4g: malformed brackets must not pass host validation.
    for (const malformed of ['http://[127.0.0.1/app', 'http://example[.com/app']) {
      assert.equal(uri.parse(malformed).error, 'URI host is malformed.');
      assert.equal(uri.equal(malformed, 'http://127.0.0.1/app'), false);
    }
    // Here '[' is userinfo, not part of the host; policy sees the actual host.
    assert.equal(uri.parse('http://[@127.0.0.1/app').host, '127.0.0.1');
    // GHSA-hrr3-gc8f-f4qj: decode and normalize hostname case consistently.
    assert.equal(uri.parse('//%41.com').host, 'a.com');
    assert.equal(uri.equal('//%41.com', '//a.com'), true);
    if (major === 4) {
      // GHSA-jvvf-x445-j334: recipient must already be visible before serialize.
      const parsed = uri.parse('mailto:reader@example.com?%74o=other@example.com');
      assert.deepEqual(parsed.to, ['reader@example.com', 'other@example.com']);
      assert.deepEqual(uri.parse(uri.serialize(parsed)).to, parsed.to);
    }
    const normal = { scheme: 'https', host: 'example.com', port: 8443, path: '/api' };
    assert.equal(uri.serialize(normal), 'https://example.com:8443/api');
    assert.equal(uri.resolve('https://example.com/base/', '../schema.json'), 'https://example.com/schema.json');
    assert.equal(uri.parse('https://[::1]:8443/').error, undefined);
    result.push({ path: relative, version: copy.version, regressions: 'passed' });
  }

  // Exercise the actual Fastify -> AJV compiler and fast-json-stringify paths.
  const app = req('fastify')();
  try {
    app.addSchema({ $id: 'https://schemas.example.test/value.json', type: 'object',
      properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false });
    app.post('/probe', { schema: {
      body: { $ref: 'https://schemas.example.test/value.json#' },
      response: { 200: { $ref: 'https://schemas.example.test/value.json#' } },
    } }, async request => request.body);
    const valid = await app.inject({ method: 'POST', url: '/probe', payload: { count: 3 } });
    assert.equal(valid.statusCode, 200); assert.deepEqual(valid.json(), { count: 3 });
    const invalid = await app.inject({ method: 'POST', url: '/probe', payload: { count: 'bad' } });
    assert.equal(invalid.statusCode, 400);
  } finally { await app.close(); }
  return { copies: result, fastifySchemaValidationAndSerialization: 'passed' };
}

module.exports = { verify };
if (require.main === module) verify(path.resolve(process.argv[2] || process.cwd()))
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
