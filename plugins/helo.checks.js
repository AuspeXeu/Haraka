// Check various bits of the HELO string
var net_utils = require('./net_utils');

var checks = [
    'init',               // config loading, multiplicity detection
    'no_dot',             // HELO has no "dot" in hostname
    'match_re',           // List of regexps
    'bare_ip',            // HELO is bare IP (vs required Address Literal)
    'dynamic',            // HELO looks dynamic (dsl|dialup|etc...)
    'big_company',        // Well known HELOs that must match rdns
    'literal_mismatch',   // IP literal that doesn't match remote IP
    'valid_tld',          // hostname has a valid TLD
    'rdns_match',         // hostname matches rDNS
    'mismatch',           // hostname differs between invocations
];

exports.register = function () {
    var plugin = this;

    for (var i=0; i < checks.length; i++) {
        var hook = checks[i];
        plugin.register_hook('helo', hook);
        plugin.register_hook('ehlo', hook);
    }
};

exports.hook_connect = function (next, connection) {
    var plugin = this;
    plugin.cfg = plugin.config.get('helo.checks.ini', {
        booleans: [
            '+check.no_dot',
            '+check.match_re',
            '+check.bare_ip',
            '+check.dynamic',
            '+check.big_company',
            '+check.valid_tld',
            '+check.rdns_match',
            '+check.mismatch',

            '+reject.no_dot',
            '+reject.bare_ip',
            '+reject.dynamic',
            '+reject.big_company',
            '-reject.literal_mismatch',
            '-reject.valid_tld',
            '-reject.rdns_match',
            '-reject.mismatch',

            '+skip.private_ip',
            '+skip.whitelist',
            '+skip.relaying',
        ],
    });

    // backwards compatible with old config file
    if (plugin.cfg.check_no_dot !== undefined) {
        plugin.cfg.check.no_dot = plugin.cfg.check_no_dot ? true : false;
    }
    if (plugin.cfg.check_dynamic !== undefined) {
        plugin.cfg.check.dynamic = plugin.cfg.check_dynamic ? true : false;
    }
    if (plugin.cfg.check_raw_ip !== undefined) {
        plugin.cfg.check.bare_ip = plugin.cfg.check_raw_ip ? true : false;
    }

    return next();
};

exports.init = function (next, connection, helo) {
    var plugin = this;

    var hc = connection.results.get('helo.checks');
    if (!hc) {     // first HELO result
        connection.results.add(plugin, {helo_host: helo});
        return next();
    }

    // we've been here before
    connection.results.add(plugin, {multi: true});

    return next();
};

exports.should_skip = function (connection, test_name) {
    var plugin = this;

    var hc = connection.results.get('helo.checks');
    if (hc && hc.multi && test_name !== 'mismatch') return true;

    if (!plugin.cfg.check[test_name]) {
        connection.results.add(plugin, {skip: test_name + '(config)'});
        return true;
    }

    if (plugin.cfg.skip.relaying && connection.relaying) {
        connection.results.add(plugin, {skip: test_name + '(relay)'});
        return true;
    }

    if (plugin.cfg.skip.private_ip && net_utils.is_rfc1918(connection.remote_ip)) {
        connection.results.add(plugin, {skip: test_name + '(private)'});
        return true;
    }

    return false;
};

exports.mismatch = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'mismatch')) return next();

    var prev_helo = connection.results.get('helo.checks').helo_host;
    if (!prev_helo) {
        connection.results.add(plugin, {skip: 'mismatch(1st)'});
        return next();
    }

    if (prev_helo === helo) {
        connection.results.add(plugin, {pass: 'mismatch'});
        return next();
    }

    var msg = 'mismatch(' + prev_helo + ' / ' + helo + ')';
    connection.results.add(plugin, {fail: msg});
    if (plugin.cfg.reject.mismatch) return next(DENY, 'HELO host ' + msg);

    return next();
};

exports.no_dot = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'no_dot')) return next();

    if (!/\./.test(helo)) {
        connection.results.add(plugin, {fail: 'no_dot'});
        if (plugin.cfg.reject.no_dot) return next(DENY, 'HELO must have a dot');
    }
    else {
        connection.results.add(plugin, {pass: 'no_dot'});
    }

    return next();
};

exports.match_re = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'match_re')) return next();

    var regexps = plugin.config.get('helo.checks.regexps', 'list');

    var fail=0;
    for (var i=0; i < regexps.length; i++) {
        var re = new RegExp('^' + regexps[i] + '$');
        if (re.test(helo)) {
            connection.results.add(plugin, {fail: 'match_re(' + regexps[i] + ')'});
            fail++;
        }
    }
    if (fail && plugin.cfg.reject.match_re) return next(DENY, "BAD HELO");
    if (!fail) connection.results.add(plugin, {pass: 'match_re'});
    return next();
};

exports.rdns_match = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'rdns_match')) return next();

    if (!helo) {
        connection.results.add(plugin, {fail: 'rdns_match(empty)'});
        return next();
    }

    if (helo.match(/^\[(?:[0-9\.]+)\]$/)) {
        connection.results.add(plugin, {fail: 'rdns_match(literal)'});
        return next();
    }

    var r_host = connection.remote_host;
    if (r_host && helo === r_host) {
        connection.results.add(plugin, {pass: 'rdns_match(exact)'});
        return next();
    }

    if (net_utils.get_organizational_domain(r_host) ===
        net_utils.get_organizational_domain(helo)) {
        connection.results.add(plugin, {pass: 'rdns_match(org_dom)'});
        return next();
    }

    connection.results.add(plugin, {fail: 'rdns_match'});
    if (plugin.cfg.reject.rdns_match) {
        return next(DENY, 'HELO host does not match rDNS');
    }
    return next();
};

exports.bare_ip = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'bare_ip')) return next();

    // RFC 2821, 4.1.1.1  Address literals must be in brackets
    // RAW IPs must be formatted: "[1.2.3.4]" not "1.2.3.4" in HELO
    if(/^\d+\.\d+\.\d+\.\d+$/.test(helo)) {
        connection.results.add(plugin, {fail: 'bare_ip(invalid literal)'});
        if (plugin.cfg.reject.bare_ip) return next(DENY, "Invalid address format in HELO");
        return next();
    }

    connection.results.add(plugin, {pass: 'bare_ip'});
    return next();
};

exports.dynamic = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'dynamic')) return next();

    // Skip if no dots or an IP literal or address
    if (!/\./.test(helo)) {
        connection.results.add(plugin, {skip: 'dynamic(no dots)'});
        return next();
    }

    if (/^\[?\d+\.\d+\.\d+\.\d+\]?$/.test(helo)) {
        connection.results.add(plugin, {skip: 'dynamic(literal)'});
        return next();
    }

    if (net_utils.is_ip_in_str(connection.remote_ip, helo)) {
        connection.results.add(plugin, {fail: 'dynamic'});
        if (plugin.cfg.reject.dynamic) return next(DENY, 'HELO is dynamic');
        return next();
    }

    connection.results.add(plugin, {pass: 'dynamic'});
    return next();
};

exports.big_company = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'big_company')) return next();

    var rdns = connection.remote_host;
    if (!rdns || rdns === 'Unknown' || rdns === 'DNSERROR') {
        connection.results.add(plugin, {fail: 'big_co(rDNS)'});
        if (plugin.cfg.reject.big_company) {
            return next(DENY, "Big company w/o rDNS? Unlikely.");
        }
        return next();
    }

    if (!plugin.cfg.bigco) {
        connection.results.add(plugin, {err: 'big_co(config missing)'});
        return next();
    }
    if (!plugin.cfg.bigco[helo]) {
        connection.results.add(plugin, {skip: 'big_co(config)'});
        return next();
    }

    var allowed_rdns = plugin.cfg.bigco[helo].split(/,/);
    for (var i=0; i < allowed_rdns.length; i++) {
        var re = new RegExp(allowed_rdns[i].replace(/\./g, '\\.') + '$');
        if (re.test(rdns)) {
            connection.results.add(plugin, {pass: 'big_co'});
            return next();
        }
    }

    connection.results.add(plugin, {fail: 'big_co'});
    if (plugin.cfg.reject.big_company) {
        return next(DENY, "You are not who you say you are");
    }
    return next();
};

exports.literal_mismatch = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'literal_mismatch')) return next();

    var literal = /^\[(\d+\.\d+\.\d+\.\d+)\]$/.exec(helo);
    if (!literal) {
        connection.results.add(plugin, {pass: 'literal_mismatch'});
        return next();
    }

    if (parseInt(plugin.cfg.check.literal_mismatch) === 2) {
        // Only match the /24
        if (literal[1].split(/\./).splice(0,3).join('.') !==
            connection.remote_ip.split(/\./).splice(0,3).join('.'))
        {
            connection.results.add(plugin, {fail: 'literal_mismatch'});
            if (plugin.cfg.reject.literal_mismatch) {
                return next(DENY, 'HELO IP literal not in the same /24 as your IP address');
            }
            return next();
        }
        connection.results.add(plugin, {pass: 'literal_mismatch'});
        return next();
    }

    if (literal[1] !== connection.remote_ip) {
        connection.results.add(plugin, {pass: 'literal_mismatch'});
        if (plugin.cfg.reject.literal_mismatch) return next(DENY, 'HELO IP literal does not match your IP address');
        return next();
    }

    connection.results.add(plugin, {pass: 'literal_mismatch'});
    return next();
};

exports.valid_tld = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'valid_tld')) return next();

    if (/^\[\d+\.\d+\.\d+\.\d+\]$/.test(helo)) {
        connection.results.add(plugin, {skip: 'valid_tld(literal)'});
        return next();
    }

    var tld = (helo.split(/\./).reverse())[0];
    if (net_utils.is_public_suffix(tld)) {
        connection.results.add(plugin, {pass: 'valid_tld'});
        return next();
    }

    connection.results.add(plugin, {fail: 'valid_tld('+tld+')'});
    if (plugin.cfg.reject.valid_tld) {
        return next(DENY, "HELO must have a valid TLD");
    }
    return next();
};
