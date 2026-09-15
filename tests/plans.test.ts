import { test, expect } from "bun:test";
import { analyzePlan, mergePhases } from "../src/plans";

const source = `
export const meta = { name: 'fixture', description: 'Plan fixture', phases: [
  { title: 'Build', detail: 'Build it' }, { title: 'Review', detail: 'Two reviewers' },
  { title: 'Fix', detail: 'Conditional repairs' }, { title: 'Publish', detail: 'Declared only' }
] };
const IMPLEMENTER = 'gpt-fixture';
phase('Build');
await agent('Build', {label: 'build:web', model: IMPLEMENTER, effort: 'high'});
phase('Review');
await parallel([
 () => agent('Review A', {label: 'review:a', model: 'gpt-review', effort: 'xhigh'}),
 () => agent('Review B', {label: 'review:b', model: 'claude-review'})
]);
phase('Fix');
if (args.findings) await agent('Fix', {label: 'fix', model: IMPLEMENTER});
throw new Error('Source must never run');
`;

test("source plans retain exact models, labels, effort and optional steps before launch", () => {
  const plan = analyzePlan(source);
  expect(plan.phases.map((p) => p.title)).toEqual(["Build", "Review", "Fix", "Publish"]);
  expect(plan.phases[0].plannedModels).toEqual(["gpt-fixture"]);
  expect(plan.phases[0].steps?.[0]).toMatchObject({
    label: "build:web",
    labelExact: true,
    model: "gpt-fixture",
    effort: "high",
    optional: false,
    min: 1,
    max: 1,
  });
  expect(plan.phases[1].plannedModels).toEqual(["gpt-review", "claude-review"]);
  expect(plan.phases[1].steps).toHaveLength(2);
  expect(plan.phases[2].conditional).toBe(true);
  expect(plan.phases[2].steps?.[0]).toMatchObject({
    optional: true,
    conditionalReason: "branch",
    min: 0,
    max: 1,
  });
  expect(plan.phases[3].steps).toEqual([]);
});

test("recorded phase headings keep their source planning detail without dropping future phases", () => {
  const phases = mergePhases(
    [{ title: "Build", detail: "Recorded description" }, "Review", "Runtime"],
    analyzePlan(source),
  );
  expect(phases.map((p) => p.title)).toEqual(["Build", "Review", "Runtime", "Fix", "Publish"]);
  expect(phases[0].detail).toBe("Recorded description");
  expect(phases[1].plannedModels).toEqual(["gpt-review", "claude-review"]);
  expect(phases.find((p) => p.title === "Fix")?.conditional).toBe(true);
  expect(phases.find((p) => p.title === "Runtime")?.steps).toEqual([]);
});

test("model selectors and defaults stay unresolved; prompt excerpts are not agent names", () => {
  const plan = analyzePlan(`export const meta = {name:'dynamic',phases:[{title:'Run'}]};
    phase('Run');
    await agent('A long private task prompt', {model: args.model});
    await agent('Default', {});
    await agent('Choice', {label:'chosen',model:args.fast ? 'gpt-fast' : 'gpt-slow'});
  `);
  expect(plan.phases[0].plannedModels).toEqual([]);
  expect(plan.phases[0].steps?.map((s) => s.model)).toEqual([null, null, null]);
  expect(plan.phases[0].steps?.[0].label).toBe("Agent call");
});

test("literal options references resolve, later overrides win, spreads and getters stay unknown", () => {
  const plan = analyzePlan(`export const meta = {name:'options',phases:[{title:'Run'}]};
    const opts = {model:'gpt-known',label:'exact'};
    phase('Run');
    await agent('Task', opts);
    await agent('Task', {model:'gpt-first', model:'gpt-last'});
    await agent('Task', {model:'gpt-hidden', ...args.options});
    await agent('Task', {get model() {throw new Error('never run')}});
  `);
  expect(plan.phases[0].steps?.map((s) => s.model)).toEqual(["gpt-known", "gpt-last", null, null]);
});

test("phase metadata still supplies plans when no source is available", () => {
  const phases = mergePhases([{ title: "Repair", optional: true, models: ["gpt-fixture"] }], {});
  expect(phases[0]).toMatchObject({
    title: "Repair",
    conditional: true,
    plannedModels: ["gpt-fixture"],
    steps: [],
  });
});

test("recorded arguments resolve exact metadata through aliases, helper returns and bounded assignment lists", () => {
  const plan = analyzePlan(
    `
    export const meta={name:'arguments',phases:[{title:'Acceptance'},{title:'Build'},{title:'Review'},{title:'Repair'},{title:'Seal'}]};
    function validate(input) { const config={...input,limit:input.limit??3}; config.unrelated=runtime(); return config; }
    let config; config=validate(args);
    let round=0; round++;
    async function ask(seat,group) {
      return await agent('Never execute this', {label:seat.id,phase:group,...(seat.model?{model:seat.model}:{}),...(seat.effort?{effort:seat.effort}:{})});
    }
    phase('Acceptance'); await ask(config.roles.acceptance,'Acceptance');
    phase('Build'); for(const batch of config.batches) await parallel(batch.map(worker=>()=>ask(worker,'Build')));
    phase('Review'); await parallel(config.roles.reviewers.map(reviewer=>()=>ask(reviewer,'Review')));
    phase('Repair'); if(runtimeFindings()) await ask(config.roles.fixer,'Repair');
    phase('Seal'); await ask(config.roles.seal??config.roles.acceptance,'Seal');
    throw new Error('must never execute');
  `,
    {
      roles: {
        acceptance: { id: "acceptance", model: "gpt-accept", effort: "high" },
        reviewers: [
          { id: "a", model: "gpt-review" },
          { id: "b", model: "claude-review" },
        ],
        fixer: { id: "fix", model: "gpt-fix" },
      },
      batches: [
        [
          { id: "web", model: "claude-build" },
          { id: "api", model: "gpt-build" },
        ],
        [{ id: "tests", model: "gpt-build" }],
      ],
    },
  );
  expect(plan.phases.map((p) => p.plannedModels)).toEqual([
    ["gpt-accept"],
    ["claude-build", "gpt-build"],
    ["gpt-review", "claude-review"],
    ["gpt-fix"],
    ["gpt-accept"],
  ]);
  expect(plan.phases[0].steps?.[0]).toMatchObject({
    label: "acceptance",
    labelExact: true,
    model: "gpt-accept",
    effort: "high",
  });
  expect(plan.phases[1].steps).toHaveLength(1); // A list enriches one site; it does not inflate launch counts.
  expect(plan.phases[1].steps?.[0].models).toEqual(["claude-build", "gpt-build"]);
  expect(plan.phases[3].conditional).toBe(true);
});

test("argument lookups support destructuring, defaults, literal choices and lexical shadowing", () => {
  const source = `export const meta={name:'scopes',phases:[{title:'Run'}]};
    const {model,options}=args; phase('Run');
    await agent('',{label:'direct',model,effort:args.fast?'high':'low'});
    await agent('',{...options,model:args.fallback??'gpt-default'});
    function worker(args={model:'gpt-local'}) {return agent('',{model:args.model});}
    await worker(); await worker({model:'gpt-override'});
  `;
  const plan = analyzePlan(source, {
    model: "gpt-recorded",
    options: { model: "gpt-other" },
    fast: true,
  });
  expect(plan.phases[0].steps?.map((s) => s.model)).toEqual([
    "gpt-recorded",
    "gpt-default",
    "gpt-local",
    "gpt-override",
  ]);
  expect(plan.phases[0].steps?.[0].effort).toBe("high");
});

test("mutated references, unknown calls, getters and runtime selections do not become exact planned models", () => {
  const examples = [
    `const opts=args.options; opts.model='changed'; await agent('',opts);`,
    `const opts=args.options; const alias=opts; alias.model='changed'; await agent('',opts);`,
    `const opts=args.options; importedMutation(opts); await agent('',opts);`,
    `function mutate(value){value.model='changed';} mutate(args.options); await agent('',args.options);`,
    `function mutate(value){importedMutation(value);} mutate(args.options); await agent('',args.options);`,
    `const reviewers=[args.options]; reviewers.map(value=>importedMutation(value)); await agent('',reviewers[0]);`,
    `const reviewers=[args.options]; reviewers.map(importedMutation); await agent('',reviewers[0]);`,
    `await agent('',{...args.options,get model(){globalThis.executed=true;return 'wrong'}});`,
    `await agent('',{model:'old',...unknownOptions()});`,
    `await agent('',{model:result.ok?args.options.model:'other'});`,
    `let opts=args.options; opts=unknownOptions(); await agent('',opts);`,
    `if(runtime()){var opts=args.options;} await agent('',opts);`,
    `function copy(input){if(runtime())return input;return {model:'other'};} await agent('',copy(args.options));`,
  ];
  for (const example of examples) {
    const plan = analyzePlan(
      `export const meta={name:'unknown',phases:[{title:'Run'}]};phase('Run');${example}`,
      { options: { model: "gpt-original" } },
    );
    expect(plan.phases[0].plannedModels, example).toEqual([]);
  }
  expect((globalThis as any).executed).toBeUndefined();
});

test("argument-aware plans do not preserve stale literal labels or phase assignments after mutation", () => {
  const plan = analyzePlan(
    `export const meta={name:'mutated',phases:[{title:'Run'}]};
    phase('Run'); const options={model:'old',label:'old label',phase:'old phase'};
    importedMutation(options); await agent('',options);`,
    {},
  );
  expect(plan.phases.map((p) => p.title)).toEqual(["Run"]);
  expect(plan.phases[0].steps?.[0]).toMatchObject({ model: null, labelExact: false });
});
