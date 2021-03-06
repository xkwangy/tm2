var test = require('tape');
var _ = require('underscore');
var os = require('os');
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var tilelive = require('tilelive');
var yaml = require('js-yaml');

var tm = require('../lib/tm');
var middleware = require('../lib/middleware');
var style = require('../lib/style');
var source = require('../lib/source');
var mockOauth = require('../lib/mapbox-mock')(require('express')());
var tmp = os.tmpdir();
var tmppath = path.join(tmp, 'tm2-middleware-' + (+new Date));

var tmpId = path.join(tmp, 'tm2-middlewareProject-' + (+new Date));
var sourceId = 'tmsource://' + path.resolve(path.join(__dirname, 'fixtures-localsource'));
var styleId = 'tmstyle://' + path.resolve(path.join(__dirname, 'fixtures-localsource'));
var server;

test('setup: config', function(t) {
    tm.config({
        db: path.join(tmppath, 'app.db'),
        cache: path.join(tmppath, 'cache'),
        fonts: path.join(tmppath, 'fonts'),
        mapboxauth: 'http://localhost:3001'
    }, t.end);
});

test('setup: mockserver', function(t) {
    tm.db.set('oauth', {
        account: 'test',
        accesstoken: 'testaccesstoken'
    });
    tm._config.mapboxtile = 'http://localhost:3001/v4';
    server = mockOauth.listen(3001, t.end);
});

test('history: loads', function(t) {
    var req = {};
    middleware.history(req, {}, function() {
        t.ok(req.history, 'has history');
        t.ok(req.history.source, 'history object includes a source');
        t.ok(req.history.source['mapbox:///mapbox.mapbox-streets-v4'], 'default source is listed');
        t.end();
    });
});

test('history: gets style/source info', function(t) {
    tm.history('source', sourceId);
    tm.history('style', styleId);

    var req = {};
    middleware.history(req, {}, function() {
        var sourceInfo = req.history.source[sourceId];
        var styleInfo = req.history.style[styleId];
        t.equal('Test source', sourceInfo.name, 'source info was loaded');
        t.equal('Test style', styleInfo.name, 'style info was loaded');
        t.end();
    });
});

test('history: removes dead source/styles', function(t) {
    tm.history('source', 'foo');
    tm.history('style', 'bar');
    var req = {};
    middleware.history(req, {}, function() {
        t.ok(!req.history.source.foo, 'source `foo` was removed');
        if (req.history.style) t.ok(!req.history.style.bar, 'style `bar` was removed');
        t.end();
    });
});

test('writeStyle: makes tmp styles', function(t) {
    var req = { body: {} };
    middleware.writeStyle(req, {}, function() {
        t.ok(req.style, 'appends style to req');
        t.ok(tm.tmpid('tmstyle:', req.style.data.id), 'creates a valid tmp id');
        var history = tm.history();
        if (history.style) {
            t.ok(history.style.indexOf(req.style.data.id) === -1, 'does not write to history');
        }

        style.info('tmstyle://' + path.dirname(require.resolve('tm2-default-style')), function(err, defaultInfo) {
            delete req.style.data.id;
            delete req.style.data.mtime;
            delete req.style.data._tmp;
            delete req.style.data.background;
            delete defaultInfo.id;
            delete defaultInfo.mtime;

            t.deepEqual(req.style.data, defaultInfo, 'mimics default style');
            t.end();
        });
    });
});

test('writeStyle: makes persistent styles', function(t) {
    var data = {
        id:'tmstyle://' + tmpId,
        name:'tmp-1234',
        source:'mapbox:///mapbox.mapbox-streets-v2',
        styles:{ 'a.mss': '#water { polygon-fill:#fff }' }
    };
    var req = { body: data };
    middleware.writeStyle(req, {}, function() {
        t.ok(req.style, 'appends style to req');
        t.ok(!tm.tmpid('tmstyle:', req.style.data.id), 'does not create a tmp id');
        t.ok(tm.history().style.indexOf(req.style.data.id) !== -1, 'writes to history');
        t.equal(req.style.data.name, data.name, 'has correct info');
        t.ok(/maxzoom: 22/.test(fs.readFileSync(tmpId + '/project.yml', 'utf8')), 'saves project.yml');
        t.equal(data.styles['a.mss'], fs.readFileSync(tmpId + '/a.mss', 'utf8'), 'saves a.mss');
        t.end();
    });
});

test('writeStyle: cleanup', function(t) {
    setTimeout(function() {
        ['project.xml','project.yml','a.mss','.thumb.png'].forEach(function(file) {
            try { fs.unlinkSync(path.join(tmpId,file)) } catch(err) {};
        });
        try { fs.rmdirSync(tmpId) } catch(err) {};
        t.end();
    }, 250);
});

test('loadStyle: loads a tmp style', function(t) {
    var writeReq = { body: {} };
    middleware.writeStyle(writeReq, {}, function() {
        var req = { query: { id: writeReq.style.data.id } };
        middleware.loadStyle(req, {}, function() {
            t.ok(req.style, 'appends style to req');
            t.equal(req.style.data.id, writeReq.style.data.id, 'has the correct id');
            var history = tm.history();
            if (history.style) {
                t.ok(history.style.indexOf(req.style.data.id) === -1, 'does not write to history');
            }
            t.end();
        });
    });
});

test('loadStyle: loads a tmp style with source', function(t) {
    var sourceId = 'tmsource://' + path.resolve(path.join(__dirname, 'fixtures-localsource'));
    var req = { body: {}, query: { source:sourceId } };
    middleware.writeStyle(req, {}, function(err) {
        t.ifError(err);
        t.deepEqual({
            'style.mss': 'Map {\n  background-color: #fff;\n}\n\n#box {\n  line-width: 1;\n  line-color: rgba(238,68,187,0.5);\n}\n\n'
        }, req.style.data.styles, 'creates default styles');
        t.equal(sourceId, req.style.data.source, 'sets source from input param');
        t.ok(tm.tmpid(req.style.data.id));
        t.end();
    });
});

test('loadStyle: errors a tmp style with bad source', function(t) {
    var sourceId = 'tmsource:///bad/path/to/nonexistent/source';
    var req = { body: {}, query: { source:sourceId } };
    middleware.writeStyle(req, {}, function(err) {
        t.ok(err);
        t.equal('ENOENT', err.code);
        t.end();
    });
});

test('loadStyle: loads a persistent style', function(t) {
    var styleId = 'tmstyle://' + path.resolve(path.join(__dirname, 'fixtures-localsource'));
    var styleDoc = require('./fixtures-localsource/project.yml');
    var req = { query: { id: styleId } };
    middleware.loadStyle(req, {}, function() {
        t.ok(req.style, 'appends style to req');
        t.equal(req.style.data.id, styleId, 'has the correct id');
        t.ok(tm.history().style.indexOf(req.style.data.id) !== -1, 'writes to history');
        t.equal(req.style.data.mtime, styleDoc.mtime, 'style info was loaded');
        t.end();
    });
});

test('writeSource: makes tmp sources', function(t) {
    var req = { body: {} };
    middleware.writeSource(req, {}, function() {
        t.ok(req.source, 'appends source to req');
        t.ok(source.tmpid(req.source.data.id), 'creates a valid tmp id');
        var history = tm.history();
        if (history.source) {
            t.ok(history.source.indexOf(req.source.data.id) === -1, 'does not write to history');
        }
        t.end();
    });
});

test('writeSource: makes persistent sources', function(t) {
    var data = {
        id: 'tmsource://' + tmpId,
        name: 'Test source',
        attribution: '&copy; John Doe 2013.',
        minzoom: 0,
        maxzoom: 6,
        Layer: [ {
            id: 'box',
            name: 'box',
            description: '',
            srs: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0.0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs +over',
            properties: {
                'buffer-size': 0,
                minzoom: 0,
                maxzoom: 6
            },
            Datasource: {
                file: __dirname + '/fixtures-localsource/10m-900913-bounding-box.shp',
                type: 'shape'
            }
        } ]
    };
    var req = { body: data };
    middleware.writeSource(req, {}, function() {
        var s = req.source;
        t.ok(s, 'appends source to req');
        t.ok(!source.tmpid(s.data.id), 'does not creates a tmp id');
        var history = tm.history();
        if (history.source) {
            t.ok(history.source.indexOf(s.data.id) !== -1, 'writes to history');
        }
        t.deepEqual(s.data, data, 'has the right data');
        t.end();
    });
});

test('writeSource: cleanup', function(t) {
    setTimeout(function() {
        ['data.xml', 'data.yml'].forEach(function(file) {
            try { fs.unlinkSync(path.join(tmpId,file)) } catch(err) {};
        });
        try { fs.rmdirSync(tmpId) } catch(err) {};
        t.end();
    }, 250);
});

test('loadSource: loads a tmp source', function(t) {
    var writeReq = { body: {} };
    middleware.writeSource(writeReq, {}, function() {
        var req = { query: { id: writeReq.source.data.id } };
        middleware.loadSource(req, {}, function() {
            t.ok(req.source, 'appends source to req');
            t.equal(req.source.data.id, writeReq.source.data.id, 'has the correct id');
            var history = tm.history();
            if (history.source) {
                t.ok(history.source.indexOf(req.source.data.id) === -1, 'does not write to history');
            }
            t.end();
        });
    });
});

test('loadSource: loads a persistent source', function(t) {
    var sourceId = 'tmsource://' + path.resolve(path.join(__dirname, 'fixtures-localsource'));
    var sourceDoc = require('./fixtures-localsource/data.yml');
    var req = { query: { id: sourceId } };
    middleware.loadSource(req, {}, function() {
        t.ok(req.source, 'appends source to req');
        t.equal(req.source.data.id, sourceId, 'has the correct id');
        t.ok(tm.history().source.indexOf(req.source.data.id) !== -1, 'writes to history');
        t.equal(req.source.data.name, sourceDoc.name, 'has the correct name');
        t.equal(req.source.data.attribution, sourceDoc.attribution, 'has the correct attribution');
        t.equal(req.source.data.minzoom, sourceDoc.minzoom, 'has the correct minzoom');
        t.equal(req.source.data.maxzoom, sourceDoc.maxzoom, 'has the correct maxzoom');
        t.deepEqual(req.source.data.Layer[0].Datasource, sourceDoc.Layer[0].Datasource, 'has the correct Layer');
        t.end();
    });
});

test('auth: errors on unauthenticated requests', function(t) {
    tm.db.rm('oauth');
    middleware.auth({}, {}, function(err) {
        t.equal('EOAUTH', err.code);
        t.end();
    });
});

test('auth: passes through authenticated requests', function(t) {
    tm.db.set('oauth', {
        account: 'test',
        accesstoken: '12345678'
    });
    middleware.auth({}, {}, function(err) {
        t.ok(!err);
        t.end();
    });
});

test('exporting: passes through', function(t) {
    middleware.exporting({}, {}, function(err) {
        t.ifError(err);
        t.end();
    });
});
// @TODO test cases where copytask has been started.
// Requires fixes for copytask pause/cancel.

test('userTilesets: fails without oauth', function(t) {
    tm.db.rm('oauth');
    middleware.userTilesets({}, {}, function(err) {
        t.equal('Error: oauth required', err.toString());
        t.end();
    });
});

test('userTilesets: requires 200 from Mapbox API', function(t) {
    tm.db.set('oauth', {
        account: 'baduser',
        accesstoken: 'badtoken'
    });
    middleware.userTilesets({}, {}, function(err) {
        t.equal('Error: 403 GET http://localhost:3001/api/Map?account=baduser&_type=tileset&private=true&access_token=badtoken', err.toString());
        t.end();
    });
});

test('userTilesets: adds history entries for tilesets', function(t) {
    tm.db.set('oauth', {
        account: 'test',
        accesstoken: '12345678'
    });
    middleware.userTilesets({}, {}, function(err) {
        t.ifError(err);
        t.ok(tm.history().source.indexOf('mapbox:///test.vector-source') !== -1);
        t.ok(tm.history().source.indexOf('mapbox:///test.raster-source') === -1);
        t.end();
    });
});

test('cleanup', function(t) {
    tm.db.rm('oauth');
    tm.history('source', sourceId, true);
    tm.history('style', styleId, true);
    try { fs.unlinkSync(path.join(tmppath, 'app.db')); } catch(err) {}
    try { fs.rmdirSync(path.join(tmppath, 'cache')); } catch(err) {}
    try { fs.rmdirSync(tmppath); } catch(err) {}
    server.close(function() {
        t.end();
    });
});

