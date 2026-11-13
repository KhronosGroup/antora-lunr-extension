/* eslint-env mocha */
'use strict'

const { expect } = require('./harness')
const { promises: fsp } = require('fs')
const cheerio = require('cheerio')
const ospath = require('path')

const FIXTURES_DIR = ospath.join(__dirname, 'fixtures')
const WORK_DIR = ospath.join(__dirname, 'work')
const pako = require('pako')

const generateSite = require('@antora/site-generator')

describe('generateSite()', () => {
  const cacheDir = ospath.join(WORK_DIR, '.cache/antora')
  const outputDir = ospath.join(WORK_DIR, 'public')
  const defaultPlaybookFile = ospath.join(
    FIXTURES_DIR,
    'docs-site/antora-playbook.yml'
  )
  const playbookFileWithCustomSupplementalUi = ospath.join(
    FIXTURES_DIR,
    'docs-site',
    'antora-playbook-with-custom-supplemental-ui.yml'
  )

  beforeEach(() => fsp.rm(outputDir, { recursive: true, force: true }))
  after(() => fsp.rm(WORK_DIR, { recursive: true, force: true }))

  it('should generate a site with a search index', async () => {
    const env = {}
    await generateSite(
      [
        '--playbook',
        defaultPlaybookFile,
        '--to-dir',
        outputDir,
        '--cache-dir',
        cacheDir,
        '--quiet',
      ],
      env
    )
    expect(env).to.not.have.property('SITE_SEARCH_PROVIDER')
    const searchIndexPath = ospath.join(outputDir, 'search-index.js')
    expect(searchIndexPath).to.be.a.file()
    const mdDocsDir = ospath.join(outputDir, 'site-docs')
    expect(mdDocsDir).to.be.a.directory()
    // Check that at least one markdown file exists in the directory
    const mdFiles = await fsp.readdir(mdDocsDir)
    expect(mdFiles.length).to.be.greaterThan(0)
    // eslint-disable-next-line no-unused-expressions
    expect(mdFiles.some((file) => file.endsWith('.md'))).to.be.true
    global.lunr = {}
    global.antoraSearch = {}
    global.antoraSearch.initSearch = function (lunr, index, _) {
      index = atob(index)
      index = index.split('').map((c) => c.charCodeAt(0))
      index = pako.inflate(index, { to: 'string' })
      index = JSON.parse(index)
      expect(Object.keys(index.store.documents).length).to.equal(2)
      expect(
        Object.entries(index.store.documents).map(([key, value]) => ({
          title: value.title,
          url: value.url,
        }))
      ).to.deep.include.members([
        {
          title: 'Antora x Lunr',
          url: '/antora-lunr/index.html',
        },
        {
          title: 'Page Title',
          url: '/antora-lunr/named-module/the-page.html',
        },
      ])
    }
    require(searchIndexPath)
    delete global.lunr
    delete global.antoraSearch
  })

  it('should insert script element with predefined data attributes', async () => {
    await generateSite(
      [
        '--playbook',
        defaultPlaybookFile,
        '--to-dir',
        outputDir,
        '--cache-dir',
        cacheDir,
        '--quiet',
      ],
      {}
    )
    const startPageContents = await fsp.readFile(
      ospath.join(outputDir, 'antora-lunr/index.html')
    )
    let $ = cheerio.load(startPageContents)
    expect($('#search-input')).to.have.lengthOf(1)
    let searchScript = $('#search-ui-script')
    expect(searchScript).to.have.lengthOf(1)
    expect(searchScript.attr('data-site-root-path')).to.equal('..')
    expect(searchScript.attr('data-stylesheet')).to.equal('../_/css/search.css')
    expect(searchScript.attr('data-snippet-length')).to.equal('100')
    const thePageContents = await fsp.readFile(
      ospath.join(outputDir, 'antora-lunr/named-module/the-page.html')
    )
    $ = cheerio.load(thePageContents)
    searchScript = $('#search-ui-script')
    expect(searchScript.attr('data-site-root-path')).to.equal('../..')
    expect(searchScript.attr('data-stylesheet')).to.equal(
      '../../_/css/search.css'
    )
  })

  it('should output lunr.js client/engine to js vendor directory of UI output folder', async () => {
    await generateSite(
      [
        '--playbook',
        defaultPlaybookFile,
        '--to-dir',
        outputDir,
        '--cache-dir',
        cacheDir,
        '--quiet',
      ],
      {}
    )
    const expected = ospath.join(outputDir, '_/js/vendor/lunr.js')
    expect(expected)
      .to.be.a.file()
      .and.equal(require.resolve('lunr/lunr.min.js'))
    const thePageContents = await fsp.readFile(
      ospath.join(outputDir, 'antora-lunr/named-module/the-page.html')
    )
    const $ = cheerio.load(thePageContents)
    expect($('script[src="../../_/js/vendor/lunr.js"]').get()).to.have.lengthOf(
      1
    )
  })

  it('should output vendored JS files to multiple destinations', async () => {
    const playbookFile = ospath.join(
      FIXTURES_DIR,
      'docs-site',
      'antora-playbook-with-destinations.yml'
    )
    await generateSite(
      ['--playbook', playbookFile, '--cache-dir', cacheDir, '--quiet'],
      {}
    )
    const expectedA = ospath.join(outputDir, 'a', '_/js/vendor/lunr.js')
    expect(expectedA).to.be.a.file().and.not.empty()
    expect(expectedA)
      .to.be.a.file()
      .and.equal(require.resolve('lunr/lunr.min.js'))
    const expectedB = ospath.join(outputDir, 'b', '_/js/vendor/lunr.js')
    expect(expectedB).to.be.a.file().and.not.empty()
    expect(expectedB)
      .to.be.a.file()
      .and.equal(require.resolve('lunr/lunr.min.js'))
  })

  it('should output language support files to js vendor directory of UI output folder', async () => {
    const playbookFile = ospath.join(
      FIXTURES_DIR,
      'docs-site',
      'antora-playbook-with-languages.yml'
    )
    const env = {}
    await generateSite(
      [
        '--playbook',
        playbookFile,
        '--to-dir',
        outputDir,
        '--cache-dir',
        cacheDir,
        '--quiet',
      ],
      env
    )
    expect(env).to.not.have.property('SITE_SEARCH_LANGUAGES')
    const expectedContents = await Promise.all([
      fsp.readFile(require.resolve('lunr-languages/lunr.stemmer.support.js')),
      fsp.readFile(require.resolve('lunr-languages/lunr.fr.js')),
      fsp.readFile(require.resolve('lunr-languages/lunr.de.js')),
    ]).then(Buffer.concat)
    expect(ospath.join(outputDir, '_/js/vendor/lunr-languages.js'))
      .to.be.a.file()
      .and.have.content(expectedContents.toString())
    const thePageContents = await fsp.readFile(
      ospath.join(outputDir, 'antora-lunr/named-module/the-page.html')
    )
    const $ = cheerio.load(thePageContents)
    expect(
      $('script[src="../../_/js/vendor/lunr-languages.js"]').get()
    ).to.have.lengthOf(1)
    expect(
      $('script[src="../../_/js/vendor/lunr.stemmer.support.js"]').get()
    ).to.have.lengthOf(0)
    expect(
      $('script[src="../../_/js/vendor/lunr.fr.js"]').get()
    ).to.have.lengthOf(0)
  })

  it('should output language support files[ja] to js vendor directory of UI output folder', async () => {
    const playbookFile = ospath.join(
      FIXTURES_DIR,
      'docs-site',
      'antora-playbook-with-languages-ja.yml'
    )
    const env = {}
    await generateSite(
      [
        '--playbook',
        playbookFile,
        '--to-dir',
        outputDir,
        '--cache-dir',
        cacheDir,
        '--quiet',
      ],
      env
    )
    expect(env).to.not.have.property('SITE_SEARCH_LANGUAGES')
    const expectedContents = await Promise.all([
      fsp.readFile(require.resolve('lunr-languages/lunr.stemmer.support.js')),
      fsp.readFile(require.resolve('lunr-languages/tinyseg.js')),
      fsp.readFile(require.resolve('lunr-languages/lunr.ja.js')),
    ]).then(Buffer.concat)
    expect(ospath.join(outputDir, '_/js/vendor/lunr-languages.js'))
      .to.be.a.file()
      .and.have.content(expectedContents.toString())
    const thePageContents = await fsp.readFile(
      ospath.join(outputDir, 'antora-lunr/named-module/the-page.html')
    )
    const $ = cheerio.load(thePageContents)
    expect(
      $('script[src="../../_/js/vendor/lunr.stemmer.support.js"]').get()
    ).to.have.lengthOf(0)
    expect(
      $('script[src="../../_/js/vendor/lunr-languages.js"]').get()
    ).to.have.lengthOf(1)
    expect(
      $('script[src="../../_/js/vendor/tinyseg.js"]').get()
    ).to.have.lengthOf(0)
    expect(
      $('script[src="../../_/js/vendor/lunr.ja.js"]').get()
    ).to.have.lengthOf(0)
  })

  it('should output language support files[th] to js vendor directory of UI output folder', async () => {
    const playbookFile = ospath.join(
      FIXTURES_DIR,
      'docs-site',
      'antora-playbook-with-languages-th.yml'
    )
    const env = {}
    await generateSite(
      [
        '--playbook',
        playbookFile,
        '--to-dir',
        outputDir,
        '--cache-dir',
        cacheDir,
        '--quiet',
      ],
      env
    )
    expect(env).to.not.have.property('SITE_SEARCH_LANGUAGES')
    const expectedContents = await Promise.all([
      fsp.readFile(require.resolve('lunr-languages/lunr.stemmer.support.js')),
      fsp.readFile(require.resolve('lunr-languages/wordcut.js')),
      fsp.readFile(require.resolve('lunr-languages/lunr.th.js')),
    ]).then(Buffer.concat)
    expect(ospath.join(outputDir, '_/js/vendor/lunr-languages.js'))
      .to.be.a.file()
      .and.have.content(expectedContents.toString())
    const thePageContents = await fsp.readFile(
      ospath.join(outputDir, 'antora-lunr/named-module/the-page.html')
    )
    const $ = cheerio.load(thePageContents)
    expect(
      $('script[src="../../_/js/vendor/lunr-languages.js"]').get()
    ).to.have.lengthOf(1)
    expect(
      $('script[src="../../_/js/vendor/lunr.stemmer.support.js"]').get()
    ).to.have.lengthOf(0)
    expect(
      $('script[src="../../_/js/vendor/wordcut.js"]').get()
    ).to.have.lengthOf(0)
    expect(
      $('script[src="../../_/js/vendor/lunr.th.js"]').get()
    ).to.have.lengthOf(0)
  })

  it('should allow extension to configure snippet length', async () => {
    const playbookFile = ospath.join(
      FIXTURES_DIR,
      'docs-site',
      'antora-playbook-with-snippet-length.yml'
    )
    await generateSite(
      [
        '--playbook',
        playbookFile,
        '--to-dir',
        outputDir,
        '--cache-dir',
        cacheDir,
        '--quiet',
      ],
      {}
    )
    const startPageContents = await fsp.readFile(
      ospath.join(outputDir, 'antora-lunr/index.html')
    )
    const searchScript = cheerio.load(startPageContents)('#search-ui-script')
    expect(searchScript.attr('data-snippet-length')).to.equal('250')
  })

  it('should use existing search-scripts.hbs partial if present in UI', async () => {
    await generateSite(
      [
        '--playbook',
        playbookFileWithCustomSupplementalUi,
        '--to-dir',
        outputDir,
        '--cache-dir',
        cacheDir,
        '--quiet',
      ],
      {}
    )
    const startPageContents = await fsp.readFile(
      ospath.join(outputDir, 'antora-lunr/index.html')
    )
    const searchScript = cheerio.load(startPageContents)('#search-ui-script')
    expect(searchScript).to.have.lengthOf(1)
    expect(searchScript.attr('data-snippet-length')).to.equal('150')
    expect(searchScript.attr('data-stylesheet')).to.be.undefined()
  })

  it('should not generate search index or add scripts to pages if extension is not enabled', async () => {
    const playbookFile = ospath.join(
      FIXTURES_DIR,
      'docs-site',
      'antora-playbook-without-extension.yml'
    )
    const env = {}
    await generateSite(
      [
        '--playbook',
        playbookFile,
        '--to-dir',
        outputDir,
        '--cache-dir',
        cacheDir,
        '--quiet',
      ],
      env
    )
    expect(env).to.not.have.property('SITE_SEARCH_PROVIDER')
    expect(ospath.join(outputDir, 'search-index.js')).to.not.be.a.path()
    const startPageContents = await fsp.readFile(
      ospath.join(outputDir, 'antora-lunr/index.html')
    )
    const $ = cheerio.load(startPageContents)
    expect($('#search-input')).to.have.lengthOf(0)
    expect($('#search-ui-script')).to.have.lengthOf(0)
  })

  it('should throw error if unknown options are specified in playbook', async () => {
    const playbookFile = ospath.join(
      FIXTURES_DIR,
      'docs-site',
      'antora-playbook-with-unknown-options.yml'
    )
    const expectedMessage =
      'Unrecognized options specified for @antora/lunr-extension: foo, yin'
    expect(
      await generateSite(['--playbook', playbookFile], {}).then(
        (result) => () => result,
        (err) => () => {
          throw err
        }
      )
    ).to.throw(expectedMessage)
  })

  it('should throw error if component_order is not a list of component names', async () => {
    const playbookFile = ospath.join(
      FIXTURES_DIR,
      'docs-site',
      'antora-playbook-with-invalid-component-order.yml'
    )
    const expectedMessage =
      'The component_order option for @antora/lunr-extension must be a list of component names'
    expect(
      await generateSite(['--playbook', playbookFile], {}).then(
        (result) => () => result,
        (err) => () => {
          throw err
        }
      )
    ).to.throw(expectedMessage)
  })

  it('should record the configured component order in the search index manifest', async () => {
    const playbookFile = ospath.join(
      FIXTURES_DIR,
      'docs-site',
      'antora-playbook-with-component-order.yml'
    )
    await generateSite(
      ['--playbook', playbookFile, '--to-dir', outputDir, '--cache-dir', cacheDir, '--quiet'],
      {}
    )
    const manifest = JSON.parse(
      await fsp.readFile(ospath.join(outputDir, 'search-index/manifest.json'), 'utf8')
    )
    const entry = manifest.modules.find((it) => it.component === 'antora-lunr')
    // "missing-component" is listed first but is not in the site, so antora-lunr is second.
    expect(entry.order).to.equal(1)
  })

  it('should output search.css to css directory of UI output folder', async () => {
    await generateSite(
      [
        '--playbook',
        defaultPlaybookFile,
        '--to-dir',
        outputDir,
        '--cache-dir',
        cacheDir,
        '--quiet',
      ],
      {}
    )
    const expected = ospath.join(outputDir, '_/css/search.css')
    expect(expected)
      .to.be.a.file()
      .and.equal(ospath.join(__dirname, '..', 'data', 'css', 'search.css'))
  })

  it('should output search-ui.js to js directory of UI output folder', async () => {
    await generateSite(
      [
        '--playbook',
        defaultPlaybookFile,
        '--to-dir',
        outputDir,
        '--cache-dir',
        cacheDir,
        '--quiet',
      ],
      {}
    )
    const expected = ospath.join(outputDir, '_/js/search-ui.js')
    expect(expected)
      .to.be.a.file()
      .and.equal(ospath.join(__dirname, '..', 'data', 'js', 'search-ui.js'))
  })

  it('should preserve existing search.css', async () => {
    await generateSite(
      [
        '--playbook',
        playbookFileWithCustomSupplementalUi,
        '--to-dir',
        outputDir,
        '--cache-dir',
        cacheDir,
        '--quiet',
      ],
      {}
    )
    const expected = ospath.join(outputDir, '_/css/search.css')
    expect(expected)
      .to.be.a.file()
      .and.equal(
        ospath.join(
          __dirname,
          'fixtures',
          'docs-site',
          'custom-supplemental-ui',
          'css',
          'search.css'
        )
      )
  })

  it('should preserve existing search-ui.js', async () => {
    await generateSite(
      [
        '--playbook',
        playbookFileWithCustomSupplementalUi,
        '--to-dir',
        outputDir,
        '--cache-dir',
        cacheDir,
        '--quiet',
      ],
      {}
    )
    const expected = ospath.join(outputDir, '_/js/search-ui.js')
    expect(expected)
      .to.be.a.file()
      .and.equal(
        ospath.join(
          __dirname,
          'fixtures',
          'docs-site',
          'custom-supplemental-ui',
          'js',
          'search-ui.js'
        )
      )
  })
})
