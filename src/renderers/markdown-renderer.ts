import {
  companyDossierSchema,
  type CompanyDossier,
  type EvidenceRef,
  type Fact,
  type JsonValue,
} from "../contracts/company-evidence.js";
import { stableJsonStringify } from "./json-renderer.js";

const markdownControlCharacterPattern = /([\\`*_{}\[\]()#+.!|-])/gu;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeMarkdown(value: string): string {
  return escapeHtml(value).replace(markdownControlCharacterPattern, "\\$1");
}

function escapeLinkDestination(value: string): string {
  return value
    .replaceAll("\\", "%5C")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
}

function formatJsonValue(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }

  return stableJsonStringify(value);
}

function sourceLinks(evidence: readonly EvidenceRef[]): string {
  return evidence
    .map(
      (reference, index) =>
        `[Source ${String(index + 1)}](${escapeLinkDestination(reference.sourceUri)})`,
    )
    .join(", ");
}

function renderFact(lines: string[], fact: Fact): void {
  lines.push(
    `- ${escapeMarkdown(fact.id)} (${escapeMarkdown(fact.type)}, ${escapeMarkdown(fact.origin)})`,
  );
  lines.push(`  - Value: ${escapeMarkdown(formatJsonValue(fact.value))}`);

  if (fact.origin === "derived") {
    lines.push(`  - Rule: ${escapeMarkdown(fact.ruleId)}`);
  }

  lines.push(`  - Sources: ${sourceLinks(fact.evidence)}`);
}

function renderMessages(
  lines: string[],
  heading: "Warnings" | "Errors",
  messages: readonly string[],
): void {
  if (messages.length === 0) {
    return;
  }

  lines.push(`### ${heading}`);

  for (const message of messages) {
    lines.push(`- ${escapeMarkdown(message)}`);
  }

  lines.push("");
}

export function renderCompanyDossierMarkdown(dossier: CompanyDossier): string {
  const validatedDossier = companyDossierSchema.parse(dossier);
  const companyName =
    validatedDossier.company.registeredName ??
    validatedDossier.company.companyNumber;
  const lines: string[] = [
    `# Company dossier: ${escapeMarkdown(companyName)}`,
    "",
    `Company number: ${escapeMarkdown(validatedDossier.company.companyNumber)}`,
    `Generated at: ${validatedDossier.generatedAt}`,
    "",
    "This report is not legal, financial, accounting, or investment advice.",
    "",
    "## Evidence sections",
    "",
  ];

  for (const sectionKey of Object.keys(validatedDossier.sections).sort()) {
    const section = validatedDossier.sections[sectionKey];

    if (section === undefined) {
      continue;
    }

    lines.push(`### ${escapeMarkdown(sectionKey)}`);
    lines.push(`Status: ${section.status}`);
    lines.push("");

    if (section.facts.length > 0) {
      lines.push("#### Facts");

      for (const fact of section.facts) {
        renderFact(lines, fact);
      }

      lines.push("");
    } else {
      lines.push("No facts recorded.");
      lines.push("");
    }

    renderMessages(lines, "Warnings", section.warnings);
    renderMessages(lines, "Errors", section.errors);
  }

  lines.push("## Source attribution");
  lines.push("");
  lines.push(
    `Provider: ${escapeMarkdown(validatedDossier.sourceAttribution.provider)}`,
  );
  lines.push(
    `Source: [${escapeMarkdown(validatedDossier.sourceAttribution.sourceUri)}](${escapeLinkDestination(validatedDossier.sourceAttribution.sourceUri)})`,
  );
  lines.push(
    `Licence: [${escapeMarkdown(validatedDossier.sourceAttribution.licenceUri)}](${escapeLinkDestination(validatedDossier.sourceAttribution.licenceUri)})`,
  );
  lines.push(
    `Data terms: [${escapeMarkdown(validatedDossier.sourceAttribution.dataTermsUri)}](${escapeLinkDestination(validatedDossier.sourceAttribution.dataTermsUri)})`,
  );
  lines.push(
    `Retrieval caveat: ${escapeMarkdown(validatedDossier.sourceAttribution.retrievalCaveat)}`,
  );
  lines.push(
    `Non-affiliation: ${escapeMarkdown(validatedDossier.sourceAttribution.nonAffiliationStatement)}`,
  );

  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}
