/**
 * Render static topology as terminal cards. Mermaid remains available as an
 * explicit artifact format for GitHub, documentation, and the gallery.
 */

import { isExactRange } from './static-values.mjs'
import {
  displayWidth,
  padEndDisplay,
  padStartDisplay,
  safeTerminalText,
  wrapTerminalText,
} from './terminal-text.mjs'

const CARD_WIDTH = 74
const CARD_TEXT_WIDTH = CARD_WIDTH - 4
const OUTPUT_WIDTH = CARD_WIDTH + 4
const RAIL = '│   '
const NO_RAIL = '    '
const EDGE_INDENT = ' '.repeat(24)

const GLYPH = { single: '·', barrier: '⇉', panel: '⇉', pipeline: '⇉', workflow: '▸' }
const KIND_TAG = { panel: 'vote panel', barrier: '', pipeline: 'per item', workflow: 'sub-workflow', single: '' }

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function fanoutText(fanout) {
  if (isExactRange(fanout)) return fanout.max > 1 ? `×${fanout.max}` : ''
  return fanout.max === null ? '×N ⁇' : `×${fanout.min}–${fanout.max} ⁇`
}

function repeatText(repeat) {
  if (isExactRange(repeat)) return repeat.max > 1 ? `×${repeat.max} rounds` : ''
  return repeat.max === null ? '×N rounds ⁇' : `×${repeat.min}–${repeat.max} rounds ⁇`
}

function multiplicityText(node, showOptional) {
  const fanout = fanoutText(node.fanoutMultiplicity)
  const repeat = repeatText(node.repeatMultiplicity)
  const bits = [fanout, repeat].filter(Boolean)
  if (node.conditional && showOptional) bits.push('optional')
  return bits.join('  ')
}

function prefixedLines(value, firstPrefix, continuationPrefix = firstPrefix) {
  const prefixWidth = Math.max(displayWidth(firstPrefix), displayWidth(continuationPrefix))
  const first = padEndDisplay(firstPrefix, prefixWidth)
  const continuation = padEndDisplay(continuationPrefix, prefixWidth)
  return wrapTerminalText(value, CARD_TEXT_WIDTH - prefixWidth)
    .map((line, index) => `${index === 0 ? first : continuation}${line}`)
}

function toCards(topology) {
  const detailOf = title => topology.phases.find(phase => phase.title === title)?.detail || ''
  const ordinals = new Map()
  const cards = []
  for (const node of topology.nodes) {
    const last = cards[cards.length - 1]
    if (last && last.phase === node.phase) {
      last.nodes.push(node)
      continue
    }
    const revisit = ordinals.has(node.phase)
    if (!revisit) ordinals.set(node.phase, ordinals.size + 1)
    cards.push({ phase: node.phase, detail: detailOf(node.phase), ordinal: ordinals.get(node.phase), revisit, nodes: [node] })
  }
  return cards
}

function agentLines(node, showOptional) {
  const fallbackLabel = node.kind === 'workflow' ? 'workflow:*' : 'agent'
  const label = safeTerminalText(node.label) || fallbackLabel
  const lines = prefixedLines(label, `  ${GLYPH[node.kind] || '·'}  `, '     ')
  if (node.dynamicTarget && node.possibleTargets.length) {
    lines.push(...prefixedLines(node.possibleTargets.join(' | '), '     → ', '       '))
  }
  const effort = node.effort === null ? 'inherited' : safeTerminalText(node.effort)
  const metadata = [multiplicityText(node, showOptional), KIND_TAG[node.kind], `effort: ${effort}`]
    .filter(Boolean)
    .join('  ·  ')
  lines.push(...prefixedLines(metadata, '     '))
  return lines
}

function boxedLine(value) {
  return `│ ${padEndDisplay(value, CARD_TEXT_WIDTH)} │`
}

function cardHeading(card) {
  const revisit = card.revisit ? ' (revisit)' : ''
  const titleLines = wrapTerminalText(`${card.ordinal} · ${safeTerminalText(card.phase).toUpperCase()}${revisit}`, CARD_TEXT_WIDTH - 2)
  const firstTitle = titleLines.shift() || `${card.ordinal} · UNTITLED`
  const start = `╭─ ${firstTitle} `
  const heading = start + '─'.repeat(Math.max(1, CARD_WIDTH - displayWidth(start) - 1)) + '╮'
  return [heading, ...titleLines.map(line => boxedLine(`  ${line}`))]
}

function renderCard(card, showOptional) {
  const lines = cardHeading(card)
  lines.push(...wrapTerminalText(card.detail, CARD_TEXT_WIDTH).map(boxedLine), boxedLine(''))
  for (const node of card.nodes) {
    lines.push(...agentLines(node, showOptional).map(boxedLine))
    if (node.loopsTo === node.id) lines.push(boxedLine('     ↺ repeats sequentially'))
  }
  lines.push('╰' + '─'.repeat(CARD_WIDTH - 2) + '╯')
  return lines
}

function edgeLabel(fromCard, toCard) {
  const left = fromCard.nodes.at(-1)
  const right = toCard.nodes[0]
  if (left.pipeline && right.pipeline && left.pipeline.id === right.pipeline.id
    && left.pipeline.stage !== right.pipeline.stage) return '  each item'
  return left.kind === 'barrier' || left.kind === 'panel' ? '  barrier' : ''
}

function totalFact(total) {
  if (isExactRange(total)) return plural(total.max, 'agent')
  if (total.max !== null) return `${total.min}–${total.max} agents`
  return `${total.min}+ agents · unknown upper bound`
}

function footerLines(topology, showOptional) {
  const facts = [plural(topology.nodes.length, 'call site'), totalFact(topology.totalMultiplicity)]
  if (topology.loops) facts.push('contains a loop')
  if (topology.partial) facts.push('partial analysis')
  const messages = [facts.join(' · ')]
  if (!showOptional && topology.nodes.some(node => node.conditional)) {
    messages.push('every call site is conditional, so no node is guaranteed to run')
  }
  if (topology.uncertainties.length) {
    const uncertainNodes = new Set(topology.uncertainties.map(uncertainty => uncertainty.node)).size
    messages.push(`⁇ = runtime-dependent or unresolved statically (${uncertainNodes} of ${plural(topology.nodes.length, 'call site')})`)
  }
  messages.push('· single   ⇉ parallel   ▸ sub-workflow   ↺ loop')
  return ['', ...messages.flatMap(message => prefixedOutputLines(message))]
}

function prefixedOutputLines(value, prefix = '  ') {
  return wrapTerminalText(value, OUTPUT_WIDTH - displayWidth(prefix)).map(line => `${prefix}${line}`)
}

function headerLines(topology) {
  const label = 'static analysis'
  const names = wrapTerminalText(topology.meta.name, OUTPUT_WIDTH)
  if (!names.length) names.push('unnamed workflow')
  const lastName = names.at(-1) || ''
  if (displayWidth(lastName) + displayWidth(label) + 1 <= OUTPUT_WIDTH) {
    names[names.length - 1] = `${padEndDisplay(lastName, OUTPUT_WIDTH - displayWidth(label))}${label}`
  } else names.push(padStartDisplay(label, OUTPUT_WIDTH))
  return [...names, ...wrapTerminalText(topology.meta.description, OUTPUT_WIDTH), '']
}

function loopEdges(topology) {
  const nodesById = new Map(topology.nodes.map(node => [node.id, node]))
  return topology.nodes
    .filter(node => node.loopsTo && node.loopsTo !== node.id && nodesById.has(node.loopsTo))
    .map(node => ({ from: node, to: nodesById.get(node.loopsTo) }))
}

function loopDetailLines(edges) {
  if (!edges.length) return []
  const details = edges.flatMap(({ from, to }) => prefixedOutputLines(
    `${safeTerminalText(from.phase)}/${safeTerminalText(from.label)} → ${safeTerminalText(to.phase)}/${safeTerminalText(to.label)}`,
    '  ↺ ',
  ))
  return ['', '  loop edges:', ...details]
}

function renderCards(topology, cards, showOptional) {
  const cardByNode = new Map(cards.flatMap((card, index) => card.nodes.map(node => [node.id, index])))
  const edges = loopEdges(topology)
  const primary = edges.find(edge => cardByNode.get(edge.to.id) < cardByNode.get(edge.from.id))
  const railStart = primary ? cardByNode.get(primary.to.id) : -1
  const railEnd = primary ? cardByNode.get(primary.from.id) : -1
  const body = []

  cards.forEach((card, index) => {
    const onRail = primary && index >= railStart && index <= railEnd
    renderCard(card, showOptional).forEach((line, row) => {
      body.push((index === railStart && row === 0 ? '╭─▶ ' : onRail ? RAIL : NO_RAIL) + line)
    })
    if (index === railEnd) body.push('╰──── primary loop returns to the marked card')
    if (index < cards.length - 1) {
      const prefix = onRail && index < railEnd ? RAIL : NO_RAIL
      body.push(`${prefix}${EDGE_INDENT}│${edgeLabel(card, cards[index + 1])}`, `${prefix}${EDGE_INDENT}▼`)
    }
  })
  return [...body, ...loopDetailLines(edges)]
}

export function terminalFromTopology(topology) {
  const header = headerLines(topology)
  if (!topology.nodes.length) return [...header, '  (no agent or child-workflow calls found)'].join('\n')
  if (topology.dynamicDispatch) {
    header.push(...prefixedOutputLines('! dynamic dispatcher: the child workflow is chosen at runtime.'), '')
  }
  const showOptional = topology.nodes.some(node => !node.conditional)
  const cards = toCards(topology)
  return [...header, ...renderCards(topology, cards, showOptional), ...footerLines(topology, showOptional)].join('\n')
}
