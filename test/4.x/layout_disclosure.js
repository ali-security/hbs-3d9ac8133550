// @see https://securitylab.github.com/advisories/GHSL-2021-020-pillarjs-hbs/ (CVE-2021-32822)

'use strict'

var assert = require('assert')
var fs = require('fs')
var os = require('os')
var path = require('path')
var request = require('supertest')
var rimraf = require('rimraf')
var utils = require('../support/utils')

var SECRET_SOURCE = 'SECRET-SOURCE-CVE-2021-32822'
var SECRET_TEMPLATE = 'SECRET-TEMPLATE-CVE-2021-32822'
var SECRET_VIEWS_SOURCE = 'SECRET-VIEWS-SOURCE-CVE-2021-32822'
var OUTSIDE_LAYOUT = 'OUTSIDE-LAYOUT-CVE-2021-32822'
var REJECTED_LAYOUT = /layout must be a template inside the views directory/

var app = null
var hbs = null
var tmpDir = null
var viewsDir = null

before(function () {
  if (utils.nodeVersionCompare(0.10) < 0) {
    this.skip()
    return
  }

  // fs.mkdtempSync (Node >= 5.10) and os.tmpdir (Node >= 0.10) are not
  // available on every version in the CI matrix, so build the path by hand.
  var tmpBase = (os.tmpdir || os.tmpDir)()
  tmpDir = path.join(tmpBase, 'hbs-layout-disclosure-' + process.pid + '-' + Date.now())
  viewsDir = path.join(tmpDir, 'views')
  fs.mkdirSync(tmpDir)
  fs.mkdirSync(viewsDir)

  // files outside of the views directory
  fs.writeFileSync(path.join(tmpDir, 'secret.js'), 'module.exports = "' + SECRET_SOURCE + '"\n')
  fs.writeFileSync(path.join(tmpDir, 'secret.hbs'), SECRET_TEMPLATE + '{{{body}}}')
  fs.writeFileSync(path.join(tmpDir, 'layout.hbs'), OUTSIDE_LAYOUT + '{{{body}}}')

  // files inside of the views directory
  fs.writeFileSync(path.join(viewsDir, 'index.hbs'), 'index body')
  fs.writeFileSync(path.join(viewsDir, 'layout.hbs'), '<main>{{{body}}}</main>')
  fs.writeFileSync(path.join(viewsDir, 'alternate.hbs'), '<section>{{{body}}}</section>')
  fs.writeFileSync(path.join(viewsDir, 'app.js'), 'module.exports = "' + SECRET_VIEWS_SOURCE + '"\n')

  var express = require('express')

  hbs = require('../../').create()

  app = express()
  app.engine('hbs', hbs.__express)
  app.set('view engine', 'hbs')
  app.set('views', viewsDir)

  // vulnerable pattern from GHSL-2021-020: user input used as render options
  app.get('/', function (req, res) {
    res.render('index', req.query)
  })

  app.use(function (err, req, res, next) {
    res.statusCode = 500
    res.end(String(err.message))
  })
})

after(function (done) {
  if (!tmpDir) return done()
  rimraf(tmpDir, done)
})

test('CVE-2021-32822: settings[views] override is ignored for the default layout', function (done) {
  request(app)
    .get(query({ 'settings[views]': tmpDir }))
    .expect(200)
    .expect(shouldNotDisclose(OUTSIDE_LAYOUT))
    .expect('<main>index body</main>')
    .end(done)
})

test('CVE-2021-32822: settings[views] and settings[view options][layout] cannot disclose a source file', function (done) {
  request(app)
    .get(query({ 'settings[views]': tmpDir, 'settings[view options][layout]': 'secret.js' }))
    .expect(500)
    .expect(shouldNotDisclose(SECRET_SOURCE))
    .expect(REJECTED_LAYOUT)
    .end(done)
})

test('CVE-2021-32822: settings[views] and settings[view options][layout] cannot render a template outside the views directory', function (done) {
  request(app)
    .get(query({ 'settings[views]': tmpDir, 'settings[view options][layout]': 'secret' }))
    .expect(500)
    .expect(shouldNotDisclose(SECRET_TEMPLATE))
    .expect(/ENOENT/)
    .end(done)
})

test('CVE-2021-32822: advisory PoC with relative settings[views] and layout cannot disclose package.json', function (done) {
  request(app)
    .get(query({ 'settings[views]': '.', 'settings[view options][layout]': 'package.json' }))
    .expect(500)
    .expect(shouldNotDisclose('"name": "hbs"'))
    .expect(REJECTED_LAYOUT)
    .end(done)
})

test('CVE-2021-32822: layout cannot traverse to a source file outside the views directory', function (done) {
  request(app)
    .get(query({ layout: '../secret.js' }))
    .expect(500)
    .expect(shouldNotDisclose(SECRET_SOURCE))
    .expect(REJECTED_LAYOUT)
    .end(done)
})

test('CVE-2021-32822: layout cannot traverse to a template outside the views directory', function (done) {
  request(app)
    .get(query({ layout: '../secret' }))
    .expect(500)
    .expect(shouldNotDisclose(SECRET_TEMPLATE))
    .expect(REJECTED_LAYOUT)
    .end(done)
})

test('CVE-2021-32822: layout cannot traverse through a nested path', function (done) {
  request(app)
    .get(query({ layout: 'partials/../../secret.hbs' }))
    .expect(500)
    .expect(shouldNotDisclose(SECRET_TEMPLATE))
    .expect(REJECTED_LAYOUT)
    .end(done)
})

test('CVE-2021-32822: settings[view options][layout] cannot traverse outside the views directory', function (done) {
  request(app)
    .get(query({ 'settings[view options][layout]': '../secret' }))
    .expect(500)
    .expect(shouldNotDisclose(SECRET_TEMPLATE))
    .expect(REJECTED_LAYOUT)
    .end(done)
})

test('CVE-2021-32822: layout cannot be a non-template file inside the views directory', function (done) {
  request(app)
    .get(query({ layout: 'app.js' }))
    .expect(500)
    .expect(shouldNotDisclose(SECRET_VIEWS_SOURCE))
    .expect(REJECTED_LAYOUT)
    .end(done)
})

test('CVE-2021-32822: absolute layout path is resolved inside the views directory', function (done) {
  request(app)
    .get(query({ layout: path.join(tmpDir, 'secret') }))
    .expect(500)
    .expect(shouldNotDisclose(SECRET_TEMPLATE))
    .end(done)
})

test('CVE-2021-32822: default layout inside the views directory still applies', function (done) {
  request(app)
    .get('/')
    .expect(200)
    .expect('<main>index body</main>')
    .end(done)
})

test('CVE-2021-32822: layout inside the views directory is still allowed', function (done) {
  request(app)
    .get(query({ layout: 'alternate' }))
    .expect(200)
    .expect('<section>index body</section>')
    .end(function (err) {
      if (err) return done(err)
      request(app)
        .get(query({ layout: 'alternate.hbs' }))
        .expect(200)
        .expect('<section>index body</section>')
        .end(done)
    })
})

test('CVE-2021-32822: direct engine call rejects a layout outside the views directory', function (done) {
  hbs.__express(path.join(viewsDir, 'index.hbs'), {
    settings: {
      views: viewsDir,
      'view options': { layout: '../secret' }
    }
  }, function (err, out) {
    assert.ok(err, 'expected an error, got: ' + out)
    assert.ok(REJECTED_LAYOUT.test(err.message), err.message)
    done()
  })
})

test('CVE-2021-32822: direct engine call rejects a non-template layout', function (done) {
  hbs.__express(path.join(viewsDir, 'index.hbs'), {
    layout: 'app.js',
    settings: { views: viewsDir }
  }, function (err, out) {
    assert.ok(err, 'expected an error, got: ' + out)
    assert.ok(REJECTED_LAYOUT.test(err.message), err.message)
    done()
  })
})

test('CVE-2021-32822: direct engine call still renders a layout inside the views directory', function (done) {
  hbs.__express(path.join(viewsDir, 'index.hbs'), {
    layout: 'alternate',
    settings: { views: viewsDir }
  }, function (err, out) {
    if (err) return done(err)
    assert.strictEqual(out, '<section>index body</section>')
    done()
  })
})

function query (params) {
  return '/?' + Object.keys(params).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key])
  }).join('&')
}

function shouldNotDisclose (secret) {
  return function (res) {
    assert.ok(res.text.indexOf(secret) === -1, 'expected response not to disclose file contents, got: ' + res.text)
  }
}
