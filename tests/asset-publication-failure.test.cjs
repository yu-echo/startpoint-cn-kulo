const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Fastify = require('fastify');

const first = 'pinball-1.4.1-1.4.2-1-first.zip';
const second = 'pinball-1.4.1-1.4.2-2-second.zip';
const patch = () => ({type: 'patch', enabled: true, version: '1.4.2', depends_on: '1.4.1',
    chain: [first, second], archive_integrity: [{name: first, size: 100}, {name: second, size: 200}]});

function fixture(t, patches = [patch()], configured = 'external-cdn') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-publication-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const env = {CDN_DIR: configured === 'absolute' ? path.join(root, 'outside', 'cdn') : configured};
    const cdn = path.resolve(root, env.CDN_DIR || '.cdn');
    const active = path.join(root, 'assets/asset-patch/active');
    fs.mkdirSync(active, {recursive: true});
    fs.writeFileSync(path.join(root, 'assets/asset-patch/manifest.json'), JSON.stringify({patches}));
    for (const platform of ['common', 'medium', 'android', 'ios']) {
        for (const kind of ['full', 'diff']) {
            const dir = path.join(cdn, 'cn', `archive-${platform}-${kind}`);
            fs.mkdirSync(dir, {recursive: true});
            if (kind === 'full') fs.writeFileSync(path.join(dir, 'fixture.zip'), Buffer.alloc(22));
        }
    }
    const modules = new Map();
    const quiet = {warn() {}, error() {}, log() {}};
    const load = relative => {
        if (modules.has(relative)) return modules.get(relative).exports;
        const source = path.resolve(__dirname, '../src', relative + '.ts');
        const text = process.env.STARPOINT_TEST_COMPILED === '1'
            ? fs.readFileSync(path.resolve(__dirname, '../out', relative + '.js'), 'utf8')
            : ts.transpileModule(fs.readFileSync(source, 'utf8'), {compilerOptions: {
                module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
            }}).outputText;
        const module = {exports: {}};
        modules.set(relative, module);
        vm.runInNewContext(text, {module, exports: module.exports, URL, console: quiet,
            __dirname: path.dirname(path.join(root, 'out', relative + '.js')),
            process: {env, platform: process.platform},
            require: name => {
                if (name.endsWith('/utils')) return {generateDataHeaders: value => value || {}};
                if (name.startsWith('.')) return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), name)));
                return require(name);
            },
        }, {filename: source});
        return module.exports;
    };
    return {root, cdn, active, load,
        write: (name, size) => fs.writeFileSync(path.join(active, name), Buffer.alloc(size)),
        cdnArchive: (version, base = cdn) => {
            const directory = path.join(base, 'cn/archive-common-diff');
            fs.mkdirSync(directory, {recursive: true});
            fs.writeFileSync(path.join(directory, `pinball-1.4.0-${version}-1-fixture.zip`), Buffer.alloc(22));
        },
    };
}

async function application(t, f) {
    const app = Fastify({logger: false});
    await app.register(f.load('routes/cn/asset').default);
    t.after(() => app.close());
    return app;
}

test('missing one published ZIP rejects both update endpoints on both platforms, then recovers', async t => {
    const f = fixture(t);
    f.write(first, 100);
    const app = await application(t, f);
    for (const device of ['Android', 'iOS']) {
        for (const version of [undefined, '1.4.1']) {
            for (const url of ['/get_path', '/version_info']) {
                const headers = {device, ...(version ? {res_ver: version} : {})};
                const response = await app.inject({method: 'POST', url, headers, payload: {}});
                assert.equal(response.statusCode, 503);
                assert.equal(response.json().code, 'ASSET_UPDATE_INCOMPLETE');
                assert.equal(response.json().data, undefined);
            }
        }
    }
    // No restart or catalog expiry is needed after completing the publication.
    f.write(second, 200);
    const headers = {device: 'iOS', res_ver: '1.4.1'};
    const repaired = await app.inject({method: 'POST', url: '/get_path', headers, payload: {}});
    assert.equal(repaired.statusCode, 200);
    assert.equal(repaired.json().data.diff[0].archive.length, 2);
    assert.equal(repaired.json().data.info.target_asset_version, '1.4.2');
    const size = await app.inject({method: 'POST', url: '/version_info', headers, payload: {}});
    assert.equal(size.json().data.total_size, 300);
    fs.unlinkSync(path.join(f.active, second));
    assert.equal((await app.inject({method: 'POST', url: '/get_path', headers, payload: {}})).statusCode, 503);
});

test('truncated, empty and directory-shaped published files fail even after a cached success', async t => {
    const f = fixture(t);
    f.write(first, 100); f.write(second, 200);
    const app = await application(t, f);
    const request = {method: 'POST', url: '/get_path', headers: {res_ver: '1.4.1'}, payload: {}};
    assert.equal((await app.inject(request)).statusCode, 200);
    for (const size of [199, 0]) {
        f.write(second, size);
        assert.equal((await app.inject(request)).statusCode, 503);
    }
    fs.unlinkSync(path.join(f.active, second));
    fs.mkdirSync(path.join(f.active, second));
    assert.equal((await app.inject(request)).statusCode, 503);
});

test('missing disabled and already-applied files do not block a valid update or no-update response', async t => {
    const f = fixture(t, [patch(), {type: 'patch', enabled: false, version: '1.4.3', archive: 'missing.zip'},
        {type: 'patch', enabled: true, version: '1.4.1', archive: 'pinball-1.4.0-1.4.1-1-old.zip'}]);
    f.write(first, 100); f.write(second, 200);
    const app = await application(t, f);
    assert.equal((await app.inject({method: 'POST', url: '/get_path', headers: {res_ver: '1.4.1'}, payload: {}})).statusCode, 200);
    fs.unlinkSync(path.join(f.active, first));
    for (const version of ['1.4.2', '1.4.999']) {
        const response = await app.inject({method: 'POST', url: '/get_path', headers: {res_ver: version}, payload: {}});
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().data_headers.asset_update, false);
        assert.equal(response.json().data.diff, null);
    }
});

test('an enabled version with an empty archive chain cannot acknowledge advancement', async t => {
    const f = fixture(t, [{...patch(), chain: []}]);
    const app = await application(t, f);
    assert.equal((await app.inject({method: 'POST', url: '/get_path', headers: {res_ver: '1.4.1'}, payload: {}})).statusCode, 503);
});

test('a manifest version cannot advance using only archives for an already-applied version', async t => {
    const f = fixture(t, [{...patch(), chain: ['pinball-1.4.0-1.4.1-1-old.zip']}]);
    const app = await application(t, f);
    for (const url of ['/get_path', '/version_info']) {
        const response = await app.inject({method: 'POST', url, headers: {res_ver: '1.4.1'}, payload: {}});
        assert.equal(response.statusCode, 503);
        assert.equal(response.json().code, 'ASSET_UPDATE_INCOMPLETE');
    }
});

test('a published chain may legitimately contain several historical version edges', async t => {
    const old = 'pinball-1.4.0-1.4.1-1-old.zip';
    const f = fixture(t, [{...patch(), chain: [old, first, second]}]);
    // Only the part after the client version is required, even in a consolidated chain.
    f.write(first, 100); f.write(second, 200);
    const app = await application(t, f);
    const response = await app.inject({method: 'POST', url: '/get_path', headers: {res_ver: '1.4.1'}, payload: {}});
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.diff[0].archive.length, 2);
});

for (const configured of ['absolute', 'relative-cdn', '']) {
    test(`version detection and download paths use the same CDN root (${configured || 'default'})`, async t => {
        const f = fixture(t, [], configured);
        f.cdnArchive('1.4.3');
        if (configured) f.cdnArchive('1.4.99', path.join(f.root, '.cdn'));
        const version = f.load('lib/version');
        assert.equal(version.detectCDNVersion(), '1.4.3');
        assert.equal(f.load('lib/cdn-path').getCdnRoot(), f.cdn);
        const app = await application(t, f);
        const response = await app.inject({method: 'POST', url: '/get_path', headers: {res_ver: '1.4.1'}, payload: {}});
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().data.info.target_asset_version, '1.4.3');
        assert.equal(response.json().data.diff[0].version, '1.4.3');
    });
}

test('CDN version is refreshed after publication instead of cached for the process lifetime', t => {
    const f = fixture(t, []);
    const version = f.load('lib/version');
    assert.equal(version.detectCDNVersion(), '1.4.0');
    f.cdnArchive('1.4.3');
    version.reloadPatchManifest();
    assert.equal(version.detectCDNVersion(), '1.4.3');
    f.cdnArchive('1.4.4');
    f.load('routes/cn/asset').invalidateAssetArchiveCatalog();
    assert.equal(version.detectCDNVersion(), '1.4.4');
});
