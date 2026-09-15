/** Parse Workflow-dialect source as inert ESTree data. */

import { parse } from '../../vendor/acorn.mjs'
import { extractMeta } from '../workflow-meta.mjs'

const MAX_SOURCE_BYTES = 1_000_000
const MAX_AST_NODES = 100_000
const MAX_AST_DEPTH = 512
const SKIP_KEYS = new Set(['end', 'loc', 'range', 'raw', 'sourceFile', 'start', 'type'])

export class WorkflowParseError extends Error {}

function astValues(value) {
  if (Array.isArray(value)) return value.filter(item => item && typeof item.type === 'string')
  return value && typeof value === 'object' && typeof value.type === 'string' ? [value] : []
}

export function childNodes(node) {
  const children = []
  for (const [key, value] of Object.entries(node || {})) {
    if (SKIP_KEYS.has(key) || value == null) continue
    children.push(...astValues(value))
  }
  return children
}

function indexAst(ast) {
  const nodes = []
  const parents = new WeakMap()
  const stack = [{ node: ast, parent: null, depth: 0 }]

  while (stack.length) {
    const { node, parent, depth } = stack.pop()
    if (depth > MAX_AST_DEPTH) throw new WorkflowParseError(`workflow AST exceeds depth limit ${MAX_AST_DEPTH}`)
    nodes.push(node)
    if (nodes.length > MAX_AST_NODES) throw new WorkflowParseError(`workflow AST exceeds node limit ${MAX_AST_NODES}`)
    if (parent) parents.set(node, parent)
    const children = childNodes(node)
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index], parent: node, depth: depth + 1 })
    }
  }
  return { nodes, parents }
}

export function parseWorkflowSource(source) {
  if (typeof source !== 'string') throw new WorkflowParseError('workflow source must be a string')
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new WorkflowParseError(`workflow source exceeds ${MAX_SOURCE_BYTES} bytes`)
  }

  const metaErrors = []
  const meta = extractMeta(source, metaErrors)
  if (!meta) throw new WorkflowParseError(metaErrors.join('; ') || 'workflow metadata is invalid')

  let ast
  try {
    ast = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
      ranges: true,
    })
  } catch (error) {
    throw new WorkflowParseError(`syntax error at ${error.loc?.line || 1}:${(error.loc?.column || 0) + 1}: ${error.message}`)
  }
  return { ast, meta, source, ...indexAst(ast) }
}

export function ancestorsOf(node, parents) {
  const ancestors = []
  for (let parent = parents.get(node); parent; parent = parents.get(parent)) ancestors.push(parent)
  return ancestors
}

export function containsNode(container, candidate) {
  return container.start <= candidate.start && candidate.end <= container.end
}
