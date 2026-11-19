const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const engine = html.match(/<script id="geminiApi">([\s\S]*?)<\/script>/)[1];
const key = 'fixture-key';
const model = id => ({ name: 'models/' + id, supportedGenerationMethods: ['generateContent'] });
const ok = text => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
const blocked = () => Response.json({ error: { details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } }, { status: 403 });

function fixture(reply) {
    const calls = [];
    const fetch = async (resource, options) => {
        const url = new URL(resource);
        assert.ok(['aiplatform.googleapis.com', 'generativelanguage.googleapis.com'].includes(url.hostname));
        assert.equal(options.headers['x-goog-api-key'], key);
        assert.ok(!url.href.includes(key));
        const call = {
            provider: url.hostname === 'aiplatform.googleapis.com' ? 'vertex-express' : 'developer',
            model: options.method === 'POST' ? url.pathname.split('/').pop().split(':')[0] : '',
            page: url.searchParams.get('pageToken'), signal: options.signal
        };
        if (call.model) {
            const parts = JSON.parse(options.body).contents[0].parts;
            assert.equal(parts.length, 1);
            assert.match(parts[0].text, /接続テスト/);
        }
        calls.push(call);
        const response = await reply(call);
        return response instanceof Response ? response : Response.json(response);
    };
    const api = vm.runInNewContext(engine + '\n({detectModels, probeModel})', {
        fetch, URL, DOMException, AbortController, setTimeout, clearTimeout
    });
    return {
        calls, probe: api.probeModel,
        detect: (preferred = 'developer', signal = new AbortController().signal) =>
            api.detectModels(key, preferred, signal, () => {})
    };
}

test('two catalog pages, numeric versions, stable tie-break and real text before selecting', async () => {
    const mock = fixture(({ provider, model: id, page }) => {
        if (provider === 'vertex-express') return blocked();
        if (!id && !page) return {
            models: ['gemini-3.8-flash', 'gemini-9-flash-image', 'gemini-9-pro-tts', 'gemini-4-hydrogen',
                'gemini-9-flash-cyber', 'gemini-9-flash-lite'].map(model), nextPageToken: 'two'
        };
        if (!id) return { models: ['gemini-3.10-flash-preview', 'gemini-3.10-flash', 'gemini-3.9-flash',
            'gemini-4.1-pro-preview'].map(model).concat({ name: 'models/gemini-10-pro', supportedGenerationMethods: ['countTokens'] }) };
        if (id === 'gemini-3.10-flash') return Response.json({}, { status: 404 });
        if (id === 'gemini-3.10-flash-preview') return { candidates: [{ content: { parts: [{ thought: true, text: 'internal' }] } }] };
        return ok('OK');
    });
    const result = await mock.detect();
    assert.deepEqual(mock.calls.filter(c => c.model).map(c => c.model), [
        'gemini-3.10-flash', 'gemini-3.10-flash-preview', 'gemini-3.9-flash', 'gemini-4.1-pro-preview'
    ]);
    assert.deepEqual(Array.from(result.choices, c => c.model), ['gemini-3.9-flash', 'gemini-4.1-pro-preview']);
});

test('a key accepted by both APIs can use a newer Flash on one endpoint and Pro on the other', async () => {
    const mock = fixture(({ provider, model: id }) => {
        if (id) return ok('OK');
        return provider === 'developer' ? { models: ['gemini-3.8-flash', 'gemini-4.1-pro'].map(model) }
            : { publisherModels: ['gemini-4.2-flash', 'gemini-4.1-pro'].map(name => ({ name: 'publishers/google/models/' + name })) };
    });
    const first = await mock.detect();
    assert.deepEqual(Array.from(first.choices, c => c.provider + '/' + c.model),
        ['vertex-express/gemini-4.2-flash', 'developer/gemini-4.1-pro']);
    const next = await mock.detect('vertex-express');
    assert.ok(next.choices.every(c => c.provider === 'vertex-express'));
});

test('a Model Garden permission error still permits generation on Express. No unsupported Pro is offered', async () => {
    const mock = fixture(({ provider, model: id }) => {
        if (provider === 'developer') return blocked();
        if (!id) return Response.json({ error: { message: 'List requires OAuth' } }, { status: 403 });
        return id === 'gemini-3.8-flash' ? ok('OK') : Response.json({}, { status: 404 });
    });
    const result = await mock.detect();
    assert.deepEqual(Array.from(result.choices, c => c.model), ['gemini-3.8-flash']);
    assert.equal(result.choices[0].provider, 'vertex-express');
    assert.ok(result.catalogs.find(c => c.provider === 'vertex-express').limited);
    assert.ok(!mock.calls.some(c => c.model.includes('hydrogen')));
});

test('temporary model failures and an API-wide Retry-After have different scopes', async () => {
    const mock = fixture(({ provider, model: id }) => {
        if (provider === 'vertex-express') return blocked();
        if (!id) return { models: ['gemini-5-flash', 'gemini-4-flash', 'gemini-5-pro', 'gemini-4-pro'].map(model) };
        if (id === 'gemini-5-flash') return Response.json({}, { status: 429 });
        if (id === 'gemini-5-pro') return Response.json({}, { status: 429, headers: { 'retry-after': '45' } });
        return ok('OK');
    });
    const result = await mock.detect();
    assert.deepEqual(Array.from(result.choices, c => c.model), ['gemini-4-flash']);
    assert.ok(!mock.calls.some(c => c.model === 'gemini-4-pro'));
});

test('a catalog entry for Hydrogen and a response without output are insufficient', async () => {
    let reply = () => Response.json({ error: { message: 'denied for ' + key } }, { status: 403 });
    const mock = fixture(() => reply());
    const signal = new AbortController().signal;
    const probe = () => mock.probe(key, 'vertex-express', 'gemini-4-hydrogen', signal);
    await assert.rejects(probe, e => e.status === 403 && !e.message.includes(key));
    reply = () => ok('   ');
    await assert.rejects(probe, /テキスト応答/);
    reply = () => ({ ...ok('OK'), modelVersion: 'gemini-4-hydrogen' });
    const confirmed = await probe();
    assert.equal(confirmed.provider, 'vertex-express');
    assert.equal(confirmed.modelVersion, 'gemini-4-hydrogen');
    assert.ok(confirmed.checkedAt > 0);
});

test('cancelling a key change during discovery prevents generation attempts', async () => {
    const parent = new AbortController();
    const mock = fixture(() => {
        parent.abort();
        return { models: [model('gemini-3.8-flash')] };
    });
    await assert.rejects(() => mock.detect('developer', parent.signal), { name: 'AbortError' });
    assert.ok(!mock.calls.some(c => c.model));
});

test('upgrading v1.4.3 restores the clinical connection once, without treating its model as verified', () => {
    const store = new Map([
        ['api_keys', JSON.stringify([
            { id: 'meeting', key, provider: 'developer', name: '会議用', model: 'gemini-3.8-flash' },
            { id: 'clinic', key: 'fixture-clinic', provider: 'vertex-express', name: '病状説明用', model: 'gemini-3.1-pro-preview' }
        ])],
        ['last_used_api_key_id', 'meeting'],
        ['voice_rec_clinical_profile', 'clinic'],
        ['voice_rec_clinical_model', 'gemini-4-hydrogen']
    ]);
    function loadPage() {
        const elements = Array.from(html.matchAll(/\bid="([^"]+)"/g), ([, id]) => ({ id, addEventListener() {} }));
        const scripts = Array.from(html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g), m => m[1]);
        return vm.runInNewContext(scripts.join('\n') + '\nactive', {
            document: { querySelectorAll: () => elements }, navigator: {},
            localStorage: { getItem: name => store.get(name), setItem: (name, value) => store.set(name, value) }
        });
    }
    const restored = loadPage();
    assert.equal(restored.id, 'clinic');
    assert.equal(restored.model, 'gemini-4-hydrogen');
    assert.equal(restored.verifiedModels.length, 0);
    assert.equal(JSON.parse(store.get('api_keys')).length, 2);
    store.set('last_used_api_key_id', 'meeting');
    assert.equal(loadPage().id, 'meeting');
});
