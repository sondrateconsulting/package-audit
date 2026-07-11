// indexHtml.ts — the multi-package index page for the xray/ bundle: one summary row per tracked
// package, linking to that package's dossier. PURE and deterministic like reportHtml.ts (no wall
// clock, no env, no locale), and it reuses the renderer's shell verbatim, so the CSP meta, the
// theming, and the single inline script are BYTE-IDENTICAL to every dossier (the script-hash
// test pins this). Every dynamic value passes through the one escapeHtml; the only dynamic hrefs
// are dossier filenames, which dossierFilename() already constrains to the flat ASCII artifact
// grammar (no quotes, no slashes — safe in a double-quoted href by construction, and escaped
// anyway).

import { escapeHtml } from "./htmlEscape.ts";
import {
  computeDossierModel,
  dossierFilename,
  renderShell,
  type DossierPackage,
  type DossierReport,
} from "./reportHtml.ts";

// The index's fixed artifact name inside <outputDir>/xray/ (matches the artifact name grammar).
export const INDEX_FILENAME = "index.html";

const esc = escapeHtml;
const num = (v: number): string => esc(String(v));
const plural = (count: number, singular: string, pluralForm?: string): string =>
  `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;

const mdCell = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");

interface IndexRow {
  readonly name: string;
  readonly filename: string;
  readonly repoCount: number; // headline scope (same fallback rule as the dossier cards)
  readonly usageSiteCount: number;
  readonly versions: string; // versionsSeen, joined
  readonly fallback: boolean; // '*' marker: default branch unknown → all-branches counts
}

function buildRow(pkg: DossierPackage): IndexRow {
  const m = computeDossierModel(pkg);
  return {
    name: pkg.name,
    filename: dossierFilename(pkg.name),
    repoCount: m.headlineRepos.length,
    usageSiteCount: m.headlineSiteCount,
    versions: m.versionsSeen.join(", "),
    fallback: m.scopeMode === "all-branches-fallback",
  };
}

// One self-contained index document for a whole report. Package order follows the report's
// packages[] (already name-sorted by the report layer).
export function renderIndex(report: DossierReport, opts: { formatVersion: number }): string {
  const rows = report.packages.map(buildRow);
  const anyFallback = rows.some((r) => r.fallback);

  const receipts = [
    `${plural(report.summary.repositoriesScanned, "repository", "repositories")} scanned`,
    `${plural(report.summary.branchesScanned, "branch", "branches")} scanned`,
    `${plural(report.summary.branchesSkippedByCutoff, "branch", "branches")} skipped by the ${report.config.cutoffDate} cutoff`,
  ].join(" · ");

  const md = [
    `| package | repos (default branches) | usage sites | versions seen |`,
    `| --- | --- | --- | --- |`,
    ...rows.map(
      (r) => `| ${mdCell(r.name)}${r.fallback ? " *" : ""} | ${r.repoCount} | ${r.usageSiteCount} | ${mdCell(r.versions)} |`,
    ),
  ].join("\n");

  const body =
    rows.length === 0
      ? `<p class="note">no tracked packages in this run.</p>`
      : `<div class="tablewrap"><table><thead><tr><th>package</th><th class="n">repos (default branches)</th>` +
        `<th class="n">usage sites</th><th>versions seen</th><th>dossier</th></tr></thead><tbody>\n` +
        rows
          .map(
            (r) =>
              `<tr><td><code>${esc(r.name)}</code>${r.fallback ? ` <span class="branchnote">*</span>` : ""}</td>` +
              `<td class="n">${num(r.repoCount)}</td><td class="n">${num(r.usageSiteCount)}</td><td>${esc(r.versions)}</td>` +
              `<td><a href="${esc(r.filename)}">open</a></td></tr>`,
          )
          .join("\n") +
        `\n</tbody></table></div>` +
        (anyFallback
          ? `<p class="note">* default branch unknown for this run — counts cover all scanned branches; re-run the audit to record it.</p>`
          : "");

  const html =
    `<header id="exec"><p class="meta">package usage x-ray</p><h1 class="exec">Package usage dossiers — ${esc(plural(rows.length, "tracked package"))}.</h1>` +
    `<p class="meta num">run ${esc(report.runId)} · generated ${esc(report.generatedAt)} · ${esc(receipts)}</p></header>` +
    `<section id="packages" aria-label="Tracked packages"><h2>Tracked packages</h2>` +
    `<button class="copy" type="button" data-copy-target="packages">copy as markdown</button>` +
    `<template id="packages-md">${esc(md)}</template>${body}</section>` +
    `<footer>package usage x-ray · report-format version ${num(opts.formatVersion)} · run ${esc(report.runId)} · generated ${esc(report.generatedAt)}</footer>`;

  return renderShell({ title: "Package usage x-ray — index", body: html, formatVersion: opts.formatVersion });
}
