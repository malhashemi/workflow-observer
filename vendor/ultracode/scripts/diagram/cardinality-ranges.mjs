/** Safe arithmetic for authoritative static multiplicity ranges. */

export const exactRange = value => ({ min: value, max: value })
export const unknownRange = (max = null) => ({ min: 0, max })
export const isExactRange = value => value.max !== null && value.min === value.max

function safeCardinality(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function multiplyRanges(left, right) {
  const min = safeCardinality(left.min * right.min)
  if (min === null) return unknownRange()
  const product = left.max === null || right.max === null ? null : left.max * right.max
  return {
    min,
    max: product === null ? null : safeCardinality(product),
  }
}

export function sumRanges(values) {
  let total = exactRange(0)
  for (const value of values) {
    const min = safeCardinality(total.min + value.min)
    if (min === null) return unknownRange()
    const sum = total.max === null || value.max === null ? null : total.max + value.max
    total = { min, max: sum === null ? null : safeCardinality(sum) }
  }
  return total
}
