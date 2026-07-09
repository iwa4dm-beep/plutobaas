// Validates that every entry registered in HELP_REGISTRY exposes the required
// PageHelp / HelpSection fields in both bn and en. Also asserts each sidebar
// navigation item has a corresponding registry entry so the Cmd+K palette
// keeps full coverage as new pages are added.
import { describe, expect, it } from "vitest";
import { HELP_REGISTRY } from "@/content/help/registry";
import type { PageHelp, HelpSection, Bilingual } from "@/lib/help/types";

function assertBilingual(v: Bilingual | undefined, path: string) {
  expect(v, `${path} missing`).toBeDefined();
  expect(typeof v!.bn, `${path}.bn must be string`).toBe("string");
  expect(typeof v!.en, `${path}.en must be string`).toBe("string");
  expect(v!.bn.trim().length, `${path}.bn empty`).toBeGreaterThan(0);
  expect(v!.en.trim().length, `${path}.en empty`).toBeGreaterThan(0);
}

function assertSection(s: HelpSection, path: string) {
  expect(s.id, `${path}.id`).toMatch(/^[a-z0-9-]+$/);
  assertBilingual(s.title, `${path}.title`);
  assertBilingual(s.whatItDoes, `${path}.whatItDoes`);
  if (s.howToUse) {
    s.howToUse.forEach((step, i) => {
      expect(typeof step.bn).toBe("string");
      expect(typeof step.en).toBe("string");
      expect(step.bn.trim().length, `${path}.howToUse[${i}].bn`).toBeGreaterThan(0);
      expect(step.en.trim().length, `${path}.howToUse[${i}].en`).toBeGreaterThan(0);
    });
  }
  if (s.troubleshooting) {
    s.troubleshooting.forEach((t, i) => {
      assertBilingual(t.problem, `${path}.troubleshooting[${i}].problem`);
      assertBilingual(t.solution, `${path}.troubleshooting[${i}].solution`);
    });
  }
  if (s.fields) {
    s.fields.forEach((f, i) => {
      expect(f.name, `${path}.fields[${i}].name`).toBeTruthy();
      assertBilingual(f.purpose, `${path}.fields[${i}].purpose`);
    });
  }
}

function assertPageHelp(help: PageHelp, route: string) {
  expect(help.slug, `${route} slug`).toMatch(/^[a-z0-9.-]+$/);
  // route derived from slug
  expect(route).toBe("/" + help.slug.replace(/\./g, "/"));
  assertBilingual(help.page.title, `${help.slug}.page.title`);
  assertBilingual(help.page.whatItDoes, `${help.slug}.page.whatItDoes`);
  expect(help.sections.length, `${help.slug} needs at least one section`).toBeGreaterThan(0);
  const ids = new Set<string>();
  help.sections.forEach((s, i) => {
    assertSection(s, `${help.slug}.sections[${i}]`);
    expect(ids.has(s.id), `${help.slug} duplicate section id ${s.id}`).toBe(false);
    ids.add(s.id);
  });
}

describe("HELP_REGISTRY", () => {
  it("has at least one entry", () => {
    expect(HELP_REGISTRY.length).toBeGreaterThan(0);
  });

  it("every entry has a unique route", () => {
    const seen = new Set<string>();
    for (const e of HELP_REGISTRY) {
      expect(seen.has(e.route), `duplicate route ${e.route}`).toBe(false);
      seen.add(e.route);
    }
  });

  it("every entry has a unique slug", () => {
    const seen = new Set<string>();
    for (const e of HELP_REGISTRY) {
      expect(seen.has(e.help.slug), `duplicate slug ${e.help.slug}`).toBe(false);
      seen.add(e.help.slug);
    }
  });

  it.each(HELP_REGISTRY.map((e) => [e.help.slug, e] as const))(
    "%s renders with required bilingual fields",
    (_slug, entry) => {
      assertPageHelp(entry.help, entry.route);
    },
  );

  it("covers all pages from the AI & Search and Ops & Observability groups", () => {
    const expected = [
      // AI & Search
      "/dashboard/ai",
      "/dashboard/vector",
      "/dashboard/pluto-search",
      // Ops & Observability
      "/dashboard/observability",
      "/dashboard/logs",
      "/dashboard/logs-explorer",
      "/dashboard/audit",
      "/dashboard/audit-log",
      "/dashboard/scaling",
      "/dashboard/usage",
      "/dashboard/pluto-billing",
    ];
    const routes = new Set(HELP_REGISTRY.map((e) => e.route));
    for (const r of expected) {
      expect(routes.has(r), `missing help entry for ${r}`).toBe(true);
    }
  });

  it("covers all pages from the Platform group", () => {
    const expected = [
      "/dashboard/projects",
      "/dashboard/workspaces",
      "/dashboard/cors",
      "/dashboard/custom-domains",
      "/dashboard/backups",
      "/dashboard/branching",
      "/dashboard/pluto-branches",
      "/dashboard/pluto-replicas",
      "/dashboard/pluto-compliance",
      "/dashboard/pluto-vault",
      "/dashboard/enterprise",
      "/dashboard/pluto-marketplace",
    ];
    const routes = new Set(HELP_REGISTRY.map((e) => e.route));
    for (const r of expected) {
      expect(routes.has(r), `missing help entry for ${r}`).toBe(true);
    }
  });
});
