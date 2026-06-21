#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
const requiredDiagramLabels = [
  "setup-flow",
  "evidence-flow",
  "best-value-workflow",
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function extractMermaidBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split(/\r?\n/u);
  let activeBlock;
  let activeStartLine = 0;

  for (const [index, line] of lines.entries()) {
    if (activeBlock === undefined) {
      if (line.trim() === "```mermaid") {
        activeBlock = [];
        activeStartLine = index + 1;
      }

      continue;
    }

    if (line.trim() === "```") {
      blocks.push({
        content: activeBlock.join("\n"),
        startLine: activeStartLine,
      });
      activeBlock = undefined;
      continue;
    }

    if (line.trim().startsWith("```")) {
      fail(
        `Nested fenced block inside Mermaid diagram at README.md:${index + 1}`,
      );
    }

    activeBlock.push(line);
  }

  if (activeBlock !== undefined) {
    fail("README.md has an unclosed Mermaid fenced block.");
  }

  return blocks;
}

function assertBasicMermaidSyntax(block) {
  const syntaxLines = block.content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("%%"));
  const firstSyntaxLine = syntaxLines[0];

  if (firstSyntaxLine === undefined) {
    fail(`Empty Mermaid diagram at README.md:${block.startLine}`);
  }

  if (!firstSyntaxLine.startsWith("flowchart ")) {
    fail(
      `Mermaid diagram at README.md:${block.startLine} must start with flowchart.`,
    );
  }

  for (const line of syntaxLines.slice(1)) {
    if (line.includes("[") && !/\["[^"]+"\]/u.test(line)) {
      fail(
        `Mermaid node labels must be quoted at README.md:${block.startLine}: ${line}`,
      );
    }
  }
}

const blocks = extractMermaidBlocks(readme);

if (blocks.length < requiredDiagramLabels.length) {
  fail(
    "README.md must contain setup, evidence, and best-value Mermaid diagrams.",
  );
}

for (const label of requiredDiagramLabels) {
  const block = blocks.find((candidate) =>
    candidate.content.includes(`%% ${label}`),
  );

  if (block === undefined) {
    fail(`README.md is missing Mermaid diagram label: ${label}`);
  }

  assertBasicMermaidSyntax(block);
}

process.stdout.write("Mermaid documentation checks passed.\n");
