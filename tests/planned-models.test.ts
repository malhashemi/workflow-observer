import { test, expect } from "bun:test";
import { analyzePlan } from "../src/plans";

const header = `export const meta={name:'tool-capabilities',description:'Inert fixture',phases:[
  {title:'Read'},{title:'Check'},{title:'Retry'},{title:'Finish'}]};`;
const phaseModels = (source: string, args?: unknown) =>
  Object.fromEntries(
    analyzePlan(header + source, args).phases.map((p) => [p.title, p.plannedModels]),
  );

test("pipeline binds original item and index independently of opaque previous results", () => {
  const plan = analyzePlan(
    header +
      `
    await pipeline(args.items,
      item => agent('', {model:item.reader, phase:'Read'}),
      (previous, original, index) => agent('', {model:original.checker, phase:'Check', label:\`check:\${index}\`}),
      previous => agent('', {model:previous.nextModel,phase:'Retry'})
    );
    await workflow({scriptPath:args.child});
  `,
    {
      items: [
        { reader: "read-a", checker: "check-a" },
        { reader: "read-b", checker: "check-b" },
      ],
      child: "/fixture/child.js",
    },
  );
  expect(plan.phases.find((p) => p.title === "Read")?.plannedModels).toEqual(["read-a", "read-b"]);
  expect(plan.phases.find((p) => p.title === "Check")?.plannedModels).toEqual([
    "check-a",
    "check-b",
  ]);
  expect(plan.phases.find((p) => p.title === "Check")?.steps?.[0].labelExact).toBe(false);
  expect(plan.phases.find((p) => p.title === "Retry")?.plannedModels).toEqual([]);
  expect(plan.nodes.find((n: any) => n.kind === "workflow")?.models).toEqual([]);
});

test("omitted model inherits only a recorded native default; dynamic choices do not", () => {
  const source =
    header +
    `phase('Read'); await agent(''); await agent('',{model:args.override});
    const result=await agent(''); phase('Check'); await agent('',{model:result.model});`;
  const plan = analyzePlan(source, { override: "explicit" }, "recorded-default");
  expect(plan.phases[0].steps?.map((s) => [s.model, s.modelOrigin])).toEqual([
    ["recorded-default", "inherited"],
    ["explicit", "explicit"],
    ["recorded-default", "inherited"],
  ]);
  expect(plan.phases[1].steps?.[0]).toMatchObject({ model: null, modelOrigin: "dynamic" });
  expect(analyzePlan(header + `phase('Read');await agent('');`).phases[0].steps?.[0]).toMatchObject(
    { model: null, modelOrigin: "inherited" },
  );
});

test("named pipeline stages retain original inputs when called through local wrappers", () => {
  const plan = analyzePlan(
    header +
      `
    function ask(options){return agent('',options);}
    async function read(item){return ask({model:item.reader,phase:'Read'});}
    async function check(previous,original,index){return ask({model:original.checker,phase:'Check',label:\`check:\${index}\`});}
    await pipeline(args.items,read,check);
  `,
    { items: [{ reader: "one", checker: "two" }] },
  );
  expect(plan.phases[0].plannedModels).toEqual(["one"]);
  expect(plan.phases[1].steps?.[0]).toMatchObject({
    model: "two",
    label: "check:0",
    labelExact: true,
  });
});

test("cloned data and multiple helper layers retain arbitrary assignment and phase names", () => {
  const source =
    header +
    `
    const copy = input => JSON.parse(JSON.stringify(input));
    function prepare(input) {const cfg={...copy(input)};cfg.unrelated=runtime();return cfg;}
    const cfg=prepare(args);
    function ticket(assignment, destination) {return {assignment,destination};}
    async function dispatch(ticket) {return agent('',{phase:ticket.destination,...(ticket.assignment.model?{model:ticket.assignment.model}:{}),effort:ticket.assignment.effort});}
    async function relay(ticket) {return await dispatch(ticket);}
    async function run() {
      phase('Read');
      for(const batch of cfg.queue) await parallel(batch.map(value=>()=>relay(ticket(value,'Read'))));
      phase('Check'); const jobs=cfg.checks.map(value=>ticket(value,'Check'));
      await parallel(jobs.map(value=>()=>relay(value)));
      phase('Finish'); await relay(ticket(cfg.finish,'Retry'));
    }
    await run(); throw new Error('Never executed');
  `;
  const args = {
    queue: [[{ model: "one", effort: "high" }, { model: "two" }]],
    checks: [{ model: "three" }, { model: "four" }],
    finish: { model: "five" },
  };
  const plan = analyzePlan(source, args);
  expect(Object.fromEntries(plan.phases.map((p) => [p.title, p.plannedModels]))).toEqual({
    Read: ["one", "two"],
    Check: ["three", "four"],
    Retry: ["five"],
    Finish: ["five"],
  });
  expect(plan.phases.find((p) => p.title === "Finish")?.steps?.[0].assignedPhase).toBe("Retry");
  expect(plan.phases[0].steps).toHaveLength(1);
  expect(analyzePlan(source, args)).toEqual(plan);
});

test("recursive helpers preserve untouched metadata but propagate writes across parameter positions", () => {
  const untouched = `function a(v){if(runtime())b(v);return v;} function b(v){v.note=runtime();a(v);}
    const cfg=a(args);phase('Read');await agent('',cfg);`;
  expect(phaseModels(untouched, { model: "known" }).Read).toEqual(["known"]);
  for (const source of [
    `function a(left,right){b(right,left);} function b(left,right){left.model='changed';if(runtime())a(right,left);} a({},args);`,
    `function a(v){b(v);} function b(v){if(runtime())a(v); imported(v);} a(args);`,
  ])
    expect(
      phaseModels(source + `phase('Read');await agent('',args);`, { model: "stale" }).Read,
    ).toEqual([]);
});

test("bounded indexed lists, filters and mapped job records preserve possible models without exact dynamic indices", () => {
  const source =
    header +
    `const cfg=JSON.parse(JSON.stringify(args));
    if(runtime())cfg.batches=[...runtimeItems(),...cfg.batches];
    const history=[];phase('Read');
    for(let index=0;index<cfg.batches.length;index++) {
      const batch=cfg.batches[index].filter(item=>runtime());
      const jobs=batch.map((seat,index)=>({model:seat.model,label:\`item:\${index}\`,phase:'Read'}));
      await parallel(jobs.map(options=>()=>agent('',options)));
      history.push({assignment:batch[0]});
    }`;
  const plan = analyzePlan(source, { batches: [[{ model: "one" }, { model: "two" }]] });
  expect(plan.phases[0].plannedModels).toEqual(["one", "two"]);
  expect(plan.phases[0].steps?.every((s) => s.labelExact === false)).toBe(true);
  expect(plan.phases[0].steps?.some((s) => s.modelsComplete === false)).toBe(true);
});

test("array storage does not mutate input, but writes through stored references and custom methods do", () => {
  expect(
    phaseModels(
      `const saved=[];saved.push({assignment:args});phase('Read');await agent('',args);`,
      { model: "known" },
    ).Read,
  ).toEqual(["known"]);
  for (const source of [
    `const saved=[];saved.push({assignment:args});saved[0].assignment.model='changed';`,
    `const saved=[];saved.push({assignment:args});external(saved);`,
    `const saved={push(value){value.model='changed'}};saved.push(args);`,
    `let saved=[];saved=custom();saved.push(args);`,
    `const saved=[];saved.push=custom;saved.push(args);`,
    `function change(saved){saved.push=custom;} const saved=[];change(saved);saved.push(args);`,
  ])
    expect(
      phaseModels(source + `phase('Read');await agent('',args);`, { model: "stale" }).Read,
    ).toEqual([]);
});

test("cloning never executes getters, custom JSON implementations, revivers or workflow source", () => {
  for (const expression of [
    `JSON.parse(JSON.stringify({get model(){globalThis.planExecuted=true;return 'bad'}}))`,
    `JSON.parse(JSON.stringify({toJSON(){globalThis.planExecuted=true;return {model:'bad'}}}))`,
    `JSON.parse(JSON.stringify(args),()=>({model:'bad'}))`,
  ])
    expect(
      phaseModels(`phase('Read');await agent('',${expression});`, { model: "known" }).Read,
    ).toEqual([]);
  expect(
    phaseModels(
      `const JSON={parse:()=>({model:'bad'}),stringify:()=>''};
    phase('Read');await agent('',JSON.parse(JSON.stringify(args)));`,
      { model: "known" },
    ).Read,
  ).toEqual([]);
  expect(
    phaseModels(`phase('Read');await agent('',structuredClone(args));`, { model: "known" }).Read,
  ).toEqual(["known"]);
  expect((globalThis as any).planExecuted).toBeUndefined();
});

test("runtime-selected phases do not attach a model to the wrong ambient phase", () => {
  const models = phaseModels(`phase('Read');await agent('',{phase:runtime(),model:'known'});`, {});
  expect(models.Read).toEqual([]);
});

test("standard Boolean filtering preserves known assignments; shadowed primitives do not claim tool models", () => {
  expect(
    phaseModels(
      `phase('Read');await parallel(args.items.filter(Boolean).map(options=>()=>agent('',options)));`,
      {
        items: [null, { model: "known" }, false],
      },
    ).Read,
  ).toEqual(["known"]);
  expect(
    phaseModels(`function agent(){}phase('Read');agent('',{model:'not-a-tool-call'});`, {}).Read,
  ).toEqual([]);
});

test("large collections remain unresolved rather than silently sampling assignments", () => {
  const plan = analyzePlan(
    header + `phase('Read');await parallel(args.items.map(model=>()=>agent('',{model})));`,
    {
      items: Array.from({ length: 129 }, (_, i) => "model-" + i),
    },
  );
  expect(plan.phases[0].plannedModels).toEqual([]);
  expect(plan.phases[0].steps?.[0].modelsComplete).toBe(false);
});

test("unresolved optional model spreads do not invent a session-default assignment", () => {
  expect(
    analyzePlan(
      header +
        `phase('Read');const seat=runtime();
    await agent('',{...(seat.model?{model:seat.model}:{})});`,
      {},
      "recorded-default",
    ).phases[0].plannedModels,
  ).toEqual([]);
});

test("pipeline mutations of original items invalidate metadata in later stages", () => {
  for (const stages of [
    `item=>{item.model='changed';return item;}, (previous,original)=>agent('',{phase:'Check',model:original.model})`,
    `importedStage, (previous,original)=>agent('',{phase:'Check',model:original.model})`,
  ])
    expect(
      phaseModels(`await pipeline(args.items,${stages});`, { items: [{ model: "stale" }] }).Check,
    ).toEqual([]);
});
