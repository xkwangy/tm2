var _ = require('underscore');
var fs = require('fs');
var url = require('url');
var path = require('path');
var yaml = require('js-yaml');
var dirty = require('dirty');
var mapnik = require('mapnik');
var mkdirp = require('mkdirp');
var chrono = require('chrono');
var crypto = require('crypto');
var tilelive = require('tilelive');
var existsSync = require('fs').existsSync || require('path').existsSync;
var speedometer = require('speedometer');

tilelive.protocols['mbtiles:'] = require('mbtiles');

var tm = {};

// Set or get config.
tm.db;
tm._config = {
    db: path.join(process.env.HOME, '.tilemill', 'v2', 'app.db'),
    tmp: path.join(process.env.HOME, '.tilemill', 'v2', 'tmp'),
    cache: path.join(process.env.HOME, '.tilemill', 'v2', 'cache'),
    fonts: path.join(process.env.HOME, '.tilemill', 'v2', 'fonts'),
    mapboxauth: 'https://api.mapbox.com',
    mapboxtile: 'https://a.tiles.mapbox.com/v4'
};
tm.config = function(opts, callback) {
    if (!opts) return tm._config;

    tm._config = _(opts).defaults(tm._config);
    // @TODO create other paths (cache, etc.)
    try {
        mkdirp.sync(path.dirname(tm.config().db));
        mkdirp.sync(tm.config().tmp);
        mkdirp.sync(tm.config().cache);
        mkdirp.sync(tm.config().fonts);
    } catch(err) { throw err; }

    // Register default fonts.
    mapnik.register_fonts(path.dirname(require.resolve('mapbox-studio-pro-fonts')), { recurse: true });
    mapnik.register_fonts(path.dirname(require.resolve('mapbox-studio-default-fonts')), { recurse: true });
    mapnik.register_fonts(tm.config().fonts, { recurse: true });

    // Register default plugins. Used for font rendering.
    mapnik.register_default_input_plugins();

    tm.dbcompact(tm.config().db, function(err, db) {
        if (err && callback) return callback(err);
        tm.dbmigrate(db);
        tm.db = db;
        if (callback) return callback();
    });

    return tm._config;
};

// Run migrations on a node-dirty database.
tm.dbmigrate = function(db) {
    switch(db.get('version')) {
    case 1:
        db.set('version', 2);
        db.set('history', _(db.get('history')||{}).reduce(function(memo, list, type) {
            if (type !== 'style' && type !== 'source') return memo;
            memo[type] = list.map(function(id) {
                var uri = url.parse(id);
                if (uri.protocol === 'mapbox:') {
                    return !uri.pathname ? id.replace('://', ':///') : id;
                } else if (!uri.protocol) {
                    return 'tm' + type + '://' + uri.pathname;
                } else {
                    return id;
                }
            });
            return memo;
        }, { style:[], source:[] }));
        break;
    case undefined:
        db.set('version', 2);
        break;
    }
};

// Compact a node-dirty database. Works by loading an old instance of the db,
// copying all docs into memory, deleting the old db and writing a new one
// in its place.
tm.dbcompact = function(filepath, callback) {
    fs.exists(filepath, function(exists) {
        // If the db does not exist, no need to compact.
        if (!exists) return callback(null, dirty(filepath));

        // Read the old db into memory and remove the old file.
        var old = dirty(filepath);
        var olddb = {};
        old.once('read_close', function() {
            fs.unlink(filepath, function(err) {
                if (err && err.code !== 'ENOENT') return callback(err);
                var db = dirty(filepath);
                for (var k in olddb) db.set(k, olddb[k]);
                return callback(null, db);
            });
        });
        old.once('load', function() {
            old.forEach(function(k,v) { olddb[k] = v; });
            old.close();
            if (!Object.keys(olddb).length) old.emit('read_close');
        });
    });
};

// Set or remove a project id from recent history.
var defaultSources = [
    'mapbox:///mapbox.mapbox-streets-v4'
];
tm.history = function(type, id, invalidate) {
    var history = tm.db.get('history') || {};
    history = _(history).isArray() ? { style: history } : history;
    history.style = history.style || [];
    history.source = history.source || [];

    if (id && type) {
        if (!history[type]) throw new Error('History set requires valid type');
        var update = invalidate
            ? _(history[type]).reject(function(k) { return k === id; })
            : _(history[type].concat([id])).uniq();
        if (!_(update).isEqual(history[type])) {
            history[type] = update;
            tm.db.set('history', history);
        }
    }
    history.source = _(history.source.concat(defaultSources)).uniq();
    history.style.sort();
    history.source.sort();
    return history;
};

// Remotes cache.
var remote = {};
tm.remote = function(id, data) {
    if (!data) {
        return remote[id] || false;
    } else {
        remote[id] = data;
        return remote[id];
    }
};

// Load templates.
tm.templates = _(fs.readdirSync(__dirname + '/../templates')).reduce(function(memo, file) {
    if (file.charAt(0) === '.') return memo;
    memo[file.split('.')[0]] = _(fs.readFileSync(__dirname + '/../templates/' + file, 'utf8')).template();
    return memo;
}, {});

// Writes an array of files defined by { basename:[basename], data:[data] }
tm.writefiles = function(basepath, files, callback) {
    var write = function() {
        if (!files.length) return callback();
        var file = files.shift();
        fs.writeFile(path.join(basepath, file.basename), file.data, function(err) {
            if (err) return callback(err);
            write();
        });
    };
    mkdirp(basepath, function(err) {
        if (err) return callback(err);
        write();
    });
};

// Reads a directory of files.
tm.dirfiles = function(basepath, callback) {
    fs.readdir(path.resolve(basepath), function(err, files) {
        if (err) return callback(err);
        files = files.filter(function(f) { return f[0] !== '.' });

        var stats = [];
        var stat = function() {
            if (!files.length) {
                stats.sort(function(a,b) {
                    if (a.type < b.type) return -1;
                    if (a.type > b.type) return 1;
                    if (a.basename.toLowerCase() < b.basename.toLowerCase()) return -1;
                    if (a.basename.toLowerCase() > b.basename.toLowerCase()) return 1;
                    return 0;
                });
                return callback(null, stats);
            }
            var p = path.join(basepath, files.shift());
            fs.stat(p, function(err, s) {
                if (err && err.code === 'ENOENT') return stat();
                if (err) return callback(err);
                if (s.isFile()) s.type = 'file';
                if (s.isDirectory()) s.type = 'dir';
                if (s.type) {
                    s.path = p;
                    s.extname = path.extname(p);
                    s.basename = path.basename(p);
                    stats.push(s);
                }
                stat();
            });
        };
        stat();
    });
};

// Filter keys out of an object that are not present in defaults.
tm.filterkeys = function(data, defaults) {
    return _(data).reduce(function(memo,v,k) {
        if (!(k in defaults)) return memo;
        memo[k] = v;
        return memo;
    }, {})
};

// Return an object with sorted keys, ignoring case.
tm.sortkeys = function(obj) {
    try {
        return obj.map(tm.sortkeys);
    } catch(e) {};
    try {
        return Object.keys(obj).sort(function(a, b) {
            a = a.toLowerCase();
            b = b.toLowerCase();
            if (a === 'id') return -1;
            if (b === 'id') return 1;
            if (a > b) return 1;
            if (a < b) return -1;
            return 0;
        }).reduce(function(memo, key) {
            memo[key] = tm.sortkeys(obj[key]);
            return memo;
        }, {});
    } catch(e) { return obj };
};

// Generate or verify that an id is a temporary one.
tm.tmpid = function(protocol, id, md5) {
    if (id && !md5) return (new RegExp(protocol + '\/\/\/tmp-[0-9a-f]{8}')).test(id);

    if (id && md5) {
        return protocol + '///tmp-' + crypto.createHash('md5').update(id).digest('hex').substr(0,8);
    } else {
        id = protocol + '///tmp-';
        var base16 = '0123456789abcdef';
        for (var i = 0; i < 8; i++) id += base16[Math.random() * 16 | 0];
        return id;
    }
};

// Named projections.
tm.srs = {
    'WGS84': '+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs',
    '900913': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0.0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs +over'
};
tm.extent = {
    'WGS84': '-180,-85.0511,180,85.0511',
    '900913': '-20037508.34,-20037508.34,20037508.34,20037508.34'
};
// Reverse the above hash to allow for srs name lookups.
tm.srsname = {};
for (name in tm.srs) tm.srsname[tm.srs[name]] = name;

// Render a preview image for a font.
tm.font = function(name, text, callback) {
    tm.fonts = tm.fonts || mapnik.fonts();
    if (tm.fonts.indexOf(name) === -1) return callback(new Error('Invalid font ' + name));

    // Attempt to retrieve from cache.
    var xml = tm.templates.xrayfont({name:name, text:text||name});
    var ckey = 'font-' + crypto.createHash('md5').update(xml).digest('hex').substr(0,8) + '.png';
    var file = tm.config().cache + '/' + ckey;
    fs.readFile(file, function(err, buffer) {
        if (err && err.code !== 'ENOENT') return callback(err);
        if (buffer) return callback(null, buffer);

        var map = new mapnik.Map(400,40);
        map.extent = [-180,-10,180,10];
        map.fromString(xml, function(err) {
            if (err) return callback(err);
            map.render(new mapnik.Image(400,40), {}, function(err, image) {
                if (err) return callback(err);
                image.encode('png8:m=h:c=64', function(err, buffer) {
                    if (err) return callback(err);

                    // Don't wait for disk write to return image buffer.
                    // If caching fails, error is logged to console.
                    callback(null, buffer);
                    fs.writeFile(file, buffer, function(err) {
                        if (err) console.error(err);
                    });
                });
            });
        });
    });
};

// Take list of fonts from mapnik and group by "family".
tm._fontfamilies = null;
tm.fontfamilies = function() {
    if (tm._fontfamilies) return tm._fontfamilies;

    var fonts = require('mapnik').fonts();
    // Keywords are ordered by "display priority" -- e.g. fonts
    // containing earlier words should be favored for being a preview
    // of the family as a whole.
    var keywords = [
        'medium',
        'normal',
        'regular',
        'book',
        'roman',
        'semibold',
        'demi',
        'bold',
        'caption',
        'cn',
        'cond',
        'condensed',
        'extended',
        'extrabold',
        'black',
        'heavy',
        'ultra',
        'light',
        'narrow',
        'thin',
        'extlight',
        'hairline',
        'italic',
        'oblique',
        'dash'
    ];
    var level1 = {};
    for (var i = 0; i < fonts.length; i++) {
        var parts = fonts[i].split(' ');
        while (parts.length) {
            var word = parts[parts.length-1];
            if (keywords.indexOf(word.toLowerCase()) === -1) break;
            parts.pop();
        }
        var family = parts.join(' ');
        level1[family] = level1[family] || [];
        level1[family].push(fonts[i]);
    }
    var level2 = {};
    for (var fam in level1) {
        if (level1[fam].length > 1) continue;

        var parts = fam.split(' ');
        if (parts.length === 1) continue;
        parts.pop();
        var family = parts.join(' ');

        level2[family] = level2[family] || [];
        level2[family].push(level1[fam][0]);
    }
    for (var fam in level1) {
        if (level1[fam].length > 1) continue;

        var parts = fam.split(' ');
        if (parts.length === 1) continue;
        parts.pop();
        var family = parts.join(' ');

        if (level2[family].length > 1) {
            delete level1[fam];
            level1[family] = level2[family];
        }
    }
    for (var k in level1) level1[k].sort(famsort);

    function famsort(a, b) {
        var ascore = 0;
        var bscore = 0;
        var aindex = -1;
        var bindex = -1;
        var aparts = a.split(' ');
        var bparts = b.split(' ');
        for (var i = 0; i < aparts.length; i++) {
            aindex = keywords.indexOf(aparts[i].toLowerCase());
            ascore += aindex >= 0 ? aindex : 0;
        }
        for (var i = 0; i < bparts.length; i++) {
            bindex = keywords.indexOf(bparts[i].toLowerCase());
            bscore += bindex >= 0 ? bindex : 0;
        }
        return ascore - bscore;
    }

    tm._fontfamilies = level1;
    return level1;
};

// Return an augmented uri object from url.parse with the pathname
// transformed into an unescaped dirname.
tm.parse = function(str) {
    var uri = url.parse(str);
    if (uri.pathname) uri.dirname = unescape(uri.pathname);
    return uri;
};

// Return true/false depending on whether a path is absolute.
tm.absolute = function(str) {
    if (str.charAt(0) === '/') return true;
    if ((/^[a-z]\:/i).test(str)) return true;
    return false;
};

module.exports = tm;
