// an abstraction that implements all of the cookie handling, CSRF protection,
// etc of the wsapi.  This module also routes request to the approriate handlers
// underneath wsapi/
//
// each handler under wsapi/ supports the following exports:
//   exports.process - function(req, res) - process a request
//   exports.writes_db - must be true if the processing causes a database write
//   exports.method - either 'get' or 'post'
//   exports.authed - whether the wsapi requires authentication
//   exports.args - an array of arguments that should be verified


const
sessions = require('connect-cookie-session'),
express = require('express');
secrets = require('./secrets'),
config = require('./configuration'),
logger = require('./logging.js').logger,
httputils = require('./httputils.js'),
url = require('url'),
fs = require('fs'),
path = require('path'),
validate = require('./validate'),
bcrypt = require('bcrypt');

const COOKIE_SECRET = secrets.hydrateSecret('browserid_cookie', config.get('var_path'));
const COOKIE_KEY = 'browserid_state';

function clearAuthenticatedUser(session) {
  Object.keys(session).forEach(function(k) {
    if (k !== 'csrf') delete session[k];
  });
}

function isAuthed(req) {
  var who;
  try {
    if (req.session.authenticatedUser) {
      if (!Date.parse(req.session.authenticatedAt) > 0) throw "bad timestamp";
      if (new Date() - new Date(req.session.authenticatedAt) >
          config.get('authentication_duration_ms'))
      {
        throw "expired";
      }
      who = req.session.authenticatedUser;
    }
  } catch(e) {
    logger.debug("Session authentication has expired:", e);
    clearAuthenticatedUser(req.session);
  }

  return who;
}

function bcryptPassword(password, cb) {
  var bcryptWorkFactor = config.get('bcrypt_work_factor');

  bcrypt.gen_salt(bcryptWorkFactor, function (err, salt) {
    if (err) {
      var msg = "error generating salt with bcrypt: " + err;
      logger.error(msg);
      return cb(msg);
    }
    bcrypt.encrypt(password, salt, function(err, hash) {
      if (err) {
        var msg = "error generating password hash with bcrypt: " + err;
        logger.error(msg);
        return cb(msg);
      }
      return cb(undefined, hash);
    });
  });
};

function setAuthenticatedUser(session, email) {
  session.authenticatedUser = email;
  session.authenticatedAt = new Date();
}

// common functions exported, for use by different api calls
exports.clearAuthenticatedUser = clearAuthenticatedUser;
exports.isAuthed = isAuthed;
exports.bcryptPassword = bcryptPassword;
exports.setAuthenticatedUser = setAuthenticatedUser;

exports.setup = function(options, app) {

  // XXX: we can and should make all of the logic below only take effect for POST requests
  // to /wsapi to reduce code run for other requests (cookie parsing, etc)

  // If externally we're serving content over SSL we can enable things
  // like strict transport security and change the way cookies are set
  const overSSL = (config.get('scheme') == 'https');

  app.use(express.cookieParser());

  var cookieSessionMiddleware = sessions({
    secret: COOKIE_SECRET,
    key: COOKIE_KEY,
    cookie: {
      path: '/wsapi',
      httpOnly: true,
      // IMPORTANT: we allow users to go 1 weeks on the same device
      // without entering their password again
      maxAge: config.get('authentication_duration_ms'),
      secure: overSSL
    }
  });

  // cookie sessions && cache control
  app.use(function(req, resp, next) {
    // cookie sessions are only applied to calls to /wsapi
    // as all other resources can be aggressively cached
    // by layers higher up based on cache control headers.
    // the fallout is that all code that interacts with sessions
    // should be under /wsapi
    if (/^\/wsapi/.test(req.url)) {
      // explicitly disallow caching on all /wsapi calls (issue #294)
      resp.setHeader('Cache-Control', 'no-cache, max-age=0');

      // we set this parameter so the connect-cookie-session
      // sends the cookie even though the local connection is HTTP
      // (the load balancer does SSL)
      if (overSSL)
        req.connection.proxySecure = true;

      return cookieSessionMiddleware(req, resp, next);

    } else {
      return next();
    }
  });

  app.use(express.bodyParser());

  // Check CSRF token early.  POST requests are only allowed to
  // /wsapi and they always must have a valid csrf token
  app.use(function(req, resp, next) {
    // only on POSTs
    if (req.method == "POST") {
      var denied = false;
      if (!/^\/wsapi/.test(req.url)) { // post requests only allowed to /wsapi
        denied = true;
        logger.warn("CSRF validation failure: POST only allowed to /wsapi urls.  not '" + req.url + "'");
      }

      else if (req.session === undefined) { // there must be a session
        denied = true;
        logger.warn("CSRF validation failure: POST calls to /wsapi require an active session");
      }

      // the session must have a csrf token
      else if (typeof req.session.csrf !== 'string') {
        denied = true;
        logger.warn("CSRF validation failure: POST calls to /wsapi require an csrf token to be set");
      }

      // and the token must match what is sent in the post body
      else if (req.body.csrf != req.session.csrf) {
        denied = true;
        // if any of these things are false, then we'll block the request
        logger.warn("CSRF validation failure, token mismatch. got:" + req.body.csrf + " want:" + req.session.csrf);
      }

      if (denied) return httputils.badRequest(resp, "CSRF violation");

    }
    return next();
  });

  const WSAPI_PREFIX = '/wsapi/';

  // load all of the APIs supported by this process
  var wsapis = { };

  logger.debug("registering WSAPIs:");
  fs.readdirSync(path.join(__dirname, 'wsapi')).forEach(function (f) {
    // skip files that don't have a .js suffix or start with a dot
    if (f.length <= 3 || f.substr(-3) !== '.js' || f.substr(0,1) === '.') return;
    var operation = f.substr(0, f.length - 3);

    try {
      var api = require(path.join(__dirname, 'wsapi', f));

      // don't register read apis if we are configured as a writer
      if (options.only_write_apis && !api.writes_db) return;

      // XXX forward writes if options.forward_writes is defined

      wsapis[operation] = api;

      // set up the argument validator
      if (api.args) {
        if (!Array.isArray(api.args)) throw "exports.args must be an array of strings";
        wsapis[operation].validate = validate(api.args);
      } else {
        wsapis[operation].validate = function(req,res,next) { next(); };
      }

    } catch(e) {
      var msg = "error registering " + operation + " api: " + e;
      logger.error(msg);
      throw msg;
    }

    logger.debug('  ' + operation);

  });

  app.use(function(req, resp, next) {
    var purl = url.parse(req.url);

    if (purl.pathname.substr(0, WSAPI_PREFIX.length) === WSAPI_PREFIX) {
      const operation = purl.pathname.substr(WSAPI_PREFIX.length);
      if (wsapis.hasOwnProperty(operation) &&
          wsapis[operation].method.toLowerCase() === req.method.toLowerCase()) {

        // does the request require authentication?
        if (wsapis[operation].authed && !isAuthed(req)) {
          return httputils.badRequest(resp, "requires authentication");
        }

        // validate the arguments of the request
        wsapis[operation].validate(req, resp, function() {
          wsapis[operation].process(req, resp);
        });
      } else {
        return httputils.badRequest(resp, "no such api");
      }

    } else {
      next();
    }
  });
};
