import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import javascript from "@shikijs/langs/javascript";
import typescript from "@shikijs/langs/typescript";
import tsx from "@shikijs/langs/tsx";
import json from "@shikijs/langs/json";
import bash from "@shikijs/langs/bash";
import css from "@shikijs/langs/css";
import html from "@shikijs/langs/html";
import markdown from "@shikijs/langs/markdown";
import diff from "@shikijs/langs/diff";
import yaml from "@shikijs/langs/yaml";
import python from "@shikijs/langs/python";
import sql from "@shikijs/langs/sql";
export const observerTheme = {
  name: "observer-dark",
  type: "dark" as const,
  colors: { "editor.background": "#0b1b23", "editor.foreground": "#d5e2e8" },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#7c98a4" } },
    { scope: ["keyword", "storage", "entity.name.tag"], settings: { foreground: "#3eebff" } },
    { scope: ["string", "markup.inserted"], settings: { foreground: "#9be7ba" } },
    {
      scope: ["constant.numeric", "constant.language", "constant.character"],
      settings: { foreground: "#edbc7b" },
    },
    { scope: ["entity.name.function", "entity.name.type"], settings: { foreground: "#e7d6ff" } },
    { scope: ["variable", "support"], settings: { foreground: "#b8d9e7" } },
  ],
};
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
export async function highlight(code: string, language: string) {
  const h = await (highlighter ??= createHighlighterCore({
    themes: [observerTheme],
    langs: [javascript, typescript, tsx, json, bash, css, html, markdown, diff, yaml, python, sql],
    engine: createJavaScriptRegexEngine(),
  }));
  return h.codeToTokens(code, {
    lang: h.getLoadedLanguages().includes(language) ? language : "text",
    theme: "observer-dark",
  }).tokens;
}
