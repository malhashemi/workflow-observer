/** Conservatively retain only unambiguous, immutable static bindings. */

import { childNodes } from './parse-workflow.mjs'

const MUTATING_METHODS = new Set(['pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'])
const FUNCTION_TYPES = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'])
// Unknown calls may mutate direct reference arguments. Preserve precision only
// for harness primitives and scalar/pure built-ins with non-mutating contracts.
const NON_ESCAPING_HARNESS_CALLS = new Set(['agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow'])
const NON_ESCAPING_GLOBAL_CALLS = new Set(['Boolean', 'Number', 'String', 'parseFloat', 'parseInt'])
const NON_ESCAPING_STATIC_METHODS = new Map([
  ['Array', new Set(['from', 'isArray'])],
  ['JSON', new Set(['parse', 'stringify'])],
  ['Math', new Set(['ceil', 'floor', 'max', 'min', 'round', 'trunc'])],
])
export const SHADOWED_GLOBALS = Symbol('shadowed workflow globals')
const NON_ESCAPING_LITERAL_ARRAY_METHODS = new Set(['filter', 'flatMap', 'map', 'slice'])
// The Workflow harness injects these bindings around the raw source after it is
// parsed. Count them up front so a nested declaration cannot masquerade as the
// outer runtime value during global conservative inference.
const INJECTED_BINDINGS = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow']

function memberRoot(node) {
  if (node?.type === 'Identifier') return node.name
  if (node?.type === 'ChainExpression') return memberRoot(node.expression)
  return node?.type === 'MemberExpression' ? memberRoot(node.object) : null
}

function patternNames(pattern) {
  if (!pattern) return []
  if (pattern.type === 'Identifier') return [pattern.name]
  if (pattern.type === 'RestElement') return patternNames(pattern.argument)
  if (pattern.type === 'AssignmentPattern') return patternNames(pattern.left)
  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(patternNames)
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap(property => patternNames(property.type === 'RestElement' ? property : property.value))
  }
  return []
}

function functionNames(node) {
  const ownName = node.id?.name ? [node.id.name] : []
  return [...ownName, ...node.params.flatMap(patternNames)]
}

const DECLARATION_READERS = new Map([
  ['CatchClause', node => patternNames(node.param)],
  ['ClassDeclaration', node => node.id ? [node.id.name] : []],
  ['ClassExpression', node => node.id ? [node.id.name] : []],
  ['ImportDefaultSpecifier', node => [node.local.name]],
  ['ImportNamespaceSpecifier', node => [node.local.name]],
  ['ImportSpecifier', node => [node.local.name]],
  ['VariableDeclarator', node => patternNames(node.id)],
])
function declaredNames(node) {
  if (FUNCTION_TYPES.has(node.type)) return functionNames(node)
  const reader = DECLARATION_READERS.get(node.type)
  return reader ? reader(node) : []
}

function declaredBinding(node) {
  if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || !node.init) return null
  return [node.id.name, node.init]
}

function mutation(name, throughReference = false) {
  return name ? [{ name, throughReference }] : []
}

function targetMutations(target) {
  if (!target) return []
  if (target.type === 'Identifier') return mutation(target.name)
  if (target.type === 'MemberExpression') return mutation(memberRoot(target), true)
  if (target.type === 'ChainExpression') return targetMutations(target.expression)
  if (target.type === 'RestElement') return targetMutations(target.argument)
  if (target.type === 'AssignmentPattern') return targetMutations(target.left)
  if (target.type === 'ArrayPattern') return target.elements.flatMap(targetMutations)
  if (target.type === 'ObjectPattern') return target.properties.flatMap(property => targetMutations(
    property.type === 'RestElement' ? property : property.value,
  ))
  return []
}

function mutatingCall(node) {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return []
  const method = node.callee.computed ? node.callee.property.value : node.callee.property.name
  return MUTATING_METHODS.has(method) ? mutation(memberRoot(node.callee.object), true) : []
}

function callName(node) {
  return node.callee.type === 'Identifier' ? node.callee.name : null
}

function isNonEscapingDirectCall(node, declarations) {
  const name = callName(node)
  if (NON_ESCAPING_HARNESS_CALLS.has(name)) return declarations.get(name) === 1
  return NON_ESCAPING_GLOBAL_CALLS.has(name) && !declarations.has(name)
}

function isNonEscapingStaticCall(node, shadowedGlobals) {
  if (node.callee.type !== 'MemberExpression' || node.callee.computed) return false
  const root = memberRoot(node.callee.object)
  return !shadowedGlobals.has(root) && NON_ESCAPING_STATIC_METHODS.get(root)?.has(node.callee.property.name)
}

function isNonEscapingLiteralArrayCall(node) {
  if (node.callee.type !== 'MemberExpression' || node.callee.object.type !== 'ArrayExpression') return false
  const method = node.callee.computed ? node.callee.property.value : node.callee.property.name
  return NON_ESCAPING_LITERAL_ARRAY_METHODS.has(method)
}

function escapingCall(node, declarations, shadowedGlobals) {
  if (node.type !== 'CallExpression') return []
  if (isNonEscapingDirectCall(node, declarations)
    || isNonEscapingStaticCall(node, shadowedGlobals)
    || isNonEscapingLiteralArrayCall(node)) return []
  return node.arguments.flatMap(argument => referenceMutations(
    argument.type === 'SpreadElement' ? argument.argument : argument,
  ))
}

function referenceMutations(node) {
  const root = memberRoot(node)
  if (root) return mutation(root, true)
  return childNodes(node).flatMap(referenceMutations)
}

function containedReferenceMutations(node) {
  const transparent = ['ArrayExpression', 'ChainExpression', 'ConditionalExpression', 'LogicalExpression',
    'MemberExpression', 'ObjectExpression']
  return transparent.includes(node?.type)
    ? childNodes(node).flatMap(referenceMutations)
    : []
}

function directWrite(node) {
  if (node.type === 'AssignmentExpression') return targetMutations(node.left)
  if (node.type === 'UpdateExpression') return targetMutations(node.argument)
  if (node.type === 'UnaryExpression' && node.operator === 'delete') return targetMutations(node.argument)
  if (['ForInStatement', 'ForOfStatement'].includes(node.type) && node.left.type !== 'VariableDeclaration') {
    return targetMutations(node.left)
  }
  return []
}

export function bindingIsWritten(nodes, name) {
  return nodes.some(node => directWrite(node)
    .some(event => event.name === name && !event.throughReference))
}

function rootIsWritten(nodes, name) {
  return nodes.some(node => directWrite(node).some(event => event.name === name))
}

function mutationEvents(node, declarations, shadowedGlobals) {
  return [...directWrite(node), ...mutatingCall(node), ...escapingCall(node, declarations, shadowedGlobals)]
}

function addAlias(graph, left, right) {
  if (!graph.has(left)) graph.set(left, new Set())
  if (!graph.has(right)) graph.set(right, new Set())
  graph.get(left).add(right)
  graph.get(right).add(left)
}

function declarationAlias(declaration) {
  return declaration.id.type === 'Identifier' && declaration.init?.type === 'Identifier'
    ? [declaration.id.name, declaration.init.name]
    : null
}

function assignmentAlias(node) {
  return node.type === 'AssignmentExpression' && node.operator === '='
    && node.left.type === 'Identifier' && node.right.type === 'Identifier'
    ? [node.left.name, node.right.name]
    : null
}

function aliasesFrom(node) {
  if (node.type === 'VariableDeclaration') return node.declarations.map(declarationAlias).filter(Boolean)
  const alias = assignmentAlias(node)
  return alias ? [alias] : []
}

function collectAliases(nodes) {
  const graph = new Map()
  for (const node of nodes) {
    for (const [left, right] of aliasesFrom(node)) addAlias(graph, left, right)
  }
  return graph
}

function aliasComponent(name, graph) {
  const found = new Set([name])
  const pending = [name]
  while (pending.length) {
    for (const alias of graph.get(pending.pop()) || []) {
      if (found.has(alias)) continue
      found.add(alias)
      pending.push(alias)
    }
  }
  return found
}

function referencedComponent(name, bindings, aliases) {
  const names = aliasComponent(name, aliases)
  const pending = [...names]
  while (pending.length) {
    const value = bindings.get(pending.pop())
    if (!value) continue
    for (const event of containedReferenceMutations(value)) {
      for (const nested of aliasComponent(event.name, aliases)) {
        if (names.has(nested)) continue
        names.add(nested)
        pending.push(nested)
      }
    }
  }
  return names
}
function invalidate(bindings, event, aliases) {
  const names = event.throughReference ? referencedComponent(event.name, bindings, aliases) : [event.name]
  for (const name of names) bindings.delete(name)
}
export function declarationCounts(nodes) {
  const declarations = new Map(INJECTED_BINDINGS.map(name => [name, 1]))
  for (const node of nodes) {
    for (const name of declaredNames(node)) declarations.set(name, (declarations.get(name) || 0) + 1)
  }
  return declarations
}

export function collectBindings(nodes) {
  const declarations = declarationCounts(nodes)
  const candidates = new Map()
  for (const node of nodes) {
    const binding = declaredBinding(node)
    if (binding) candidates.set(...binding)
  }
  const bindings = new Map([...candidates].filter(([name]) => declarations.get(name) === 1))
  const shadowedGlobals = new Set([...NON_ESCAPING_STATIC_METHODS.keys()]
    .filter(name => declarations.has(name) || rootIsWritten(nodes, name)))
  bindings.set(SHADOWED_GLOBALS, shadowedGlobals)
  const aliases = collectAliases(nodes)
  for (const node of nodes) {
    for (const event of mutationEvents(node, declarations, shadowedGlobals)) invalidate(bindings, event, aliases)
  }
  return bindings
}
