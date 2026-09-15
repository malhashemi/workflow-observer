/** Index call sites and derive static orchestration context without interpretation. */

import { ancestorsOf, childNodes, containsNode } from './parse-workflow.mjs'
import {
  bindingIsWritten,
  collectBindings,
  collectionRange,
  declarationCounts,
  exactRange,
  multiplyRanges,
  propertyOf,
  stringValue,
  unknownRange,
} from './static-values.mjs'
const LOOP_TYPES = new Set(['DoWhileStatement', 'ForInStatement', 'ForOfStatement', 'ForStatement', 'WhileStatement'])
const CONDITIONAL_TYPES = new Set(['CatchClause', 'ConditionalExpression', 'IfStatement', 'LogicalExpression', 'SwitchCase'])
function calledName(node) {
  return node.type === 'CallExpression' && node.callee.type === 'Identifier' ? node.callee.name : null
}
function declaredFunctionName(node, parents) {
  if (node.type === 'FunctionDeclaration') return node.id?.name || null
  const parent = parents.get(node)
  return parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier' ? parent.id.name : null
}
function containingFunction(node, parents) {
  for (const ancestor of ancestorsOf(node, parents)) {
    if (!['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(ancestor.type)) continue
    const name = declaredFunctionName(ancestor, parents)
    if (name) return { name, node: ancestor }
  }
  return null
}
function containsReturn(node) {
  const stack = [node]
  while (stack.length) {
    const current = stack.pop()
    if (current.type === 'ReturnStatement') return true
    stack.push(...childNodes(current))
  }
  return false
}
function functionHasPriorGuard(primitive, fn) {
  const body = fn?.node.body?.body
  if (!Array.isArray(body)) return false
  return body.some(statement => statement.type === 'IfStatement'
    && statement.end <= primitive.start && containsReturn(statement))
}
function topLevelGuardStarts(ast, firstPrimitiveStart) {
  return ast.body
    .filter(statement => statement.type === 'IfStatement'
      && statement.start > firstPrimitiveStart && containsReturn(statement))
    .map(statement => statement.start)
}
function uniqueNodes(nodes) {
  return [...new Set(nodes)]
}

function subjectWithin(call, primitive, origin) {
  return containsNode(call, origin) ? origin : primitive
}

function parallelRange(call, subject, bindings) {
  const input = call.arguments[0]
  if (input?.type === 'ArrayExpression') {
    const lane = input.elements.find(element => element && containsNode(element, subject))
    if (lane) return lane.type === 'SpreadElement' ? collectionRange(lane.argument, bindings) : exactRange(1)
  }
  return collectionRange(input, bindings)
}

function loopRange(loop, bindings) {
  if (loop.type === 'ForOfStatement') return collectionRange(loop.right, bindings)
  if (loop.type === 'DoWhileStatement') return { min: 1, max: null }
  return unknownRange()
}

function pipelineStage(call, subject) {
  const index = call.arguments.findIndex(argument => argument && containsNode(argument, subject))
  return index > 0 ? index - 1 : null
}

function possibleWorkflowTargets(nodes, bindings) {
  const targets = new Set()
  for (const node of nodes) {
    if (node.type !== 'ObjectExpression') continue
    const workflow = stringValue(propertyOf(node, 'workflow'), bindings)
    const kind = stringValue(propertyOf(node, 'kind'), bindings)
    if (workflow && kind !== 'handoff') targets.add(workflow)
  }
  return [...targets].sort()
}

function recordIndexNode(node, calls) {
  const name = calledName(node)
  if (name) {
    if (!calls.has(name)) calls.set(name, [])
    calls.get(name).push(node)
  }
}

function callIndex(nodes) {
  const calls = new Map()
  for (const node of nodes) recordIndexNode(node, calls)
  return calls
}

function phaseIndex(calls, parents, bindings) {
  return (calls.get('phase') || [])
    .filter(call => !containingFunction(call, parents))
    .map(call => ({ call, title: stringValue(call.arguments[0], bindings) }))
    .filter(phase => phase.title)
    .sort((left, right) => left.call.start - right.call.start)
}

export function buildTopologyIndex(parsed) {
  const { ast, nodes, parents } = parsed
  const bindings = collectBindings(nodes)
  const calls = callIndex(nodes)
  const primitives = [...(calls.get('agent') || []), ...(calls.get('workflow') || [])]
    .sort((left, right) => left.start - right.start)
  const firstPrimitiveStart = primitives[0]?.start ?? Number.MAX_SAFE_INTEGER

  return {
    ...parsed,
    bindings,
    calls,
    declarations: declarationCounts(nodes),
    primitives,
    phases: phaseIndex(calls, parents, bindings),
    topLevelGuards: topLevelGuardStarts(ast, firstPrimitiveStart),
    possibleWorkflowTargets: possibleWorkflowTargets(nodes, bindings),
  }
}

function isDeclarationIdentifier(node, parent) {
  return ['FunctionDeclaration', 'VariableDeclarator'].includes(parent?.type) && parent.id === node
}
function isStaticPropertyName(node, parent) {
  if (parent?.computed) return false
  if (parent?.type === 'MemberExpression') return parent.property === node
  return parent?.type === 'Property' && parent.key === node && parent.value !== node
}
function unresolvedHelperReference(node, name, parents) {
  if (node.type !== 'Identifier' || node.name !== name) return false
  const parent = parents.get(node)
  if (parent?.type === 'CallExpression' && parent.callee === node) return false
  if (parent?.type === 'CallExpression' && calledName(parent) === 'pipeline'
    && parent.arguments.indexOf(node) > 0) return false
  return !isDeclarationIdentifier(node, parent) && !isStaticPropertyName(node, parent)
}

export function executionSites(primitive, index) {
  const sites = []
  const queue = [{ origin: primitive, chain: [], seen: new Set(), callbacks: [] }]
  const uncertain = new Set()
  const addUnknown = site => {
    const key = site.chain.at(-2)?.start ?? primitive.start
    if (!uncertain.has(key)) { uncertain.add(key); sites.push({ ...site, unresolved: true }) }
  }
  // Breadth first: recursion cannot exhaust the budget before direct callers are visited.
  for (let i = 0; i < queue.length && i < 512; i++) {
    const { origin, chain, seen, callbacks } = queue[i]
    const owner = containingFunction(origin, index.parents)
    const site = { primitive, origin, chain: [origin, ...chain], helper: owner?.name ?? null, callbacks }
    if (!owner) { sites.push(site); continue }
    if (seen.size >= 10 || seen.has(owner.node)) { addUnknown(site); continue }
    const ambiguous = index.declarations.get(owner.name) !== 1
      || bindingIsWritten(index.nodes, owner.name)
    const calls = ambiguous ? [] : (index.calls.get(owner.name) || []).filter(call => call !== primitive)
    const stages = ambiguous ? [] : (index.calls.get('pipeline') || []).flatMap(call =>
      call.arguments.flatMap((arg, stage) => stage > 0 && arg.type === 'Identifier' && arg.name === owner.name
        ? [{ call, stage, fn: owner.node }] : []))
    for (const call of calls) {
      if (queue.length >= 512) { addUnknown(site); break }
      queue.push({ origin: call, chain: site.chain, seen: new Set([...seen, owner.node]), callbacks })
    }
    for (const callback of stages) {
      if (queue.length >= 512) { addUnknown(site); break }
      queue.push({ origin: callback.call, chain: site.chain, seen: new Set([...seen, owner.node]), callbacks: [callback, ...callbacks] })
    }
    if ((!calls.length && !stages.length) || ambiguous
      || index.nodes.some(node => unresolvedHelperReference(node, owner.name, index.parents)))
      addUnknown(site)
  }
  return sites
}

function siteContextParts(site, index) {
  const ancestors = uniqueNodes((site.chain || [site.primitive, site.origin])
    .flatMap(node => ancestorsOf(node, index.parents)))
  return {
    ancestors,
    parallel: ancestors.filter(node => calledName(node) === 'parallel'),
    pipeline: ancestors.filter(node => calledName(node) === 'pipeline'),
    loops: ancestors.filter(node => LOOP_TYPES.has(node.type)),
  }
}

function fanoutRange(parallel, pipeline, subject, bindings) {
  let range = exactRange(1)
  for (const call of parallel) range = multiplyRanges(range, parallelRange(call, subject(call), bindings))
  for (const call of pipeline) range = multiplyRanges(range, collectionRange(call.arguments[0], bindings))
  return range
}

function repetitionRange(loops, bindings) {
  let range = exactRange(1)
  for (const loop of loops) range = multiplyRanges(range, loopRange(loop, bindings))
  return range
}

function contextKind(parallel, pipeline) {
  if (parallel.length >= 2) return 'panel'
  if (pipeline.length) return 'pipeline'
  return parallel.length ? 'barrier' : 'single'
}

function isDynamicRange(range) {
  return range.max === null || range.min !== range.max
}

function hasDynamicFanout(parallel, pipeline, subject, bindings) {
  return parallel.some(call => isDynamicRange(parallelRange(call, subject(call), bindings)))
    || pipeline.some(call => isDynamicRange(collectionRange(call.arguments[0], bindings)))
}

export function contextForSite(site, index) {
  const { primitive, origin } = site
  const { ancestors, parallel, pipeline, loops } = siteContextParts(site, index)
  const owner = containingFunction(primitive, index.parents)
  // Three different reasons a call site might not happen, kept apart because a
  // reader acts on them differently. `loop`: the body may run zero times.
  // `branch`: this site sits inside an if/ternary/catch — the run continues
  // either way, this phase just may not appear. `guard`: an early `return`
  // ABOVE it can end the whole run, so everything downstream inherits the same
  // doubt. Collapsing all three into one boolean is why nearly every phase in
  // the library reads "optional" and the word stops meaning anything.
  const inZeroableLoop = loops.some(loop => loop.type !== 'DoWhileStatement')
  const inBranch = ancestors.some(node => CONDITIONAL_TYPES.has(node.type))
  const behindGuard = functionHasPriorGuard(primitive, owner)
    || index.topLevelGuards.some(start => start < origin.start)
  const conditional = inBranch || behindGuard || inZeroableLoop
  const conditionalReason = inZeroableLoop ? 'loop' : inBranch ? 'branch' : behindGuard ? 'guard' : null
  const subject = call => subjectWithin(call, primitive, origin)
  const fanoutMultiplicity = site.unresolved
    ? unknownRange()
    : fanoutRange(parallel, pipeline, subject, index.bindings)
  const repeatMultiplicity = repetitionRange(loops, index.bindings)
  const multiplicity = multiplyRanges(fanoutMultiplicity, repeatMultiplicity)
  if (conditional) multiplicity.min = 0

  return {
    kind: contextKind(parallel, pipeline),
    multiplicity,
    fanoutMultiplicity,
    repeatMultiplicity,
    conditional,
    conditionalReason,
    guarded: behindGuard,
    loopKeys: loops.map(loop => loop.start),
    pipeline: pipeline.map(call => ({ id: call.start, stage: pipelineStage(call, subject(call)) }))
      .find(item => item.stage !== null) || null,
    dynamicFanout: site.unresolved || hasDynamicFanout(parallel, pipeline, subject, index.bindings),
  }
}

export function activePhaseAt(position, index) {
  let active = null
  for (const phase of index.phases) {
    if (phase.call.start >= position) break
    active = phase.title
  }
  return active
}

/** Lexically preceding phase declarations along a resolved helper call path.
 * This describes source context, independently of an agent's explicit assignment. */
export function phaseContextForSite(site, index) {
  let phase = null
  for (const call of site.chain || [site.origin]) {
    const owner = containingFunction(call, index.parents)?.node
    const ancestors = ancestorsOf(call, index.parents)
    const candidates = (index.calls.get('phase') || []).filter(marker => {
      if (marker.start >= call.start || containingFunction(marker, index.parents)?.node !== owner) return false
      const block = ancestorsOf(marker, index.parents).find(n => n.type === 'BlockStatement' || n.type === 'Program')
      return ancestors.includes(block)
    })
    const marker = candidates.sort((a, b) => b.start - a.start)[0]
    const title = marker && stringValue(marker.arguments[0], index.bindings)
    if (title) phase = title
  }
  return phase
}
