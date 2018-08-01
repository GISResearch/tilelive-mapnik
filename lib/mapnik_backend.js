const fs = require('fs');
const path = require('path');
const url = require('url');
const mapnik = require('@carto/mapnik');
const qs = require('querystring');
const genericPool = require("generic-pool");
const LockingCache = require('./lockingcache');
const timeoutDecorator = require('./utils/timeout-decorator');

// node-mapnik >= 1.3 no long auto-registers plugins
// so we do it here
if (mapnik.register_default_input_plugins) mapnik.register_default_input_plugins()

var cache = {};

exports = module.exports = MapnikSource;

require('util').inherits(MapnikSource, require('events').EventEmitter);
function MapnikSource(uri, callback) {
    uri = this._normalizeURI(uri);

    if (uri.protocol && uri.protocol !== 'mapnik:') {
        callback(new Error('Only the mapnik protocol is supported'));
    }

    var key = JSON.stringify(uri);

    // by default we use an internal self-caching mechanism but
    // calling applications can pass `internal_cache:false` to disable
    // TODO - consider removing completely once https://github.com/mapbox/tilemill/issues/1893
    // is in place and a solid reference implementation of external caching
    if (uri.query.internal_cache === false) {
        this.once('open', callback);
        this._open(uri);
    } else {
        // https://github.com/mapbox/tilelive-mapnik/issues/47
        if (!cache[key]) {
            cache[key] = this;
            this._self_cache_key = key;
            this._open(uri);
        }
        var source = cache[key];
        source.setMaxListeners(0);
        if (!source.open) {
            source.once('open', function(err, source) {
                if (err) cache[key] = false;
                callback(err, source);
            });
        } else {
            callback(null, source);
        }
    }
    // cache used to skip encoding of solid images
    this.solidCache = {};

    if (uri.query && uri.query.limits && uri.query.limits.render > 0) {
        this.getTile = timeoutDecorator(this.getTile.bind(this), uri.query.limits.render);
        this.getGrid = timeoutDecorator(this.getGrid.bind(this), uri.query.limits.render);
    }

    return undefined;
}

MapnikSource.mapnik = mapnik;

MapnikSource.prototype.toJSON = function() {
    return url.format(this._uri);
};

function as_bool(val) {
    var num = +val;
    return !isNaN(num) ? !!num : !!String(val).toLowerCase().replace(!!0,'');
}

MapnikSource.prototype._normalizeURI = function(uri) {
    if (typeof uri === 'string') uri = url.parse(uri, true);
    if (uri.hostname === '.' || uri.hostname == '..') {
        uri.pathname = uri.hostname + uri.pathname;
        delete uri.hostname;
        delete uri.host;
    }
    if (typeof uri.pathname !== "undefined") uri.pathname = path.resolve(uri.pathname);
    uri.query = uri.query || {};
    if (typeof uri.query === 'string') uri.query = qs.parse(uri.query);
    // cache self unless explicitly set to false
    if (typeof uri.query.internal_cache === "undefined") uri.query.internal_cache = true;
    else uri.query.internal_cache = as_bool(uri.query.internal_cache);
    if (!uri.query.base) uri.query.base = '';
    if (!uri.query.metatile) uri.query.metatile = 2;
    if (!uri.query.resolution) uri.query.resolution = 4;
    if (!Number.isFinite(uri.query.bufferSize)) uri.query.bufferSize = 128;
    if (!uri.query.tileSize) uri.query.tileSize = 256;
    if (!uri.query.scale) uri.query.scale = 1;
    // autoload fonts unless explicitly set to false
    if (typeof uri.query.autoLoadFonts === "undefined") uri.query.autoLoadFonts = true;
    else uri.query.autoLoadFonts = as_bool(uri.query.autoLoadFonts);
    uri.query.limits = uri.query.limits || {};
    if (typeof uri.query.limits.render === 'undefined') uri.query.limits.render = 0;
    uri.query.metatileCache = uri.query.metatileCache || {};
    // Time to live in ms for cached tiles/grids
    // When set to 0 and `deleteOnHit` set to `false` object won't be removed
    // from cache until they are requested
    // When set to > 0 objects will be removed from cache after the number of ms
    uri.query.metatileCache.ttl = uri.query.metatileCache.ttl || 0;
    // Overrides object removal behaviour when ttl>0 by removing objects from
    // from cache even if they had a ttl set
    uri.query.metatileCache.deleteOnHit = uri.query.metatileCache.hasOwnProperty('deleteOnHit') ?
        as_bool(uri.query.metatileCache.deleteOnHit) : false;

    if (typeof uri.query.metrics === "undefined")  uri.query.metrics = false;
    else uri.query.metrics =  as_bool(uri.query.metrics);
    return uri;
};

// Finds all XML files in the filepath and returns their tilesource URI.
MapnikSource.list = function(filepath, callback) {
    filepath = path.resolve(filepath);
    fs.readdir(filepath, function(err, files) {
        if (err) return callback(err);
        for (var result = {}, i = 0; i < files.length; i++) {
            var name = files[i].match(/^([\w-]+)\.xml$/);
            if (name) result[name[1]] = 'mapnik://' + path.join(filepath, name[0]);
        }
        return callback(null, result);
    });
};

// Finds an XML file with the given ID in the filepath and returns a
// tilesource URI.
MapnikSource.findID = function(filepath, id, callback) {
    filepath = path.resolve(filepath);
    var file = path.join(filepath, id + '.xml');
    fs.stat(file, function(err, stats) {
        if (err) return callback(err);
        else return callback(null, 'mapnik://' + file);
    });
};

MapnikSource.prototype._open = function(uri) {
    this._stats = {
        render: 0,          // # of times a render is requested from mapnik
        total: 0,           // # of tiles returned from source
        encoded: 0,         // # of tiles encoded
        solid: 0,           // # of tiles isSolid
        solidPainted: 0     // # of tiles isSolid && painted
    };
    this._internal_cache = uri.query.internal_cache;
    this._autoLoadFonts = uri.query.autoLoadFonts;
    this._base = uri.query.base;
    uri.query.metatile = +uri.query.metatile;
    uri.query.resolution = +uri.query.resolution;
    uri.query.bufferSize = +uri.query.bufferSize;
    uri.query.tileSize = +uri.query.tileSize;
    this._uri = uri;

    // Public API to announce how we're metatiling.
    this.metatile = uri.query.metatile;
    this.bufferSize = uri.query.bufferSize;

    // This defaults to true. To disable font auto-loading
    // Set ?autoLoadFonts=false in the mapnik URL to disable
    if (this._autoLoadFonts) {
        if (mapnik.register_default_fonts) mapnik.register_default_fonts();
        if (mapnik.register_system_fonts) mapnik.register_system_fonts();
    }

    // Initialize this map. This wraps `localize()` and calls `create()`
    // afterwards to actually create a new Mapnik map object.
    Step(function() {
        source._loadXML(this);
    }, function(err, xml) {
        if (err) return error(err);
        // https://github.com/mapbox/tilelive-mapnik/issues/25
        // there seems to be no value to assinging xml to a property
        //source._xml = xml;
        source._createMetatileCache(uri.query.metatileCache);
        source._createPool(xml, this);
    }, function(err) {
        if (err) return error(err);
        source._populateInfo(this);
    }, function(err) {
        if (err) return error(err);
        source.open = true;
        source.emit('open', null, source);
    });
};

MapnikSource.prototype.close = function(callback) {
    this._close(function() {
        return callback();
    });
};

MapnikSource.prototype._cache = cache;

MapnikSource.prototype._close = function(callback) {
    if (cache[this._self_cache_key]) delete cache[this._self_cache_key];
    if (this._tileCache) this._tileCache.clear();
    // https://github.com/coopernurse/node-pool/issues/17#issuecomment-6565795
    if (this._pool) {
        const pool = this._pool;
        const p = pool.drain()
        .then(function() {
            pool.clear();
            return callback();
        });
    }
};

MapnikSource.registerProtocols = function(tilelive) {
    tilelive.protocols['mapnik:'] = MapnikSource;
};

// Loads the XML file from the specified path. Calls `callback` when the mapfile
// can be expected to be in `mapfile`. If this isn't successful, `callback` gets
// an error as its first argument.
MapnikSource.prototype._loadXML = function(callback) {
    if (this._uri.pathname) {
        this._base = path.resolve(path.dirname(this._uri.pathname));
    }

    // This is a string-based map file. Pass it on literally.
    if (this._uri.xml) return callback(null, this._uri.xml);

    // Load XML from file.
    fs.readFile(path.resolve(this._uri.pathname), 'utf8', (err, xml) => {
        callback(err, xml);
    });
};

// Create a new mapnik map object at `this.mapnik`. Requires that the mapfile
// be localized with `this.localize()`. This can be called in repetition because
// it won't recreate `this.mapnik`.
MapnikSource.prototype._createPool = function(xml) {
    if (this._pool) return;

    const opts = {
        max: this._uri.query.poolSize || process.env.UV_THREADPOOL_SIZE || require('os').cpus().length
    };
    const factory = {
        create: () => {
            return new Promise((resolve, reject) => {
                // Note that acquire() never resolves/rejects if factory always rejects
                try {
                    const map = new mapnik.Map(this._uri.query.tileSize, this._uri.query.tileSize);
                    map.bufferSize = this._uri.query.bufferSize;
                    const map_opts = {strict: this._uri.strict || false, base: this._base + '/'};
                    map.fromString(xml, map_opts, (err_string, map) => {
                        if (err_string) {
                            delete map;
                            resolve(err_string);
                        }
                        else resolve(map);
                    });
                } catch (exception) {
                    resolve(exception);
                }
            });
        },
        destroy : (map) => {
            delete map;
        }
    };

    this._pool = genericPool.createPool(factory, opts);
};

MapnikSource.prototype._populateInfo = function() {
    var id = path.basename(this._uri.pathname, path.extname(this._uri.pathname));
    const mapPromise = this._pool.acquire()
    .then(map => {
        if (map instanceof Error) {
            this._pool.release(map);
            return this.emit('open', map);
        }

        var info = { id: id, name: id, minzoom: 0, maxzoom: 22, autoscale: true };

        var p = map.parameters;
        for (var key in p) info[key] = p[key];
        if (p.bounds) info.bounds = p.bounds.split(',').map(parseFloat);
        if (p.center) info.center = p.center.split(',').map(parseFloat);
        if (p.minzoom) info.minzoom = parseInt(p.minzoom, 10);
        if (p.maxzoom) info.maxzoom = parseInt(p.maxzoom, 10);
        if (p.interactivity_fields) info.interactivity_fields = p.interactivity_fields.split(',');

        if (!info.bounds || info.bounds.length !== 4)
            info.bounds = [ -180, -85.05112877980659, 180, 85.05112877980659 ];

        if (!info.center || info.center.length !== 3) info.center = [
            (info.bounds[2] - info.bounds[0]) / 2 + info.bounds[0],
            (info.bounds[3] - info.bounds[1]) / 2 + info.bounds[1],
            2 ];
        this._info = info;
        this._pool.release(map);
        this.open = true;
        this.emit('open', null, this);
    })
    .catch(err => this.emit('open', err));
};

// Creates a locking cache that generates tiles. When requesting the same tile
// multiple times, they'll be grouped to one request.
MapnikSource.prototype._createMetatileCache = function(options) {
    var source = this;
    this._tileCache = new LockingCache(function(key) {
        var cache = this;
        var coords = key.split(',');
        var keys = source._renderMetatile({
            metatile: source._uri.query.metatile,
            tileSize: source._uri.query.tileSize,
            buffer_size: source.bufferSize,
            limits: source._uri.query.limits,
            format: coords[0],
            z: +coords[1],
            x: +coords[2],
            y: +coords[3],
            metrics: source._uri.query.metrics,
            variables: source._uri.query.variables
        }, function(err, tiles) {
            if (err) {
                // Push error objects to all entries that were supposed to
                // be generated.
                keys.forEach(function(key) {
                    cache.put(key, err);
                });
            } else {
                // Put all the generated tiles into the locking cache.
                for (var key in tiles) {
                    cache.put(key, null, tiles[key].image, tiles[key].headers, tiles[key].stats);
                }
            }
        });

        // Return a list of all the tile coordinates that are being rendered
        // as part of this metatile.
        return keys;
    },
    { timeout: options.ttl, deleteOnHit: options.deleteOnHit }); // purge immediately after callbacks
};

// Render handler for a given tile request.
MapnikSource.prototype.getTile = function(z, x, y, callback) {
    z = +z; x = +x; y = +y;
    if (isNaN(z) || isNaN(x) || isNaN(y)) {
        return callback(new Error('Invalid coordinates: '+z+'/'+x+'/'+y));
    }

    var max = Math.pow(2, z);
    if (!isFinite(max) || x >= max || x < 0 || y >= max || y < 0) {
        return callback(new Error('Coordinates out of range: '+z+'/'+x+'/'+y));
    }

    var format = (this._info && this._info.format) || 'png';
    var key = [format, z, x, y].join(',');
    this._tileCache.get(key, function(err, tile, headers, stats) {
        if (err) return callback(err);
        callback(null, tile, headers, stats);
    });
};

MapnikSource.prototype.getGrid = function(z, x, y, callback) {
    z = +z; x = +x; y = +y;
    if (isNaN(z) || isNaN(x) || isNaN(y)) {
        return callback(new Error('Invalid coordinates: '+z+'/'+x+'/'+y));
    }

    var max = Math.pow(2, z);
    if (!isFinite(max) || x >= max || x < 0 || y >= max || y < 0) {
        return callback(new Error('Coordinates out of range: '+z+'/'+x+'/'+y));
    } else if (!this._info ||
        !this._info.interactivity_fields ||
        !this._info.interactivity_layer) {
        if (!this._info) {
            return callback(new Error('Tilesource info is missing, cannot rendering interactivity'));
        } else {
            return callback(new Error('Tileset has no interactivity'));
        }
    } else if (!mapnik.supports.grid) {
        return callback(new Error('Mapnik is missing grid support'));
    }

    var key = ['utf', z, x, y].join(',');
    this._tileCache.get(key, function(err, grid, headers, stats) {
        if (err) return callback(err);
        delete grid.solid;
        callback(null, grid, headers, stats);
    });
};

MapnikSource.prototype.getInfo = function(callback) {
    if (this._info) callback(null, this._info);
    else callback(new Error('Info is unavailable'));
};

// Add other functions.
require('./render');
