/*
 * Copyright (C) 2012-2014 by Coriolis Technologies Pvt Ltd.
 * This program is free software - see the file COPYING for license details.
 */

/*
 * HttpFS is the base handler for http:// URLs. Others may subclass
 * it, e.g. ApacheDir and so forth.
 *
 * This FS also provides media handler classes for text/html, image/*.
 *
 * HttpFS is distinct from HttpTX, which provides actual GET/PUT/POST/DELETE
 * support via direct or proxy channels.
 *
 * 
 * TODO TextHtml reload
 */

var HttpFS = function(opts, uri) {
    var self = this,
        Uri = URI.parse(uri),
        host = Uri.host();

    HttpFS.base.apply(this, []);
    self.opts = opts;
    self.uri = uri;
    self.Uri = Uri;
    self.tx = null;
    if (opts.tx) {
        self.tx = HttpTX.lookup(opts.tx);
    } else if (HttpFS.direct_hosts.indexOf(host) !== -1) {
        self.tx = self.tx || HttpTX.lookup('direct');
    } else {
        self.tx = self.tx || HttpTX.lookup(HttpFS.defaults.tx);
    }
};

inherit(HttpFS, Filesystem);

HttpFS.fsname = 'HttpFS';
HttpFS.filesystems = [];
HttpFS.defaults = { 'tx': 'proxy' };

/* XXX Hack to default some hosts to direct. */
HttpFS.direct_hosts = [ 'localhost', '127.0.0.1', 'pigshell.com',
    'query.yahooapis.com', 'www.quandl.com', 'rawgit.com', 'cdn.rawgit.com' ];

HttpFS.lookup_uri = function(uri, opts, cb) {
    var self = this,
        u = URI.parse(uri),
        url = u.setFragment('').toString(),
        meta = (opts && opts.meta) ? opts.meta : null;

    if (!url) {
        return cb(E('EINVAL'));
    }

    self.lookup_fs(uri, opts, ef(cb, function(fs) {
        var name = (meta && meta.name) ? meta.name : basenamedir(uri),
            file = new self.fileclass({name: name, ident: uri, fs: fs});

        /*
         * Existence of meta option means the caller want a lazy update
         * i.e. one which happens with available (possibly inaccurate)
         * "readdir" data rather than making an authoritative query of the
         * source. This is often preferred when there are hundreds of
         * links but only a few may be visited.
         */

        if (meta) {
            file.update(meta, opts, cb);
        } else {
            file.stat(opts, cb);
        }
    }));
};

HttpFS.lookup_fs = function(uri, opts, cb) {
    var self = this,
        mountopts = opts.mountopts || {};

    function create_fs(opts, uri) {
        var fs = new self(opts, uri);
        self.filesystems.push(fs);
        return fs;
    }

    if (opts.mount) {
        return cb(null, create_fs(mountopts, uri));
    }

    var fs = _lookup_fs(uri, mountopts, self.filesystems);
    return fs ? cb(null, fs) : cb(null, create_fs(mountopts, uri));
};

var HttpFile = function() {
    HttpFile.base.apply(this, arguments);

    this.mime = 'application/vnd.pigshell.httpfile';
    this.html = sprintf('<div class="pfile"><a href="%s" target="_blank">{{name}}</a></div>', this.ident);
};

inherit(HttpFile, File);

HttpFS.fileclass = HttpFile;

/*
 * Get metadata for a file, using HEAD, or in the case of a special protocol, a
 * GET with the right query parameters. Often the first operation to be invoked
 * on a new file instantiated only with ident, fs and name.
 *
 * A successful call MUST return the correct, stable mime-type of the file. It
 * SHOULD return mtime or other information to determine validity of current
 * state. It MAY return other attributes.
 *
 * This function MUST NOT update the file attributes. That is update's job.
 */

HttpFile.prototype.getmeta = function(opts, cb) {
    var self = this;

    self.fs.tx.HEAD(self.ident, opts, ef(cb, function(res) {
        var headers = header_dict(res),
            meta = self._process_headers(headers);
        return cb(null, meta);
    }));
};

/*
 * Update metadata for a file. In case of a directory, this is metadata only
 * for the directory itself, not its contents. dir.files and dir.populated
 * should be untouched.
 *
 * This may be called either after an actual getmeta call, or by a "lazy"
 * readdir/lookup_uri which doesn't want to do a getmeta call for each of its
 * files as they may be very large in number, and the user may be interested
 * only in one or two (standard text/html use case)
 *
 * 'meta' generated by a getmeta call MUST have _mime_valid set to true.
 * 'meta' generated as a wild surmise by a lazy caller MUST NOT have a
 * _mime_valid property.
 *
 * "Lazy" readdirs may guess mime type incorrectly. This means update has to
 * reset and recreate the file if the mime type has changed.
 */

HttpFile.prototype.update = function(meta, opts, cb) {
    var self = this,
        ufile = self._ufile,
        curmime = ufile ? ufile.mime : null,
        mime;

    meta = meta || {};
    mime = meta.mime;

    if (ufile && curmime !== mime) {
        fstack_rmtop(self);
    }
    if (mime && (!self._mime_valid || curmime !== mime)) {
        mergeattr(self, meta, ["_mime_valid", "mtime", "size", "readable"]);
        var mh = VFS.lookup_media_handler(mime) ||
            VFS.lookup_media_handler('application/octet-stream');
        var mf = new mh.handler(self, meta);
        fstack_addtop(self, mf);
        return mf.update(meta, opts, cb);
    }
    mergeattr(self, meta, ["mtime", "size", "readable"]);
    return File.prototype.update.call(self, meta, opts, cb);
};

/*
 * Retrieve file metadata and update file
 */

HttpFile.prototype.stat = function(opts, cb) {
    var self = this;
    self.getmeta(opts, ef(cb, function(meta) {
        self.update(meta, opts, cb);
    }));
};

/*
 * Retrieve file's 'data'.
 *
 * Options supported:
 *
 * range: { off: <offset>, len: <len>}
 * This will insert a range header in the GET request. The response might
 * either be the full file or the desired range. We supply the returned range
 * {off: <offset>, len: <len>, size: <size>} as the third parameter of the
 * response callback. All units are in bytes.
 *
 * Naive callers can get away with supplying an empty options, ignoring the
 * returned range, and assuming that they got the whole object.
 *
 * type: "text" | "blob"
 * Retrieve data as text or blob. Defaults to blob.
 */

HttpFile.prototype.getdata = function(opts, cb) {
    var self = this,
        gopts = $.extend({}, opts),
        range = gopts.range,
        uri = opts.uri || self.ident;

    gopts["responseType"] = gopts["type"] || "blob";
    delete gopts["type"];

    if (range) {
        var offstart = range.off.toString(),
            offend = (range.len === -1) ? '' : (range.off + range.len - 1).toString();
        gopts.headers = $.extend({}, gopts.headers, {'Range':
            sprintf('bytes=%s-%s', offstart, offend)});
        delete gopts["range"];
    }

    self.fs.tx.GET(uri, gopts, ef(cb, function(res) {
        var data = res.response,
            headers = header_dict(res),
            range = {};

        if (data instanceof Blob) {
            range = {off: -1, len: data.size, size: -1};
            data.href = uri;
        } else if (isstring(data)) {
            range = {off: -1, len: data.length, size: -1};
        }
        if (headers['content-range']) {
            var m = headers['content-range'].match(/bytes\s+(\d+)-(\d+)\/(\d+)/);
            if (m) {
                range = {off: parseInt(m[1], 10), size: parseInt(m[3], 10)};
                range.len = parseInt(m[2], 10) - range.off + 1;
            }
        }
        return cb(null, data, range);
    }));
};

/*
 * Retrieve file's 'data', but ensure that its mime-type is correct and stable
 * before doing so by forcing a stat() if necessary.
 */

HttpFile.prototype.read = function(opts, cb) {
    var self = this;

    if (!self._mime_valid) {
        /*
         * Mime types generated during a readdir may be speculative, based on
         * file extensions and so on. When we actually want to read a file,
         * force a stat so we're sure we've got the right mime type and
         * media handler, and switch if necessary.
         */
        self.stat(opts, ef(cb, function(res) {
            return res.getdata(opts, cb);
        }));
    } else {
        return self.getdata(opts, cb);
    }
};

/* Only generic, well-known attributes are returned. */
HttpFile.prototype._process_headers = function(xhr_headers) {
    var headers = xhr_headers || {},
        data = {},
        mime = xhr_getmime(headers),
        redirect = headers['x-psty-location'];

    if (redirect) {
        data.redirect_url = redirect;
    }

    if (headers['last-modified']) {
        data.mtime = Date.parse(headers['last-modified']);
    }
    if (mime !== null) {
        data.mime = mime;
        data._mime_valid = true;
    }
    if (headers['content-length']) {
        data.size = parseInt(headers['content-length'], 10);
    }
    data.readable = true;

    return data;
};

HttpFile.prototype._reset = function() {
    var self = this,
        file = new self.constructor({'ident': this.ident, 'name': this.name, 'fs': this.fs, 'mtime': this.mtime});
    for (var key in this) {
        delete this[key];
    }
    mixin(this, file);
};

var MediaHandler = function(file, meta) {
    MediaHandler.base.call(this, {});

    this.ident = file.ident;
    this.name = file.name;
    this.fs = file.fs;
    this.mime = meta ? meta.mime : undefined;
    this.html = sprintf('<div class="pfile"><a href="%s" target="_blank">{{name}}</a></div>', this.ident);
};

inherit(MediaHandler, File);

MediaHandler.prototype.append = fstack_passthrough("append");

MediaHandler.prototype.update = function(meta, opts, cb) {
    var self = this;

    mergeattr(self, meta, ["mtime", "ctime", "owner", "readable", "writable", "size"]);
    return File.prototype.update.call(self, meta, opts, cb);
};

/*
 * Options taken from base FS:
 * * html_nodir: will treat text/html as plain file
 */

var TextHtml = function(file, meta) {
    TextHtml.base.apply(this, arguments);
    this.mime = "text/html";
    this.html = sprintf('<div class="pfolder"><a href="%s" target="_blank">{{name}}</a></div>', this.ident);
    if (this.fs === undefined) {
        console.log('undefined fs');
    }
    if (!this.fs.opts.html_nodir) {
        this.files = {};
        this.populated = false;
        this.readdir = this._readdir;
        if (meta.mime !== 'text/vnd.pigshell.html+dir') {
            this._nodescend = true;
        }
    }
};

inherit(TextHtml, MediaHandler);

TextHtml.prototype._readdir = function(opts, cb) {
    var self = this;

    if (self.populated) {
        return cb(null, fstack_topfiles(self.files));
    }
    function makefiles(str) {
        /* Magic formula to prevent images loading by mere act of parsing */
        var str2 = str.replace(/(<img[^>]+)src=([^>]+>)/ig, '$1href=$2'),
            dom = $(str2),
            filter = self.fs.opts.html_filter || "a, img",
            alist = $(filter, dom),
            flist = [],
            base = URI.parse(self.redirect_url || self.ident),
            seen = {};

        alist.each(function(i, e) {
            var el = $(e),
                href = el.attr("href"),
                name = el.text().trim(),
                title = el.attr("title"),
                alt = el.attr("alt"),
                u = href ? URI.parse(href) : null,
                img = el.is("img");

            if (!u) {
                return;
            }
            if (!u.isAbsolute()) {
                href = base.resolve(u);
            }
            if (seen[href.toString()]) {
                return;
            }
            seen[href.toString()] = true;
            name = img ? basenamedir(href) : title || name || basenamedir(href);
            var file = {
                title: name,
                ident: href
            };
            if (img) {
                file.mime = 'image/unknown';
            } else if (href[href.length - 1] === '/') {
                file.mime = 'text/vnd.pigshell.html+dir';
            } else {
                file.mime = getMimeFromExtension(href) || 'text/html';
            }

            flist.push(file);
        });
        flist = unique_names(flist);
        async.forEachSeries(flist, function(el, lcb) {
            VFS.lookup_uri(el.ident, { meta: {'name': el.name,
                'mime': el.mime, 'mtime': self.mtime, 'readable': true} },
                function(err, res) {
                if (!err) {
                    self.files[res.name] = fstack_base(res);
                }
                return lcb(null);
            });
        }, function(err) {
            self.populated = true;
            return cb(null, fstack_topfiles(self.files));
        });
    }

    self.read({context: opts.context, type: "text"}, ef(cb, function(res) {
        return makefiles(res);
    }));
};

TextHtml.prototype.update = function(meta, opts, cb) {
    var self = this;

    if (meta.mtime !== undefined && self.mtime !== meta.mtime) {
        self.populated = false;
        self.files = {};
    }
    mergeattr(self, meta, ["mtime", "owner", "readable", "writable", "size"]);
    return File.prototype.update.call(self, meta, opts, cb);
};

TextHtml.prototype.bundle = function(opts, cb) {
    var self = this;

    function do_dump(str) {
        var $ = $$.load(str),
            data = {},
            rsrc = {},
            base = URI.parse(self.redirect_url || self.ident),
            elist = $('link, img, script').toArray();

        var dotmeta = {
            'mime': 'text/html',
            'mtime': self.mtime,
            'origin': self.redirect_url || self.ident,
            'meta': { 'type': 'object',
                        'value': {
                            'mime': 'text/html',
                            'mtime': self.mtime
                        }
                    }
        };
        async.forEachSeries(elist, function(el, lcb) {
            var e = $(el),
                ua = e.is('link') ? 'href' : 'src',
                a = e.attr(ua),
                aobj = this;
             
            if (a) {
                var uri = base.resolve(a),
                    turi = URI.parse(a),
                    tname;
                turi.setQuery('').setFragment('');
                tname = turi.toString().replace(/\//g, '_');

                VFS.lookup_uri(uri, {}, function(err, res) {
                    if (!err) {
                        rsrc[tname] = res;
                        e.attr(ua, '.rsrc/' + a.replace(/\//g, '_'));
                    }
                    return soguard(self, lcb.bind(aobj, null));
                });
            } else {
                return soguard(self, lcb.bind(aobj, null));
            }
        }, function(err) {
            if (Object.keys(rsrc).length) {
                data['.rsrc'] = rsrc;
                dotmeta['data'] = { 'type': 'file',
                    'value': self.name
                };
                data['.meta'] = JSON.stringify(dotmeta, null, "  ");
                data[self.name] = $.html();
            } else {
                data = str;
            }
            return cb(null, data);
        });
    }

    self.read({context: opts.context, type: "text"}, ef(cb, function(res) {
        return do_dump(res);
    }));
};

pigshell.HttpFS = HttpFS;

VFS.register_uri_handler('http', HttpFS, {}, 10);
VFS.register_uri_handler('https', HttpFS, {}, 10);

VFS.register_media_handler('text/html', TextHtml, {}, 100);
VFS.register_media_handler('text/vnd.pigshell.html+dir', TextHtml, {}, 100);
VFS.register_media_handler('application/octet-stream', MediaHandler, {}, 100);
