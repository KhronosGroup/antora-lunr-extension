'use strict'

// The name of the package in order to give the Antora logger a useful name
const { name: packageName } = require('../package.json')
const fs = require('fs')
const { promises: fsp } = fs
const generateIndex = require('./generate-index')
const LazyReadable = require('./lazy-readable')
const MultiFileReadStream = require('./multi-file-read-stream')
const ospath = require('path')
const template = require('./template')

/**
 * Lunr integration for an Antora documentation site.
 *
 * @module lunr-extension
 */
function register ({ config: { languages, indexLatestOnly, snippetLength = 100, componentOrder, ...unknownOptions } }) {
  const logger = this.getLogger(packageName)

  if (componentOrder != null && !(Array.isArray(componentOrder) && componentOrder.every((it) => typeof it === 'string'))) {
    throw new Error(`The component_order option for ${packageName} must be a list of component names`)
  }

  if (Object.keys(unknownOptions).length) {
    const keys = Object.keys(unknownOptions)
    throw new Error(`Unrecognized option${keys.length > 1 ? 's' : ''} specified for ${packageName}: ${keys.join(', ')}`)
  }

  this.on('uiLoaded', async ({ playbook, uiCatalog }) => {
    playbook.env.SITE_SEARCH_PROVIDER = 'lunr'
    const uiOutputDir = playbook.ui.outputDir
    vendorJsFile(uiCatalog, logger, uiOutputDir, 'lunr/lunr.min.js', 'lunr.js')
    const otherLanguages = (languages || []).filter((it) => it !== 'en')
    if (otherLanguages.length) {
      playbook.env.SITE_SEARCH_LANGUAGES = otherLanguages.join(',')
      const languageRequires = []
      languageRequires.push('lunr-languages/lunr.stemmer.support.js')
      if (otherLanguages.includes('ja') || otherLanguages.includes('jp')) {
        // needed for Japanese Support
        languageRequires.push('lunr-languages/tinyseg.js')
      }
      if (otherLanguages.includes('th')) {
        // needed for Thai support
        languageRequires.push('lunr-languages/wordcut.js')
      }
      otherLanguages.map((lang) => languageRequires.push(`lunr-languages/lunr.${lang}.js`))
      vendorJsFile(uiCatalog, logger, uiOutputDir, languageRequires, 'lunr-languages.js')
    }
    assetFile(uiCatalog, logger, uiOutputDir, 'css', 'search.css')
    assetFile(uiCatalog, logger, uiOutputDir, 'js', 'search-ui.js')
    const searchScriptsPartialPath = 'partials/search-scripts.hbs'
    if (uiCatalog.findByType('partial').some(({ path }) => path === searchScriptsPartialPath)) return
    const searchScriptsPartialFilepath = ospath.join(__dirname, '../data', searchScriptsPartialPath)
    uiCatalog.addFile({
      contents: Buffer.from(template(await fsp.readFile(searchScriptsPartialFilepath, 'utf8'), { snippetLength })),
      path: searchScriptsPartialPath,
      stem: 'search-scripts',
      type: 'partial',
    })
  })

  this.on('beforePublish', ({ playbook, siteCatalog, contentCatalog }) => {
    delete playbook.env.SITE_SEARCH_PROVIDER
    delete playbook.env.SITE_SEARCH_LANGUAGES
    const index = generateIndex(playbook, contentCatalog, { indexLatestOnly, languages, logger })
    siteCatalog.addFile(generateIndex.createIndexFile(index))

    // Also generate split index files and manifest for per-module loading
    try {
      if (componentOrder) {
        const known = new Set(contentCatalog.getComponents().map((component) => component.name))
        componentOrder
          .filter((name) => !known.has(name))
          .forEach((name) => logger.warn('component_order lists "%s", which is not a component in this site', name))
      }
      const splitFiles = generateIndex.createSplitIndexFiles(index, { componentOrder })
      splitFiles.forEach((file) => siteCatalog.addFile(file))
      logger.info('Generated split search index for %d module entries', splitFiles.length - 1)
    } catch (e) {
      logger.warn('Failed to generate split index files: %s', e.message)
    }

    // Add markdown files for LLM support
    logger.info('Generating markdown files for LLM support')
    const markdownFiles = generateIndex.createMarkdownIndexFile(index)
    markdownFiles.forEach((file) => siteCatalog.addFile(file))
  })
}

function assetFile (
  uiCatalog,
  logger,
  uiOutputDir,
  assetDir,
  basename,
  assetPath = assetDir + '/' + basename,
  contents = new LazyReadable(() => fs.createReadStream(ospath.join(__dirname, '../data', assetPath))),
  overwrite = false
) {
  const outputDir = uiOutputDir + '/' + assetDir
  const existingFile = uiCatalog.findByType('asset').some(({ path }) => path === assetPath)
  if (existingFile) {
    if (overwrite) {
      logger.warn(`Please remove the following file from your UI since it is managed by ${packageName}: ${assetPath}`)
      existingFile.contents = contents
      delete existingFile.stat
    } else {
      logger.info(`The following file already exists in your UI: ${assetPath}, skipping`)
    }
  } else {
    uiCatalog.addFile({
      contents,
      type: 'asset',
      path: assetPath,
      out: { dirname: outputDir, path: outputDir + '/' + basename, basename },
    })
  }
}

function vendorJsFile (uiCatalog, logger, uiOutputDir, requireRequest, basename = requireRequest.split('/').pop()) {
  let contents
  if (Array.isArray(requireRequest)) {
    const filepaths = requireRequest.map(require.resolve)
    contents = new LazyReadable(() => new MultiFileReadStream(filepaths))
  } else {
    const filepath = require.resolve(requireRequest)
    contents = new LazyReadable(() => fs.createReadStream(filepath))
  }
  const jsVendorDir = 'js/vendor'
  assetFile(uiCatalog, logger, uiOutputDir, jsVendorDir, basename, jsVendorDir + '/' + basename, contents)
}

module.exports = { generateIndex, register }
