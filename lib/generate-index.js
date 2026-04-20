'use strict'

const lunr = require('lunr')
const cheerio = require('cheerio')
const { decode } = require('html-entities')
const LevenshteinTrie = require('./levenshtein_patricia_trie')
const pako = require('pako')
const path = require('path')
const crypto = require('crypto')
/**
 * Generate a Lunr index.
 *
 * Iterates over the specified pages and creates a Lunr index.
 * Then creates a patricia trie index for levenshtein distance compare.
 *
 * @memberof lunr-extension
 *
 * @param {Object} playbook - The configuration object for Antora.
 * @param {Object} contentCatalog - The Antora content catalog, with pages and metadata.
 * @param {Object} [config={}] - Configuration options
 * @param {Boolean} config.indexLatestOnly - If true, only index the latest version of any given page.
 * @param {Array<String>} config.languages - List of index languages
 * @param {Object} config.logger - Logger to use
 * @typedef {Object} SearchIndexData
 * @property {lunr.Index} index - a Lunr index
 * @property {Object} store - the documents store
 * @returns {SearchIndexData} A data object that contains the Lunr index and documents store
 */
function generateIndex (playbook, contentCatalog, { indexLatestOnly = false, languages = ['en'], logger } = {}) {
  if (!logger) logger = process.env.NODE_ENV === 'test' ? { info: () => undefined } : console

  logger.info('Building search index with the language(s): %s', languages.join(', '))

  // Select indexable pages
  const pages = contentCatalog.getPages((page) => {
    if (!page.out || page.asciidoc?.attributes?.noindex != null) return
    if (indexLatestOnly) {
      const component = contentCatalog.getComponent(page.src.component)
      if (contentCatalog.getComponentVersion(component, page.src.version) !== component.latest) return
    }
    return true
  })
  if (!pages.length) return {}

  // Use short numerical identifiers (as ref) to keep the Lunr index as small as possible.
  // Since it's an identifier (and not an index) we start at 1.
  let id = 1
  // Extract document objects from indexable pages
  const documents = pages.reduce((accum, page) => {
    const $ = cheerio.load(page.contents)
    // Only index page if not marked as "noindex" by "robots" meta tag
    if (!$('meta[name=robots][content=noindex]').length) {
      accum.push({ id: id++, ...extractIndexContent(page, $) })
    }
    return accum
  }, [])

  if (languages.length > 1 || !languages.includes('en')) {
    if (languages.length > 1 && !lunr.multiLanguage) {
      // required, otherwise lunr.multiLanguage will be undefined
      require('lunr-languages/lunr.multi')(lunr)
    }
    // required, to load additional languages
    require('lunr-languages/lunr.stemmer.support')(lunr)
    languages.forEach((language) => {
      if (language === 'ja' && !lunr.TinySegmenter) {
        require('lunr-languages/tinyseg')(lunr) // needed for Japanese Support
      }
      if (language === 'th' && !lunr.wordcut) {
        lunr.wordcut = require('lunr-languages/wordcut') // needed for Thai support
      }
      if (language !== 'en' && !lunr[language]) {
        require(`lunr-languages/lunr.${language}`)(lunr)
      }
    })
  }

  // Map of Lunr ref (id) to document
  const store = {
    documents: {},
    components: {},
    trie: {},
  }

  // Construct the Lunr index from the extracted content
  const index = lunr(function () {
    if (languages.length > 1) {
      this.use(lunr.multiLanguage(...languages))
    } else if (!languages.includes('en')) {
      this.use(lunr[languages[0]])
    }
    this.ref('id')
    // Boost "name" highest so extension/page names rank near the top
    this.field('name', { boost: 15 })
    this.field('title', { boost: 10 })
    this.field('text')
    this.field('component')
    this.field('keyword', { boost: 5 })
    documents.forEach((doc) => {
      doc.titles.forEach((title) => {
        this.add({ id: `${doc.id}-${title.id}`, title: title.text })
      })
      this.add(doc)
      store.documents[doc.id] = doc
    })
  })
  // expose languages used to allow split index generation later
  store.languages = languages

  store.trie = new LevenshteinTrie()
  documents.forEach((doc) => {
    doc.titles.forEach((title) => {
      const words = (title.text).toLowerCase().split(' ').join('_')
      store.trie.insertWithData(words, doc.id)
    })
  })

  const componentVersions = {}
  const components = contentCatalog.getComponents()
  for (const component of components) {
    for (const version of component.versions) {
      componentVersions[`${component.name}/${version.version}`] = version
    }
  }
  store.componentVersions = componentVersions

  return { index, store }
}

/**
 * Extract the index content for a given page.
 * @param {Object<Page>} page Full text input to clean irrelevant material from.
 * @param {*} $ Cheerio representation of the page.
 * @returns {Object} Indexable content for a given page.
 */
function extractIndexContent (page, $) {
  // Fetch just the article content, so we don't index the TOC and other on-page text
  // Remove any found headings, to improve search results
  const article = $('article.doc')
  const $h1 = $('h1', article)
  let documentTitle = $h1.first().text()
  // Fallbacks when no <h1> is present within article.doc or the title is empty
  if (!documentTitle || !documentTitle.trim()) {
    // Try Asciidoc doctitle if available
    const docTitleFromMeta = (page.asciidoc && (page.asciidoc.doctitle || page.asciidoc.title)) || ''
    if (docTitleFromMeta && String(docTitleFromMeta).trim()) {
      documentTitle = String(docTitleFromMeta).trim()
    } else {
      // Try first <h1> anywhere in the page
      const anyH1 = $('h1').first().text()
      if (anyH1 && anyH1.trim()) {
        documentTitle = anyH1.trim()
      } else {
        // Final fallback to the page stem
        documentTitle = String(page.src && page.src.stem ? page.src.stem : '').trim()
      }
    }
  }
  $h1.remove()
  const titles = []
  const keywords = page.asciidoc.attributes?.keywords
  let id = 1
  $('h2,h3,h4,h5,h6', article).each(function () {
    const $title = $(this)
    titles.push({
      text: $title.text(),
      hash: $title.attr('id'),
      id: id++,
    })
    if (/\s/.test($title.text())) {
      titles.push({
        text: $title.text().split(' ').join('_'),
        hash: $title.attr('id'),
        id: id++,
      })
    }
    $title.remove()
  })

  // don't index navigation elements for pagination on each page
  // as these are the titles of other pages and it would otherwise pollute the index.
  $('nav.pagination', article).each(function () {
    $(this).remove()
  })

  // Get the HTML content from the article
  // Get article HTML; cheerio returns null/undefined if empty – normalize to empty string
  let html = article.html() || ''
  // Decode HTML entities
  html = decode(html)

  // For search index, we still need a plain text version without HTML tags
  let text = html
    .replace(/(<([^>]+)>)/gi, '')
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // If text is empty, try to derive a minimal, non-empty snippet
  if (!text || !text.trim()) {
    // Prefer first paragraph inside the article
    const pText = $('p', article).first().text().trim()
    if (pText) {
      text = pText
    } else if (titles.length) {
      // Otherwise use the collected section titles as a surrogate snippet
      text = titles.map((t) => t.text).filter(Boolean).join(' · ').trim()
    } else if (documentTitle && documentTitle.trim()) {
      // As a last resort, reuse the document title
      text = documentTitle.trim()
    }
  }

  // Return the indexable content, organized by type
  return {
    text: text,
    html: html, // Include the HTML content for markdown generation
    title: documentTitle,
    component: page.src.component,
    module: page.src.module,
    version: page.src.version,
    name: page.src.stem,
    url: page.pub.url,
    titles: titles, // TODO get title id to be able to use fragment identifier
    keyword: keywords,
  }
}

// Helper function allowing Antora to create a site asset containing the index
function createIndexFile (index) {
  let trieData = index.store.trie.save()
  trieData = pako.deflate(trieData)
  trieData = btoa(trieData.reduce((data, byte) => data + String.fromCharCode(byte), ''))
  let lunrData = JSON.stringify(index)
  lunrData = pako.deflate(lunrData)
  lunrData = btoa(lunrData.reduce((data, byte) => data + String.fromCharCode(byte), ''))
  return {
    mediaType: 'application/javascript',
    // eslint-disable-next-line no-useless-escape
    contents: Buffer.from(`antoraSearch.initSearch(lunr, \'${lunrData}\', \'${trieData}\')`),
    src: { stem: 'search-index' },
    out: { path: 'search-index.js' },
    pub: { url: '/search-index.js', rootPath: '' },
  }
}

// Helper to create split index files per component/module and a manifest
function createSplitIndexFiles (globalIndex) {
  const allDocs = Object.values(globalIndex.store.documents)
  const groups = {}
  for (const doc of allDocs) {
    const mod = doc.module || 'ROOT'
    const key = `${doc.component}::${mod}`
    if (!groups[key]) groups[key] = { component: doc.component, module: mod, documents: [] }
    groups[key].documents.push(doc)
  }
  const files = []
  const modules = []

  const toBase64 = (u8) => btoa(u8.reduce((data, byte) => data + String.fromCharCode(byte), ''))

  const buildIndexFromDocs = (docs, languages) => {
    let nextId = 1
    const remappedDocs = docs.map((doc) => ({ ...doc, id: nextId++ }))

    const store = {
      documents: {},
      components: {},
      trie: {},
      componentVersions: globalIndex.store.componentVersions,
      languages: globalIndex.store.languages,
    }

    const idx = lunr(function () {
      if (languages.length > 1) {
        this.use(lunr.multiLanguage(...languages))
      } else if (!languages.includes('en')) {
        this.use(lunr[languages[0]])
      }
      this.ref('id')
      this.field('title', { boost: 10 })
      this.field('name')
      this.field('text')
      this.field('component')
      this.field('keyword', { boost: 5 })
      remappedDocs.forEach((doc) => {
        doc.titles.forEach((title) => {
          this.add({ id: `${doc.id}-${title.id}`, title: title.text })
        })
        this.add(doc)
        store.documents[doc.id] = doc
      })
    })

    store.trie = new LevenshteinTrie()
    remappedDocs.forEach((doc) => {
      doc.titles.forEach((title) => {
        const words = (title.text).toLowerCase().split(' ').join('_')
        store.trie.insertWithData(words, doc.id)
      })
    })

    return { index: idx, store }
  }

  const makeSafe = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').toLowerCase()

  for (const { component, module, documents } of Object.values(groups)) {
    const subset = buildIndexFromDocs(documents, globalIndex.store.languages || ['en'])

    let trieData = subset.store.trie.save()
    trieData = pako.deflate(trieData)
    const trieB64 = toBase64(trieData)
    let lunrData = JSON.stringify(subset)
    lunrData = pako.deflate(lunrData)
    const lunrB64 = toBase64(lunrData)

    const hash = crypto.createHash('sha256').update(lunrB64).update(trieB64).digest('hex')
    const id = `${makeSafe(component)}-${makeSafe(module)}`
    const relPath = `search-index/modules/${id}.json`
    const url = `/${relPath}`

    const file = {
      mediaType: 'application/json',
      contents: Buffer.from(JSON.stringify({ id, component, module, hash, lunrData: lunrB64, trieData: trieB64 })),
      src: { stem: `search-index-${id}` },
      out: { path: relPath },
      pub: { url, rootPath: '' },
    }
    files.push(file)
    modules.push({ id, component, module, url, hash, docs: documents.length })
  }

  const manifest = {
    mediaType: 'application/json',
    contents: Buffer.from(JSON.stringify({ version: 1, languages: globalIndex.store.languages || ['en'], modules })),
    src: { stem: 'search-index-manifest' },
    out: { path: 'search-index/manifest.json' },
    pub: { url: '/search-index/manifest.json', rootPath: '' },
  }
  files.push(manifest)

  return files
}

/**
 * Convert HTML content to Markdown format.
 *
 * @param {string} html - The HTML content to convert
 * @returns {string} The converted Markdown content
 */
function htmlToMarkdown (html) {
  if (!html) return ''

  // Replace common HTML elements with Markdown equivalents
  return html
    // Handle paragraphs
    .replace(/<p>(.*?)<\/p>/gs, '$1\n\n')

    // Handle headings (h1-h6)
    .replace(/<h1[^>]*>(.*?)<\/h1>/gs, '# $1\n\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gs, '## $1\n\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gs, '### $1\n\n')
    .replace(/<h4[^>]*>(.*?)<\/h4>/gs, '#### $1\n\n')
    .replace(/<h5[^>]*>(.*?)<\/h5>/gs, '##### $1\n\n')
    .replace(/<h6[^>]*>(.*?)<\/h6>/gs, '###### $1\n\n')

    // Handle strong/bold
    .replace(/<(strong|b)>(.*?)<\/(strong|b)>/gs, '**$2**')

    // Handle emphasis/italic
    .replace(/<(em|i)>(.*?)<\/(em|i)>/gs, '*$2*')

    // Handle code blocks
    .replace(/<pre><code[^>]*>(.*?)<\/code><\/pre>/gs, '```\n$1\n```\n\n')

    // Handle inline code
    .replace(/<code>(.*?)<\/code>/gs, '`$1`')

    // Handle unordered lists
    .replace(/<ul>(.*?)<\/ul>/gs, function (match, list) {
      return list.replace(/<li>(.*?)<\/li>/gs, '* $1\n') + '\n'
    })

    // Handle ordered lists
    .replace(/<ol>(.*?)<\/ol>/gs, function (match, list) {
      let index = 1
      return list.replace(/<li>(.*?)<\/li>/gs, function (match, item) {
        return (index++) + '. ' + item + '\n'
      }) + '\n'
    })

    // Handle links
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs, '[$2]($1)')

    // Handle images
    .replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gs, '![$2]($1)')

    // Handle line breaks
    .replace(/<br\s*\/?>/gs, '\n')

    // Handle horizontal rules
    .replace(/<hr\s*\/?>/gs, '---\n\n')

    // Handle blockquotes
    .replace(/<blockquote>(.*?)<\/blockquote>/gs, '> $1\n\n')

    // Handle tables (improved support)
    .replace(/<table[^>]*>(.*?)<\/table>/gs, function (match, tableContent) {
      let markdown = ''
      let hasHeader = false
      let columnCount = 0

      // Function to clean cell content
      const cleanCellContent = (content) => {
        return content
          .replace(/<br\s*\/?>/gi, ' ') // Replace <br> with space
          .replace(/<(?!\/?(strong|b|em|i|code)(?=>|\s[^>]*>))[^>]+>/g, '') // Keep only basic formatting tags
          .replace(/\|/g, '\\|') // Escape pipe characters
          .trim()
      }

      // Extract all rows, whether they're in thead, tbody, or directly in table
      const allRows = []

      // First check for thead rows
      const theadMatch = tableContent.match(/<thead[^>]*>(.*?)<\/thead>/s)
      if (theadMatch) {
        const headerRows = theadMatch[1].match(/<tr[^>]*>.*?<\/tr>/gs) || []
        headerRows.forEach((row) => {
          allRows.push({ row, isHeader: true })
        })
        hasHeader = headerRows.length > 0
      }

      // Then check for tbody rows
      const tbodyMatch = tableContent.match(/<tbody[^>]*>(.*?)<\/tbody>/s)
      if (tbodyMatch) {
        const bodyRows = tbodyMatch[1].match(/<tr[^>]*>.*?<\/tr>/gs) || []
        bodyRows.forEach((row) => {
          allRows.push({ row, isHeader: false })
        })
      }

      // Check for rows directly in table (no thead/tbody)
      if (allRows.length === 0) {
        const directRows = tableContent.match(/<tr[^>]*>.*?<\/tr>/gs) || []
        // If we have direct rows, assume the first one is a header
        directRows.forEach((row, index) => {
          allRows.push({ row, isHeader: index === 0 })
        })
        hasHeader = directRows.length > 0
      }

      // Process all rows
      allRows.forEach((rowObj, rowIndex) => {
        const { row, isHeader } = rowObj

        // Extract cells (both th and td)
        const headerCells = row.match(/<th[^>]*>.*?<\/th>/gs) || []
        const dataCells = row.match(/<td[^>]*>.*?<\/td>/gs) || []
        const cells = headerCells.length > 0 ? headerCells : dataCells

        if (cells.length > 0) {
          // Update column count if this row has more cells
          columnCount = Math.max(columnCount, cells.length)

          // Process each cell
          const processedCells = cells.map((cell) => {
            // Extract content from th or td
            const content = cell.replace(/<t[hd][^>]*>(.*?)<\/t[hd]>/s, '$1')
            return cleanCellContent(content)
          })

          markdown += '| ' + processedCells.join(' | ') + ' |\n'

          // Add separator row after headers
          if (isHeader && rowIndex === (hasHeader ? allRows.findIndex((r) => !r.isHeader) - 1 : 0)) {
            markdown += '| ' + Array(columnCount).fill('---').join(' | ') + ' |\n'
          }
        }
      })

      // If no header was explicitly defined but we have rows, add a separator after first row
      if (!hasHeader && allRows.length > 0) {
        const firstRowMatch = markdown.match(/^.*\n/)
        if (firstRowMatch) {
          const firstRow = firstRowMatch[0]
          const restRows = markdown.slice(firstRow.length)
          markdown = firstRow + '| ' + Array(columnCount).fill('---').join(' | ') + ' |\n' + restRows
        }
      }

      return markdown + '\n'
    })

    // Clean up any remaining HTML tags
    .replace(/<[^>]*>/g, '')

    // Fix extra newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Helper function to create a Markdown file from the index data for LLM MCP support
function createMarkdownIndexFile (index) {
  const documents = Object.values(index.store.documents)

  // Create a base directory for the Markdown files
  const baseDirName = 'site-docs'

  // Function to sanitize a title for use as a filename
  function sanitizeFilename (title) {
    return title
      .replace(/[/\\?%*:|"<>]/g, '-') // Replace invalid filename characters with dash
      .replace(/\s+/g, '-') // Replace spaces with dash
      .replace(/-+/g, '-') // Replace multiple dashes with single dash
      .replace(/^-|-$/g, '') // Remove leading and trailing dashes
      .toLowerCase() // Convert to lowercase
  }

  // Filter out documents with no text and create a file object for each remaining document
  return documents
    .filter((doc) => doc.text && doc.text.trim() !== '')
    .map((doc) => {
      // Use the document title as the filename
      const filename = sanitizeFilename(doc.title) || 'untitled'

      // Create directory structure based on component and version
      const componentDir = sanitizeFilename(doc.component || 'unknown-component')
      const versionDir = sanitizeFilename(doc.version || 'unknown-version')
      const dirPath = path.join(baseDirName, componentDir, versionDir)

      // Create enhanced markdown content with metadata and the document text
      let markdownContent = `# ${doc.title}\n\n`

      // Add metadata section
      markdownContent += '## Metadata\n\n'
      markdownContent += `- **Component**: ${doc.component}\n`
      markdownContent += `- **Version**: ${doc.version}\n`
      markdownContent += `- **URL**: ${doc.url}\n`

      // Add keywords if available
      if (doc.keyword) {
        markdownContent += `- **Keywords**: ${doc.keyword}\n`
      }

      markdownContent += '\n'

      // Add section headings if available
      if (doc.titles && doc.titles.length > 0) {
        markdownContent += '## Table of Contents\n\n'
        doc.titles.forEach((title, index) => {
          // Only include titles with spaces (not the underscore versions)
          if (!/^[^_]*_[^_]*$/.test(title.text)) {
            markdownContent += `- [${title.text}](#${title.hash})\n`
          }
        })
        markdownContent += '\n'
      }

      // Add the main content
      // Use the HTML content if available, otherwise fall back to plain text
      const contentMarkdown = doc.html ? htmlToMarkdown(doc.html) : doc.text
      markdownContent += `## Content\n\n${contentMarkdown}\n`

      return {
        mediaType: 'text/markdown',
        contents: Buffer.from(markdownContent),
        src: { stem: filename },
        out: { path: path.join(dirPath, `${filename}.md`) },
        pub: { url: `/${dirPath}/${filename}.md`, rootPath: '' },
      }
    })
}

module.exports = generateIndex
module.exports.createIndexFile = createIndexFile
module.exports.createSplitIndexFiles = createSplitIndexFiles
module.exports.createMarkdownIndexFile = createMarkdownIndexFile
module.exports.htmlToMarkdown = htmlToMarkdown
