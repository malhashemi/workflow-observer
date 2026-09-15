import { ancestorsOf, childNodes } from "../vendor/ultracode/scripts/diagram/parse-workflow.mjs";
import type { RecordData } from "./types";

type Node = RecordData;
const unknown = Symbol("runtime value");
type Value =
  | typeof unknown
  | string
  | number
  | boolean
  | null
  | undefined
  | Value[]
  | Fields
  | Choices;
type Fields = { fields: Map<string, Value>; rest: Value };
type Choices = { choices: Value[] };
type Binding = { node: Node; init?: Node; path: string[] };
type Env = Map<Binding, Value>;
const isFields = (v: Value): v is Fields => typeof v === "object" && v !== null && "fields" in v;
const isChoices = (v: Value): v is Choices => typeof v === "object" && v !== null && "choices" in v;
const valuesOf = (v: Value): Value[] => (isChoices(v) ? v.choices : [v]);
const choices = (values: Value[]): Value => {
  const unique = [...new Set(values.flatMap(valuesOf))];
  return unique.length > 128 ? unknown : unique.length === 1 ? unique[0] : { choices: unique };
};
const variableLists = new WeakSet<Value[]>();
const variableList = (values: Value[]): Value[] => {
  variableLists.add(values);
  return values;
};
const listOf = (value: Value): Value[] | null => {
  if (Array.isArray(value)) return value;
  if (!isChoices(value) || !value.choices.some(Array.isArray)) return null;
  return variableList(value.choices.flatMap((v) => (Array.isArray(v) ? v : [unknown])));
};
const field = (v: Value, key: string): Value =>
  isChoices(v)
    ? choices(v.choices.map((value) => field(value, key)))
    : isFields(v)
      ? v.fields.has(key)
        ? v.fields.get(key)!
        : v.rest
      : Array.isArray(v)
        ? key === "length"
          ? variableLists.has(v)
            ? unknown
            : v.length
          : /^\d+$/.test(key)
            ? v[Number(key)]
            : unknown
        : v == null
          ? undefined
          : unknown;
const scalar = (v: Value) => v !== unknown && !isFields(v) && !Array.isArray(v) && !isChoices(v);
const truth = (v: Value): boolean | typeof unknown => {
  const choices = valuesOf(v).map((value) => (value === unknown ? unknown : !!value));
  return choices.every((value) => value === choices[0]) ? choices[0] : unknown;
};
const functions = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const scopes = new Set([
  "Program",
  "BlockStatement",
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "CatchClause",
  ...functions,
]);

/** Bounded data-flow over inert AST nodes. Only JSON, literals and local data expressions
 * can supply metadata. No source function, getter, import or runtime primitive is executed. */
export function argumentDescriptors(index: RecordData, args: unknown, defaultModel?: string) {
  const nodes: Node[] = index.nodes;
  const parents: WeakMap<Node, Node> = index.parents;
  const definitions = new Map<Node, Map<string, Binding>>();

  let remaining = 100_000;
  const ancestorCache = new WeakMap<Node, Node[]>();
  const enclosing = (node: Node) => {
    if (!ancestorCache.has(node)) ancestorCache.set(node, ancestorsOf(node, parents));
    return ancestorCache.get(node)!;
  };
  const scope = (node: Node, includeSelf = false) =>
    (includeSelf ? [node, ...enclosing(node)] : enclosing(node)).find((n) => scopes.has(n.type))!;
  const define = (pattern: Node, owner: Node, init?: Node, path: string[] = []) => {
    if (pattern.type === "Identifier") {
      const table = definitions.get(owner) ?? new Map();
      const binding = { node: pattern, init, path };
      // Ambiguous declarations never inherit a similarly named value.
      if (table.has(pattern.name)) binding.init = undefined;
      table.set(pattern.name, binding);
      definitions.set(owner, table);
    } else if (pattern.type === "ObjectPattern") {
      for (const p of pattern.properties)
        if (p.type === "Property" && !p.computed)
          define(p.value, owner, init, [...path, p.key.name ?? String(p.key.value)]);
    } else if (pattern.type === "ArrayPattern") {
      pattern.elements.forEach((p: Node | null, i: number) => {
        if (p) define(p, owner, init, [...path, String(i)]);
      });
    } else if (pattern.type === "AssignmentPattern") define(pattern.left, owner, init, path);
  };
  for (const n of nodes) {
    if (n.type === "VariableDeclarator")
      define(
        n.id,
        parents.get(n)?.kind === "var"
          ? enclosing(n).find((p) => functions.has(p.type) || p.type === "Program")!
          : scope(n),
        n.init,
      );
    if (functions.has(n.type)) {
      for (const p of n.params) define(p, n);
      if (n.type === "FunctionDeclaration" && n.id) define(n.id, scope(n), n);
    }
    if (n.type === "CatchClause" && n.param) define(n.param, n);
  }
  const bindingAt = (name: string, at: Node): Binding | undefined => {
    for (const owner of [at, ...enclosing(at)]) {
      const binding = definitions.get(owner)?.get(name);
      if (binding) return binding;
    }
  };
  const fromJSON = (value: unknown, depth = 0): Value => {
    if (--remaining < 0 || depth > 40) return unknown;
    if (value === null || ["string", "boolean", "number", "undefined"].includes(typeof value))
      return value as Value;
    if (Array.isArray(value))
      return value.length <= 128 ? value.map((v) => fromJSON(v, depth + 1)) : unknown;
    if (typeof value !== "object") return unknown;
    const fields = new Map<string, Value>();
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)))
      fields.set(key, "value" in descriptor ? fromJSON(descriptor.value, depth + 1) : unknown);
    return { fields, rest: undefined };
  };
  const recorded = args === undefined ? unknown : fromJSON(args);
  const writes = nodes.filter(
    (n) =>
      ["AssignmentExpression", "UpdateExpression", "UnaryExpression"].includes(n.type) &&
      (n.type !== "UnaryExpression" || n.operator === "delete"),
  );
  const nameRoot = (
    node: Node,
  ): { binding: Binding | undefined; name: string; path: string[] } | null => {
    if (node?.type === "ChainExpression") return nameRoot(node.expression);
    if (node?.type === "Identifier")
      return { binding: bindingAt(node.name, node), name: node.name, path: [] };
    if (node?.type !== "MemberExpression") return null;
    const root = nameRoot(node.object);
    if (!root) return null;
    const key = !node.computed
      ? node.property.name
      : node.property.type === "Literal"
        ? String(node.property.value)
        : "*";
    return { ...root, path: [...root.path, key] };
  };
  // Reference aliases propagate writes to the original object (including nested records).
  const reference = (node: Node, seen = new Set<Binding>()): ReturnType<typeof nameRoot> => {
    const root = nameRoot(node);
    if (!root?.binding || seen.has(root.binding)) return root;
    const source = root.binding.init;
    const alias = source && reference(source, new Set([...seen, root.binding]));
    return alias ? { ...alias, path: [...alias.path, ...root.binding.path, ...root.path] } : root;
  };
  const functionFor = (callee: Node): Node | null => {
    if (functions.has(callee?.type)) return callee;
    const binding = callee?.type === "Identifier" ? bindingAt(callee.name, callee) : undefined;
    const value = binding?.init;
    if (
      binding &&
      writes.some(
        (w) => w.left?.type === "Identifier" && bindingAt(w.left.name, w.left) === binding,
      )
    )
      return null;
    return value && functions.has(value.type) ? value : null;
  };
  type Reference = NonNullable<ReturnType<typeof reference>> & { cause?: Node };
  const calls = nodes.filter((n) => n.type === "CallExpression" || n.type === "NewExpression");
  const harmless = new Set([
    "agent",
    "workflow",
    "phase",
    "log",
    "parallel",
    "pipeline",
    "String",
    "Number",
    "Boolean",
    "parseInt",
    "parseFloat",
    "Set",
    "Map",
  ]);
  const staticReadOnly = new Set([
    "JSON.stringify",
    "JSON.parse",
    "Array.isArray",
    "Array.from",
    "Object.keys",
    "Object.values",
    "Object.entries",
    "Math.min",
    "Math.max",
  ]);
  harmless.add("structuredClone");
  const readOnlyMethods = new Set([
    "map",
    "filter",
    "some",
    "every",
    "find",
    "findIndex",
    "includes",
    "slice",
    "flat",
    "flatMap",
    "join",
    "trim",
    "startsWith",
    "endsWith",
  ]);
  const callbackMethods = new Set([
    "map",
    "filter",
    "some",
    "every",
    "find",
    "findIndex",
    "flatMap",
  ]);
  const refsIn = (n: Node): Reference[] => {
    const ref = reference(n);
    if (ref) return [ref];
    if (functions.has(n?.type)) return [];
    return childNodes(n).flatMap(refsIn);
  };
  const globalMember = (node: Node, name: string) => {
    const root = nameRoot(node);
    return !!root && !root.binding && [root.name, ...root.path].join(".") === name;
  };
  const unsafePushTargets = new Set<Binding | string>();
  const arrayData = (node: Node | undefined, seen = new Set<Binding>(), depth = 0): boolean => {
    if (!node || depth > 12) return false;
    if (node.type === "ArrayExpression") return true;
    if (node.type === "Identifier") {
      const binding = bindingAt(node.name, node);
      if (!binding) return false;
      if (seen.has(binding)) return true;
      const next = new Set([...seen, binding]);
      const assigned = writes.filter(
        (w) =>
          w.type === "AssignmentExpression" &&
          w.left.type === "Identifier" &&
          bindingAt(w.left.name, w.left) === binding,
      );
      return (
        arrayData(binding.init, next, depth + 1) &&
        assigned.every((w) => w.operator === "=" && arrayData(w.right, next, depth + 1))
      );
    }
    if (node.type !== "CallExpression") return false;
    // Native JSON cloning cannot produce a callable own push property.
    if (
      globalMember(node.callee, "JSON.parse") &&
      node.arguments.length === 1 &&
      node.arguments[0]?.type === "CallExpression" &&
      globalMember(node.arguments[0].callee, "JSON.stringify")
    )
      return true;
    const fn = functionFor(node.callee);
    if (fn && !fn.async && fn.body.type !== "BlockStatement")
      return arrayData(fn.body, seen, depth + 1);
    return (
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      ["map", "filter", "flat", "slice"].includes(node.callee.property.name) &&
      arrayData(node.callee.object, seen, depth + 1)
    );
  };
  const nativePush = (call: Node) => {
    if (
      call?.callee?.type !== "MemberExpression" ||
      call.callee.computed ||
      call.callee.property.name !== "push" ||
      !arrayData(call.callee.object)
    )
      return false;
    const receiver = reference(call.callee.object);
    if (unsafePushTargets.has("Array") || unsafePushTargets.has("JSON")) return false;
    if (receiver && unsafePushTargets.has(receiver.binding ?? receiver.name)) return false;
    return !writes.some((w) => {
      const target = reference(w.left ?? w.argument);
      return (
        target &&
        ((!target.binding && ["Array", "JSON"].includes(target.name)) ||
          (receiver &&
            target.binding === receiver.binding &&
            target.name === receiver.name &&
            target.path.includes("push")))
      );
    });
  };
  const functionNodes = nodes.filter((n) => functions.has(n.type));
  const owned = (items: Node[]) => {
    const groups = new Map<Node, Node[]>();
    for (const item of items) {
      const fn = enclosing(item).find((n) => functions.has(n.type));
      if (fn) groups.set(fn, [...(groups.get(fn) ?? []), item]);
    }
    return groups;
  };
  const ownedCalls = owned(calls),
    ownedWrites = owned(writes);
  const ids = new Map<Binding, number>();
  for (const table of definitions.values())
    for (const binding of table.values()) ids.set(binding, ids.size);
  const referenceKey = (r: Reference) =>
    JSON.stringify([r.binding ? ids.get(r.binding) : r.name, r.path, r.cause?.start]);
  const dedupe = (refs: Reference[]) => [
    ...new Map(
      refs.map((r) => {
        // A recursive helper can add arbitrarily many nested accesses. A wildcard
        // suffix conservatively covers deeper mutations and makes the lattice finite.
        const ref = r.path.length > 8 ? { ...r, path: [...r.path.slice(0, 7), "*"] } : r;
        return [referenceKey(ref), ref] as const;
      }),
    ).values(),
  ];
  let summaries = new Map<Node, Reference[]>();
  const effects = (call: Node): Reference[] => {
    const callee = call.callee;
    if (
      callee.type === "Identifier" &&
      callee.name === "pipeline" &&
      !bindingAt("pipeline", callee)
    ) {
      const input = reference(call.arguments[0]);
      return call.arguments.slice(1).flatMap((stage: Node) => {
        const fn = functionFor(stage);
        if (!fn) return input ? [{ ...input, path: [...input.path, "*", "*"], cause: call }] : [];
        return (summaries.get(fn) ?? []).flatMap((ref) => {
          const parameter = ref.binding
            ? fn.params.findIndex(
                (p: Node) => p.start <= ref.binding!.node.start && p.end >= ref.binding!.node.end,
              )
            : -1;
          if (parameter < 0) return [ref];
          if (parameter > 1 || !ref.path.length) return [];
          // Original items are shared between stages. A previous result may also
          // alias an item; mutations through either parameter are conservative.
          return input
            ? [
                {
                  ...input,
                  path: [...input.path, "*", ...ref.binding!.path, ...ref.path],
                  cause: ref.cause,
                },
              ]
            : [];
        });
      });
    }
    if (
      callee.type === "Identifier" &&
      harmless.has(callee.name) &&
      !bindingAt(callee.name, callee)
    )
      return [];
    if (callee.type === "MemberExpression" && !callee.computed) {
      if (
        callee.object.type === "Identifier" &&
        !bindingAt(callee.object.name, callee.object) &&
        staticReadOnly.has(`${callee.object.name}.${callee.property.name}`)
      )
        return [];
      if (nativePush(call)) {
        const receiver = reference(callee.object);
        return receiver ? [{ ...receiver, path: [...receiver.path, "*"], cause: call }] : [];
      }
      if (readOnlyMethods.has(callee.property.name)) {
        const callback = functionFor(call.arguments[0]);
        if (!callback) {
          if (
            call.arguments[0]?.type === "Identifier" &&
            call.arguments[0].name === "Boolean" &&
            !bindingAt("Boolean", call.arguments[0])
          )
            return [];
          const receiver = reference(callee.object);
          return callbackMethods.has(callee.property.name) && receiver
            ? [{ ...receiver, path: [...receiver.path, "*", "*"], cause: call }]
            : [];
        }
        return (summaries.get(callback) ?? []).flatMap((ref) => {
          const parameter =
            ref.binding &&
            callback.params.some(
              (p: Node) => p.start <= ref.binding!.node.start && p.end >= ref.binding!.node.end,
            );
          if (!parameter) return [ref];
          if (!ref.path.length) return [];
          const receiver = reference(callee.object);
          return receiver
            ? [
                {
                  ...receiver,
                  path: [...receiver.path, "*", ...ref.binding!.path, ...ref.path],
                  cause: ref.cause,
                },
              ]
            : [];
        });
      }
    }
    const fn = functionFor(callee);
    if (!fn)
      return [
        ...call.arguments.flatMap(refsIn),
        ...(callee.type === "MemberExpression" ? refsIn(callee.object) : []),
      ].map((r) => ({ ...r, path: [...r.path, "*"], cause: call }));
    return (summaries.get(fn) ?? []).flatMap((ref) => {
      const position = ref.binding
        ? fn.params.findIndex(
            (p: Node) => p.start <= ref.binding!.node.start && p.end >= ref.binding!.node.end,
          )
        : -1;
      if (position >= 0) {
        if (!ref.path.length) return []; // A parameter reassignment does not mutate its caller.
        const target = call.arguments[position] && reference(call.arguments[position]);
        return target
          ? [
              {
                ...target,
                path: [...target.path, ...ref.binding!.path, ...ref.path],
                cause: ref.cause,
              },
            ]
          : [];
      }
      return [ref];
    });
  };
  // Summarize local helper effects to a fixed point. Recursive calls share these
  // summaries instead of poisoning every argument merely because a cycle exists.
  let effectsComplete = false;
  for (let pass = 0; pass < 32; pass++) {
    const next = new Map<Node, Reference[]>();
    let changed = false;
    for (const fn of functionNodes) {
      const refs = dedupe([
        ...(summaries.get(fn) ?? []),
        ...(ownedWrites.get(fn) ?? [])
          .map((w) => {
            const r = reference(w.left ?? w.argument);
            return r ? { ...r, cause: w } : null;
          })
          .filter((r): r is Reference & { cause: Node } => !!r),
        ...(ownedCalls.get(fn) ?? []).flatMap(effects),
      ]).filter(
        (ref) =>
          !ref.binding ||
          !enclosing(ref.binding.node).includes(fn) ||
          fn.params.some(
            (p: Node) => p.start <= ref.binding!.node.start && p.end >= ref.binding!.node.end,
          ),
      );
      next.set(fn, refs);
      if (refs.length !== (summaries.get(fn)?.length ?? 0)) changed = true;
      remaining -= refs.length;
    }
    summaries = next;
    for (const ref of [...next.values()].flat().concat(calls.flatMap(effects))) {
      if (ref.path.at(-1) !== "push" && !(ref.path.length === 1 && ref.path[0] === "*")) continue;
      if (ref.cause && nativePush(ref.cause)) continue;
      const target = ref.binding ?? ref.name;
      if (!unsafePushTargets.has(target)) {
        unsafePushTargets.add(target);
        changed = true;
      }
    }
    if (remaining < 0) break;
    if (!changed) {
      effectsComplete = true;
      break;
    }
  }
  let mutations = dedupe([
    ...writes
      .map((w) => {
        const r = reference(w.left ?? w.argument);
        return r ? { ...r, cause: w } : null;
      })
      .filter((r): r is Reference & { cause: Node } => !!r),
    ...calls.flatMap(effects),
  ]);
  const storedReferences = (
    node: Node,
    path: string[] = [],
  ): { source: Reference; path: string[] }[] => {
    const source = reference(node);
    if (source) return [{ source, path }];
    if (node?.type === "ObjectExpression")
      return node.properties.flatMap((p: Node) =>
        p.type === "Property" && p.kind === "init" && !p.computed && !p.method
          ? storedReferences(p.value, [...path, p.key.name ?? String(p.key.value)])
          : p.type === "SpreadElement"
            ? storedReferences(p.argument, [...path, "*"])
            : [],
      );
    return [];
  };
  const stores = calls.filter(nativePush).flatMap((call) => {
    const target = reference(call.callee.object);
    return target
      ? call.arguments.flatMap((arg: Node) =>
          storedReferences(arg).map((ref) => ({
            ...ref,
            target,
            call,
            path: [...target.path, "*", ...ref.path],
          })),
        )
      : [];
  });
  // push stores references; it does not modify its arguments. Later mutations
  // through the receiving array must still invalidate those original objects.
  for (let pass = 0; pass < 16; pass++) {
    const propagated = stores.flatMap((store) =>
      mutations.flatMap((ref) => {
        if (
          ref.binding !== store.target.binding ||
          ref.name !== store.target.name ||
          ref.cause === store.call
        )
          return [];
        if (
          ref.cause?.type === "AssignmentExpression" &&
          ref.cause.left.type === "Identifier" &&
          !ref.path.length
        )
          return [];
        if (ref.cause && nativePush(ref.cause)) return [];
        const prefix = Math.min(ref.path.length, store.path.length);
        if (
          !ref.path
            .slice(0, prefix)
            .every((key, i) => key === "*" || store.path[i] === "*" || key === store.path[i])
        )
          return [];
        return [
          {
            ...store.source,
            path: [
              ...store.source.path,
              ...(ref.path.length > store.path.length ? ref.path.slice(store.path.length) : ["*"]),
            ],
            cause: ref.cause,
          },
        ];
      }),
    );
    const next = dedupe([...mutations, ...propagated]);
    if (next.length === mutations.length) break;
    mutations = next;
    if (pass === 15 || mutations.length > 10000) effectsComplete = false;
  }
  const mutationCache = new Map<Binding | string, string[][]>();
  const mutationPaths = (binding: Binding | undefined, name: string) =>
    mutationCache.get(binding ?? name) ??
    (() => {
      const paths = [
        ...new Map(
          mutations
            .filter((ref) =>
              binding ? ref.binding === binding : !ref.binding && ref.name === name,
            )
            .map((ref) => [JSON.stringify(ref.path), ref.path]),
        ).values(),
      ];
      mutationCache.set(binding ?? name, paths);
      return paths;
    })();
  const appendPaths = (binding: Binding | undefined, name: string) => {
    const refs = mutations.filter((ref) =>
      binding ? ref.binding === binding : !ref.binding && ref.name === name,
    );
    return mutationPaths(binding, name).filter((path) => {
      const related = refs.filter((ref) => JSON.stringify(ref.path) === JSON.stringify(path));
      return (
        related.length &&
        related.every((ref) => {
          const w = ref.cause;
          if (w && nativePush(w)) return true;
          if (
            w?.type !== "AssignmentExpression" ||
            w.operator !== "=" ||
            w.right.type !== "ArrayExpression"
          )
            return false;
          const target = reference(w.left);
          return w.right.elements.some((n: Node) => {
            if (n?.type !== "SpreadElement") return false;
            const source = reference(n.argument);
            return (
              source &&
              target &&
              source.binding === target.binding &&
              source.name === target.name &&
              JSON.stringify(source.path) === JSON.stringify(target.path)
            );
          });
        })
      );
    });
  };
  const mask = (value: Value, paths: string[][], appends: string[][] = []): Value => {
    if (isChoices(value)) return choices(value.choices.map((v) => mask(v, paths, appends)));
    if (paths.some((p) => !p.length))
      return Array.isArray(value) && appends.some((p) => !p.length)
        ? variableList([...value, unknown])
        : unknown;
    if (!paths.length) return value;
    if (isFields(value)) {
      const fields = new Map(value.fields);
      for (const [key, v] of fields)
        fields.set(
          key,
          mask(
            v,
            paths.filter((p) => p[0] === key || p[0] === "*").map((p) => p.slice(1)),
            appends.filter((p) => p[0] === key).map((p) => p.slice(1)),
          ),
        );
      for (const path of paths)
        if (path[0] !== "*" && !fields.has(path[0])) fields.set(path[0], unknown);
      return { fields, rest: paths.some((p) => p[0] === "*") ? unknown : value.rest };
    }
    if (Array.isArray(value)) {
      const result = value.map((v, i) =>
        mask(
          v,
          paths.filter((p) => p[0] === String(i) || p[0] === "*").map((p) => p.slice(1)),
          appends.filter((p) => p[0] === String(i)).map((p) => p.slice(1)),
        ),
      );
      return variableLists.has(value) ? variableList(result) : result;
    }
    return unknown;
  };
  const jsonArgs = mask(recorded, mutationPaths(undefined, "args"));
  const assignments = (binding: Binding) =>
    writes.filter(
      (w) =>
        w.type === "AssignmentExpression" &&
        w.left.type === "Identifier" &&
        bindingAt(w.left.name, w.left) === binding,
    );
  const loopIndices = new Set<Binding>();
  const builtin = (node: Node, name: string): boolean => {
    const root = nameRoot(node);
    return (
      !!root &&
      !root.binding &&
      [root.name, ...root.path].join(".") === name &&
      !mutationPaths(undefined, root.name).some(
        (path) => !path.length || path[0] === "*" || path[0] === root.path[0],
      )
    );
  };
  // Recognize the JSON clone idiom as data transformation, not by invoking JSON
  // methods from the source. Unknown fields survive; accessors/toJSON stay unknown.
  const jsonClone = (value: Value, depth = 0): Value => {
    if (--remaining < 0 || depth > 40) return unknown;
    if (Array.isArray(value)) {
      const copied = value.map((v) => (v === undefined ? null : jsonClone(v, depth + 1)));
      return variableLists.has(value) ? variableList(copied) : copied;
    }
    if (isFields(value)) {
      if (field(value, "toJSON") === unknown) return unknown;
      return {
        fields: new Map(
          [...value.fields]
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, jsonClone(v, depth + 1)]),
        ),
        rest: value.rest,
      };
    }
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  };
  const bind = (pattern: Node, fn: Node, value: Value, env: Env) => {
    if (pattern.type === "AssignmentPattern" && value === undefined)
      value = resolve(pattern.right, env);
    const target = pattern.type === "AssignmentPattern" ? pattern.left : pattern;
    if (target.type === "Identifier") {
      const binding = definitions.get(fn)?.get(target.name);
      if (binding) env.set(binding, value);
    } else if (target.type === "ObjectPattern") {
      for (const p of target.properties)
        if (p.type === "Property" && !p.computed)
          bind(p.value, fn, field(value, p.key.name ?? String(p.key.value)), env);
    } else if (target.type === "ArrayPattern")
      target.elements.forEach((p: Node | null, i: number) => {
        if (p) bind(p, fn, field(value, String(i)), env);
      });
  };
  const resolve = (node: Node | undefined, env: Env, stack = new Set<Node>()): Value => {
    if (!node) return undefined;
    if (--remaining < 0 || stack.size > 70 || stack.has(node)) return unknown;
    const next = new Set([...stack, node]);
    const read = (n: Node | undefined) => resolve(n, env, next);
    switch (node.type) {
      case "Literal":
        return scalar(node.value) && !node.regex && typeof node.value !== "bigint"
          ? node.value
          : unknown;
      case "Identifier": {
        const binding = bindingAt(node.name, node);
        if (!binding)
          return node.name === "args" ? jsonArgs : node.name === "undefined" ? undefined : unknown;
        if (env.has(binding))
          return loopIndices.has(binding)
            ? env.get(binding)!
            : mask(
                env.get(binding)!,
                mutationPaths(binding, node.name),
                appendPaths(binding, node.name),
              );
        const changed = assignments(binding);
        const init =
          binding.init ??
          (changed.length === 1 && changed[0].operator === "=" ? changed[0].right : undefined);
        if (!init || (binding.init && changed.length)) return unknown;
        // A conditionally assigned value outside that branch is not a known binding.
        for (const guard of enclosing(init)) {
          if (guard.type !== "IfStatement" || enclosing(node).includes(guard)) continue;
          const condition = read(guard.test);
          if (!scalar(condition)) return unknown;
          const branch = condition ? guard.consequent : guard.alternate;
          if (!branch || init.start < branch.start || init.end > branch.end) return unknown;
        }
        // A source write to a local's own initialization is not a later mutation.
        const paths = mutationPaths(binding, node.name).filter(
          (p) => p.length || init === binding.init,
        );
        let value = read(init);
        for (const key of binding.path) value = field(value, key);
        return mask(value, paths, appendPaths(binding, node.name));
      }
      case "ChainExpression":
        return read(node.expression);
      case "MemberExpression": {
        const key = node.computed ? read(node.property) : node.property.name;
        const object = read(node.object);
        if (key === unknown && Array.isArray(object)) return choices([...object, unknown]);
        return typeof key === "string" || typeof key === "number"
          ? field(object, String(key))
          : unknown;
      }
      case "ObjectExpression": {
        const fields = new Map<string, Value>();
        let rest: Value = undefined;
        for (const p of node.properties) {
          if (p.type === "SpreadElement") {
            const spread = read(p.argument);
            if (isFields(spread)) {
              if (spread.rest === unknown) {
                fields.clear();
                rest = unknown;
              }
              for (const [k, v] of spread.fields) fields.set(k, v);
            } else if (spread !== undefined && spread !== null && spread !== false) {
              fields.clear();
              rest = unknown;
            }
          } else {
            const key = p.computed ? read(p.key) : (p.key.name ?? String(p.key.value));
            if (typeof key !== "string" && typeof key !== "number") {
              fields.clear();
              rest = unknown;
            } else
              fields.set(String(key), p.kind === "init" && !p.method ? read(p.value) : unknown);
          }
        }
        return { fields, rest };
      }
      case "ArrayExpression": {
        const values: Value[] = [];
        for (const item of node.elements) {
          const v = read(item?.type === "SpreadElement" ? item.argument : item);
          if (item?.type === "SpreadElement") {
            if (!Array.isArray(v)) return unknown;
            values.push(...v);
          } else values.push(v);
        }
        return values.length <= 128 ? values : unknown;
      }
      case "ConditionalExpression": {
        const test = read(node.test);
        const condition = truth(test);
        if (condition !== unknown) return read(condition ? node.consequent : node.alternate);
        const yes = read(node.consequent),
          no = read(node.alternate);
        // Unknown conditional spreads can only replace the keys they declare.
        // Scalar runtime selections remain unknown rather than guessed.
        if (isFields(yes) && isFields(no))
          return {
            fields: new Map(
              [...new Set([...yes.fields.keys(), ...no.fields.keys()])].map((key) => [
                key,
                choices([field(yes, key), field(no, key)]),
              ]),
            ),
            rest: choices([yes.rest, no.rest]),
          };
        return unknown;
      }
      case "LogicalExpression": {
        const left = read(node.left);
        if (left === unknown || isChoices(left)) return unknown;
        return node.operator === "??"
          ? left == null
            ? read(node.right)
            : left
          : node.operator === "||"
            ? left || read(node.right)
            : left && read(node.right);
      }
      case "TemplateLiteral": {
        const parts = node.expressions.map(read);
        return parts.every(scalar)
          ? node.quasis
              .map(
                (q: Node, i: number) =>
                  (q.value.cooked ?? q.value.raw) + (i < parts.length ? String(parts[i]) : ""),
              )
              .join("")
          : unknown;
      }
      case "UnaryExpression": {
        const v = read(node.argument);
        return scalar(v) && node.operator === "!" ? !v : unknown;
      }
      case "CallExpression": {
        if (builtin(node.callee, "structuredClone") && node.arguments.length === 1)
          return read(node.arguments[0]);
        if (builtin(node.callee, "JSON.parse") && node.arguments.length === 1) {
          const input = node.arguments[0];
          if (
            input?.type === "CallExpression" &&
            builtin(input.callee, "JSON.stringify") &&
            input.arguments.length === 1
          )
            return jsonClone(read(input.arguments[0]));
        }
        const fn = functionFor(node.callee);
        if (fn && !fn.async) {
          const local = new Map(env);
          fn.params.forEach((p: Node, i: number) => bind(p, fn, read(node.arguments[i]), local));
          if (fn.body.type !== "BlockStatement") return resolve(fn.body, local, next);
          const returns = nodes.filter(
            (n) =>
              n.type === "ReturnStatement" &&
              enclosing(n).find((p) => functions.has(p.type)) === fn,
          );
          return returns.length === 1 ? resolve(returns[0].argument, local, next) : unknown;
        }
        if (node.callee?.type === "MemberExpression" && !node.callee.computed) {
          const list = listOf(read(node.callee.object));
          if (
            Array.isArray(list) &&
            node.callee.property.name === "flat" &&
            (!node.arguments.length || read(node.arguments[0]) === 1)
          )
            return variableLists.has(list)
              ? variableList(list.flat() as Value[])
              : (list.flat() as Value[]);
          const callback = functionFor(node.arguments[0]);
          const booleanFilter =
            node.callee.property.name === "filter" && builtin(node.arguments[0], "Boolean");
          if (
            Array.isArray(list) &&
            (booleanFilter || (callback && !callback.async)) &&
            ["map", "filter"].includes(node.callee.property.name)
          ) {
            let uncertain = variableLists.has(list);
            const mapped: Value[] = [];
            list.forEach((value, i) => {
              const local = new Map(env);
              callback?.params.forEach((p: Node, n: number) =>
                bind(
                  p,
                  callback,
                  ([value, variableLists.has(list) ? unknown : i, list] as Value[])[n],
                  local,
                ),
              );
              const body = !callback
                ? undefined
                : callback.body.type !== "BlockStatement"
                  ? callback.body
                  : callback.body.body.length === 1 &&
                      callback.body.body[0].type === "ReturnStatement"
                    ? callback.body.body[0].argument
                    : undefined;
              const result = booleanFilter
                ? truth(value)
                : body
                  ? resolve(body, local, next)
                  : unknown;
              if (node.callee.property.name === "map") mapped.push(result);
              else {
                const condition = truth(result);
                if (condition !== false) mapped.push(value);
                if (condition === unknown) uncertain = true;
              }
            });
            return uncertain ? variableList(mapped) : mapped;
          }
        }
        return unknown;
      }
      default:
        return unknown;
    }
  };
  const environments = (origin: Node, base = new Map<Binding, Value>()): Env[] => {
    let envs: Env[] = [base];
    for (const ancestor of enclosing(origin).toReversed()) {
      let collection: Node | undefined, pattern: Node | undefined, owner: Node | undefined;
      if (ancestor.type === "ForOfStatement" && ancestor.left.type === "VariableDeclaration") {
        collection = ancestor.right;
        pattern = ancestor.left.declarations[0].id;
        owner = ancestor;
      }
      if (
        ancestor.type === "ForStatement" &&
        ancestor.init?.type === "VariableDeclaration" &&
        ancestor.init.declarations.length === 1 &&
        ancestor.init.declarations[0].id.type === "Identifier" &&
        ancestor.init.declarations[0].init?.value === 0 &&
        ancestor.test?.operator === "<" &&
        ancestor.test.left?.name === ancestor.init.declarations[0].id.name &&
        ancestor.test.right?.type === "MemberExpression" &&
        !ancestor.test.right.computed &&
        ancestor.test.right.property.name === "length" &&
        ancestor.update?.type === "UpdateExpression" &&
        ancestor.update.operator === "++" &&
        ancestor.update.argument.name === ancestor.test.left.name
      ) {
        const index = ancestor.init.declarations[0].id;
        const binding = bindingAt(index.name, ancestor.test.left);
        // A conventional bounded index loop. Other writes keep its index unknown.
        if (
          binding &&
          writes.every(
            (w) => w === ancestor.update || reference(w.left ?? w.argument)?.binding !== binding,
          )
        ) {
          loopIndices.add(binding);
          envs = envs.flatMap((env) => {
            const list = listOf(resolve(ancestor.test.right.object, env));
            return Array.isArray(list) && list.length
              ? list.map((_, i) => {
                  const local = new Map(env);
                  local.set(binding, variableLists.has(list) ? unknown : i);
                  return local;
                })
              : [env];
          });
        }
      }
      if (functions.has(ancestor.type)) {
        const call = parents.get(ancestor);
        if (
          call?.type === "CallExpression" &&
          call.callee.type === "Identifier" &&
          call.callee.name === "pipeline" &&
          !bindingAt("pipeline", call.callee)
        ) {
          const stage = call.arguments.indexOf(ancestor);
          if (stage > 0) {
            envs = envs.flatMap((env) => {
              const list = listOf(resolve(call.arguments[0], env));
              const items: Value[] = Array.isArray(list) && list.length ? list : [unknown];
              return items.map((item, i) => {
                const local = new Map(env);
                const args: Value[] = [
                  stage === 1 ? item : unknown,
                  item,
                  Array.isArray(list) && !variableLists.has(list) ? i : unknown,
                ];
                ancestor.params.forEach((p: Node, n: number) => bind(p, ancestor, args[n], local));
                return local;
              });
            });
          }
        }
        if (
          call?.type === "CallExpression" &&
          call.callee.type === "MemberExpression" &&
          !call.callee.computed &&
          call.callee.property.name === "map"
        ) {
          collection = call.callee.object;
          pattern = ancestor.params[0];
          owner = ancestor;
        }
      }
      if (!collection || !pattern || !owner) continue;
      const expanded: Env[] = [];
      for (const env of envs) {
        const list = listOf(resolve(collection, env));
        const values: Value[] = Array.isArray(list) && list.length ? list : [unknown];
        for (const value of values) {
          const next = new Map(env);
          bind(pattern, owner, value, next);
          expanded.push(next);
          if (expanded.length > 128) return [new Map()];
        }
      }
      envs = expanded;
    }
    return envs;
  };
  // Unknown calls are never evaluated. Returning a record from a local helper is
  // supported above; assignments to that record are masked before reading fields.
  return (site: RecordData) => {
    if (site.primitive.callee.name !== "agent") return null;
    if (!effectsComplete || bindingAt("agent", site.primitive.callee))
      return { models: [], model: null, label: null, explicitPhase: null, effort: null };
    remaining = 20_000;
    let envs: Env[] = [new Map()];
    const chain: Node[] = site.chain ?? [site.origin, site.primitive];
    for (const call of chain) {
      envs = envs.flatMap((env) => environments(call, env));
      if (envs.length > 128) {
        envs = [new Map()];
        break;
      }
      if (call === site.primitive) break;
      const callback = site.callbacks?.find((c: RecordData) => c.call === call);
      if (
        callback &&
        !bindingAt("pipeline", call.callee) &&
        functionFor(call.arguments[callback.stage]) === callback.fn
      ) {
        envs = envs.flatMap((env) => {
          const list = listOf(resolve(call.arguments[0], env));
          const items: Value[] = list?.length ? list : [unknown];
          return items.map((item, index) => {
            const local = new Map(env);
            const inputs: Value[] = [
              callback.stage === 1 ? item : unknown,
              item,
              list && !variableLists.has(list) ? index : unknown,
            ];
            callback.fn.params.forEach((p: Node, i: number) =>
              bind(p, callback.fn, inputs[i], local),
            );
            return local;
          });
        });
        continue;
      }
      const fn = functionFor(call.callee);
      if (!fn) {
        envs = [new Map()];
        break;
      }
      envs = envs.flatMap((env) => {
        let locals = [new Map(env)];
        fn.params.forEach((p: Node, i: number) => {
          const values = valuesOf(resolve(call.arguments[i], env));
          locals = locals.flatMap((local) =>
            values.map((value) => {
              const next = new Map(local);
              bind(p, fn, value, next);
              return next;
            }),
          );
          if (locals.length > 128) locals = [new Map()];
        });
        return locals;
      });
    }
    const variants: Record<string, Value>[] = envs.map((local) => {
      const options = resolve(site.primitive.arguments[1], local);
      return Object.fromEntries(
        ["model", "label", "phase", "effort"].map((k): [string, Value] => [k, field(options, k)]),
      );
    });
    const describe = (variants: Record<string, Value>[]) => {
      const rawModels = variants.flatMap((v) => valuesOf(v.model));
      const inherited = variants.some((v) => {
        const alternatives = valuesOf(v.model);
        return !alternatives.includes(unknown) && alternatives.includes(undefined);
      });
      const modelOrigin = rawModels.every((v) => v === undefined)
        ? "inherited"
        : inherited
          ? "mixed"
          : rawModels.every((v) => typeof v === "string" && !!v)
            ? "explicit"
            : "dynamic";
      variants = variants.map((v) => ({
        ...v,
        model: choices(
          valuesOf(v.model).map((model) =>
            model === undefined && !valuesOf(v.model).includes(unknown)
              ? defaultModel || unknown
              : model === undefined
                ? unknown
                : model,
          ),
        ),
      }));
      const strings = (key: string) => [
        ...new Set(
          variants
            .flatMap((v) => valuesOf(v[key]))
            .filter((v): v is string => typeof v === "string" && !!v),
        ),
      ];
      const exact = (key: string) =>
        variants.length &&
        variants.every((v) => typeof v[key] === "string" && v[key] === variants[0][key])
          ? (variants[0][key] as string)
          : null;
      return {
        models: strings("model"),
        model: exact("model"),
        label: exact("label"),
        explicitPhase: exact("phase"),
        effort: exact("effort"),
        modelsComplete: variants.every((v) =>
          valuesOf(v.model).every((value) => typeof value === "string" && !!value),
        ),
        modelOrigin,
      };
    };
    const groups = new Map<Value, Record<string, Value>[]>();
    for (const variant of variants) {
      const phase = variant.phase;
      const key =
        typeof phase === "string"
          ? phase
          : phase === undefined || phase === null
            ? undefined
            : unknown;
      // An unresolved explicit phase cannot assign a known model to the ambient
      // phase. Keep the site visible, but do not invent that association.
      const safe: Record<string, Value> =
        key === unknown ? { ...variant, model: unknown, phase: undefined } : variant;
      groups.set(key, [...(groups.get(key) ?? []), safe]);
    }
    const descriptions = [...groups.values()].map(describe);
    return descriptions.length === 1 ? descriptions[0] : descriptions;
  };
}
