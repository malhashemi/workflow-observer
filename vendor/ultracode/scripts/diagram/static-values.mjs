/** Conservative value and cardinality inference for static topology analysis. */

import { exactRange, isExactRange, sumRanges, unknownRange } from './cardinality-ranges.mjs'
import { SHADOWED_GLOBALS } from './static-bindings.mjs'
export { exactRange, isExactRange, multiplyRanges, sumRanges, unknownRange } from './cardinality-ranges.mjs'
export { bindingIsWritten, collectBindings, declarationCounts } from './static-bindings.mjs'
export function propertyOf(object, name) {
  if (object?.type !== 'ObjectExpression') return null
  return object.properties.find(property => {
    if (property.type !== 'Property' || property.computed) return false
    const key = property.key.type === 'Identifier' ? property.key.name : property.key.value
    return key === name
  })?.value || null
}
function finiteNumber(value) {
  return Number.isSafeInteger(value) ? value : null
}

function mergeRanges(left, right) {
  return {
    min: Math.min(left.min, right.min),
    max: left.max === null || right.max === null ? null : Math.max(left.max, right.max),
  }
}

function objectMemberNumberRange(node, bindings, seen) {
  if (node.object.type !== 'Identifier') return null
  const object = bindings.get(node.object.name)
  if (object?.type !== 'ObjectExpression') return null
  const key = staticKey(node.property, node.computed, bindings)
  if (key !== null) return knownObjectMemberRange(object, key, bindings, seen)
  return dynamicObjectMemberRange(object, bindings, seen)
}

function staticKey(node, computed, bindings) {
  if (!computed && node.type === 'Identifier') return node.name
  const value = stringValue(node, bindings)
  if (value !== null) return value
  return node.type === 'Literal' && node.value !== null ? String(node.value) : null
}

function propertyKey(property, bindings) {
  return property.type === 'Property' ? staticKey(property.key, property.computed, bindings) : null
}

function knownObjectMemberRange(object, key, bindings, seen, missing = unknownRange()) {
  for (let index = object.properties.length - 1; index >= 0; index--) {
    const property = object.properties[index]
    const candidate = propertyKey(property, bindings)
    if (candidate === null) return unknownRange()
    if (candidate === key) return numberRange(property.value, bindings, seen)
  }
  // Absent means undefined; its numeric effect is consumer-specific, so retain uncertainty here.
  return missing
}

function dynamicObjectMemberRange(object, bindings, seen) {
  const values = object.properties.map(property => property.type === 'Property'
    ? numberRange(property.value, bindings, seen)
    : null)
  if (!values.length || values.some(value => !value)) return unknownRange()
  return values.reduce(mergeRanges, exactRange(0))
}

function literalNumberRange(node) {
  const value = finiteNumber(node.value)
  return value === null ? null : exactRange(value)
}

function identifierNumberRange(node, bindings, seen) {
  if (seen.has(node.name)) return null
  const value = bindings.get(node.name)
  return value ? numberRange(value, bindings, new Set([...seen, node.name])) : null
}

function unaryNumberRange(node, bindings, seen) {
  if (!['+', '-'].includes(node.operator)) return null
  const value = numberRange(node.argument, bindings, seen)
  if (!value || !isExactRange(value)) return null
  return exactRange(node.operator === '-' ? -value.min : value.min)
}

function alternativeNumberRange(leftNode, rightNode, bindings, seen) {
  const left = numberRange(leftNode, bindings, seen)
  const right = numberRange(rightNode, bindings, seen)
  return left && right ? mergeRanges(left, right) : null
}

const NUMBER_READERS = new Map([
  ['ConditionalExpression', (node, bindings, seen) => alternativeNumberRange(node.consequent, node.alternate, bindings, seen)],
  ['Identifier', identifierNumberRange],
  ['Literal', literalNumberRange],
  ['LogicalExpression', (node, bindings, seen) => alternativeNumberRange(node.left, node.right, bindings, seen)],
  ['MemberExpression', objectMemberNumberRange],
  ['UnaryExpression', unaryNumberRange],
])

export function numberRange(node, bindings, seen = new Set()) {
  const reader = NUMBER_READERS.get(node?.type)
  return reader ? reader(node, bindings, seen) : null
}

function memberCall(node, name) {
  if (node?.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return null
  const property = node.callee.computed ? node.callee.property.value : node.callee.property.name
  return property === name ? node.callee.object : null
}

function isGlobalArrayFrom(node, bindings) {
  if (bindings.get(SHADOWED_GLOBALS)?.has('Array')) return false
  const owner = memberCall(node, 'from')
  return owner?.type === 'Identifier' && owner.name === 'Array'
}

function arrayFromRange(node, bindings, seen) {
  if (!isGlobalArrayFrom(node, bindings)) return null
  const input = node.arguments[0]
  if (input?.type !== 'ObjectExpression') return collectionRange(input, bindings, seen)
  const range = knownObjectMemberRange(input, 'length', bindings, seen, exactRange(0))
  if (!range) return null
  return {
    min: Math.max(0, range.min),
    max: range.max === null ? null : Math.max(0, range.max),
  }
}

function exactSliceRange(base, start, end) {
  const index = (value, fallback) => {
    if (value === null) return fallback
    return value < 0 ? Math.max(base.max + value, 0) : Math.min(value, base.max)
  }
  const from = index(start.min, 0)
  const to = index(end?.min ?? null, base.max)
  return exactRange(Math.max(0, to - from))
}

function sliceArgument(node, index, bindings, seen, fallback) {
  const supplied = node.arguments.length > index
  const range = supplied ? numberRange(node.arguments[index], bindings, seen) : fallback
  return { supplied, range }
}

function unresolvedSliceArgument(...arguments_) {
  return arguments_.some(argument => argument.supplied && !argument.range)
}

function exactSliceArguments(start, end) {
  return isExactRange(start) && (end === null || isExactRange(end))
}

function inexactSliceCap(base, start, end) {
  if (!end || start.min < 0 || end.min < 0) return base.max
  const bounded = Math.max(0, end.min - start.min)
  return base.max === null ? bounded : Math.min(base.max, bounded)
}

function sliceRange(node, bindings, seen) {
  const source = memberCall(node, 'slice')
  if (!source) return null
  const base = collectionRange(source, bindings, seen)
  const start = sliceArgument(node, 0, bindings, seen, exactRange(0))
  const end = sliceArgument(node, 1, bindings, seen, null)
  if (unresolvedSliceArgument(start, end)) return unknownRange(base.max)
  if (!exactSliceArguments(start.range, end.range)) return unknownRange(base.max)
  if (isExactRange(base)) return exactSliceRange(base, start.range, end.range)
  return unknownRange(inexactSliceCap(base, start.range, end.range))
}

function identifierCollectionRange(node, bindings, seen) {
  if (seen.has(node.name)) return unknownRange()
  const value = bindings.get(node.name)
  return value ? collectionRange(value, bindings, new Set([...seen, node.name])) : unknownRange()
}

function conditionalCollectionRange(node, bindings, seen) {
  return mergeRanges(
    collectionRange(node.consequent, bindings, seen),
    collectionRange(node.alternate, bindings, seen),
  )
}

function orchestrationCollectionRange(node, bindings, seen) {
  const name = node.callee.type === 'Identifier' ? node.callee.name : null
  return ['parallel', 'pipeline'].includes(name) ? collectionRange(node.arguments[0], bindings, seen) : null
}

function callCollectionRange(node, bindings, seen) {
  const orchestration = orchestrationCollectionRange(node, bindings, seen)
  if (orchestration) return orchestration
  const from = arrayFromRange(node, bindings, seen)
  if (from) return from
  const sliced = sliceRange(node, bindings, seen)
  if (sliced) return sliced
  const mapped = memberCall(node, 'map')
  if (mapped) return collectionRange(mapped, bindings, seen)
  const filtered = memberCall(node, 'filter')
  return filtered ? unknownRange(collectionRange(filtered, bindings, seen).max) : unknownRange()
}

function arrayExpressionRange(node, bindings, seen) {
  return sumRanges(node.elements.map(element => element?.type === 'SpreadElement'
    ? collectionRange(element.argument, bindings, seen)
    : exactRange(1)))
}

const COLLECTION_READERS = new Map([
  ['ArrayExpression', arrayExpressionRange],
  ['AwaitExpression', (node, bindings, seen) => collectionRange(node.argument, bindings, seen)],
  ['CallExpression', callCollectionRange],
  ['ConditionalExpression', conditionalCollectionRange],
  ['Identifier', identifierCollectionRange],
])

export function collectionRange(node, bindings, seen = new Set()) {
  const reader = COLLECTION_READERS.get(node?.type)
  return reader ? reader(node, bindings, seen) : unknownRange()
}

function normalizeLabel(value) {
  return value.replace(/\*+/gu, '*').replace(/\s+/gu, ' ').trim() || '*'
}

export function stringValue(node, bindings, seen = new Set()) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'Identifier') {
    if (seen.has(node.name)) return null
    const value = bindings.get(node.name)
    return value ? stringValue(value, bindings, new Set([...seen, node.name])) : null
  }
  return null
}

export function expressionLabel(node, bindings) {
  const literal = stringValue(node, bindings)
  if (literal !== null) return { text: literal, exact: true }
  if (node?.type === 'TemplateLiteral') {
    let text = ''
    for (let index = 0; index < node.quasis.length; index++) {
      text += node.quasis[index].value.cooked ?? node.quasis[index].value.raw
      if (index < node.expressions.length) text += '*'
    }
    return { text: normalizeLabel(text), exact: false }
  }
  return { text: '*', exact: false }
}

export function renderHint(range) {
  return isExactRange(range) ? range.max : 1
}
