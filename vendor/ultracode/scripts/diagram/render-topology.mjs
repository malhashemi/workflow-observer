/** Render static topology as Mermaid or the versioned structure JSON contract. */

import { isExactRange } from './static-values.mjs'

function escapeMermaid(value) {
  return String(value).replace(/"/gu, "'").replace(/\s+/gu, ' ')
}

function conditionalMultiplicityText(node, fanout) {
  if (!node.conditional || !isExactRange(fanout) || !isExactRange(node.repeatMultiplicity)) return null
  return fanout.max > 1 ? `(optional ×${fanout.max})` : '(optional)'
}

function multiplicityText(node) {
  const fanout = node.fanoutMultiplicity
  const conditional = conditionalMultiplicityText(node, fanout)
  if (conditional) return conditional
  if (isExactRange(fanout) && fanout.max > 1) return `×${fanout.max}`
  if (!isExactRange(fanout)) {
    if (fanout.max === null) return '×N'
    return `×${fanout.min}..${fanout.max}`
  }
  if (!isExactRange(node.repeatMultiplicity)) return '(repeated)'
  if (node.conditional) return '(optional)'
  return null
}

function kindText(node) {
  if (node.kind === 'panel') return '(vote panel)'
  if (node.kind === 'barrier') return '(barrier)'
  if (node.kind === 'pipeline') return '(per item)'
  return null
}

function nodeText(node) {
  const bits = [escapeMermaid(node.label)]
  const multiplicity = multiplicityText(node)
  const kind = kindText(node)
  if (multiplicity) bits.push(multiplicity)
  if (kind) bits.push(kind)
  if (node.effort) bits.push(`[${escapeMermaid(node.effort)}]`)
  return bits.join(' ')
}

function mermaidNode(node) {
  const text = nodeText(node)
  if (node.kind === 'workflow') return `    ${node.id}{{"▸ ${text}"}}`
  const fanout = !isExactRange(node.fanoutMultiplicity) || node.fanoutMultiplicity.max > 1
  return node.kind !== 'single' || fanout
    ? `    ${node.id}[["${text}"]]`
    : `    ${node.id}(["${text}"])`
}

function phaseDetail(topology, title) {
  const detail = topology.phases.find(phase => phase.title === title)?.detail
  return detail ? ` — ${detail}` : ''
}

function topologyEdges(nodes) {
  const edges = new Set()
  for (let index = 0; index < nodes.length - 1; index++) {
    const left = nodes[index]
    const right = nodes[index + 1]
    const samePipeline = left.pipeline && right.pipeline
      && left.pipeline.id === right.pipeline.id
      && left.pipeline.stage !== right.pipeline.stage
    edges.add(`  ${left.id} -->${samePipeline ? '|each item|' : ''} ${right.id}`)
  }
  for (const node of nodes) {
    if (node.loopsTo) edges.add(`  ${node.id} -.->|repeat| ${node.loopsTo}`)
  }
  return [...edges]
}

export function mermaidFromTopology(topology, options = {}) {
  const lines = ['flowchart TD']
  if (!topology.nodes.length) {
    lines.push('  empty["(no agent or child-workflow calls found)"]')
  } else {
    for (let index = 0; index < topology.phases.length; index++) {
      const phase = topology.phases[index]
      const nodes = topology.nodes.filter(node => node.phase === phase.title)
      lines.push(`  subgraph P${index}["${escapeMermaid(phase.title)}${escapeMermaid(phaseDetail(topology, phase.title))}"]`)
      lines.push(...nodes.map(mermaidNode))
      lines.push('  end')
    }
    lines.push(...topologyEdges(topology.nodes))
  }
  if (options.title !== false) {
    lines.unshift(`%% ${escapeMermaid(topology.meta.name)} — ${escapeMermaid(topology.meta.description)}`)
  }
  return lines.join('\n')
}

export function structureFromTopology(topology) {
  return {
    schemaVersion: topology.schemaVersion,
    analysis: topology.analysis,
    name: topology.name,
    phases: topology.phases,
    nodes: topology.nodes,
    total: topology.total,
    totalMultiplicity: topology.totalMultiplicity,
    loops: topology.loops,
    partial: topology.partial,
    uncertainties: topology.uncertainties,
  }
}
