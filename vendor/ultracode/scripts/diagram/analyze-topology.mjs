/** Convert inert Workflow AST data into a static orchestration topology. */

import { parseWorkflowSource } from './parse-workflow.mjs'
import { activePhaseAt, buildTopologyIndex, contextForSite, executionSites, phaseContextForSite } from './topology-context.mjs'
import {
  expressionLabel,
  isExactRange,
  propertyOf,
  renderHint,
  stringValue,
  sumRanges,
} from './static-values.mjs'

function taskOptions(primitive) {
  return primitive.callee.name === 'agent'
    ? primitive.arguments[1]
    : null
}

function promptLabel(primitive, index) {
  const label = expressionLabel(primitive.arguments[0], index.bindings)
  if (label.text === '*') return { text: 'agent', exact: false }
  const words = label.text.trim().split(/\s+/u).slice(0, 3).join(' ')
  return { text: words || 'agent', exact: label.exact }
}

function agentDescriptor(primitive, index) {
  const options = taskOptions(primitive)
  const labelNode = resolvedObjectProperty(options, 'label', index.bindings)
  const modelNode = resolvedObjectProperty(options, 'model', index.bindings)
  const label = labelNode ? expressionLabel(labelNode, index.bindings) : promptLabel(primitive, index)
  return {
    label,
    labelDeclared: Boolean(labelNode),
    model: stringValue(modelNode, index.bindings),
    explicitPhase: stringValue(resolvedObjectProperty(options, 'phase', index.bindings), index.bindings),
    effort: stringValue(resolvedObjectProperty(options, 'effort', index.bindings), index.bindings),
    schema: Boolean(propertyOf(options, 'schema')),
    dynamicTarget: false,
    possibleTargets: [],
  }
}

function resolvedBinding(node, bindings, seen = new Set()) {
  if (node?.type !== 'Identifier') return node
  if (seen.has(node.name)) return null
  const value = bindings.get(node.name)
  return value ? resolvedBinding(value, bindings, new Set([...seen, node.name])) : null
}

function resolvedObjectProperty(node, name, bindings) {
  const object = resolvedBinding(node, bindings)
  if (object?.type !== 'ObjectExpression') return null
  for (let index = object.properties.length - 1; index >= 0; index--) {
    const property = object.properties[index]
    if (property.type !== 'Property' || property.kind !== 'init') return null
    if (property.computed) return null
    const key = property.key.type === 'Identifier' ? property.key.name : property.key.value
    if (key === name) return property.value
  }
  return null
}

function workflowDescriptor(primitive, index) {
  const reference = primitive.arguments[0]
  const target = stringValue(reference, index.bindings)
    || stringValue(resolvedObjectProperty(reference, 'scriptPath', index.bindings), index.bindings)
  return {
    label: target ? { text: target, exact: true } : { text: 'workflow:*', exact: false },
    explicitPhase: null,
    effort: null,
    schema: false,
    dynamicTarget: !target,
    possibleTargets: target ? [target] : index.possibleWorkflowTargets,
  }
}

function sourceLocation(site) {
  return {
    callLine: site.origin.loc.start.line,
    definitionLine: site.primitive.loc.start.line,
    invocationLine: site.chain?.length > 1 ? site.chain.at(-2).loc.start.line
      : site.helper ? site.origin.loc.start.line : null,
  }
}

function nodeFromSite(site, index, resolved) {
  const isWorkflow = site.primitive.callee.name === 'workflow'
  const descriptor = isWorkflow
    ? workflowDescriptor(site.primitive, index)
    : agentDescriptor(site.primitive, index)
  if (resolved) {
    descriptor.model = resolved.model
    descriptor.models = resolved.models
    descriptor.effort = resolved.effort
    descriptor.explicitPhase = resolved.explicitPhase
    if (resolved.label) { descriptor.label = {text: resolved.label, exact: true}; descriptor.labelDeclared = true }
    else if (descriptor.label.exact) { descriptor.label = {text: 'Agent call', exact: false}; descriptor.labelDeclared = false }
  }
  const context = contextForSite(site, index)
  const contextPhase = phaseContextForSite(site, index)
  const phase = descriptor.explicitPhase
    || contextPhase
    || activePhaseAt(site.origin.start, index)
    || '(start)'

  return {
    id: null,
    order: site.origin.start,
    phase,
    contextPhases: contextPhase ? [contextPhase] : [],
    label: descriptor.label.text,
    labelExact: descriptor.label.exact,
    labelDeclared: descriptor.labelDeclared ?? false,
    model: descriptor.model ?? null,
    models: descriptor.models ?? [],
    modelsComplete: resolved?.modelsComplete ?? Boolean(descriptor.model),
    modelOrigin: resolved?.modelOrigin ?? (descriptor.model ? 'explicit' : 'dynamic'),
    siteKey: site.chain?.at(-2)?.start ?? site.origin.start,
    agents: renderHint(context.multiplicity),
    multiplicity: context.multiplicity,
    fanoutMultiplicity: context.fanoutMultiplicity,
    repeatMultiplicity: context.repeatMultiplicity,
    kind: isWorkflow ? 'workflow' : context.kind,
    // What CONTAINS the call site, kept separately because `workflow` overwrites
    // the structural kind: a child workflow inside a parallel() is still behind
    // a barrier, and a consumer that reads only `kind` cannot see it.
    container: context.kind,
    effort: descriptor.effort,
    schema: descriptor.schema,
    loopsTo: null,
    conditional: context.conditional,
    conditionalReason: context.conditionalReason,
    guarded: context.guarded,
    dynamicFanout: context.dynamicFanout,
    dynamicTarget: descriptor.dynamicTarget,
    possibleTargets: descriptor.possibleTargets,
    pipeline: context.pipeline,
    loopKeys: context.loopKeys,
    unresolved: Boolean(site.unresolved),
    source: sourceLocation(site),
  }
}

function assignIdsAndLoops(nodes) {
  nodes.sort((left, right) => left.order - right.order || left.source.definitionLine - right.source.definitionLine)
  nodes.forEach((node, index) => { node.id = `n${index}` })

  const loopGroups = new Map()
  for (const node of nodes) {
    for (const key of node.loopKeys) {
      if (!loopGroups.has(key)) loopGroups.set(key, [])
      loopGroups.get(key).push(node)
    }
  }
  for (const group of loopGroups.values()) {
    const first = group[0]
    group[group.length - 1].loopsTo = first.id
  }
  return loopGroups
}

function phaseOrder(meta, nodes) {
  const observed = [...new Set(nodes.map(node => node.phase))]
  const declared = (meta.phases || []).map(phase => phase.title).filter(title => observed.includes(title))
  return [...declared, ...observed.filter(title => !declared.includes(title))]
}

function compatibilityTotal(nodes) {
  const total = nodes.reduce((sum, node) => sum + node.agents, 0)
  return Number.isSafeInteger(total) ? total : 1
}

function phasesFromNodes(meta, nodes) {
  const detail = new Map((meta.phases || []).map(phase => [phase.title, phase.detail || null]))
  return phaseOrder(meta, nodes).map(title => {
    const phaseNodes = nodes.filter(node => node.phase === title)
    const multiplicity = sumRanges(phaseNodes.map(node => node.multiplicity))
    return {
      title,
      agents: compatibilityTotal(phaseNodes),
      multiplicity,
      detail: detail.get(title) || null,
    }
  })
}

function uncertaintiesFromNodes(nodes) {
  const uncertainties = []
  for (const node of nodes) {
    if (!isExactRange(node.multiplicity)) {
      uncertainties.push({ node: node.id, reason: 'multiplicity depends on runtime data or control flow' })
    }
    if (node.dynamicTarget) {
      uncertainties.push({ node: node.id, reason: 'child workflow target is selected at runtime' })
    }
    if (node.unresolved) uncertainties.push({ node: node.id, reason: 'local helper invocation could not be resolved' })
  }
  return uncertainties
}

function publicNode(node) {
  const { order, loopKeys, unresolved, siteKey, ...publicFields } = node
  return publicFields
}

export function analyzeWorkflowTopology(source, descriptors) {
  const index = buildTopologyIndex(parseWorkflowSource(source))
  const describeSite = descriptors?.(index)
  const candidates = index.primitives.flatMap(primitive => executionSites(primitive, index)
    .flatMap(site => {
      const resolved = describeSite?.(site)
      return (Array.isArray(resolved) ? resolved : [resolved]).map(value => nodeFromSite(site, index, value))
    }))
  // Repeated helper paths enrich one source launch site. They are alternatives,
  // not proof of extra launches or of an exact runtime model selection.
  const grouped = new Map()
  for (const node of candidates) {
    const key = `${node.source.definitionLine}:${node.siteKey}:${node.phase}`
    const prior = grouped.get(key)
    if (!prior) { grouped.set(key, node); continue }
    prior.models = [...new Set([...prior.models, prior.model, ...node.models, node.model].filter(Boolean))]
    prior.modelsComplete &&= node.modelsComplete
    if (prior.modelOrigin !== node.modelOrigin) prior.modelOrigin = 'mixed'
    prior.contextPhases = [...new Set([...prior.contextPhases, ...node.contextPhases])]
    if (prior.model !== node.model) prior.model = null
    if (prior.effort !== node.effort) prior.effort = null
    if (prior.label !== node.label || !node.labelExact) {
      prior.label = 'Agent call'; prior.labelExact = false; prior.labelDeclared = false
    }
    prior.multiplicity = { min: 0, max: null }
    prior.fanoutMultiplicity = { min: 0, max: null }
    prior.conditional = true
    prior.conditionalReason = prior.conditionalReason || node.conditionalReason || 'guard'
    prior.dynamicFanout = true
    prior.unresolved ||= node.unresolved
    prior.loopKeys = [...new Set([...prior.loopKeys, ...node.loopKeys])]
  }
  const nodes = [...grouped.values()]
  const loopGroups = assignIdsAndLoops(nodes)
  const phases = phasesFromNodes(index.meta, nodes)
  const totalMultiplicity = sumRanges(nodes.map(node => node.multiplicity))
  const uncertainties = uncertaintiesFromNodes(nodes)

  return {
    schemaVersion: 2,
    analysis: 'static',
    meta: index.meta,
    name: index.meta.name,
    phases,
    nodes: nodes.map(publicNode),
    total: compatibilityTotal(nodes),
    totalMultiplicity,
    loops: loopGroups.size > 0,
    partial: nodes.some(node => node.unresolved),
    uncertainties,
    dynamicDispatch: nodes.some(node => node.dynamicTarget),
  }
}
