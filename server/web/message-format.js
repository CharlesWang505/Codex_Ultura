const textFenceLanguages = new Set(['', 'text', 'txt', 'plaintext', 'markdown', 'md'])

function normalizeSource(value) {
  return String(value || '').replace(/\r\n?/g, '\n')
}

export function normalizeMessageMarkdown(value) {
  const source = normalizeSource(value).trim()
  const wrapped = source.match(/^ {0,3}```([^\n`]*)\n([\s\S]*?)\n?```[ \t]*$/)
  if (!wrapped) return source
  const language = wrapped[1].trim().toLowerCase()
  return textFenceLanguages.has(language) ? wrapped[2].trim() : source
}

function safeLink(value) {
  try {
    const url = new URL(value, location.href)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

function appendInline(parent, source) {
  const pattern = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\[([^\]\n]+)\]\(([^)\s]+)\)|\*([^*\n]+)\*/g
  let cursor = 0
  let match
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) parent.append(document.createTextNode(source.slice(cursor, match.index)))
    let node
    if (match[1]) {
      node = document.createElement('code')
      node.textContent = match[2]
    } else if (match[3] || match[4]) {
      node = document.createElement('strong')
      appendInline(node, match[3] || match[4])
    } else if (match[5]) {
      node = document.createElement('del')
      appendInline(node, match[5])
    } else if (match[6]) {
      const href = safeLink(match[7])
      if (href) {
        node = document.createElement('a')
        node.href = href
        node.target = '_blank'
        node.rel = 'noreferrer noopener'
        appendInline(node, match[6])
      } else {
        node = document.createTextNode(match[0])
      }
    } else {
      node = document.createElement('em')
      appendInline(node, match[8])
    }
    parent.append(node)
    cursor = pattern.lastIndex
  }
  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)))
}

function createTextBlock(tagName, text) {
  const element = document.createElement(tagName)
  appendInline(element, text.trim())
  return element
}

function fenceStart(line) {
  return line.match(/^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+.-]*)\s*$/)
}

function listItem(line) {
  const unordered = line.match(/^\s*([-*+]|\u2192)\s+(.+)$/)
  if (unordered) return { ordered: false, arrow: unordered[1] === '\u2192', text: unordered[2] }
  const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/)
  if (ordered) return { ordered: true, start: Number(ordered[1]), arrow: false, text: ordered[2] }
  return null
}

function isTableDivider(line) {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|')
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
}

function isBlockStart(lines, index) {
  const line = lines[index] || ''
  if (!line.trim()) return true
  if (fenceStart(line)) return true
  if (/^ {0,3}#{1,6}\s+/.test(line)) return true
  if (/^ {0,3}>\s?/.test(line)) return true
  if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return true
  if (listItem(line)) return true
  return line.includes('|') && isTableDivider(lines[index + 1] || '')
}

function appendCodeBlock(fragment, language, codeText) {
  const wrapper = document.createElement('section')
  wrapper.className = 'markdown-code-block'
  const header = document.createElement('header')
  const label = document.createElement('span')
  label.textContent = language || '代码'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'markdown-copy'
  copy.textContent = '复制'
  copy.setAttribute('aria-label', '复制代码')
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codeText)
      copy.textContent = '已复制'
      setTimeout(() => { copy.textContent = '复制' }, 1400)
    } catch {
      copy.textContent = '复制失败'
      setTimeout(() => { copy.textContent = '复制' }, 1400)
    }
  })
  header.append(label, copy)
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.textContent = codeText
  if (language) code.dataset.language = language
  pre.append(code)
  wrapper.append(header, pre)
  fragment.append(wrapper)
}

function appendTable(fragment, lines, start) {
  const tableWrap = document.createElement('div')
  tableWrap.className = 'markdown-table-wrap'
  const table = document.createElement('table')
  const head = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const value of tableCells(lines[start])) {
    const cell = document.createElement('th')
    appendInline(cell, value)
    headRow.append(cell)
  }
  head.append(headRow)
  table.append(head)
  const body = document.createElement('tbody')
  let index = start + 2
  while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
    const row = document.createElement('tr')
    for (const value of tableCells(lines[index])) {
      const cell = document.createElement('td')
      appendInline(cell, value)
      row.append(cell)
    }
    body.append(row)
    index += 1
  }
  table.append(body)
  tableWrap.append(table)
  fragment.append(tableWrap)
  return index
}

export function renderMessageMarkdown(container, value) {
  const source = normalizeMessageMarkdown(value)
  const lines = source.split('\n')
  const fragment = document.createDocumentFragment()
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = fenceStart(line)
    if (fence) {
      const marker = fence[1]
      const language = fence[2]
      const code = []
      index += 1
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      appendCodeBlock(fragment, language, code.join('\n'))
      continue
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+)$/)
    if (heading) {
      fragment.append(createTextBlock(`h${heading[1].length}`, heading[2]))
      index += 1
      continue
    }

    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      fragment.append(document.createElement('hr'))
      index += 1
      continue
    }

    if (line.includes('|') && isTableDivider(lines[index + 1] || '')) {
      index = appendTable(fragment, lines, index)
      continue
    }

    const firstListItem = listItem(line)
    if (firstListItem) {
      const list = document.createElement(firstListItem.ordered ? 'ol' : 'ul')
      if (firstListItem.ordered && firstListItem.start !== 1) list.start = firstListItem.start
      if (firstListItem.arrow) list.className = 'arrow-list'
      while (index < lines.length) {
        const item = listItem(lines[index])
        if (!item || item.ordered !== firstListItem.ordered || item.arrow !== firstListItem.arrow) break
        const row = document.createElement('li')
        const task = item.text.match(/^\[([ xX])]\s+(.+)$/)
        if (task) {
          row.className = 'task-list-item'
          const checkbox = document.createElement('input')
          checkbox.type = 'checkbox'
          checkbox.disabled = true
          checkbox.checked = task[1].toLowerCase() === 'x'
          row.append(checkbox)
          const content = document.createElement('span')
          appendInline(content, task[2])
          row.append(content)
        } else {
          appendInline(row, item.text)
        }
        list.append(row)
        index += 1
      }
      fragment.append(list)
      continue
    }

    if (/^ {0,3}>\s?/.test(line)) {
      const quote = document.createElement('blockquote')
      const quoteLines = []
      while (index < lines.length && /^ {0,3}>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^ {0,3}>\s?/, ''))
        index += 1
      }
      appendInline(quote, quoteLines.join('\n'))
      fragment.append(quote)
      continue
    }

    const paragraphLines = [line.trim()]
    index += 1
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index].trim())
      index += 1
    }
    const paragraph = document.createElement('p')
    paragraphLines.forEach((text, lineIndex) => {
      if (lineIndex > 0) paragraph.append(document.createElement('br'))
      appendInline(paragraph, text)
    })
    fragment.append(paragraph)
  }

  container.replaceChildren(fragment)
}
